//! HTTP/SSE & WebSocket ACP (Agent Client Protocol) server for Omnia.
//!
//! Compatible with Goose Desktop's **External Backend (ACP)** (`GET /status`,
//! `POST /acp` JSON-RPC / SSE, `GET /acp` WebSocket upgrade, `X-Secret-Key` /
//! `?token=` authentication) while delegating every turn to `NativeSuperEngine`.

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

use crate::permissions::{ApprovalMode, PermissionsEngine};
use crate::{
    default_omnia_data_dir, redact_secrets, resolve_model_endpoint, validate_workspace_dir,
    AgentStore, EpochMaskingState, HarnessEventSink, HarnessStreamEvent, ModelEditAffinity,
    NativeSuperEngine, PluginRegistry, WorkspaceGraphIndex,
};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type SessionEntry = (Arc<AsyncMutex<NativeSuperEngine>>, Arc<AtomicBool>);

#[derive(Clone)]
struct AcpHttpState {
    sessions: Arc<AsyncMutex<HashMap<String, SessionEntry>>>,
    store: Option<AgentStore>,
    secret_key: Option<String>,
    default_model: Option<String>,
    default_base_url: Option<String>,
    default_api_key: Option<String>,
    env_auto_approve: bool,
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
    let store = AgentStore::open(&default_omnia_data_dir())
        .or_else(|_| AgentStore::open_in_memory())
        .ok();
    let env_auto_approve = std::env::var("OMNIA_ACP_AUTO_APPROVE")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
    let state = AcpHttpState {
        sessions: Arc::new(AsyncMutex::new(HashMap::new())),
        store,
        secret_key: secret_key.filter(|s| !s.trim().is_empty()),
        default_model,
        default_base_url,
        default_api_key,
        env_auto_approve,
    };

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
    let parts: Vec<&str> = request_line.trim_end_matches(['\r', '\n']).split_whitespace().collect();
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
        write_http_response(&mut s, 404, "Not Found", "application/json", br#"{"error":"not found"}"#).await?;
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

    let mut s = reader.into_inner();
    write_http_response(
        &mut s,
        405,
        "Method Not Allowed",
        "application/json",
        br#"{"error":"method not allowed"}"#,
    )
    .await?;
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
                if write_ws_frame(&mut stream_write, 0x1, text.as_bytes()).await.is_err() {
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

async fn dispatch_rpc(
    req: Value,
    state: &AcpHttpState,
    notify_tx: Option<mpsc::UnboundedSender<Value>>,
) -> Option<Value> {
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
                        "promptCapabilities": { "embeddedContext": true }
                    }
                }
            })
        }),
        "session/new" => {
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
            let opt_in_auto = state.env_auto_approve
                || params
                    .get("autoApprove")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
            let approval_mode = if opt_in_auto {
                ApprovalMode::Yolo
            } else {
                ApprovalMode::AlwaysAsk
            };
            let workspace_trusted = opt_in_auto
                || params
                    .get("workspaceTrusted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
            let model = params
                .get("model")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| state.default_model.clone())
                .unwrap_or_else(|| "htmustc-claude/claude-sonnet-5-5".into());
            let sid = format!("acp-{}", uuid::Uuid::new_v4());
            let cancel_flag = Arc::new(AtomicBool::new(false));
            match resolve_model_endpoint(
                &model,
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
                Ok(eng) => {
                    let wire_dialect = eng.active_wire_dialect().to_string();
                    let resolved_model =
                        format!("{}/{}", eng.endpoint.provider_id, eng.endpoint.model_id);
                    state
                        .sessions
                        .lock()
                        .await
                        .insert(sid.clone(), (Arc::new(AsyncMutex::new(eng)), cancel_flag));
                    id.map(|req_id| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "result": {
                                "sessionId": sid,
                                "backend": "omnia-sota-v4.4",
                                "model": resolved_model,
                                "wireDialect": wire_dialect
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
            let prompt_text: String = params
                .get("prompt")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let entry = state.sessions.lock().await.get(&sid).cloned();
            let Some((eng_arc, cancel_arc)) = entry else {
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
            match eng.run_prompt(&prompt_text, 50, 300, h_sink).await {
                Ok(sum) => id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "stopReason": if sum.status == "completed" { "end_turn" } else { "max_turn_requests" }
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
                if let Some((_, cancel_flag)) = state.sessions.lock().await.get(sid) {
                    cancel_flag.store(true, Ordering::Relaxed);
                }
            }
            id.map(|req_id| json!({ "jsonrpc": "2.0", "id": req_id, "result": {} }))
        }
        "session/set_model" => {
            let sid = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let model = params.get("model").and_then(|v| v.as_str()).unwrap_or("").trim();
            let thinking = params
                .get("thinkingLevel")
                .and_then(|v| v.as_str())
                .map(String::from);
            let entry = state.sessions.lock().await.get(sid).cloned();
            let Some((eng_arc, _)) = entry else {
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
            let sid = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let target_turn = params.get("turn").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let entry = state.sessions.lock().await.get(sid).cloned();
            let Some((eng_arc, _)) = entry else {
                return id.map(|req_id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32602, "message": format!("unknown sessionId: {sid}") }
                    })
                });
            };
            let mut eng = eng_arc.lock().await;
            match eng.rewind_to_turn(target_turn) {
                Ok(restored) => id.map(|req_id| {
                    json!({ "jsonrpc": "2.0", "id": req_id, "result": { "restored": restored } })
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

fn is_authorized(secret_key: &Option<String>, headers: &HashMap<String, String>, query: &str) -> bool {
    let Some(ref expected) = secret_key else {
        return true;
    };
    if let Some(h) = headers.get("x-secret-key") {
        if constant_time_eq(h.as_bytes(), expected.as_bytes()) {
            return true;
        }
    }
    if let Some(auth) = headers.get("authorization") {
        if let Some(tok) = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acp_http_status_auth_and_websocket_initialize_work() {
        assert_eq!(
            compute_ws_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            let _ = serve_acp_http_listener(
                listener,
                Some("test-secret".into()),
                None,
                None,
                None,
            )
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
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#;
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
        let frame_bytes = br#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":1}}"#;
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

        srv.abort();
    }
}
