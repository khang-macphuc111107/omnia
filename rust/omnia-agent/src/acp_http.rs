//! HTTP/SSE & WebSocket ACP (Agent Client Protocol) server for Omnia.
//!
//! Compatible with Goose Desktop's **External Backend (ACP)** (`GET /status`,
//! `POST /acp` JSON-RPC / SSE, `GET /acp` WebSocket upgrade, `X-Secret-Key` /
//! `?token=` authentication) while delegating every turn to `NativeSuperEngine`.
//!
//! Prompt blocks are rendered in order. Resource links are passed as name and URI,
//! never dereferenced by the adapter. Embedded resources are rejected because
//! `embeddedContext` is not advertised.
//! An unsupported block rejects the entire turn before any session state changes.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::acp_proto;
use crate::permissions::{ApprovalMode, PermissionsEngine};
use crate::{
    default_omnia_data_dir, redact_secrets, resolve_model_endpoint, validate_workspace_dir,
    AgentStore, EpochMaskingState, HarnessEventSink, HarnessStreamEvent, ModelEditAffinity,
    NativeSuperEngine, PluginRegistry, WorkspaceGraphIndex,
};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type SessionEntry = (
    Arc<AsyncMutex<NativeSuperEngine>>,
    Arc<AtomicBool>,
    Arc<Mutex<LivePermSnapshot>>,
);

/// Mirror live engine state into the shared permission snapshot.
fn sync_perm_snapshot(snap: &Arc<Mutex<LivePermSnapshot>>, eng: &NativeSuperEngine) {
    let mut s = snap.lock().unwrap();
    s.spec = format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
    s.effort = eng.thinking_level.clone();
    s.approval = eng.tool_runtime.approval_mode;
    s.trusted = eng.tool_runtime.workspace_trusted;
}

/// Fold session-scoped `allow_always` grants into the engine at the START of a
/// prompt turn (approver owns the snapshot; engine rules are rebuilt, not mutated).
fn apply_grants_to_engine(eng: &mut NativeSuperEngine, snap: &Arc<Mutex<LivePermSnapshot>>) {
    let grants: Vec<_> = snap
        .lock()
        .unwrap()
        .rules
        .iter()
        .filter(|r| r.id.starts_with("acp-allow-"))
        .cloned()
        .collect();
    if !grants.is_empty() {
        eng.tool_runtime
            .permission_rules
            .retain(|r| !r.id.starts_with("acp-allow-"));
        eng.tool_runtime.permission_rules.extend(grants);
    }
}

/// `configOptions` for a freshly created session (endpoint already resolved).
fn new_session_config_options(
    spec: &str,
    effort: Option<&str>,
    approval: ApprovalMode,
) -> Vec<Value> {
    crate::acp_proto::build_config_options(
        &crate::acp_proto::model_catalog(None),
        spec,
        effort,
        approval,
    )
}

#[derive(Clone)]
pub(crate) struct AcpSessionState {
    pub sessions: Arc<AsyncMutex<HashMap<String, SessionEntry>>>,
    pub store: Option<AgentStore>,
    pub secret_key: Option<String>,
    pub default_model: Option<String>,
    pub default_base_url: Option<String>,
    pub default_api_key: Option<String>,
    env_auto_approve: bool,
    history_root: Option<PathBuf>,
    pub(crate) stdio_replay: bool,
    /// Transport hook for server->client `session/request_permission` frames
    /// when an interactive transport is available.
    pub perm_emitter: Option<Arc<dyn Fn(Value) -> bool + Send + Sync>>,
    /// Pending permission responses keyed by request id (value = chosen optionId).
    pub pending_perms: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
}

pub(crate) type AcpHttpState = AcpSessionState;

/// Shared session-store bootstrap (store + auto-approve env) for both transports.
pub(crate) fn new_acp_state(
    default_model: Option<String>,
    default_base_url: Option<String>,
    default_api_key: Option<String>,
) -> AcpSessionState {
    let store = AgentStore::open(&default_omnia_data_dir())
        .or_else(|_| AgentStore::open_in_memory())
        .ok();
    let env_auto_approve = std::env::var("OMNIA_ACP_AUTO_APPROVE")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
    AcpSessionState {
        sessions: Arc::new(AsyncMutex::new(HashMap::new())),
        store,
        secret_key: None,
        default_model,
        default_base_url,
        default_api_key,
        env_auto_approve,
        history_root: crate::acp_history::default_root(),
        stdio_replay: false,
        perm_emitter: None,
        pending_perms: Arc::new(Mutex::new(HashMap::new())),
    }
}

/// Build the ACP `session/request_permission` frame for one engine `Ask` decision.
fn acp_permission_frame(sid: &str, req_id: &str, tool: &str, target: &str) -> Value {
    let kind = acp_tool_kind(tool);
    let raw_input = if matches!(kind, "execute") {
        json!({ "command": target })
    } else {
        json!({ "path": target })
    };
    let shown: String = target.chars().take(160).collect();
    json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": sid,
            "toolCall": {
                "toolCallId": req_id,
                "title": format!("{tool}: {shown}"),
                "kind": kind,
                "status": "pending",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": redact_secrets(&format!("{tool} -> {shown}")) }
                }],
                "rawInput": raw_input
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
                { "optionId": "reject_once", "name": "Reject once", "kind": "reject_once" },
                { "optionId": "reject_always", "name": "Always reject", "kind": "reject_always" }
            ]
        }
    })
}

#[must_use]
fn acp_tool_kind(tool: &str) -> &'static str {
    match tool {
        "read" => "read",
        "write" | "edit" | "apply_patch" => "edit",
        "delete" => "delete",
        "search" | "grep" | "glob" | "lsp" | "ast_grep" => "search",
        "shell" | "bash" | "execute" | "terminal" => "execute",
        "web_search" | "fetch" => "fetch",
        _ => "other",
    }
}

/// Live session state mirrored for the approver + configOptions builders so
/// they can answer while `run_prompt` holds the engine lock. `sync_perm_snapshot`
/// refreshes it at every mutation point (session/new, each prompt turn, every
/// set_config_option/set_mode).
#[derive(Clone)]
pub(crate) struct LivePermSnapshot {
    pub sid: String,
    journal: Option<Arc<Mutex<crate::acp_history::Journal>>>,
    /// `provider/model` currently bound to the session.
    pub spec: String,
    pub effort: Option<String>,
    pub approval: ApprovalMode,
    pub trusted: bool,
    /// Session-scoped permission rules (defaults + `allow_always` grants).
    pub rules: Vec<crate::permissions::PermissionRule>,
}

/// Interactive approver answering engine `Ask` decisions with ACP
/// `session/request_permission` round-trips (fail-closed on absence/timeout/deny).
fn live_acp_approver(
    state: &AcpSessionState,
    snap: Arc<Mutex<LivePermSnapshot>>,
) -> Option<crate::tools::InteractiveApprover> {
    let emitter = state.perm_emitter.as_ref().map(Arc::clone)?;
    let pending = Arc::clone(&state.pending_perms);
    Some(Arc::new(move |tool: String, target: String| {
        let emitter = Arc::clone(&emitter);
        let pending = Arc::clone(&pending);
        let snap = Arc::clone(&snap);
        Box::pin(async move {
            use crate::permissions::{PermissionAction, PermissionDecision, PermissionsEngine};
            let aliases: Vec<&str> = if matches!(
                tool.as_str(),
                "shell" | "bash" | "execute" | "terminal" | "run" | "command"
            ) {
                vec![tool.as_str(), "bash", "shell"]
            } else if matches!(
                tool.as_str(),
                "edit" | "apply_patch" | "hashline_edit" | "delete"
            ) {
                vec![tool.as_str(), "write", "edit"]
            } else {
                vec![tool.as_str()]
            };
            let (approval, trusted, rules, sid) = {
                let s = snap.lock().unwrap();
                (s.approval, s.trusted, s.rules.clone(), s.sid.clone())
            };
            let mut any_deny = false;
            let mut any_allow = false;
            for alias in &aliases {
                let eval = PermissionsEngine::evaluate(&rules, trusted, alias, &target, approval);
                match eval.decision {
                    PermissionDecision::Deny => any_deny = true,
                    PermissionDecision::Allow => any_allow = true,
                    PermissionDecision::Ask => {}
                }
            }
            if any_deny || any_allow {
                return !any_deny;
            }

            let req_id = format!("perm-{}", uuid::Uuid::new_v4());
            let (tx, rx) = tokio::sync::oneshot::channel();
            pending.lock().unwrap().insert(req_id.clone(), tx);
            if !(emitter)(acp_permission_frame(&sid, &req_id, &tool, &target)) {
                pending.lock().unwrap().remove(&req_id);
                return false;
            }
            let oid = match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
                Ok(Ok(oid)) => oid,
                _ => {
                    pending.lock().unwrap().remove(&req_id);
                    return false;
                }
            };
            if oid == "allow_always" {
                let mut s = snap.lock().unwrap();
                s.rules.retain(|r| {
                    !(r.tool == tool && r.match_pattern == "*" && r.id.starts_with("acp-allow-"))
                });
                s.rules.push(crate::permissions::PermissionRule {
                    id: format!("acp-allow-{tool}-{}", uuid::Uuid::new_v4()),
                    scope: crate::permissions::PermissionScope::Workspace,
                    workspace_id: None,
                    action: PermissionAction::Allow,
                    tool: tool.clone(),
                    match_pattern: "*".into(),
                    note: format!("ACP client allowed `{tool}` for this session"),
                });
            }
            matches!(oid.as_str(), "allow_once" | "allow_always")
        })
    }))
}

/// Runs the Goose-compatible HTTP + SSE + WebSocket ACP server.
pub async fn run_acp_http_server(
    host: &str,
    port: u16,
    secret_key: Option<String>,
    default_model: Option<String>,
    default_base_url: Option<String>,
    default_api_key: Option<String>,
) -> Result<()> {
    let listener = TcpListener::bind((host, port))
        .await
        .with_context(|| format!("failed to bind ACP HTTP server on {host}:{port}"))?;
    let local_addr = listener.local_addr()?;
    eprintln!(
        "Omnia External ACP Backend (v{}) listening on http://{} (GET /status, POST|WS /acp, auth={})",
        env!("CARGO_PKG_VERSION"),
        local_addr,
        if secret_key.as_deref().is_some_and(|s| !s.is_empty()) {
            "X-Secret-Key"
        } else {
            "open-loopback"
        }
    );
    serve_acp_http_listener(
        listener,
        secret_key,
        default_model,
        default_base_url,
        default_api_key,
    )
    .await
}

pub async fn serve_acp_http_listener(
    listener: TcpListener,
    secret_key: Option<String>,
    default_model: Option<String>,
    default_base_url: Option<String>,
    default_api_key: Option<String>,
) -> Result<()> {
    let mut state = new_acp_state(default_model, default_base_url, default_api_key);
    state.secret_key = secret_key.filter(|s| !s.trim().is_empty());

    loop {
        let (stream, _peer) = listener.accept().await?;
        let st = state.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, st).await;
        });
    }
}

pub fn local_addr_port(addr: SocketAddr) -> u16 {
    addr.port()
}

async fn handle_connection(stream: TcpStream, state: AcpHttpState) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let parts: Vec<&str> = request_line
        .trim_end_matches(['\r', '\n'])
        .split_whitespace()
        .collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let method = parts[0].to_ascii_uppercase();
    let target = parts[1].to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0)
        .min(16 * 1024 * 1024);
    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader.read_exact(&mut body).await?;
    }

    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));

    if method == "OPTIONS" {
        let mut s = reader.into_inner();
        write_http_response(&mut s, 204, "No Content", "text/plain", b"").await?;
        return Ok(());
    }

    if method == "GET" && path == "/status" {
        let payload = serde_json::to_vec(&json!({
            "status": "ok",
            "backend": "omnia-sota-v4.4",
            "protocolVersion": 1
        }))?;
        let mut s = reader.into_inner();
        write_http_response(&mut s, 200, "OK", "application/json", &payload).await?;
        return Ok(());
    }

    if path != "/acp" {
        let mut s = reader.into_inner();
        write_http_response(
            &mut s,
            404,
            "Not Found",
            "application/json",
            br#"{"error":"not found"}"#,
        )
        .await?;
        return Ok(());
    }

    if !is_authorized(&state.secret_key, &headers, query) {
        let mut s = reader.into_inner();
        write_http_response(
            &mut s,
            401,
            "Unauthorized",
            "application/json",
            br#"{"error":"unauthorized"}"#,
        )
        .await?;
        return Ok(());
    }

    let is_ws = headers
        .get("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if method == "GET" && is_ws {
        let Some(ws_key) = headers.get("sec-websocket-key").cloned() else {
            let mut s = reader.into_inner();
            write_http_response(
                &mut s,
                400,
                "Bad Request",
                "application/json",
                br#"{"error":"missing Sec-WebSocket-Key"}"#,
            )
            .await?;
            return Ok(());
        };
        return handle_websocket(reader, &ws_key, state).await;
    }

    if method == "POST" {
        let req: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                let err = serde_json::to_vec(&json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") }
                }))?;
                let mut s = reader.into_inner();
                write_http_response(&mut s, 400, "Bad Request", "application/json", &err).await?;
                return Ok(());
            }
        };

        let rpc_method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let wants_sse = rpc_method == "session/prompt"
            || headers
                .get("accept")
                .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"));

        let mut s = reader.into_inner();
        if wants_sse {
            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
            s.write_all(hdr.as_bytes()).await?;
            s.flush().await?;

            let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
            let st_clone = state.clone();
            let req_clone = req.clone();
            let worker = tokio::spawn(async move {
                let reply = dispatch_rpc(req_clone, &st_clone, Some(tx.clone())).await;
                if let Some(frame) = reply {
                    let _ = tx.send(frame);
                }
            });

            while let Some(frame) = rx.recv().await {
                let line = format!("data: {}\n\n", serde_json::to_string(&frame)?);
                if s.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = s.flush().await;
            }
            let _ = worker.await;
            return Ok(());
        }

        if let Some(reply) = dispatch_rpc(req, &state, None).await {
            let payload = serde_json::to_vec(&reply)?;
            write_http_response(&mut s, 200, "OK", "application/json", &payload).await?;
        } else {
            write_http_response(&mut s, 202, "Accepted", "application/json", b"{}").await?;
        }
        return Ok(());
    }

    // Goose Desktop external-backend readiness: `GET /acp` (auth OK, no WS Upgrade)
    // MUST answer 406 — that exact status is what the app-asar handshake checks for.
    let mut s = reader.into_inner();
    if method == "GET" {
        write_http_response(
            &mut s,
            406,
            "Not Acceptable",
            "application/json",
            br#"{"error":"WebSocket upgrade required for ACP"}"#,
        )
        .await?;
    } else {
        write_http_response(
            &mut s,
            405,
            "Method Not Allowed",
            "application/json",
            br#"{"error":"method not allowed"}"#,
        )
        .await?;
    }
    Ok(())
}

async fn handle_websocket(
    mut reader: BufReader<TcpStream>,
    ws_key: &str,
    state: AcpHttpState,
) -> Result<()> {
    let accept = compute_ws_accept(ws_key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    reader.get_mut().write_all(handshake.as_bytes()).await?;
    reader.get_mut().flush().await?;

    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel::<Value>();
    let (stream_read, mut stream_write) = reader.into_inner().into_split();
    let mut ws_reader = BufReader::new(stream_read);

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = ws_rx.recv().await {
            if let Ok(text) = serde_json::to_string(&frame) {
                if write_ws_frame(&mut stream_write, 0x1, text.as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    });

    while let Some((opcode, payload)) = read_ws_frame(&mut ws_reader).await? {
        match opcode {
            0x8 => break, // Close
            0x9 => {
                // Ping -> reply Pong on channel is skipped; close gracefully if unsupported
                continue;
            }
            0x1 | 0x2 => {
                let text = String::from_utf8_lossy(&payload);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    let st = state.clone();
                    let tx = ws_tx.clone();
                    tokio::spawn(async move {
                        if let Some(reply) = dispatch_rpc(req, &st, Some(tx.clone())).await {
                            let _ = tx.send(reply);
                        }
                    });
                }
            }
            _ => {}
        }
    }

    drop(ws_tx);
    let _ = writer_task.await;
    Ok(())
}

fn render_prompt(prompt: &Value) -> Result<String, String> {
    let blocks = prompt.as_array().ok_or("prompt must be an array")?;
    let mut rendered = String::new();
    for (i, block) in blocks.iter().enumerate() {
        if i != 0 {
            rendered.push('\n');
        }
        match block["type"].as_str() {
            Some("text") => rendered.push_str(
                block["text"]
                    .as_str()
                    .ok_or_else(|| format!("prompt[{i}]: text must be a string"))?,
            ),
            Some("resource_link") => {
                let name = block["name"]
                    .as_str()
                    .ok_or_else(|| format!("prompt[{i}]: missing resource link name"))?;
                let uri = block["uri"]
                    .as_str()
                    .ok_or_else(|| format!("prompt[{i}]: missing resource link URI"))?;
                rendered.push_str(name);
                rendered.push_str(": ");
                rendered.push_str(uri);
            }
            Some("resource") => {
                return Err(format!("prompt[{i}]: embedded resources are unsupported"));
            }
            Some(_) => return Err(format!("prompt[{i}]: unsupported content block type")),
            None => return Err(format!("prompt[{i}]: missing content block type")),
        }
    }
    Ok(rendered)
}

pub(crate) async fn dispatch_rpc(
    req: Value,
    state: &AcpHttpState,
    notify_tx: Option<mpsc::UnboundedSender<Value>>,
) -> Option<Value> {
    // Client->agent RESPONSE to a server-initiated request (permission outcome):
    // route it to the pending waiter and emit nothing.
    if req.get("method").is_none() && (req.get("result").is_some() || req.get("error").is_some()) {
        if let Some(rid) = req.get("id").and_then(|v| v.as_str()) {
            if let Some((_, tx)) = state.pending_perms.lock().unwrap().remove_entry(rid) {
                let oid = req
                    .pointer("/result/outcome")
                    .filter(|_| req.get("error").is_none())
                    .filter(|outcome| {
                        outcome.get("outcome").and_then(Value::as_str) == Some("selected")
                    })
                    .and_then(|outcome| outcome.get("optionId"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let _ = tx.send(oid);
            }
        }
        return None;
    }
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => id.map(|req_id| {
            json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": 1,
                    "agentInfo": {
                        "name": "omnia",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "agentCapabilities": {
                        "loadSession": state.history_root.is_some() && (state.stdio_replay || notify_tx.is_some()),
                        "promptCapabilities": { "embeddedContext": false, "image": false, "audio": false },
                        "mcpCapabilities": { "http": true, "sse": true },
                        "sessionCapabilities": { "close": {} }
                    }
                }
            })
        }),
        "session/new" | "session/load" => {
            let loading = method == "session/load";
            let replay_capable = state.stdio_replay || notify_tx.is_some();
            let history_error = || id.clone().map(|i| json!({"jsonrpc":"2.0", "id":i,"error":{"code":-32000,"message":"Session checkpoint unavailable, incomplete, active, or bound to another workspace"}}));
            if loading && notify_tx.is_none() {
                return history_error();
            }
            let mcp_servers: Vec<crate::mcp_client::McpServerConfig> = match params.get("mcpServers") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(arr)) => {
                    let mut parsed_srvs = Vec::with_capacity(arr.len());
                    for entry in arr {
                        match parse_acp_mcp_server(entry) {
                            Ok(cfg) => parsed_srvs.push(cfg),
                            Err(msg) => {
                                return id.map(|req_id| json!({
                                    "jsonrpc": "2.0", "id": req_id,
                                    "error": { "code": -32602, "message": format!("Invalid mcpServers entry: {msg}") }
                                }));
                            }
                        }
                    }
                    parsed_srvs
                }
                Some(_) => {
                    return id.map(|req_id| json!({
                        "jsonrpc": "2.0", "id": req_id,
                        "error": { "code": -32602, "message": "mcpServers must be an array" }
                    }));
                }
            };
            if loading && !params.get("cwd").and_then(Value::as_str).is_some_and(|cwd| std::path::Path::new(cwd).is_absolute()) {
                return id.map(|i| json!({"jsonrpc":"2.0","id":i,"error":{"code":-32602,"message":"session/load requires an absolute cwd"}}));
            }
            let raw_cwd = params
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            let cwd = match validate_workspace_dir(&raw_cwd) {
                Ok(valid) => valid,
                Err(e) => {
                    return id.map(|req_id| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "error": { "code": -32602, "message": redact_secrets(&e.to_string()) }
                        })
                    });
                }
            };
            let opt_in_auto = params
                .get("autoApprove")
                .map_or(state.env_auto_approve, |v| v.as_bool().unwrap_or(false));
            let approval_mode = match params.get("approvalMode") {
                Some(value) => match value
                    .as_str()
                    .and_then(|m| ApprovalMode::try_parse_flag(m).ok())
                {
                    Some(mode) => mode,
                    None => {
                        return id.map(|req_id| {
                            json!({
                                "jsonrpc": "2.0", "id": req_id,
                                "error": { "code": -32602, "message": "Invalid approvalMode" }
                            })
                        })
                    }
                },
                None if opt_in_auto => ApprovalMode::Yolo,
                None => ApprovalMode::AlwaysAsk,
            };
            let workspace_trusted = opt_in_auto
                || params
                    .get("workspaceTrusted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            let model = params
                .get("model")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| state.default_model.clone())
                .unwrap_or_else(|| "htmustc-claude/claude-sonnet-5-5".into());
            let sid = if loading {
                params.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned()
            } else { format!("acp-{}", uuid::Uuid::new_v4()) };
            let mut journal = if replay_capable {
                match &state.history_root {
                    Some(root) => match crate::acp_history::Journal::open(root, &cwd, &sid, !loading) {
                        Ok(j) => Some(j), Err(_) => return history_error(),
                    },
                    None if loading => return history_error(),
                    None => None,
                }
            } else { None };
            // Signed reasoning/tool state must not silently move to the new process's default model.
            let model = journal.as_ref().and_then(|j| j.saved_model()).unwrap_or(&model);
            let cancel_flag = Arc::new(AtomicBool::new(false));
            match resolve_model_endpoint(
                model,
                None,
                state.default_base_url.as_deref(),
                state.default_api_key.as_deref(),
            )
            .and_then(|ep| {
                let g = Arc::new(Mutex::new(WorkspaceGraphIndex::with_options(
                    &cwd,
                    PermissionsEngine::default_rules(),
                    state.store.clone(),
                )));
                let g_bg = Arc::clone(&g);
                tokio::task::spawn_blocking(move || {
                    if let Ok(mut idx) = g_bg.lock() {
                        let _ = idx.refresh();
                    }
                });
                NativeSuperEngine::new(
                    sid.clone(),
                    cwd,
                    ep,
                    None,
                    approval_mode,
                    workspace_trusted,
                    PermissionsEngine::default_rules(),
                    PluginRegistry::with_default_pillars(),
                    g,
                    state.store.clone(),
                    None,
                    Arc::clone(&cancel_flag),
                    None,
                )
            }) {
                Ok(mut eng) => {
                    if let Some(j) = journal.as_mut() {
                        if loading {
                            let Ok(updates) = j.restore(&mut eng) else { return history_error() };
                            let tx = notify_tx.as_ref().unwrap();
                            for (_, update) in updates {
                                if tx.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":sid,"update":update}})).is_err() { return history_error(); }
                            }
                        } else {
                            let secrets = [eng.endpoint.api_key.as_str(), state.default_api_key.as_deref().unwrap_or(""), state.secret_key.as_deref().unwrap_or("")];
                            if j.save(&eng, 1, &[], &secrets).is_err() { return history_error(); }
                        }
                    }
                    if !mcp_servers.is_empty() {
                        let mcp_mgr = Arc::clone(&eng.tool_runtime.mcp_manager);
                        tokio::spawn(async move {
                            for cfg in mcp_servers {
                                let _ = mcp_mgr.connect_server(cfg).await;
                            }
                        });
                    }
                    let wire_dialect = eng.active_wire_dialect().to_string();
                    let resolved_model =
                        format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
                    let config_options =
                        new_session_config_options(&resolved_model, None, approval_mode);
                    let modes = acp_proto::build_modes_state(approval_mode);
                    let snap = Arc::new(Mutex::new(LivePermSnapshot {
                        journal: journal.map(|j| Arc::new(Mutex::new(j))),
                        sid: sid.clone(),
                        spec: resolved_model.clone(),
                        effort: None,
                        approval: approval_mode,
                        trusted: workspace_trusted,
                        rules: PermissionsEngine::default_rules(),
                    }));
                    state.sessions.lock().await.insert(
                        sid.clone(),
                        (Arc::new(AsyncMutex::new(eng)), cancel_flag, snap),
                    );
                    id.map(|req_id| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "result": {
                                "sessionId": sid,
                                "backend": "omnia-sota-v4.4",
                                "model": resolved_model,
                                "wireDialect": wire_dialect,
                                "configOptions": config_options,
                                "modes": modes
                            }
                        })
                    })
                }
                Err(e) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32000, "message": redact_secrets(&e.to_string()) }
                    })
                }),
            }
        }
        "session/prompt" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let prompt_text = match render_prompt(&params["prompt"]) {
                Ok(text) => text,
                Err(message) => {
                    return id.map(|id| json!({
                        "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": message }
                    }));
                }
            };
            let entry = state.sessions.lock().await.get(&sid).cloned();
            let Some((eng_arc, cancel_arc, perm_snap)) = entry else {
                return id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                });
            };
            cancel_arc.store(false, Ordering::Relaxed);
            let h_sink: Option<HarnessEventSink> = notify_tx.map(|tx| {
                let sid_ev = sid.clone();
                let sink: HarnessEventSink = Arc::new(move |ev| {
                    if let Some(upd) = harness_event_to_acp_update(ev) {
                        let _ = tx.send(json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": { "sessionId": sid_ev, "update": upd }
                        }));
                    }
                });
                sink
            });

            let mut eng = eng_arc.lock().await;
            sync_perm_snapshot(&perm_snap, &eng);
            apply_grants_to_engine(&mut eng, &perm_snap);
            eng.tool_runtime.approver = if matches!(eng.tool_runtime.approval_mode, ApprovalMode::Yolo)
                || state.perm_emitter.is_none()
            {
                None
            } else {
                live_acp_approver(state, Arc::clone(&perm_snap))
            };
            let journal = perm_snap.lock().unwrap().journal.clone();
            let checkpoint_error = || id.clone().map(|i| json!({"jsonrpc":"2.0","id":i,"error":{"code":-32000,"message":"ACP history checkpoint failed; do not retry tools automatically"}}));
            if journal.as_ref().is_some_and(|j| j.lock().unwrap().begin_turn().is_err()) {
                return checkpoint_error();
            }
            let first = eng.messages.len();
            let run_result = eng.run_prompt(&prompt_text, 50, 300, h_sink).await;
            sync_perm_snapshot(&perm_snap, &eng);
            if let Some(j) = journal {
                let blocks = params.get("prompt").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                let secrets = [eng.endpoint.api_key.as_str(), state.default_api_key.as_deref().unwrap_or(""), state.secret_key.as_deref().unwrap_or("")];
                if j.lock().unwrap().save(&eng, first, blocks, &secrets).is_err() { return checkpoint_error(); }
            }
            match run_result {
                Ok(sum) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "stopReason": acp_proto::stop_reason_for_status(&sum.status)
                        }
                    })
                }),
                Err(e) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32000, "message": redact_secrets(&e.to_string()) }
                    })
                }),
            }
        }
        "session/cancel" => {
            if let Some(sid) = params.get("sessionId").and_then(|v| v.as_str()) {
                if let Some((_, cancel_flag, _)) = state.sessions.lock().await.get(sid) {
                    cancel_flag.store(true, Ordering::Relaxed);
                }
            }
            id.map(|req_id| json!({ "jsonrpc": "2.0", "id": req_id, "result": {} }))
        }
        "session/set_model" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let model = params
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let thinking = params
                .get("thinkingLevel")
                .and_then(|v| v.as_str())
                .map(String::from);
            let entry = state.sessions.lock().await.get(sid).cloned();
            let Some((eng_arc, _, perm_snap)) = entry else {
                return id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                });
            };
            match resolve_model_endpoint(
                model,
                None,
                state.default_base_url.as_deref(),
                state.default_api_key.as_deref(),
            ) {
                Ok(ep) => {
                    let mut eng = eng_arc.lock().await;
                    eng.endpoint = ep.clone();
                    eng.epoch_masker = EpochMaskingState::for_context_window(ep.context_window);
                    eng.edit_affinity = ModelEditAffinity::for_model(&ep.model_id);
                    if thinking.is_some() {
                        eng.thinking_level = thinking;
                    }
                    sync_perm_snapshot(&perm_snap, &eng);
                    let dialect = eng.active_wire_dialect().to_string();
                    id.map(|req_id| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "result": {
                                "provider": ep.provider_id,
                                "modelId": ep.model_id,
                                "contextWindow": ep.context_window,
                                "wireDialect": dialect
                            }
                        })
                    })
                }
                Err(e) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": redact_secrets(&e.to_string()) }
                    })
                }),
            }
        }
        "session/rewind" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let target_turn = params.get("turn").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let entry = state.sessions.lock().await.get(sid).cloned();
            let Some((eng_arc, _, snap)) = entry else {
                return id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                });
            };
            let mut eng = eng_arc.lock().await;
            let journal = snap.lock().unwrap().journal.clone();
            let error = || id.clone().map(|i| json!({"jsonrpc":"2.0","id":i,"error":{"code":-32000,"message":"Rewind checkpoint unavailable"}}));
            if journal.as_ref().is_some_and(|j| !j.lock().unwrap().can_rewind_to(target_turn)) {
                return id.map(|i| json!({"jsonrpc":"2.0","id":i,"error":{"code":-32602,"message":"Cannot rewind before the restored turn: the conversation checkpoint does not include filesystem undo records"}}));
            }
            if journal.as_ref().is_some_and(|j| j.lock().unwrap().begin_turn().is_err()) { return error(); }
            match eng.rewind_to_turn(target_turn) {
                Ok(restored) => {
                    let secrets = [eng.endpoint.api_key.as_str(), state.default_api_key.as_deref().unwrap_or(""), state.secret_key.as_deref().unwrap_or("")];
                    if journal.as_ref().is_some_and(|j| j.lock().unwrap().rewind(&eng, target_turn, &secrets).is_err()) { return error(); }
                    id.map(|i| json!({"jsonrpc":"2.0","id":i,"result":{"restored":restored}}))
                }
                Err(e) => id.map(|i| json!({"jsonrpc":"2.0","id":i,"error":{"code":-32000,"message":redact_secrets(&e.to_string())}})),
            }
        }
        // ---- Goose (ACP client) session configuration surface ------------------
        // goose's pi-acp/claude-acp style providers drive model + effort + mode
        // through `session/set_config_option`, so mirror claude-agent-acp here.
        "session/set_config_option" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let config_id = params
                .get("configId")
                .or_else(|| params.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let entry = state.sessions.lock().await.get(sid).cloned();
            let Some((eng_arc, _, perm_snap)) = entry else {
                return id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                });
            };
            let catalog = acp_proto::model_catalog(None);
            let mut eng = eng_arc.lock().await;
            let result = match config_id {
                acp_proto::MODEL_OPTION_ID => {
                    if value == "current" || value.is_empty() {
                        Ok(String::new())
                    } else {
                        acp_proto::rebind_model(
                            &mut eng,
                            &value,
                            None,
                            state.default_base_url.as_deref(),
                            state.default_api_key.as_deref(),
                        )
                    }
                }
                acp_proto::THOUGHT_LEVEL_OPTION_ID | "effort" => {
                    let spec = format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
                    let entry = catalog.iter().find(|e| e.spec == spec);
                    let ok = entry
                        .map(|e| e.efforts.iter().any(|o| o.eq_ignore_ascii_case(&value)))
                        .unwrap_or(true);
                    if !ok {
                        Err(anyhow::anyhow!(
                            "unsupported reasoning effort '{value}' for {spec}"
                        ))
                    } else {
                        eng.thinking_level = Some(value.to_ascii_lowercase());
                        Ok(String::new())
                    }
                }
                acp_proto::MODE_OPTION_ID => match acp_proto::approval_for_mode_id(&value) {
                    Some(mode) => {
                        eng.tool_runtime.approval_mode = mode;
                        eng.tool_runtime.workspace_trusted = matches!(mode, ApprovalMode::Yolo);
                        Ok(String::new())
                    }
                    None => Err(anyhow::anyhow!("unknown session mode '{value}'")),
                },
                other => Err(anyhow::anyhow!("unknown config option '{other}'")),
            };
            match result {
                Ok(_) => {
                    let spec = format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
                    let approval = eng.tool_runtime.approval_mode;
                    let effort = eng.thinking_level.clone();
                    sync_perm_snapshot(&perm_snap, &eng);
                    drop(eng);
                    let options = acp_proto::build_config_options(
                        &catalog,
                        &spec,
                        effort.as_deref(),
                        approval,
                    );
                    if let Some(tx) = notify_tx.as_ref() {
                        let _ = tx.send(json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": sid,
                                "update": {
                                    "sessionUpdate": "config_option_update",
                                    "configOptions": options
                                }
                            }
                        }));
                    }
                    id.map(|req_id| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "result": { "configOptions": options }
                        })
                    })
                }
                Err(e) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": redact_secrets(&e.to_string()) }
                    })
                }),
            }
        }
        "session/set_mode" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mode_id = params
                .get("modeId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let entry = state.sessions.lock().await.get(sid).cloned();
            match entry {
                Some((eng_arc, _, perm_snap)) => {
                    let approval = acp_proto::approval_for_mode_id(&mode_id)
                        .unwrap_or(ApprovalMode::AlwaysAsk);
                    let mut eng = eng_arc.lock().await;
                    eng.tool_runtime.approval_mode = approval;
                    eng.tool_runtime.workspace_trusted = matches!(approval, ApprovalMode::Yolo);
                    let spec = format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
                    let effort = eng.thinking_level.clone();
                    let options = acp_proto::build_config_options(
                        &acp_proto::model_catalog(None),
                        &spec,
                        effort.as_deref(),
                        approval,
                    );
                    {
                        let mut s = perm_snap.lock().unwrap();
                        s.approval = approval;
                        s.trusted = eng.tool_runtime.workspace_trusted;
                    }
                    drop(eng);
                    if let Some(tx) = notify_tx.as_ref() {
                        let _ = tx.send(json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": sid,
                                "update": {
                                    "sessionUpdate": "current_mode_update",
                                    "currentModeId": if matches!(approval, ApprovalMode::Yolo) { "yolo" } else { "default" }
                                }
                            }
                        }));
                        let _ = tx.send(json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": sid,
                                "update": {
                                    "sessionUpdate": "config_option_update",
                                    "configOptions": options
                                }
                            }
                        }));
                    }
                    id.map(|req_id| json!({ "jsonrpc": "2.0", "id": req_id, "result": {} }))
                }
                None => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                }),
            }
        }
        "session/close" => {
            let sid = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some((_, cancel_flag, _)) = state.sessions.lock().await.remove(sid) {
                cancel_flag.store(true, Ordering::Relaxed);
            }
            id.map(|req_id| json!({ "jsonrpc": "2.0", "id": req_id, "result": {} }))
        }
        _ => id.map(|req_id| {
            json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            })
        }),
    }
}

fn harness_event_to_acp_update(ev: HarnessStreamEvent) -> Option<Value> {
    match ev {
        HarnessStreamEvent::DeltaBatch {
            text_delta,
            thinking_delta,
            ..
        } => {
            if !text_delta.is_empty() {
                Some(json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": redact_secrets(&text_delta) }
                }))
            } else if !thinking_delta.is_empty() {
                Some(json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": redact_secrets(&thinking_delta) }
                }))
            } else {
                None
            }
        }
        HarnessStreamEvent::ToolStart {
            tool_call_id,
            tool_name,
            ..
        } => Some(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": tool_call_id,
            "title": tool_name,
            "status": "in_progress"
        })),
        HarnessStreamEvent::ToolEnd {
            tool_call_id,
            tool_name,
            output,
            is_error,
            duration_ms,
        } => {
            let preview: String = output.chars().take(160).collect();
            Some(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": tool_call_id,
                "title": tool_name,
                "status": if is_error { "failed" } else { "completed" },
                "durationMs": duration_ms,
                "outputPreview": redact_secrets(&preview)
            }))
        }
        HarnessStreamEvent::AutoRecovery { attempt, reason } => Some(json!({
            "sessionUpdate": "omnia_recovery",
            "attempt": attempt,
            "reason": redact_secrets(&reason)
        })),
        HarnessStreamEvent::Metrics {
            tokens_per_second,
            context_tokens,
            context_window,
            context_percent,
            total_cost_usd,
        } => Some(json!({
            "sessionUpdate": "omnia_metrics",
            "tokensPerSecond": tokens_per_second,
            "contextTokens": context_tokens,
            "contextWindow": context_window,
            "contextPercent": context_percent,
            "totalCostUsd": total_cost_usd
        })),
        HarnessStreamEvent::Telemetry {
            cache_stats,
            lakeview_compressions,
            turn_count,
            tool_call_count,
            tool_error_count,
            ..
        } => Some(json!({
            "sessionUpdate": "omnia_telemetry",
            "kvHitPct": cache_stats.cache_hit_pct,
            "cacheReadTokens": cache_stats.cache_read_tokens,
            "lakeviewCompressions": lakeview_compressions,
            "turnCount": turn_count,
            "toolCallCount": tool_call_count,
            "toolErrorCount": tool_error_count
        })),
        _ => None,
    }
}

fn is_authorized(
    secret_key: &Option<String>,
    headers: &HashMap<String, String>,
    query: &str,
) -> bool {
    let Some(ref expected) = secret_key else {
        return true;
    };
    if let Some(h) = headers.get("x-secret-key") {
        if constant_time_eq(h.as_bytes(), expected.as_bytes()) {
            return true;
        }
    }
    if let Some(auth) = headers.get("authorization") {
        if let Some(tok) = auth
            .strip_prefix("Bearer ")
            .or_else(|| auth.strip_prefix("bearer "))
        {
            if constant_time_eq(tok.trim().as_bytes(), expected.as_bytes()) {
                return true;
            }
        }
    }
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "token" && constant_time_eq(v.as_bytes(), expected.as_bytes()) {
                return true;
            }
        }
    }
    false
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, X-Secret-Key, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if !body.is_empty() {
        stream.write_all(body).await?;
    }
    stream.flush().await?;
    Ok(())
}

async fn read_ws_frame<R: tokio::io::AsyncRead + Unpin>(
    r: &mut R,
) -> Result<Option<(u8, Vec<u8>)>> {
    let mut hdr = [0u8; 2];
    match r.read_exact(&mut hdr).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let opcode = hdr[0] & 0x0F;
    let masked = (hdr[1] & 0x80) != 0;
    let mut len = (hdr[1] & 0x7F) as usize;
    if len == 126 {
        let mut ext = [0u8; 2];
        r.read_exact(&mut ext).await?;
        len = u16::from_be_bytes(ext) as usize;
    } else if len == 127 {
        let mut ext = [0u8; 8];
        r.read_exact(&mut ext).await?;
        let wide = u64::from_be_bytes(ext);
        if wide > 16 * 1024 * 1024 {
            bail!("websocket frame exceeds 16 MiB limit");
        }
        len = wide as usize;
    }
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask).await?;
    }
    let mut payload = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut payload).await?;
    }
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok(Some((opcode, payload)))
}

async fn write_ws_frame<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    opcode: u8,
    payload: &[u8],
) -> Result<()> {
    let mut hdr = Vec::with_capacity(10);
    hdr.push(0x80 | (opcode & 0x0F));
    let len = payload.len();
    if len < 126 {
        hdr.push(len as u8);
    } else if len <= u16::MAX as usize {
        hdr.push(126);
        hdr.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        hdr.push(127);
        hdr.extend_from_slice(&(len as u64).to_be_bytes());
    }
    w.write_all(&hdr).await?;
    if !payload.is_empty() {
        w.write_all(payload).await?;
    }
    w.flush().await?;
    Ok(())
}

fn compute_ws_accept(key: &str) -> String {
    let mut input = key.trim().as_bytes().to_vec();
    input.extend_from_slice(WS_GUID.as_bytes());
    let digest = sha1_digest(&input);
    base64_encode(&digest)
}

fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, h) in [h0, h1, h2, h3, h4].iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&h.to_be_bytes());
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn parse_acp_kv_map(val: Option<&Value>) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    match val {
        Some(Value::Object(map)) => {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    out.insert(k.clone(), s.to_owned());
                }
            }
        }
        Some(Value::Array(arr)) => {
            for item in arr {
                if let (Some(k), Some(v)) = (
                    item.get("name").and_then(Value::as_str),
                    item.get("value").and_then(Value::as_str),
                ) {
                    out.insert(k.to_owned(), v.to_owned());
                }
            }
        }
        _ => {}
    }
    out
}

fn parse_acp_mcp_server(entry: &Value) -> Result<crate::mcp_client::McpServerConfig, String> {
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing non-empty server `name`".to_owned())?
        .to_owned();
    let kind = entry
        .get("type")
        .and_then(Value::as_str)
        .map(|s| s.to_ascii_lowercase());
    let transport = match kind.as_deref() {
        Some("http") | Some("streamable_http") | Some("streamable-http") => {
            let url = entry
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("HTTP MCP server `{name}` missing `url`"))?
                .to_owned();
            crate::mcp_client::McpTransportConfig::Http {
                url,
                headers: parse_acp_kv_map(entry.get("headers")),
            }
        }
        Some("sse") => {
            let url = entry
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("SSE MCP server `{name}` missing `url`"))?
                .to_owned();
            crate::mcp_client::McpTransportConfig::Sse {
                url,
                headers: parse_acp_kv_map(entry.get("headers")),
            }
        }
        Some("stdio") | None => {
            let command = entry
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Stdio MCP server `{name}` missing `command`"))?
                .to_owned();
            let args = entry
                .get("args")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let cwd = entry
                .get("cwd")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            crate::mcp_client::McpTransportConfig::Stdio {
                command,
                args,
                env: parse_acp_kv_map(entry.get("env")),
                cwd,
            }
        }
        Some(other) => return Err(format!("unsupported MCP server type `{other}`")),
    };
    let timeout_ms = entry
        .get("timeoutMs")
        .or_else(|| entry.get("timeout_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(1_000, 300_000);
    let enabled = entry
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(crate::mcp_client::McpServerConfig {
        name,
        transport,
        enabled,
        timeout_ms,
        oauth: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acp_prompt_contract() {
        let state = AcpSessionState {
            sessions: Default::default(),
            store: None,
            secret_key: None,
            default_model: None,
            default_base_url: None,
            default_api_key: None,
            env_auto_approve: false,
            history_root: None,
            stdio_replay: false,
            perm_emitter: None,
            pending_perms: Default::default(),
        };
        let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":7,"method":method,"params":params});
        let init = dispatch_rpc(rpc("initialize", json!({})), &state, None)
            .await
            .unwrap();
        let caps = &init["result"]["agentCapabilities"]["promptCapabilities"];
        for key in ["image", "audio", "embeddedContext"] {
            assert_eq!(caps[key], false, "{key}");
        }
        let blocks = json!([
            {"type":"text","text":"question"},
            {"type":"resource_link","name":"ref","uri":"https://example.invalid/doc"},
            {"type":"text","text":"tail"}
        ]);
        assert_eq!(
            render_prompt(&blocks).unwrap(),
            "question\nref: https://example.invalid/doc\ntail"
        );
        let prompt = |blocks: Value| {
            rpc(
                "session/prompt",
                json!({"sessionId":"absent","prompt":blocks}),
            )
        };
        let reply = dispatch_rpc(prompt(blocks), &state, None).await.unwrap();
        assert_eq!(reply["error"]["message"], "unknown sessionId: absent");

        // An invalid suffix must fail before the session lookup, let alone inference.
        for bad in [
            json!({"type":"image","text":"not a text block"}),
            json!({"type":"audio"}),
            json!({"type":"future"}),
            json!({"text":"untagged"}),
            json!({"type":"text","text":1}),
            json!({"type":"resource_link","uri":"file:///example"}),
            json!({"type":"resource","resource":{"uri":"file:///example","text":"inline"}}),
            json!({"type":"resource","resource":{"uri":"file:///example","blob":"AA=="}}),
        ] {
            let reply = dispatch_rpc(
                prompt(json!([{"type":"text","text":"prefix"},bad])),
                &state,
                None,
            )
            .await
            .unwrap();
            assert_eq!(reply["id"], 7);
            assert_eq!(reply["error"]["code"], -32602);
            assert!(
                reply["error"]["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("prompt[1]:"),
                "{reply}"
            );
        }
        let reply = dispatch_rpc(prompt(Value::Null), &state, None)
            .await
            .unwrap();
        assert_eq!(reply["error"]["message"], "prompt must be an array");
    }

    #[tokio::test]
    async fn acp_checkpoint_next_prompt_sends_restored_turn_to_local_provider() {
        use std::fs;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for answer in ["first assistant answer", "second assistant answer"] {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut headers = String::new();
                while !headers.ends_with("\r\n\r\n") {
                    assert_ne!(reader.read_line(&mut headers).await.unwrap(), 0);
                }
                let size: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; size];
                reader.read_exact(&mut body).await.unwrap();
                bodies.push(serde_json::from_slice::<Value>(&body).unwrap());
                let frame = json!({"choices":[{"delta":{"content":answer},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":5}});
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n");
                reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
                reader.get_mut().shutdown().await.unwrap();
            }
            bodies
        });
        let tmp = std::env::temp_dir().join(format!("acp-probe-{}", uuid::Uuid::new_v4()));
        let cwd = tmp.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let prompt = |sid: &str, text: &str| {
            rpc(
                "session/prompt",
                json!({"sessionId":sid,"prompt":[{"type":"text","text":text}]}),
            )
        };
        let state = || AcpSessionState {
            sessions: Default::default(),
            store: None,
            secret_key: None,
            default_model: Some("openai/offline".into()),
            default_api_key: Some("offline-secret".into()),
            default_base_url: Some(endpoint.clone()),
            env_auto_approve: false,
            history_root: Some(tmp.join("history")),
            stdio_replay: true,
            perm_emitter: None,
            pending_perms: Default::default(),
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut sid = String::new();
        for (index, text) in ["first user message", "second user message"]
            .into_iter()
            .enumerate()
        {
            let st = state();
            let request = if index == 0 {
                rpc("session/new", json!({"cwd":cwd}))
            } else {
                rpc("session/load", json!({"cwd":cwd,"sessionId":sid}))
            };
            let reply = dispatch_rpc(request, &st, Some(tx.clone())).await.unwrap();
            sid = reply["result"]["sessionId"].as_str().unwrap().into();
            let engine = st.sessions.lock().await.get(&sid).unwrap().0.clone();
            engine.lock().await.wire_api_mode = crate::engine::WireApiMode::Chat;
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                dispatch_rpc(prompt(&sid, text), &st, Some(tx.clone())),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(result["result"]["stopReason"], "end_turn", "{result}");
        }
        let bodies = provider.await.unwrap();
        let messages = bodies[1]["messages"].as_array().unwrap();
        let visible: Vec<_> = messages.iter().filter(|m| m["role"] != "system").collect();
        assert!(visible[0]["content"]
            .to_string()
            .contains("first user message"));
        assert_eq!(visible[1]["role"], "assistant");
        assert!(visible[1]["content"]
            .to_string()
            .contains("first assistant answer"));
        assert_eq!(visible[2]["content"], "second user message");
        fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn acp_checkpoint_restart_replays_tool_history_and_isolates_workspaces() {
        use crate::{HarnessMessage, ToolCallRecord};
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let cwd = tmp.join("project");
        let other = tmp.join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let make_state = || AcpSessionState {
            sessions: Default::default(),
            store: None,
            secret_key: Some("secret-http-test".into()),
            default_model: Some("openai/offline".into()),
            default_api_key: Some("test-endpoint-credential".into()),
            default_base_url: Some("http://127.0.0.1:1/v1".into()),
            env_auto_approve: false,
            history_root: Some(tmp.join("history")),
            stdio_replay: false,
            perm_emitter: None,
            pending_perms: Default::default(),
        };
        let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let state = make_state();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let init = rpc("initialize", json!({}));
        assert_eq!(
            dispatch_rpc(init.clone(), &state, None).await.unwrap()["result"]["agentCapabilities"]
                ["loadSession"],
            false
        );
        assert_eq!(
            dispatch_rpc(init, &state, Some(tx.clone())).await.unwrap()["result"]
                ["agentCapabilities"]["loadSession"],
            true
        );
        let new = rpc("session/new", json!({"cwd":cwd,"autoApprove":true}));
        let reply = dispatch_rpc(new, &state, Some(tx.clone())).await.unwrap();
        let sid = reply["result"]["sessionId"].as_str().expect("new session");
        assert_eq!(
            uuid::Uuid::parse_str(sid.strip_prefix("acp-").unwrap())
                .unwrap()
                .get_version_num(),
            4
        );
        let load =
            |path: &std::path::Path| rpc("session/load", json!({"sessionId":sid,"cwd":path}));
        assert!(dispatch_rpc(load(&cwd), &make_state(), Some(tx.clone()))
            .await
            .unwrap()["error"]
            .is_object());
        {
            let entry = state.sessions.lock().await.get(sid).unwrap().clone();
            let mut eng = entry.0.lock().await;
            let journal = entry.2.lock().unwrap().journal.clone().unwrap();
            let grant = crate::permissions::PermissionRule {
                id: "acp-allow-private-grant-canary".into(),
                scope: crate::permissions::PermissionScope::Workspace,
                workspace_id: None,
                action: crate::permissions::PermissionAction::Allow,
                tool: "shell".into(),
                match_pattern: "*".into(),
                note: "session-only grant".into(),
            };
            entry.2.lock().unwrap().rules.push(grant);
            apply_grants_to_engine(&mut eng, &entry.2);
            assert!(eng
                .tool_runtime
                .permission_rules
                .iter()
                .any(|r| r.id == "acp-allow-private-grant-canary"));
            eng.messages.extend([
                HarnessMessage::user("show the file", 1),
                HarnessMessage::assistant(
                    "",
                    None,
                    vec![ToolCallRecord {
                        id: "call1".into(),
                        name: "read_file".into(),
                        arguments: r#"{"path":"file"}"#.into(),
                    }],
                    1,
                ),
                HarnessMessage::tool_result_with_meta(
                    "call1",
                    "read_file",
                    "not found",
                    1,
                    None,
                    true,
                ),
                HarnessMessage::assistant("File not found.", None, vec![], 2),
            ]);
            eng.total_turns = 2;
            journal.lock().unwrap().begin_turn().unwrap();
            journal
                .lock()
                .unwrap()
                .save(
                    &eng,
                    1,
                    &[json!({"type":"text","text":"show the file"})],
                    &[&eng.endpoint.api_key],
                )
                .unwrap();
        }
        drop(state);
        let saved =
            fs::read_to_string(tmp.join("history").join(format!("{}.json", &sid[4..]))).unwrap();
        for absent in [
            "test-endpoint-credential",
            "secret-http-test",
            "acp-allow-private-grant-canary",
            "permission_rules",
            "approval_mode",
            "autoApprove",
        ] {
            assert!(!saved.contains(absent));
        }
        let mut fresh = make_state();
        for params in [json!({"sessionId":sid}), json!({"sessionId":sid,"cwd":"."})] {
            let response = dispatch_rpc(rpc("session/load", params), &fresh, Some(tx.clone()))
                .await
                .unwrap();
            assert_eq!(response["error"]["code"], -32602);
            assert_eq!(
                response["error"]["message"],
                "session/load requires an absolute cwd"
            );
        }
        fresh.default_model = Some("openai/different-default".into());
        assert!(dispatch_rpc(load(&other), &fresh, Some(tx.clone()))
            .await
            .unwrap()["error"]
            .is_object());
        assert!(rx.try_recv().is_err());
        assert!(dispatch_rpc(load(&cwd), &fresh, None).await.unwrap()["error"].is_object());
        assert!(dispatch_rpc(load(&cwd), &fresh, Some(tx.clone()))
            .await
            .unwrap()["result"]
            .is_object());
        let frames: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|v| v["params"]["update"].clone())
            .collect();
        assert_eq!(
            frames
                .iter()
                .map(|f| f["sessionUpdate"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "user_message_chunk",
                "tool_call",
                "tool_call_update",
                "agent_message_chunk"
            ]
        );
        assert_eq!(frames[1]["rawInput"]["path"], "file");
        assert_eq!(frames[2]["toolCallId"], "call1");
        assert_eq!(frames[2]["status"], "failed");
        // Park a real prompt exactly at the busy engine lock. Cancel via ACP (not the
        // atomic flag directly), then prove no provider request or assistant reply is needed.
        {
            let engine = fresh.sessions.lock().await.get(sid).unwrap().0.clone();
            let guard = engine.lock().await;
            let turn = dispatch_rpc(
                rpc(
                    "session/prompt",
                    json!({"sessionId":sid,"prompt":[{"type":"text","text":"cancel this turn"}]}),
                ),
                &fresh,
                Some(tx.clone()),
            );
            tokio::pin!(turn);
            tokio::select! { biased; _ = &mut turn => panic!("prompt bypassed engine lock"), _ = std::future::ready(()) => {} }
            dispatch_rpc(
                rpc("session/cancel", json!({"sessionId":sid})),
                &fresh,
                None,
            )
            .await;
            drop(guard);
            assert_eq!(turn.await.unwrap()["result"]["stopReason"], "cancelled");
        }
        drop(fresh);
        let fresh = make_state();
        assert!(dispatch_rpc(load(&cwd), &fresh, Some(tx.clone()))
            .await
            .unwrap()["result"]
            .is_object());
        let replay: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        let last = &replay.last().unwrap()["params"]["update"];
        assert_eq!(last["sessionUpdate"], "user_message_chunk");
        assert_eq!(last["content"]["text"], "cancel this turn");
        let rewind = |turn: u32| rpc("session/rewind", json!({"sessionId":sid,"turn":turn}));
        assert_eq!(
            dispatch_rpc(rewind(1), &fresh, None).await.unwrap()["error"]["code"],
            -32602
        );
        assert!(dispatch_rpc(rewind(2), &fresh, None).await.unwrap()["result"].is_object());
        // Close releases the exclusive lease without erasing the conversation.
        let closed = dispatch_rpc(rpc("session/close", json!({"sessionId":sid})), &fresh, None)
            .await
            .unwrap();
        assert_eq!(closed["result"], json!({}));
        assert!(!fresh.sessions.lock().await.contains_key(sid));
        assert!(dispatch_rpc(load(&cwd), &fresh, Some(tx.clone()))
            .await
            .unwrap()["result"]
            .is_object());
        let after_rewind: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|v| v["params"]["update"].clone())
            .collect();
        assert_eq!(after_rewind, frames);
        {
            let entry = fresh.sessions.lock().await.get(sid).unwrap().clone();
            assert!(!entry.1.load(Ordering::Relaxed));
            let mut eng = entry.0.lock().await;
            assert_eq!(eng.endpoint.model_id, "offline");
            assert_eq!(eng.total_turns, 2);
            assert_eq!(eng.messages[3].tool_call_id.as_deref(), Some("call1"));
            assert_eq!(eng.tool_runtime.approval_mode, ApprovalMode::AlwaysAsk);
            assert!(!eng.tool_runtime.workspace_trusted);
            assert!(!eng
                .tool_runtime
                .permission_rules
                .iter()
                .any(|r| r.id.starts_with("acp-allow-")));
            assert!(!entry
                .2
                .lock()
                .unwrap()
                .rules
                .iter()
                .any(|r| r.id.starts_with("acp-allow-")));
            let journal = entry.2.lock().unwrap().journal.clone().unwrap();
            journal.lock().unwrap().begin_turn().unwrap();
            eng.messages
                .push(HarnessMessage::user("test-endpoint-credential", 3));
            assert!(journal
                .lock()
                .unwrap()
                .save(&eng, 5, &[], &[&eng.endpoint.api_key])
                .is_err());
            assert!(journal.lock().unwrap().begin_turn().is_err());
        }
        drop(fresh);
        assert!(dispatch_rpc(load(&cwd), &make_state(), Some(tx))
            .await
            .unwrap()["error"]
            .is_object());
        assert!(!cwd.join("history").exists());
        fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn acp_http_status_auth_and_websocket_initialize_work() {
        assert_eq!(
            compute_ws_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            let _ = serve_acp_http_listener(listener, Some("test-secret".into()), None, None, None)
                .await;
        });

        // 1. GET /status -> 200 OK without auth
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).await.unwrap();
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "{resp}");
        assert!(resp.contains("omnia-sota-v4.4"), "{resp}");

        // 2. POST /acp without secret -> 401
        let mut s2 = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s2.write_all(
            b"POST /acp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )
        .await
        .unwrap();
        let mut resp2 = String::new();
        s2.read_to_string(&mut resp2).await.unwrap();
        assert!(resp2.starts_with("HTTP/1.1 401 Unauthorized"), "{resp2}");

        // 3. POST /acp with X-Secret-Key initialize -> 200
        let body =
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#;
        let mut s3 = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req3 = format!(
            "POST /acp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Secret-Key: test-secret\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        s3.write_all(req3.as_bytes()).await.unwrap();
        s3.write_all(body).await.unwrap();
        let mut resp3 = String::new();
        s3.read_to_string(&mut resp3).await.unwrap();
        assert!(resp3.starts_with("HTTP/1.1 200 OK"), "{resp3}");
        assert!(resp3.contains("\"name\":\"omnia\""), "{resp3}");
        let initialized: Value =
            serde_json::from_str(resp3.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            initialized["result"]["agentCapabilities"]["mcpCapabilities"],
            json!({"http": true, "sse": true})
        );
        assert_eq!(
            initialized["result"]["agentCapabilities"]["loadSession"],
            false
        );
        let mut sse = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let headers = req3.replace(
            "Connection: close",
            "Accept: text/event-stream\r\nConnection: close",
        );
        sse.write_all(headers.as_bytes()).await.unwrap();
        sse.write_all(body).await.unwrap();
        let mut streamed = String::new();
        sse.read_to_string(&mut streamed).await.unwrap();
        let (headers, data) = streamed.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains("Content-Type: text/event-stream"));
        let event: Value =
            serde_json::from_str(data.trim().strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(
            event["result"]["agentCapabilities"]["loadSession"],
            crate::acp_history::default_root().is_some()
        );
        // Valid mcpServers entry on session/new is accepted; malformed entry fails -32602.
        let bad_body = json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"mcpServers":[{"name":"bad-only"}]}}).to_string();
        let mut rejected = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let headers = format!("POST /acp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Secret-Key: test-secret\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bad_body.len());
        rejected.write_all(headers.as_bytes()).await.unwrap();
        rejected.write_all(bad_body.as_bytes()).await.unwrap();
        let mut reply = String::new();
        rejected.read_to_string(&mut reply).await.unwrap();
        let response: Value =
            serde_json::from_str(reply.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["id"], 2);

        let good_body = json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"mcpServers":[{"name":"example","type":"http","url":"http://127.0.0.1:1"}]}}).to_string();
        let mut accepted = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let good_headers = format!("POST /acp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Secret-Key: test-secret\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", good_body.len());
        accepted.write_all(good_headers.as_bytes()).await.unwrap();
        accepted.write_all(good_body.as_bytes()).await.unwrap();
        let mut good_reply = String::new();
        accepted.read_to_string(&mut good_reply).await.unwrap();
        let good_resp: Value =
            serde_json::from_str(good_reply.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert!(good_resp["result"]["sessionId"].as_str().is_some(), "{good_resp}");

        // 4. GET /acp WebSocket upgrade + initialize frame
        let mut s4 = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s4.write_all(
            b"GET /acp?token=test-secret HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        )
        .await
        .unwrap();
        let mut ws_reader = BufReader::new(s4);
        let mut hdr = String::new();
        loop {
            let mut line = String::new();
            ws_reader.read_line(&mut line).await.unwrap();
            hdr.push_str(&line);
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }
        assert!(hdr.starts_with("HTTP/1.1 101 Switching Protocols"), "{hdr}");
        assert!(hdr.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "{hdr}");

        // Send masked client text frame
        let frame_bytes =
            br#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":1}}"#;
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let mut out = vec![0x81u8, 0x80 | (frame_bytes.len() as u8)];
        out.extend_from_slice(&mask);
        for (i, b) in frame_bytes.iter().enumerate() {
            out.push(b ^ mask[i % 4]);
        }
        ws_reader.get_mut().write_all(&out).await.unwrap();
        let (op, reply) = read_ws_frame(&mut ws_reader).await.unwrap().unwrap();
        assert_eq!(op, 0x1);
        let reply_str = String::from_utf8_lossy(&reply);
        assert!(reply_str.contains("\"id\":7"), "{reply_str}");
        assert!(reply_str.contains("\"name\":\"omnia\""), "{reply_str}");
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(
            reply["result"]["agentCapabilities"]["loadSession"],
            crate::acp_history::default_root().is_some()
        );

        srv.abort();
    }
}
