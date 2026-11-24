//! Real MCP `2026-07-28` Client (with `2025-11-25` handshake-era fallback):
//! - Zero-flash hidden Win32 stdio transport + `JobObject` termination
//! - Streamable HTTP + SSE transport (`Mcp-Session-Id`, progress/list_changed streams)
//! - OAuth 2.1 + PKCE S256 + RFC 8707 Resource Indicators + CIMD metadata discovery
//! - Async Tasks (`tasks/get`, `tasks/cancel`)
//! - Form & URL Elicitation (`elicitation/create` + `input_required` MRTR retry)
//! - KV-Invariant Dynamic Tool Search (`<1k` prefix tokens for 200+ tools)
//! - MCP Apps `_meta` / `ui://` payload passthrough

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader as StdBufReader, Write as StdWrite};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
pub const MCP_LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";

const DEFAULT_MCP_TIMEOUT_MS: u64 = 30_000;
const KV_SEARCH_DEFAULT_MAX_TOKENS: usize = 900;

/// Transport configuration for one MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthSettings {
    #[serde(default)]
    pub client_id: Option<String>,
    /// HTTPS URL pointing to a Client ID Metadata Document (CIMD).
    #[serde(default)]
    pub client_metadata_url: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    /// RFC 8707 canonical resource URI. Defaults to server URL when omitted.
    #[serde(default)]
    pub resource: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    #[serde(flatten)]
    pub transport: McpTransportConfig,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub oauth: Option<McpOAuthSettings>,
}

const fn default_true() -> bool {
    true
}

const fn default_timeout_ms() -> u64 {
    DEFAULT_MCP_TIMEOUT_MS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolSpec {
    pub server_name: String,
    pub original_name: String,
    /// Canonical sanitized tool name: `mcp__<server>_<tool>`.
    pub qualified_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_schema_obj")]
    pub input_schema: Value,
    #[serde(default)]
    pub meta: Option<Value>,
}

fn default_schema_obj() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": true })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAppPayload {
    pub resource_uri: Option<String>,
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub raw_meta: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResult {
    pub is_error: bool,
    pub content: Vec<Value>,
    pub text_summary: String,
    pub task_id: Option<String>,
    pub app_payload: Option<McpAppPayload>,
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTaskStatus {
    pub task_id: String,
    pub status: String,
    pub status_message: Option<String>,
    pub raw: Value,
}

/// Form or URL Elicitation request surfaced by an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum McpElicitationRequest {
    Form {
        server_name: String,
        message: String,
        requested_schema: Value,
    },
    Url {
        server_name: String,
        message: String,
        url: String,
        elicitation_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpElicitationAction {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpElicitationResponse {
    pub action: McpElicitationAction,
    #[serde(default)]
    pub content: Option<Value>,
}

pub type ElicitationCallback = Arc<
    dyn Fn(McpElicitationRequest) -> futures_util::future::BoxFuture<'static, McpElicitationResponse>
        + Send
        + Sync,
>;

/// OAuth 2.1 PKCE challenge pair + state + RFC 8707 resource metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkceAuthPair {
    pub code_verifier: String,
    pub code_challenge: String,
    pub challenge_method: String,
    pub state: String,
}

/// Generates cryptographic PKCE (`S256`) verifier/challenge + anti-CSRF state.
#[must_use]
pub fn generate_pkce_pair() -> PkceAuthPair {
    let verifier_bytes = random_32_bytes();
    let state_bytes = random_32_bytes();
    let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let state = URL_SAFE_NO_PAD.encode(&state_bytes[..16]);
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(digest);
    PkceAuthPair {
        code_verifier,
        code_challenge,
        challenge_method: "S256".into(),
        state,
    }
}

fn random_32_bytes() -> [u8; 32] {
    let mut seed = [0u8; 48];
    seed[0..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[16..32].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[32..48].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let digest = Sha256::digest(seed);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Discovered OAuth 2.1 endpoints + RFC 9728 / RFC 8414 / CIMD validation metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub client_id_metadata_document_supported: bool,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub resource: Option<String>,
}

/// Builds a RFC 9728 protected-resource metadata URL from an MCP endpoint URL.
pub fn rfc9728_protected_resource_url(server_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(server_url).context("parse server_url")?;
    let origin = parsed.origin().ascii_serialization();
    let path = parsed.path().trim_end_matches('/');
    if path.is_empty() || path == "/" {
        Ok(format!("{origin}/.well-known/oauth-protected-resource"))
    } else {
        Ok(format!("{origin}/.well-known/oauth-protected-resource{path}"))
    }
}

/// Validates and parses an HTTPS CIMD (Client ID Metadata Document) URL.
pub fn validate_cimd_client_id(url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(url.trim()).context("parse CIMD client_id URL")?;
    if parsed.scheme() != "https" {
        bail!("CIMD client_id must use https:// scheme (got `{}`)", parsed.scheme());
    }
    if parsed.host_str().is_none() || parsed.path().is_empty() || parsed.path() == "/" {
        bail!("CIMD client_id must include host and metadata document path");
    }
    if parsed.username() != "" || parsed.password().is_some() {
        bail!("CIMD client_id must not contain embedded userinfo");
    }
    Ok(parsed.to_string())
}

/// Builds an OAuth 2.1 + PKCE + RFC 8707 + CIMD authorization URL without logging secrets.
pub fn build_oauth_authorize_url(
    meta: &OAuthMetadata,
    client_id: &str,
    redirect_uri: &str,
    pkce: &PkceAuthPair,
    scope: Option<&str>,
    resource: Option<&str>,
) -> Result<String> {
    let mut url =
        reqwest::Url::parse(&meta.authorization_endpoint).context("parse authorization_endpoint")?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("response_type", "code");
        qp.append_pair("client_id", client_id);
        qp.append_pair("redirect_uri", redirect_uri);
        qp.append_pair("state", &pkce.state);
        qp.append_pair("code_challenge", &pkce.code_challenge);
        qp.append_pair("code_challenge_method", &pkce.challenge_method);
        if let Some(sc) = scope.filter(|s| !s.trim().is_empty()) {
            qp.append_pair("scope", sc.trim());
        }
        if let Some(res) = resource
            .or(meta.resource.as_deref())
            .filter(|s| !s.trim().is_empty())
        {
            qp.append_pair("resource", res.trim());
        }
    }
    Ok(url.to_string())
}

/// Discovers OAuth 2.1 metadata for an HTTP/SSE MCP server via RFC 9728 -> RFC 8414 + CIMD check.
pub async fn discover_oauth_metadata(
    http: &reqwest::Client,
    server_url: &str,
) -> Result<Option<OAuthMetadata>> {
    let prm_url = rfc9728_protected_resource_url(server_url)?;
    let mut auth_server: Option<String> = None;
    let mut prm_scopes: Vec<String> = Vec::new();
    let mut prm_resource: Option<String> = None;

    if let Ok(resp) = http.get(&prm_url).send().await {
        if resp.status().is_success() {
            if let Ok(prm) = resp.json::<Value>().await {
                prm_resource = prm
                    .get("resource")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(arr) = prm.get("authorization_servers").and_then(Value::as_array) {
                    auth_server = arr.first().and_then(Value::as_str).map(str::to_owned);
                }
                if let Some(arr) = prm.get("scopes_supported").and_then(Value::as_array) {
                    prm_scopes = arr
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                }
            }
        }
    }

    let issuer_base = match auth_server {
        Some(a) => a,
        None => {
            let parsed = reqwest::Url::parse(server_url)?;
            parsed.origin().ascii_serialization()
        }
    };
    let issuer_base_trimmed = issuer_base.trim_end_matches('/');
    let candidates = [
        format!("{issuer_base_trimmed}/.well-known/oauth-authorization-server"),
        format!("{issuer_base_trimmed}/.well-known/openid-configuration"),
    ];

    for meta_url in candidates {
        let Ok(resp) = http.get(&meta_url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.json::<Value>().await else {
            continue;
        };
        let Some(issuer) = body.get("issuer").and_then(Value::as_str) else {
            continue;
        };
        // RFC 8414 §3.3 strict issuer match check (origin equality)
        if let (Ok(u_expected), Ok(u_got)) =
            (reqwest::Url::parse(&issuer_base), reqwest::Url::parse(issuer))
        {
            if u_expected.origin() != u_got.origin() {
                bail!(
                    "OAuth issuer mismatch: expected origin `{}`, got `{}`",
                    u_expected.origin().ascii_serialization(),
                    u_got.origin().ascii_serialization()
                );
            }
        }
        let Some(auth_ep) = body.get("authorization_endpoint").and_then(Value::as_str) else {
            continue;
        };
        let Some(tok_ep) = body.get("token_endpoint").and_then(Value::as_str) else {
            continue;
        };
        let cimd_ok = body
            .get("client_id_metadata_document_supported")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let scopes = if !prm_scopes.is_empty() {
            prm_scopes
        } else {
            body.get("scopes_supported")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        return Ok(Some(OAuthMetadata {
            issuer: issuer.to_owned(),
            authorization_endpoint: auth_ep.to_owned(),
            token_endpoint: tok_ep.to_owned(),
            registration_endpoint: body
                .get("registration_endpoint")
                .and_then(Value::as_str)
                .map(str::to_owned),
            client_id_metadata_document_supported: cimd_ok,
            scopes_supported: scopes,
            resource: prm_resource.or_else(|| Some(server_url.to_owned())),
        }));
    }

    Ok(None)
}

/// Canonicalizes `server_name` and `tool_name` into `mcp__<server>_<tool>` matching OMP convention.
#[must_use]
pub fn canonical_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let s = sanitize_ident(server_name);
    let mut t = sanitize_ident(tool_name);
    let redundant_prefix = format!("{s}_");
    if let Some(stripped) = t.strip_prefix(&redundant_prefix) {
        if !stripped.is_empty() {
            t = stripped.to_owned();
        }
    }
    let full = format!("mcp__{s}_{t}");
    if full.len() <= 64 {
        return full;
    }
    let hash = Sha256::digest(full.as_bytes());
    let short_hex = omnia_core::hex_encode(&hash[..4]);
    format!("{}_{}", &full[..55], short_hex)
}

/// Resolves canonical and Claude-Code doubled (`mcp__<server>__<tool>`) candidates cleanly.
#[must_use]
pub fn mcp_tool_lookup_candidates(raw_name: &str) -> Vec<String> {
    let mut out = vec![raw_name.to_owned()];
    if let Some(tail) = raw_name.strip_prefix("mcp__") {
        for (idx, _) in tail.match_indices("__") {
            let srv = &tail[..idx];
            let tool = &tail[idx + 2..];
            if !srv.is_empty() && !tool.is_empty() {
                let c = canonical_mcp_tool_name(srv, tool);
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn sanitize_ident(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_us = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_us = false;
        } else if !prev_us && !out.is_empty() {
            out.push('_');
            prev_us = true;
        }
    }
    out.trim_end_matches('_').to_owned()
}

/// KV-Invariant compact tool search index (<1k prefix tokens even for 200+ registered tools).
#[derive(Debug, Default, Clone)]
pub struct McpToolSearchIndex {
    tools: BTreeMap<String, McpToolSpec>,
    catalog_epoch: u64,
}

impl McpToolSearchIndex {
    pub fn upsert_server_tools(&mut self, server_name: &str, specs: Vec<McpToolSpec>) {
        self.tools.retain(|_, v| v.server_name != server_name);
        for spec in specs {
            self.tools.insert(spec.qualified_name.clone(), spec);
        }
        self.catalog_epoch += 1;
    }

    pub fn remove_server(&mut self, server_name: &str) {
        self.tools.retain(|_, v| v.server_name != server_name);
        self.catalog_epoch += 1;
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.catalog_epoch
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    #[must_use]
    pub fn resolve(&self, name: &str) -> Option<&McpToolSpec> {
        for cand in mcp_tool_lookup_candidates(name) {
            if let Some(hit) = self.tools.get(&cand) {
                return Some(hit);
            }
        }
        None
    }

    /// Searches tools deterministically within a strict token budget (`< 1,000` tokens).
    #[must_use]
    pub fn search(&self, query: &str, limit: usize, max_tokens: usize) -> Vec<Value> {
        let budget = if max_tokens == 0 {
            KV_SEARCH_DEFAULT_MAX_TOKENS
        } else {
            max_tokens.min(KV_SEARCH_DEFAULT_MAX_TOKENS)
        };
        let q_terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect();

        let mut scored: Vec<(i32, &McpToolSpec)> = self
            .tools
            .values()
            .filter_map(|spec| {
                if q_terms.is_empty() {
                    return Some((1, spec));
                }
                let hay_name = spec.qualified_name.to_ascii_lowercase();
                let hay_orig = spec.original_name.to_ascii_lowercase();
                let hay_desc = spec.description.to_ascii_lowercase();
                let mut score = 0i32;
                for term in &q_terms {
                    if hay_orig == *term || hay_name == *term {
                        score += 50;
                    } else if hay_name.contains(term) || hay_orig.contains(term) {
                        score += 20;
                    } else if hay_desc.contains(term) {
                        score += 8;
                    }
                }
                (score > 0).then_some((score, spec))
            })
            .collect();

        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.qualified_name.cmp(&b.1.qualified_name))
        });

        let mut used_chars = 0usize;
        let max_chars = budget * 4;
        let mut results = Vec::new();
        for (_, spec) in scored.into_iter().take(limit.max(1).min(25)) {
            let short_desc: String = spec.description.chars().take(160).collect();
            let prop_names: Vec<String> = spec
                .input_schema
                .get("properties")
                .and_then(Value::as_object)
                .map(|m| m.keys().take(12).cloned().collect())
                .unwrap_or_default();
            let item = json!({
                "name": spec.qualified_name,
                "server": spec.server_name,
                "tool": spec.original_name,
                "description": short_desc,
                "parameters": prop_names,
            });
            let est = item.to_string().len();
            if !results.is_empty() && used_chars + est > max_chars {
                break;
            }
            used_chars += est;
            results.push(item);
        }
        results
    }
}

/// Summary exposed to Studio & agent diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub name: String,
    pub transport_kind: String,
    pub protocol_version: String,
    pub connected: bool,
    pub tool_count: usize,
    pub catalog_epoch: u64,
    pub session_id: Option<String>,
    pub last_error: Option<String>,
}

enum ConnectedTransport {
    Stdio(Arc<StdioMcpTransport>),
    Http(Arc<HttpMcpTransport>),
}

struct ConnectedServer {
    config: McpServerConfig,
    protocol_version: String,
    capabilities: Value,
    instructions: Option<String>,
    transport: ConnectedTransport,
    tool_count: usize,
}

enum StdioChildGuard {
    #[cfg(windows)]
    Hidden(omnia_workspace_ops::win32_window::HiddenStdioProcess),
    #[cfg(not(windows))]
    Std(std::process::Child),
}

impl StdioChildGuard {
    fn kill_tree(&mut self) {
        match self {
            #[cfg(windows)]
            Self::Hidden(proc_guard) => proc_guard.kill(),
            #[cfg(not(windows))]
            Self::Std(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct StdioMcpTransport {
    writer_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>>,
    next_id: AtomicI64,
    child: Mutex<Option<StdioChildGuard>>,
}

impl StdioMcpTransport {
    async fn connect(
        server_name: &str,
        command: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
        cwd: Option<&str>,
        workspace_root: &PathBuf,
        list_changed_notify: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Arc<Self>> {
        let work_dir = cwd.map(PathBuf::from).unwrap_or_else(|| workspace_root.clone());

        #[cfg(windows)]
        let (mut guard, stdin_file, stdout_file) = {
            let mut proc_h = omnia_workspace_ops::win32_window::spawn_hidden_suspended_stdio(
                command, args, &work_dir, env,
            )
            .map_err(|e| anyhow::anyhow!("spawn MCP stdio server `{server_name}` (`{command}`): {e}"))?;
            let in_f = proc_h.take_stdin().context("MCP stdio missing stdin pipe")?;
            let out_f = proc_h.take_stdout().context("MCP stdio missing stdout pipe")?;
            (StdioChildGuard::Hidden(proc_h), Box::new(in_f) as Box<dyn StdWrite + Send>, Box::new(out_f) as Box<dyn std::io::Read + Send>)
        };

        #[cfg(not(windows))]
        let (mut guard, stdin_file, stdout_file) = {
            let mut cmd = std::process::Command::new(command);
            cmd.args(args)
                .current_dir(&work_dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            for (k, v) in env {
                cmd.env(k, v);
            }
            let mut child = cmd
                .spawn()
                .with_context(|| format!("spawn MCP stdio server `{server_name}` (`{command}`)"))?;
            let in_f = child.stdin.take().context("MCP stdio missing stdin")?;
            let out_f = child.stdout.take().context("MCP stdio missing stdout")?;
            (StdioChildGuard::Std(child), Box::new(in_f) as Box<dyn StdWrite + Send>, Box::new(out_f) as Box<dyn std::io::Read + Send>)
        };

        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<String>();
        let writer_tx_for_reader = writer_tx.clone();
        std::thread::Builder::new()
            .name(format!("mcp-stdio-in-{server_name}"))
            .spawn(move || {
                let mut w = stdin_file;
                while let Some(line) = writer_rx.blocking_recv() {
                    if w.write_all(line.as_bytes()).is_err()
                        || w.write_all(b"\n").is_err()
                        || w.flush().is_err()
                    {
                        break;
                    }
                }
            })
            .context("spawn MCP stdio writer thread")?;

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending);
        let srv_owned = server_name.to_owned();
        let root_uri = path_to_file_uri(workspace_root);

        let reader_res = std::thread::Builder::new()
            .name(format!("mcp-stdio-out-{server_name}"))
            .spawn(move || {
                let reader = StdBufReader::new(stdout_file);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || !trimmed.starts_with('{') {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    if let Some(id_val) = msg.get("id") {
                        if msg.get("method").is_some() {
                            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                            let reply = match method {
                                "roots/list" => json!({
                                    "jsonrpc": "2.0",
                                    "id": id_val,
                                    "result": { "roots": [{ "uri": root_uri, "name": "workspace" }] }
                                }),
                                "ping" => json!({ "jsonrpc": "2.0", "id": id_val, "result": {} }),
                                _ => json!({
                                    "jsonrpc": "2.0",
                                    "id": id_val,
                                    "error": { "code": -32601, "message": "method not implemented" }
                                }),
                            };
                            if let Ok(line_out) = serde_json::to_string(&reply) {
                                let _ = writer_tx_for_reader.send(line_out);
                            }
                            continue;
                        }
                        if let Some(id) = id_val.as_i64() {
                            let sender = reader_pending
                                .lock()
                                .ok()
                                .and_then(|mut map| map.remove(&id));
                            if let Some(tx) = sender {
                                if let Some(err) = msg.get("error") {
                                    let code =
                                        err.get("code").and_then(Value::as_i64).unwrap_or(-32000);
                                    let message = err
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("MCP JSON-RPC error");
                                    let _ = tx
                                        .send(Err(anyhow::anyhow!("MCP error {code}: {message}")));
                                } else {
                                    let _ = tx.send(Ok(
                                        msg.get("result").cloned().unwrap_or(Value::Null),
                                    ));
                                }
                            }
                        }
                    } else if let Some(method) = msg.get("method").and_then(Value::as_str) {
                        if method == "notifications/tools/list_changed" {
                            list_changed_notify(&srv_owned);
                        }
                    }
                }
            });

        if let Err(e) = reader_res {
            guard.kill_tree();
            return Err(anyhow::anyhow!("spawn MCP stdio reader thread: {e}"));
        }

        Ok(Arc::new(Self {
            writer_tx: Mutex::new(Some(writer_tx)),
            pending,
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(guard)),
        }))
    }

    async fn request(&self, method: &str, params: Option<Value>, timeout_ms: u64) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": with_mcp_meta(params),
        });
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP pending lock poisoned"))?
            .insert(id, tx);

        let line = serde_json::to_string(&req)?;
        let sent = self
            .writer_tx
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|tx_w| tx_w.send(line).is_ok()))
            .unwrap_or(false);
        if !sent {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&id);
            }
            bail!("MCP stdio writer channel closed");
        }

        let wait_ms = timeout_ms.max(1_000);
        let res = tokio::time::timeout(Duration::from_millis(wait_ms), rx)
            .await
            .map_err(|_| {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                anyhow::anyhow!("MCP stdio `{method}` timed out after {wait_ms}ms")
            })?;
        res.context("MCP stdio transport closed")?
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or_else(|| json!({})),
        });
        let line = serde_json::to_string(&msg)?;
        let sent = self
            .writer_tx
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|tx_w| tx_w.send(line).is_ok()))
            .unwrap_or(false);
        if !sent {
            bail!("MCP stdio writer channel closed");
        }
        Ok(())
    }

    async fn close(&self) {
        if let Ok(mut w) = self.writer_tx.lock() {
            w.take();
        }
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut guard) = g.take() {
                guard.kill_tree();
            }
        }
    }
}

struct HttpMcpTransport {
    url: String,
    headers: BTreeMap<String, String>,
    http: reqwest::Client,
    session_id: Arc<RwLock<Option<String>>>,
    bearer_token: Arc<RwLock<Option<String>>>,
    next_id: AtomicI64,
}

impl HttpMcpTransport {
    fn new(url: String, headers: BTreeMap<String, String>, http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self {
            url,
            headers,
            http,
            session_id: Arc::new(RwLock::new(None)),
            bearer_token: Arc::new(RwLock::new(None)),
            next_id: AtomicI64::new(1),
        })
    }

    fn set_bearer_token(&self, token: String) {
        if let Ok(mut g) = self.bearer_token.write() {
            *g = Some(token);
        }
    }

    async fn request(&self, method: &str, params: Option<Value>, timeout_ms: u64) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": with_mcp_meta(params),
        });

        let mut hdrs = HeaderMap::new();
        hdrs.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        hdrs.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        hdrs.insert(
            HeaderName::from_static("mcp-protocol-version"),
            HeaderValue::from_static(MCP_PROTOCOL_VERSION),
        );
        if let Some(sid) = self.session_id.read().ok().and_then(|g| g.clone()) {
            if let Ok(hv) = HeaderValue::from_str(&sid) {
                hdrs.insert(HeaderName::from_static("mcp-session-id"), hv);
            }
        }
        if let Some(tok) = self.bearer_token.read().ok().and_then(|g| g.clone()) {
            if let Ok(hv) = HeaderValue::from_str(&format!("Bearer {tok}")) {
                hdrs.insert(AUTHORIZATION, hv);
            }
        }
        for (k, v) in &self.headers {
            if let (Ok(hn), Ok(hv)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                hdrs.insert(hn, hv);
            }
        }

        let resp = self
            .http
            .post(&self.url)
            .headers(hdrs)
            .timeout(Duration::from_millis(timeout_ms.max(1_000)))
            .json(&payload)
            .send()
            .await
            .with_context(|| format!("HTTP POST MCP `{method}` to {}", self.url))?;

        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            if let Ok(mut g) = self.session_id.write() {
                *g = Some(sid.to_owned());
            }
        }

        let status = resp.status();
        let ct = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body_text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            bail!("MCP HTTP {status} for `{method}`: {body_text}");
        }

        if ct.contains("text/event-stream") {
            return parse_sse_json_rpc_result(&body_text, id);
        }

        let val: Value =
            serde_json::from_str(&body_text).context("parse MCP HTTP JSON-RPC response")?;
        extract_jsonrpc_result(val)
    }
}

fn parse_sse_json_rpc_result(sse_body: &str, expected_id: i64) -> Result<Value> {
    let mut last_result: Option<Value> = None;
    let mut data_buf = String::new();
    for line in sse_body.lines() {
        let clean = line.trim_end_matches('\r');
        if clean.is_empty() {
            if !data_buf.is_empty() {
                if let Ok(msg) = serde_json::from_str::<Value>(data_buf.trim()) {
                    if msg.get("id").and_then(Value::as_i64) == Some(expected_id)
                        || msg.get("result").is_some()
                        || msg.get("error").is_some()
                    {
                        last_result = Some(extract_jsonrpc_result(msg)?);
                    }
                }
                data_buf.clear();
            }
            continue;
        }
        if let Some(d) = clean.strip_prefix("data:") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            data_buf.push_str(d.trim_start());
        }
    }
    if !data_buf.is_empty() {
        if let Ok(msg) = serde_json::from_str::<Value>(data_buf.trim()) {
            last_result = Some(extract_jsonrpc_result(msg)?);
        }
    }
    last_result.context("SSE stream closed without matching JSON-RPC result")
}

fn extract_jsonrpc_result(msg: Value) -> Result<Value> {
    if let Some(err) = msg.get("error") {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(-32000);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP error");
        bail!("MCP error {code}: {message}");
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

fn with_mcp_meta(params: Option<Value>) -> Value {
    let mut obj = match params {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let mut meta = obj
        .remove("_meta")
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    meta.insert(
        "io.modelcontextprotocol/protocolVersion".into(),
        json!(MCP_PROTOCOL_VERSION),
    );
    meta.insert(
        "io.modelcontextprotocol/clientCapabilities".into(),
        json!({
            "roots": { "listChanged": false },
            "elicitation": { "form": {}, "url": {} },
            "tasks": { "list": {}, "cancel": {}, "requests": { "tools": { "call": {} } } },
        }),
    );
    meta.insert(
        "io.modelcontextprotocol/clientInfo".into(),
        json!({ "name": "omnia-agent", "version": "5.0.0" }),
    );
    obj.insert("_meta".into(), Value::Object(meta));
    Value::Object(obj)
}

fn path_to_file_uri(path: &std::path::Path) -> String {
    let norm = path.to_string_lossy().replace('\\', "/");
    if norm.starts_with('/') {
        format!("file://{norm}")
    } else {
        format!("file:///{norm}")
    }
}

/// Process-wide / session-scoped MCP 2026-07-28 Manager.
#[derive(Clone)]
pub struct McpManager {
    workspace_root: PathBuf,
    http: reqwest::Client,
    servers: Arc<RwLock<HashMap<String, Arc<ConnectedServer>>>>,
    tool_index: Arc<RwLock<McpToolSearchIndex>>,
    elicitation_handler: Arc<RwLock<Option<ElicitationCallback>>>,
    epoch_counter: Arc<AtomicU64>,
}

impl std::fmt::Debug for McpManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let srv_count = self.servers.read().map(|g| g.len()).unwrap_or(0);
        let tool_count = self.tool_index.read().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("McpManager")
            .field("workspace_root", &self.workspace_root)
            .field("servers", &srv_count)
            .field("tools", &tool_count)
            .finish()
    }
}

impl McpManager {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent("omnia-agent-mcp/2026-07-28")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            workspace_root: workspace_root.into(),
            http,
            servers: Arc::new(RwLock::new(HashMap::new())),
            tool_index: Arc::new(RwLock::new(McpToolSearchIndex::default())),
            elicitation_handler: Arc::new(RwLock::new(None)),
            epoch_counter: Arc::new(AtomicU64::new(1)),
        }
    }

    #[must_use]
    pub fn search_epoch(&self) -> u64 {
        self.epoch_counter.load(Ordering::Relaxed)
    }

    pub fn set_elicitation_handler(&self, cb: ElicitationCallback) {
        if let Ok(mut g) = self.elicitation_handler.write() {
            *g = Some(cb);
        }
    }

    pub async fn connect_server(&self, cfg: McpServerConfig) -> Result<McpServerStatus> {
        if !cfg.enabled {
            bail!("MCP server `{}` is disabled", cfg.name);
        }
        let srv_name = cfg.name.clone();
        let epoch_ref = Arc::clone(&self.epoch_counter);
        let notify_cb: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |_| {
            epoch_ref.fetch_add(1, Ordering::Relaxed);
        });

        let transport = match &cfg.transport {
            McpTransportConfig::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                let t = StdioMcpTransport::connect(
                    &srv_name,
                    command,
                    args,
                    env,
                    cwd.as_deref(),
                    &self.workspace_root,
                    notify_cb,
                )
                .await?;
                ConnectedTransport::Stdio(t)
            }
            McpTransportConfig::Http { url, headers } | McpTransportConfig::Sse { url, headers } => {
                let t = HttpMcpTransport::new(url.clone(), headers.clone(), self.http.clone());
                if let Some(ref oauth) = cfg.oauth {
                    if let Some(ref cimd) = oauth.client_metadata_url {
                        let _ = validate_cimd_client_id(cimd)?;
                    }
                    if let Some(tok) = Self::resolve_stored_token(&srv_name, url) {
                        t.set_bearer_token(tok);
                    }
                }
                ConnectedTransport::Http(t)
            }
        };

        // 2026-07-28 `server/discover` first, falling back to 2025-11-25 `initialize`.
        let (protocol_version, capabilities, instructions) =
            match self.rpc_call(&transport, "server/discover", None, cfg.timeout_ms).await {
                Ok(disc) => (
                    MCP_PROTOCOL_VERSION.to_owned(),
                    disc.get("capabilities").cloned().unwrap_or_else(|| json!({})),
                    disc.get("instructions").and_then(Value::as_str).map(str::to_owned),
                ),
                Err(_) => {
                    let init_res = self
                        .rpc_call(
                            &transport,
                            "initialize",
                            Some(json!({
                                "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
                                "capabilities": {
                                    "roots": { "listChanged": false },
                                    "elicitation": { "form": {}, "url": {} }
                                },
                                "clientInfo": { "name": "omnia-agent", "version": "5.0.0" }
                            })),
                            cfg.timeout_ms,
                        )
                        .await?;
                    if let ConnectedTransport::Stdio(ref st) = transport {
                        let _ = st.notify("notifications/initialized", Some(json!({}))).await;
                    }
                    (
                        init_res
                            .get("protocolVersion")
                            .and_then(Value::as_str)
                            .unwrap_or(MCP_LEGACY_PROTOCOL_VERSION)
                            .to_owned(),
                        init_res.get("capabilities").cloned().unwrap_or_else(|| json!({})),
                        init_res.get("instructions").and_then(Value::as_str).map(str::to_owned),
                    )
                }
            };

        let listed = self
            .rpc_call(&transport, "tools/list", Some(json!({})), cfg.timeout_ms)
            .await
            .unwrap_or_else(|_| json!({ "tools": [] }));
        let mut tool_specs = Vec::new();
        if let Some(arr) = listed.get("tools").and_then(Value::as_array) {
            for t in arr {
                let Some(orig_name) = t.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let qualified_name = canonical_mcp_tool_name(&srv_name, orig_name);
                tool_specs.push(McpToolSpec {
                    server_name: srv_name.clone(),
                    original_name: orig_name.to_owned(),
                    qualified_name,
                    description: t
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(default_schema_obj),
                    meta: t.get("_meta").cloned(),
                });
            }
        }
        let tool_count = tool_specs.len();

        let epoch = if let Ok(mut idx) = self.tool_index.write() {
            idx.upsert_server_tools(&srv_name, tool_specs);
            idx.epoch()
        } else {
            0
        };

        let conn = Arc::new(ConnectedServer {
            config: cfg.clone(),
            protocol_version: protocol_version.clone(),
            capabilities,
            instructions,
            transport,
            tool_count,
        });
        if let Ok(mut srvs) = self.servers.write() {
            srvs.insert(srv_name.clone(), Arc::clone(&conn));
        }

        let transport_kind = match cfg.transport {
            McpTransportConfig::Stdio { .. } => "stdio",
            McpTransportConfig::Http { .. } => "http",
            McpTransportConfig::Sse { .. } => "sse",
        }
        .to_owned();

        Ok(McpServerStatus {
            name: srv_name,
            transport_kind,
            protocol_version,
            connected: true,
            tool_count,
            catalog_epoch: epoch,
            session_id: match &conn.transport {
                ConnectedTransport::Http(h) => h.session_id.read().ok().and_then(|g| g.clone()),
                ConnectedTransport::Stdio(_) => None,
            },
            last_error: None,
        })
    }

    pub async fn refresh_tools(&self, server_name: &str) -> Result<usize> {
        let srv = self.get_server(server_name)?;
        let listed = self
            .rpc_call(
                &srv.transport,
                "tools/list",
                Some(json!({})),
                srv.config.timeout_ms,
            )
            .await?;
        let mut specs = Vec::new();
        if let Some(arr) = listed.get("tools").and_then(Value::as_array) {
            for t in arr {
                let Some(orig_name) = t.get("name").and_then(Value::as_str) else {
                    continue;
                };
                specs.push(McpToolSpec {
                    server_name: server_name.to_owned(),
                    original_name: orig_name.to_owned(),
                    qualified_name: canonical_mcp_tool_name(server_name, orig_name),
                    description: t
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(default_schema_obj),
                    meta: t.get("_meta").cloned(),
                });
            }
        }
        let count = specs.len();
        if let Ok(mut idx) = self.tool_index.write() {
            idx.upsert_server_tools(server_name, specs);
        }
        Ok(count)
    }

    /// Searches indexed MCP tools strictly within `<1k` token budget without mutating Prefix-0.
    #[must_use]
    pub fn search_tools(&self, query: &str, limit: usize) -> Vec<Value> {
        self.tool_index
            .read()
            .map(|idx| idx.search(query, limit, KV_SEARCH_DEFAULT_MAX_TOKENS))
            .unwrap_or_default()
    }

    #[must_use]
    pub fn resolve_tool(&self, qualified_or_alias: &str) -> Option<McpToolSpec> {
        self.tool_index
            .read()
            .ok()
            .and_then(|idx| idx.resolve(qualified_or_alias).cloned())
    }

    /// Calls an MCP tool by qualified name (or alias) or explicit `(server, tool)`.
    pub async fn call_tool(
        &self,
        qualified_or_server: &str,
        explicit_tool: Option<&str>,
        arguments: Value,
    ) -> Result<McpToolCallResult> {
        let (server_name, tool_name) = if let Some(t) = explicit_tool {
            (qualified_or_server.to_owned(), t.to_owned())
        } else if let Some(spec) = self.resolve_tool(qualified_or_server) {
            (spec.server_name, spec.original_name)
        } else {
            bail!("unknown MCP tool `{qualified_or_server}` (discover_tools first)");
        };

        let srv = self.get_server(&server_name)?;
        let mut params = json!({
            "name": tool_name,
            "arguments": arguments,
        });
        let mut raw = self
            .rpc_call(
                &srv.transport,
                "tools/call",
                Some(params.clone()),
                srv.config.timeout_ms,
            )
            .await?;

        // 2026-07-28 MRTR `input_required` elicitation retry loop (up to 3 rounds).
        for _ in 0..3 {
            if raw.get("resultType").and_then(Value::as_str) != Some("input_required") {
                break;
            }
            let responses = self.answer_input_requests(&server_name, &raw).await?;
            let mut obj = params.as_object().cloned().unwrap_or_default();
            obj.insert("inputResponses".into(), responses);
            if let Some(st) = raw.get("requestState") {
                obj.insert("requestState".into(), st.clone());
            }
            params = Value::Object(obj);
            raw = self
                .rpc_call(
                    &srv.transport,
                    "tools/call",
                    Some(params.clone()),
                    srv.config.timeout_ms,
                )
                .await?;
        }

        Ok(parse_tool_call_result(raw))
    }

    pub async fn get_task(&self, server_name: &str, task_id: &str) -> Result<McpTaskStatus> {
        let srv = self.get_server(server_name)?;
        let raw = self
            .rpc_call(
                &srv.transport,
                "tasks/get",
                Some(json!({ "taskId": task_id })),
                srv.config.timeout_ms,
            )
            .await?;
        Ok(McpTaskStatus {
            task_id: task_id.to_owned(),
            status: raw
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            status_message: raw
                .get("statusMessage")
                .and_then(Value::as_str)
                .map(str::to_owned),
            raw,
        })
    }

    pub async fn cancel_task(&self, server_name: &str, task_id: &str) -> Result<McpTaskStatus> {
        let srv = self.get_server(server_name)?;
        let raw = self
            .rpc_call(
                &srv.transport,
                "tasks/cancel",
                Some(json!({ "taskId": task_id })),
                srv.config.timeout_ms,
            )
            .await?;
        Ok(McpTaskStatus {
            task_id: task_id.to_owned(),
            status: raw
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("cancelled")
                .to_owned(),
            status_message: raw
                .get("statusMessage")
                .and_then(Value::as_str)
                .map(str::to_owned),
            raw,
        })
    }

    pub async fn disconnect_server(&self, server_name: &str) -> bool {
        let removed = self
            .servers
            .write()
            .ok()
            .and_then(|mut m| m.remove(server_name));
        if let Ok(mut idx) = self.tool_index.write() {
            idx.remove_server(server_name);
        }
        if let Some(srv) = removed {
            if let ConnectedTransport::Stdio(ref st) = srv.transport {
                st.close().await;
            }
            true
        } else {
            false
        }
    }

    #[must_use]
    pub fn list_servers(&self) -> Vec<McpServerStatus> {
        let epoch = self.tool_index.read().map(|i| i.epoch()).unwrap_or(0);
        let mut out = Vec::new();
        if let Ok(srvs) = self.servers.read() {
            for srv in srvs.values() {
                let transport_kind = match srv.config.transport {
                    McpTransportConfig::Stdio { .. } => "stdio",
                    McpTransportConfig::Http { .. } => "http",
                    McpTransportConfig::Sse { .. } => "sse",
                }
                .to_owned();
                out.push(McpServerStatus {
                    name: srv.config.name.clone(),
                    transport_kind,
                    protocol_version: srv.protocol_version.clone(),
                    connected: true,
                    tool_count: srv.tool_count,
                    catalog_epoch: epoch,
                    session_id: match &srv.transport {
                        ConnectedTransport::Http(h) => {
                            h.session_id.read().ok().and_then(|g| g.clone())
                        }
                        ConnectedTransport::Stdio(_) => None,
                    },
                    last_error: None,
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    fn resolve_stored_token(server_name: &str, url: &str) -> Option<String> {
        // Consult Win32 Credential Manager (`omnia:mcp:<server>` or `omnia:mcp_oauth:<url>`) if populated.
        let targets = [
            format!("omnia:mcp:{server_name}"),
            format!("omnia:mcp_oauth:{url}"),
        ];
        for target in targets {
            if let Ok(Some(secret)) = omnia_core::credentials::CredentialStore::resolve_secret(&target)
            {
                if let Ok(v) = secret.expose_for_wire() {
                    if !v.is_empty() {
                        return Some(v.to_owned());
                    }
                }
            }
        }
        None
    }

    async fn answer_input_requests(&self, server_name: &str, raw: &Value) -> Result<Value> {
        let mut replies = Map::new();
        let Some(reqs) = raw.get("inputRequests").and_then(Value::as_object) else {
            return Ok(Value::Object(replies));
        };
        let handler = self.elicitation_handler.read().ok().and_then(|g| g.clone());
        for (req_id, req_body) in reqs {
            let method = req_body.get("method").and_then(Value::as_str).unwrap_or("");
            let params = req_body.get("params").cloned().unwrap_or_else(|| json!({}));
            if method == "elicitation/create" {
                let mode = params.get("mode").and_then(Value::as_str).unwrap_or("form");
                let msg = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("MCP server requested additional input")
                    .to_owned();
                let elic = if mode == "url" {
                    McpElicitationRequest::Url {
                        server_name: server_name.to_owned(),
                        message: msg,
                        url: params
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        elicitation_id: params
                            .get("elicitationId")
                            .and_then(Value::as_str)
                            .unwrap_or(req_id)
                            .to_owned(),
                    }
                } else {
                    McpElicitationRequest::Form {
                        server_name: server_name.to_owned(),
                        message: msg,
                        requested_schema: params
                            .get("requestedSchema")
                            .cloned()
                            .unwrap_or_else(default_schema_obj),
                    }
                };
                let resp = if let Some(ref cb) = handler {
                    cb(elic).await
                } else {
                    McpElicitationResponse {
                        action: McpElicitationAction::Decline,
                        content: None,
                    }
                };
                replies.insert(req_id.clone(), serde_json::to_value(resp)?);
            } else {
                replies.insert(
                    req_id.clone(),
                    json!({ "error": { "code": -32601, "message": "unsupported server ask" } }),
                );
            }
        }
        Ok(Value::Object(replies))
    }

    async fn rpc_call(
        &self,
        transport: &ConnectedTransport,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
    ) -> Result<Value> {
        match transport {
            ConnectedTransport::Stdio(s) => s.request(method, params, timeout_ms).await,
            ConnectedTransport::Http(h) => h.request(method, params, timeout_ms).await,
        }
    }

    fn get_server(&self, server_name: &str) -> Result<Arc<ConnectedServer>> {
        self.servers
            .read()
            .map_err(|_| anyhow::anyhow!("MCP servers lock poisoned"))?
            .get(server_name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("MCP server `{server_name}` is not connected"))
    }
}

fn parse_tool_call_result(raw: Value) -> McpToolCallResult {
    let is_error = raw.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let content = raw
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let task_id = raw
        .get("task")
        .and_then(|t| t.get("taskId"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let mut texts = Vec::new();
    let mut app_payload: Option<McpAppPayload> = None;

    for item in &content {
        if let Some(txt) = item.get("text").and_then(Value::as_str) {
            texts.push(txt.to_owned());
        }
        if item.get("type").and_then(Value::as_str) == Some("resource") {
            if let Some(res) = item.get("resource") {
                let mime = res.get("mimeType").and_then(Value::as_str).map(str::to_owned);
                let uri = res.get("uri").and_then(Value::as_str).map(str::to_owned);
                if mime
                    .as_deref()
                    .is_some_and(|m| m.contains("mcp-app") || m.contains("text/html"))
                    || uri.as_deref().is_some_and(|u| u.starts_with("ui://"))
                {
                    app_payload = Some(McpAppPayload {
                        resource_uri: uri,
                        mime_type: mime,
                        text: res.get("text").and_then(Value::as_str).map(str::to_owned),
                        raw_meta: raw.get("_meta").cloned().unwrap_or(Value::Null),
                    });
                }
            }
        }
    }

    if app_payload.is_none() {
        if let Some(ui_meta) = raw
            .get("_meta")
            .and_then(|m| m.get("ui").or_else(|| m.get("ui/resourceUri")))
        {
            app_payload = Some(McpAppPayload {
                resource_uri: ui_meta
                    .get("resourceUri")
                    .and_then(Value::as_str)
                    .or_else(|| ui_meta.as_str())
                    .map(str::to_owned),
                mime_type: Some("text/html;profile=mcp-app".into()),
                text: None,
                raw_meta: raw.get("_meta").cloned().unwrap_or(Value::Null),
            });
        }
    }

    McpToolCallResult {
        is_error,
        content,
        text_summary: texts.join("\n"),
        task_id,
        app_payload,
        raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc8707_cimd_and_kv_search_work_cleanly() {
        let pkce = generate_pkce_pair();
        assert_eq!(pkce.challenge_method, "S256");
        assert!(pkce.code_verifier.len() >= 43);
        assert!(validate_cimd_client_id("https://app.example.com/oauth/client.json").is_ok());
        assert!(validate_cimd_client_id("http://app.example.com/oauth/client.json").is_err());

        let meta = OAuthMetadata {
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: None,
            client_id_metadata_document_supported: true,
            scopes_supported: vec!["mcp:tools".into()],
            resource: Some("https://mcp.example.com/v1".into()),
        };
        let auth_url = build_oauth_authorize_url(
            &meta,
            "https://client.example.com/cimd.json",
            "http://127.0.0.1:3900/callback",
            &pkce,
            Some("mcp:tools"),
            None,
        )
        .expect("auth url");
        assert!(auth_url.contains("resource=https%3A%2F%2Fmcp.example.com%2Fv1"));
        assert!(auth_url.contains("code_challenge_method=S256"));

        // Verify 250+ tools stay strictly <1k tokens in KV-invariant search results.
        let mut idx = McpToolSearchIndex::default();
        let specs: Vec<McpToolSpec> = (0..250)
            .map(|i| McpToolSpec {
                server_name: "github".into(),
                original_name: format!("issue_action_{i}"),
                qualified_name: canonical_mcp_tool_name("github", &format!("issue_action_{i}")),
                description: format!("Perform GitHub issue action #{i} with pagination and labels"),
                input_schema: json!({
                    "type": "object",
                    "properties": { "owner": { "type": "string" }, "repo": { "type": "string" } }
                }),
                meta: None,
            })
            .collect();
        idx.upsert_server_tools("github", specs);
        assert_eq!(idx.len(), 250);
        let hits = idx.search("issue action 42", 10, 900);
        assert!(!hits.is_empty());
        let total_chars = serde_json::to_string(&hits).expect("json").len();
        assert!(total_chars < 3800, "expected <1k token budget, got {total_chars} chars");
        assert!(idx.resolve("mcp__github__issue_action_42").is_some());
    }

    #[tokio::test]
    async fn http_mcp_client_supports_2026_tools_tasks_elicitation_and_apps_meta() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let hdr_end;
                    loop {
                        let n = match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        raw.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            hdr_end = pos + 4;
                            break;
                        }
                    }
                    let hdr_str = String::from_utf8_lossy(&raw[..hdr_end]).to_ascii_lowercase();
                    let cl = hdr_str
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while raw.len() < hdr_end + cl {
                        let n = match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        raw.extend_from_slice(&tmp[..n]);
                    }
                    let body_val: Value =
                        serde_json::from_slice(&raw[hdr_end..hdr_end + cl]).unwrap_or(Value::Null);
                    let id = body_val.get("id").cloned().unwrap_or(Value::Null);
                    let method = body_val
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let params = body_val.get("params").cloned().unwrap_or_else(|| json!({}));

                    let mut use_sse = false;
                    let reply_opt: Option<Value> = match method {
                        "initialize" => Some(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": MCP_PROTOCOL_VERSION,
                                "capabilities": { "tools": { "listChanged": true } },
                                "serverInfo": { "name": "mock-mcp", "version": "1.0" },
                                "instructions": "Mock MCP 2026-07-28 server"
                            }
                        })),
                        "notifications/initialized" => None,
                        "tools/list" => {
                            use_sse = true;
                            Some(json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [{
                                        "name": "open_dashboard",
                                        "description": "Open interactive metrics app",
                                        "inputSchema": { "type": "object", "properties": { "env": { "type": "string" } } }
                                    }]
                                }
                            }))
                        }
                        "tools/call" => {
                            if params.get("inputResponses").is_none() {
                                Some(json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "resultType": "input_required",
                                        "requestState": { "round": 1 },
                                        "inputRequests": {
                                            "req_1": {
                                                "method": "elicitation/create",
                                                "params": {
                                                    "mode": "form",
                                                    "message": "Confirm environment",
                                                    "requestedSchema": { "type": "object" }
                                                }
                                            }
                                        }
                                    }
                                }))
                            } else {
                                Some(json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "isError": false,
                                        "task": { "taskId": "task-99" },
                                        "content": [{ "type": "text", "text": "rendered prod dashboard" }],
                                        "_meta": { "ui": { "resourceUri": "ui://dashboard/panel" } }
                                    }
                                }))
                            }
                        }
                        "tasks/get" => Some(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "status": "completed", "statusMessage": "done" }
                        })),
                        "tasks/cancel" => Some(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "status": "cancelled" }
                        })),
                        _ => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
                    };

                    if let Some(reply) = reply_opt {
                        let serialized = serde_json::to_string(&reply).unwrap();
                        if use_sse {
                            let sse_body = format!("event: message\ndata: {serialized}\n\n");
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: sess-2026\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                sse_body.len(),
                                sse_body
                            );
                            let _ = sock.write_all(resp.as_bytes()).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-2026\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                serialized.len(),
                                serialized
                            );
                            let _ = sock.write_all(resp.as_bytes()).await;
                        }
                    } else {
                        let _ = sock
                            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                    }
                });
            }
        });

        let mgr = McpManager::new(std::env::temp_dir());
        mgr.set_elicitation_handler(Arc::new(|req| {
            Box::pin(async move {
                match req {
                    McpElicitationRequest::Form { .. } => McpElicitationResponse {
                        action: McpElicitationAction::Accept,
                        content: Some(json!({ "confirm": true })),
                    },
                    McpElicitationRequest::Url { .. } => McpElicitationResponse {
                        action: McpElicitationAction::Accept,
                        content: None,
                    },
                }
            })
        }));

        let status = mgr
            .connect_server(McpServerConfig {
                name: "demo".into(),
                transport: McpTransportConfig::Http {
                    url: format!("http://127.0.0.1:{port}/mcp"),
                    headers: BTreeMap::new(),
                },
                enabled: true,
                timeout_ms: 5_000,
                oauth: None,
            })
            .await
            .expect("connect http+sse mcp");
        assert!(status.connected);
        assert_eq!(status.protocol_version, MCP_PROTOCOL_VERSION);
        assert_eq!(status.tool_count, 1);

        let hits = mgr.search_tools("dashboard", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["name"], "mcp__demo_open_dashboard");

        let call_res = mgr
            .call_tool("mcp__demo__open_dashboard", None, json!({ "env": "prod" }))
            .await
            .expect("elicitation + mcp app call");
        assert!(!call_res.is_error);
        assert_eq!(call_res.text_summary, "rendered prod dashboard");
        assert_eq!(call_res.task_id.as_deref(), Some("task-99"));
        assert_eq!(
            call_res
                .app_payload
                .as_ref()
                .and_then(|p| p.resource_uri.as_deref()),
            Some("ui://dashboard/panel")
        );

        let t_get = mgr.get_task("demo", "task-99").await.expect("tasks/get");
        assert_eq!(t_get.status, "completed");
        let t_cancel = mgr
            .cancel_task("demo", "task-99")
            .await
            .expect("tasks/cancel");
        assert_eq!(t_cancel.status, "cancelled");
        assert!(mgr.disconnect_server("demo").await);
        srv.abort();
    }

    #[tokio::test]
    async fn stdio_mcp_client_spawns_hidden_suspended_job_and_handles_list_changed() {
        let Ok(py_bin) = which::which("python") else {
            return;
        };
        let py_srv = r#"
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    msg = json.loads(line)
    m = msg.get("method", "")
    i = msg.get("id")
    if m == "initialize":
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":i,"result":{"protocolVersion":"2026-07-28","capabilities":{"tools":{"listChanged":True}},"serverInfo":{"name":"py-mcp","version":"1.0"}}}) + "\n")
        sys.stdout.flush()
    elif m == "notifications/initialized":
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}) + "\n")
        sys.stdout.flush()
    elif m == "tools/list":
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":i,"result":{"tools":[{"name":"echo","description":"Echo args","inputSchema":{"type":"object"}}]}}) + "\n")
        sys.stdout.flush()
    elif m == "tools/call":
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":i,"result":{"content":[{"type":"text","text":"stdio_ok"}]}}) + "\n")
        sys.stdout.flush()
"#;
        let mgr = McpManager::new(std::env::temp_dir());
        let epoch_before = mgr.search_epoch();
        let st = mgr
            .connect_server(McpServerConfig {
                name: "pydemo".into(),
                transport: McpTransportConfig::Stdio {
                    command: py_bin.to_string_lossy().into_owned(),
                    args: vec!["-B".into(), "-u".into(), "-c".into(), py_srv.into()],
                    env: BTreeMap::new(),
                    cwd: None,
                },
                enabled: true,
                timeout_ms: 8_000,
                oauth: None,
            })
            .await
            .expect("connect stdio mcp");
        assert!(st.connected && st.tool_count == 1);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            mgr.search_epoch() > epoch_before,
            "notifications/tools/list_changed must bump epoch"
        );
        let call = mgr
            .call_tool("mcp__pydemo__echo", None, json!({ "hello": 1 }))
            .await
            .expect("stdio tools/call");
        assert_eq!(call.text_summary, "stdio_ok");
        assert!(mgr.disconnect_server("pydemo").await);
    }
}
