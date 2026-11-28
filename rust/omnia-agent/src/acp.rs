//! Google Antigravity / Zed Standard ACP (Agent Client Protocol) JSON-RPC 2.0 Client.
//!
//! Implements line-delimited JSON-RPC 2.0 over stdio inside Win32 Job Objects (`0` orphans):
//! - `initialize` (protocolVersion: 1)
//! - `session/new` (cwd, mcpServers)
//! - `session/prompt` (content blocks)
//! - `session/cancel`
//! - Incoming `session/update` streaming notifications (`agent_message_chunk`, `agent_thought_chunk`,
//!   `tool_call`, `tool_call_update`, `plan`)
//! - Bidirectional `session/request_permission` handling governed by `crate::permissions::PermissionsEngine`
//!
//! Supports external harnesses: `goose acp`, `agy acp`, `codex-acp`, `claude-acp` (plus custom).

use crate::path_guard::sanitize_windows_path;
use crate::permissions::{ApprovalMode, PermissionDecision, PermissionRule, PermissionsEngine};
use crate::supervisor::{process_tree_rss_bytes, spawn_supervised_command, ProcessSupervisor};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum HarnessBackendId {
    #[serde(rename = "omni-super")]
    #[default]
    OmniSuper,
    #[serde(rename = "omp-rpc")]
    OmpRpc,
    #[serde(rename = "goose-acp")]
    GooseAcp,
    #[serde(rename = "agy-acp")]
    AgyAcp,
    #[serde(rename = "codex-acp")]
    CodexAcp,
    #[serde(rename = "claude-acp")]
    ClaudeAcp,
}

impl HarnessBackendId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OmniSuper => "omni-super",
            Self::OmpRpc => "omp-rpc",
            Self::GooseAcp => "goose-acp",
            Self::AgyAcp => "agy-acp",
            Self::CodexAcp => "codex-acp",
            Self::ClaudeAcp => "claude-acp",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "omni-super" | "omni" | "super" => Some(Self::OmniSuper),
            "omp-rpc" | "omp" => Some(Self::OmpRpc),
            "goose-acp" | "goose" => Some(Self::GooseAcp),
            "agy-acp" | "agy" | "antigravity" => Some(Self::AgyAcp),
            "codex-acp" | "codex" => Some(Self::CodexAcp),
            "claude-acp" | "claude" | "claude-code" => Some(Self::ClaudeAcp),
            _ => None,
        }
    }

    pub fn is_acp(self) -> bool {
        matches!(
            self,
            Self::GooseAcp | Self::AgyAcp | Self::CodexAcp | Self::ClaudeAcp
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessBackendInfo {
    pub id: HarnessBackendId,
    pub name: String,
    pub description: String,
    pub transport: String, // "native_rust" | "omp_rpc_v2" | "acp_stdio"
    pub available: bool,
    pub is_default: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub estimated_rss_mb: u32,
    pub estimated_startup_ms: u32,
    pub warnings: Vec<String>,
}

/// Detect all 6 supported harness backends and their live availability on this machine.
pub fn detect_all_backends(omp_override: Option<&Path>) -> Vec<HarnessBackendInfo> {
    let omp_exe = omp_override
        .filter(|p| p.is_file())
        .map(Path::to_path_buf)
        .or_else(|| which::which("omp").ok());
    let goose_exe = find_goose_binary();
    let agy_exe = which::which("agy").ok();
    let codex_exe = which::which("codex-acp")
        .ok()
        .or_else(|| which::which("codex").ok());
    let claude_exe = which::which("claude-acp")
        .ok()
        .or_else(|| which::which("claude-code-acp").ok())
        .or_else(|| which::which("claude").ok());

    vec![
        HarnessBackendInfo {
            id: HarnessBackendId::OmniSuper,
            name: "Omnia Agent (SOTA v4 Native Rust)".into(),
            description: "Built-in native Rust super-harness: 4-Tier Prefix-0 KV-Cache, Token-Progress SSE Watchdog, SAP JSON Repair, Multi-Dialect Wire Router, Tree-sitter PPR + Lazy LSP, Adaptive Hashline v2 + BlockDiff + apply_patch, Context-Scaled Lakeview + Anchored Summary, and PASTE-lite Speculative Parallelism.".into(),
            transport: "native_rust".into(),
            available: true,
            is_default: true,
            executable_path: std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            capabilities: vec![
                "prefix_cache_guard".into(),
                "token_progress_sse_watchdog".into(),
                "sap_json_repair".into(),
                "multi_dialect_wire".into(),
                "merkle_index".into(),
                "graph_locator".into(),
                "lazy_lsp".into(),
                "adaptive_edit_router".into(),
                "codex_apply_patch".into(),
                "context_scaled_lakeview".into(),
                "paste_lite_speculative".into(),
                "anti_termination_lag".into(),
                "atomic_rewind".into(),
            ],
            estimated_rss_mb: 28,
            estimated_startup_ms: 15,
            warnings: Vec::new(),
        },
        HarnessBackendInfo {
            id: HarnessBackendId::OmpRpc,
            name: "OMP v19.1.0 RPC".into(),
            description: "External Bun-based Oh-My-Pi `--mode rpc-ui` protocol v2 backend.".into(),
            transport: "omp_rpc_v2".into(),
            available: omp_exe.is_some(),
            is_default: false,
            executable_path: omp_exe.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: omp_exe.as_ref().map(|_| "rpc-v2".into()),
            capabilities: vec![
                "rpc_v2".into(),
                "subagents".into(),
                "session_tree".into(),
            ],
            estimated_rss_mb: 380,
            estimated_startup_ms: 4200,
            warnings: if omp_exe.is_none() {
                vec!["`omp` CLI not found in PATH.".into()]
            } else {
                Vec::new()
            },
        },
        HarnessBackendInfo {
            id: HarnessBackendId::GooseAcp,
            name: "Goose ACP".into(),
            description: "Block Goose CLI driven over standard ACP JSON-RPC 2.0 stdio (`goose acp --with-builtin developer`).".into(),
            transport: "acp_stdio".into(),
            available: goose_exe.is_some(),
            is_default: false,
            executable_path: goose_exe.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: goose_exe.as_ref().map(|_| "acp".into()),
            capabilities: vec!["acp_stdio".into(), "developer_tools".into()],
            estimated_rss_mb: 135,
            estimated_startup_ms: 320,
            warnings: if goose_exe.is_none() {
                vec!["`goose` CLI not found in PATH or WinGet packages.".into()]
            } else {
                Vec::new()
            },
        },
        HarnessBackendInfo {
            id: HarnessBackendId::AgyAcp,
            name: "Antigravity (agy) ACP".into(),
            description: "Google Antigravity CLI driven over standard ACP JSON-RPC 2.0 stdio (`agy acp`).".into(),
            transport: "acp_stdio".into(),
            available: agy_exe.is_some(),
            is_default: false,
            executable_path: agy_exe.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: agy_exe.as_ref().map(|_| "acp".into()),
            capabilities: vec!["acp_stdio".into(), "skills".into()],
            estimated_rss_mb: 160,
            estimated_startup_ms: 450,
            warnings: if agy_exe.is_none() {
                vec!["`agy` CLI not found in PATH.".into()]
            } else {
                Vec::new()
            },
        },
        HarnessBackendInfo {
            id: HarnessBackendId::CodexAcp,
            name: "Codex ACP".into(),
            description: "OpenAI Codex ACP adapter over standard JSON-RPC 2.0 stdio (`codex-acp`).".into(),
            transport: "acp_stdio".into(),
            available: codex_exe.is_some(),
            is_default: false,
            executable_path: codex_exe.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: codex_exe.as_ref().map(|_| "acp".into()),
            capabilities: vec!["acp_stdio".into(), "apply_patch".into()],
            estimated_rss_mb: 140,
            estimated_startup_ms: 350,
            warnings: if codex_exe.is_none() {
                vec!["`codex-acp` / `codex` not found in PATH.".into()]
            } else {
                Vec::new()
            },
        },
        HarnessBackendInfo {
            id: HarnessBackendId::ClaudeAcp,
            name: "Claude Code ACP".into(),
            description: "Anthropic Claude Code ACP adapter over standard JSON-RPC 2.0 stdio (`claude-acp`).".into(),
            transport: "acp_stdio".into(),
            available: claude_exe.is_some(),
            is_default: false,
            executable_path: claude_exe.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: claude_exe.as_ref().map(|_| "acp".into()),
            capabilities: vec!["acp_stdio".into(), "edit_guard".into()],
            estimated_rss_mb: 210,
            estimated_startup_ms: 600,
            warnings: if claude_exe.is_none() {
                vec!["`claude-acp` / `claude` not found in PATH.".into()]
            } else {
                Vec::new()
            },
        },
    ]
}

pub fn find_goose_binary() -> Option<PathBuf> {
    if let Ok(p) = which::which("goose") {
        return Some(p);
    }
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        let winget = local
            .join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("AgenticAIFoundation.gooseCLI_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("goose-package")
            .join("goose.exe");
        if winget.is_file() {
            return Some(winget);
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct AcpLaunchConfig {
    pub backend: HarnessBackendId,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub approval_mode: ApprovalMode,
    pub workspace_trusted: bool,
    pub permission_rules: Vec<PermissionRule>,
    pub mcp_servers: Vec<Value>,
}

impl AcpLaunchConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        backend: HarnessBackendId,
        explicit_bin: Option<&Path>,
        cwd: &Path,
        model: Option<&str>,
        api_base: Option<&str>,
        api_key: Option<&str>,
        approval_mode: ApprovalMode,
        workspace_trusted: bool,
        permission_rules: Vec<PermissionRule>,
    ) -> Result<Self> {
        let (program, args) = match backend {
            HarnessBackendId::GooseAcp => {
                let p = explicit_bin
                    .map(PathBuf::from)
                    .or_else(find_goose_binary)
                    .ok_or_else(|| anyhow::anyhow!("goose binary not found"))?;
                (
                    p,
                    vec!["acp".into(), "--with-builtin".into(), "developer".into()],
                )
            }
            HarnessBackendId::AgyAcp => {
                let p = explicit_bin
                    .map(PathBuf::from)
                    .or_else(|| which::which("agy").ok())
                    .ok_or_else(|| anyhow::anyhow!("agy binary not found"))?;
                (p, vec!["acp".into()])
            }
            HarnessBackendId::CodexAcp => {
                let p = explicit_bin
                    .map(PathBuf::from)
                    .or_else(|| which::which("codex-acp").ok())
                    .or_else(|| which::which("codex").ok())
                    .ok_or_else(|| anyhow::anyhow!("codex-acp binary not found"))?;
                let is_adapter = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.to_ascii_lowercase().contains("acp"));
                (
                    p,
                    if is_adapter {
                        vec![]
                    } else {
                        vec!["acp".into()]
                    },
                )
            }
            HarnessBackendId::ClaudeAcp => {
                let p = explicit_bin
                    .map(PathBuf::from)
                    .or_else(|| which::which("claude-acp").ok())
                    .or_else(|| which::which("claude-code-acp").ok())
                    .or_else(|| which::which("claude").ok())
                    .ok_or_else(|| anyhow::anyhow!("claude-acp binary not found"))?;
                let is_adapter = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.to_ascii_lowercase().contains("acp"));
                (
                    p,
                    if is_adapter {
                        vec![]
                    } else {
                        vec!["acp".into()]
                    },
                )
            }
            _ => bail!("backend {:?} is not an ACP stdio backend", backend),
        };

        let mut env = BTreeMap::new();
        env.insert("PYTHONUTF8".into(), "1".into());
        env.insert("PYTHONIOENCODING".into(), "utf-8".into());
        if backend == HarnessBackendId::GooseAcp {
            env.insert("GOOSE_PROVIDER".into(), "openai".into());
            env.insert("GOOSE_DISABLE_TELEMETRY".into(), "1".into());
            if let Some(m) = model {
                let model_id = m.split_once('/').map(|(_, id)| id).unwrap_or(m);
                env.insert("GOOSE_MODEL".into(), model_id.to_string());
            }
            if let Some(base) = api_base {
                let trimmed = base.trim_end_matches('/');
                let host = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
                env.insert("OPENAI_HOST".into(), host.to_string());
                env.insert("OPENAI_BASE_PATH".into(), "v1/chat/completions".into());
            }
            if let Some(key) = api_key {
                env.insert("OPENAI_API_KEY".into(), key.to_string());
            }
        }

        let mcp_servers = std::env::var("OMNIA_ACP_MCP_SERVERS")
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();

        Ok(Self {
            backend,
            program,
            args,
            cwd: sanitize_windows_path(cwd),
            env,
            approval_mode,
            workspace_trusted,
            permission_rules,
            mcp_servers,
        })
    }
}

#[derive(Debug, Clone)]
pub enum AcpEvent {
    TextDelta(String),
    ThinkingDelta(String),
    ToolCallStart {
        id: String,
        name: String,
    },
    ToolCallEnd {
        id: String,
        name: String,
        is_error: bool,
    },
    RawUpdate(Value),
    ProcessExit {
        exit_code: Option<i32>,
        stderr_tail: String,
    },
}

pub type AcpEventSink = Arc<dyn Fn(AcpEvent) + Send + Sync>;

/// Live ACP JSON-RPC 2.0 client session supervising an external ACP agent process.
pub struct AcpClient {
    pub pid: u32,
    pub acp_session_id: String,
    pub agent_info: Value,
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    next_id: AtomicU64,
    supervisor: Arc<std::sync::Mutex<ProcessSupervisor>>,
    alive: Arc<AtomicBool>,
}

impl AcpClient {
    pub async fn spawn_and_initialize(cfg: AcpLaunchConfig, sink: AcpEventSink) -> Result<Self> {
        let mut cmd = Command::new(&cfg.program);
        for a in &cfg.args {
            cmd.arg(a);
        }
        cmd.current_dir(&cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }

        let (mut child, supervisor) = spawn_supervised_command(&mut cmd)
            .with_context(|| format!("failed to spawn ACP agent {}", cfg.program.display()))?;
        let pid = child.id();
        let supervisor = Arc::new(std::sync::Mutex::new(supervisor));

        let mut child_stdin = child.stdin.take().context("missing ACP stdin")?;
        let child_stdout = child.stdout.take().context("missing ACP stdout")?;
        let child_stderr = child.stderr.take().context("missing ACP stderr")?;

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        std::thread::spawn(move || {
            while let Some(line) = stdin_rx.blocking_recv() {
                if child_stdin.write_all(line.as_bytes()).is_err()
                    || child_stdin.write_all(b"\n").is_err()
                    || child_stdin.flush().is_err()
                {
                    break;
                }
            }
        });

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_bg = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let reader = BufReader::new(child_stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut g = stderr_bg.lock().unwrap();
                g.push_str(&line);
                g.push('\n');
                if g.len() > 8192 {
                    let keep = g.ceil_char_boundary(g.len() - 4096);
                    *g = g[keep..].to_string();
                }
            }
        });

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        let pending_bg = Arc::clone(&pending);
        let stdin_bg = stdin_tx.clone();
        let sink_bg = Arc::clone(&sink);
        let alive_bg = Arc::clone(&alive);
        let stderr_exit = Arc::clone(&stderr_tail);
        let rules_bg = cfg.permission_rules.clone();
        let approval_bg = cfg.approval_mode;
        let trusted_bg = cfg.workspace_trusted;

        std::thread::spawn(move || {
            let reader = BufReader::new(child_stdout);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() || !trimmed.starts_with('{') {
                    continue;
                }
                let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                dispatch_acp_frame(
                    &frame,
                    &pending_bg,
                    &stdin_bg,
                    &sink_bg,
                    &rules_bg,
                    trusted_bg,
                    approval_bg,
                );
            }
            alive_bg.store(false, Ordering::Relaxed);
            let exit_code = child.wait().ok().and_then(|s| s.code());
            let tail = stderr_exit.lock().unwrap().clone();
            for (_, tx) in pending_bg.lock().unwrap().drain() {
                let _ = tx.send(Err(anyhow::anyhow!("ACP process exited")));
            }
            sink_bg(AcpEvent::ProcessExit {
                exit_code,
                stderr_tail: tail,
            });
        });

        let mut client = Self {
            pid,
            acp_session_id: String::new(),
            agent_info: Value::Null,
            stdin_tx,
            pending,
            next_id: AtomicU64::new(1),
            supervisor,
            alive,
        };

        // 1. ACP `initialize`
        let init_res = client
            .call(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false }
                    },
                    "clientInfo": {
                        "name": "omp-omni",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                Duration::from_secs(20),
            )
            .await
            .context("ACP initialize handshake failed")?;
        client.agent_info = init_res;

        // 2. ACP `session/new`
        let new_res = client
            .call(
                "session/new",
                json!({
                    "cwd": cfg.cwd.to_string_lossy(),
                    "mcpServers": cfg.mcp_servers
                }),
                Duration::from_secs(20),
            )
            .await
            .context("ACP session/new failed")?;
        client.acp_session_id = new_res
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("acp-default")
            .to_string();

        Ok(client)
    }

    pub async fn call(&self, method: &str, params: Value, timeout_dur: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = serde_json::to_string(&req)?;
        if self.stdin_tx.send(line).is_err() {
            self.pending.lock().unwrap().remove(&id);
            bail!("ACP stdin closed");
        }
        match tokio::time::timeout(timeout_dur, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => bail!("ACP process exited before replying to {method}"),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!(
                    "ACP request '{method}' timed out after {}s",
                    timeout_dur.as_secs()
                )
            }
        }
    }

    pub async fn prompt(&self, text: &str, timeout_dur: Duration) -> Result<Value> {
        self.call(
            "session/prompt",
            json!({
                "sessionId": self.acp_session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            timeout_dur,
        )
        .await
    }

    pub fn cancel(&self) {
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": self.acp_session_id }
        });
        if let Ok(line) = serde_json::to_string(&notif) {
            let _ = self.stdin_tx.send(line);
        }
    }

    pub fn rss_bytes(&self) -> u64 {
        process_tree_rss_bytes(self.pid)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn kill(&self) {
        if let Ok(mut sup) = self.supervisor.lock() {
            sup.kill_tree();
        }
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        if let Ok(mut sup) = self.supervisor.lock() {
            sup.kill_tree();
        }
    }
}

/// Evaluate an incoming ACP `session/request_permission` JSON-RPC request and produce
/// the standard ACP JSON-RPC 2.0 response frame.
pub fn build_acp_permission_response(
    req_id: &Value,
    params: &Value,
    rules: &[PermissionRule],
    workspace_trusted: bool,
    approval_mode: ApprovalMode,
) -> Value {
    let tool_title = params
        .pointer("/toolCall/title")
        .or_else(|| params.pointer("/toolCall/kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("shell");
    let tool_kind = params
        .pointer("/toolCall/kind")
        .and_then(|v| v.as_str())
        .unwrap_or(tool_title);

    // Build alias set so `bash` deny/allow rules always cover ACP `shell`/`execute`/`terminal` calls
    let mut tool_aliases: Vec<&str> = vec![tool_title];
    if !tool_kind.eq_ignore_ascii_case(tool_title) {
        tool_aliases.push(tool_kind);
    }
    let lower_title = tool_title.to_ascii_lowercase();
    let lower_kind = tool_kind.to_ascii_lowercase();
    if matches!(
        lower_title.as_str(),
        "shell" | "execute" | "exec" | "terminal" | "run" | "bash" | "command"
    ) || matches!(
        lower_kind.as_str(),
        "shell" | "execute" | "exec" | "terminal" | "bash"
    ) {
        if !tool_aliases.iter().any(|t| t.eq_ignore_ascii_case("bash")) {
            tool_aliases.push("bash");
        }
        if !tool_aliases.iter().any(|t| t.eq_ignore_ascii_case("shell")) {
            tool_aliases.push("shell");
        }
    } else if matches!(lower_title.as_str(), "edit" | "write" | "patch" | "delete")
        || matches!(lower_kind.as_str(), "edit" | "write" | "patch" | "delete")
    {
        if !tool_aliases.iter().any(|t| t.eq_ignore_ascii_case("write")) {
            tool_aliases.push("write");
        }
        if !tool_aliases.iter().any(|t| t.eq_ignore_ascii_case("edit")) {
            tool_aliases.push("edit");
        }
    }

    // Extract clean target strings from `rawInput` (command/path/file_path) so glob patterns
    // like `*.env`, `*rm -rf /*`, and `npm test*` match cleanly instead of wrapped JSON!
    let mut targets: Vec<String> = Vec::new();
    if let Some(raw_in) = params.pointer("/toolCall/rawInput") {
        if let Some(obj) = raw_in.as_object() {
            for key in [
                "command",
                "cmd",
                "path",
                "file_path",
                "filePath",
                "target",
                "filename",
            ] {
                if let Some(s) = obj.get(key).and_then(|v| v.as_str()) {
                    if !s.trim().is_empty() {
                        targets.push(s.to_string());
                    }
                }
            }
        } else if let Some(s) = raw_in.as_str() {
            if !s.trim().is_empty() {
                targets.push(s.to_string());
            }
        }
        if targets.is_empty() {
            targets.push(raw_in.to_string());
        }
    }
    if targets.is_empty() {
        targets.push(tool_title.to_string());
    }

    // Deny ALWAYS wins across all (tool_alias, target) pairs; Allow wins if any allows and none deny
    let mut any_deny = false;
    let mut any_allow = false;
    for alias in &tool_aliases {
        for tgt in &targets {
            let eval =
                PermissionsEngine::evaluate(rules, workspace_trusted, alias, tgt, approval_mode);
            match eval.decision {
                PermissionDecision::Deny => {
                    any_deny = true;
                    break;
                }
                PermissionDecision::Allow => {
                    any_allow = true;
                }
                PermissionDecision::Ask => {}
            }
        }
        if any_deny {
            break;
        }
    }
    let final_decision = if any_deny {
        PermissionDecision::Deny
    } else if any_allow {
        PermissionDecision::Allow
    } else {
        PermissionDecision::Ask
    };

    let options = params
        .get("options")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let pick_option = |kinds: &[&str]| -> Option<String> {
        for wanted in kinds {
            for opt in &options {
                if opt.get("kind").and_then(|v| v.as_str()) == Some(*wanted) {
                    if let Some(oid) = opt.get("optionId").and_then(|v| v.as_str()) {
                        return Some(oid.to_string());
                    }
                }
            }
        }
        None
    };

    let outcome = match final_decision {
        PermissionDecision::Allow => {
            if let Some(oid) = pick_option(&["allow_once", "allow_always"]) {
                json!({ "outcome": "selected", "optionId": oid })
            } else {
                json!({ "outcome": "selected", "optionId": "allow_once" })
            }
        }
        PermissionDecision::Deny | PermissionDecision::Ask => {
            if let Some(oid) = pick_option(&["reject_once", "reject_always"]) {
                json!({ "outcome": "selected", "optionId": oid })
            } else {
                json!({ "outcome": "cancelled" })
            }
        }
    };

    json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": { "outcome": outcome }
    })
}

type PendingAcpMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

fn dispatch_acp_frame(
    frame: &Value,
    pending: &PendingAcpMap,
    stdin_tx: &mpsc::UnboundedSender<String>,
    sink: &AcpEventSink,
    rules: &[PermissionRule],
    workspace_trusted: bool,
    approval_mode: ApprovalMode,
) {
    let method = frame.get("method").and_then(|v| v.as_str());
    let id = frame.get("id");

    // 1. Response to client-initiated request (has `id`, no `method`)
    if method.is_none() {
        if let Some(num_id) = id.and_then(|v| v.as_u64()) {
            if let Some(tx) = pending.lock().unwrap().remove(&num_id) {
                if let Some(err) = frame.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("ACP JSON-RPC error");
                    let _ = tx.send(Err(anyhow::anyhow!("{msg}")));
                } else {
                    let _ = tx.send(Ok(frame.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
        }
        return;
    }

    let method = method.unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or(Value::Null);

    // 2. Bidirectional request from agent (`session/request_permission`)
    if method == "session/request_permission" {
        if let Some(req_id) = id {
            let reply = build_acp_permission_response(
                req_id,
                &params,
                rules,
                workspace_trusted,
                approval_mode,
            );
            if let Ok(line) = serde_json::to_string(&reply) {
                let _ = stdin_tx.send(line);
            }
        }
        return;
    }

    // 3. Streaming notification (`session/update`)
    if method == "session/update" {
        if let Some(ev) = parse_acp_session_update(&params) {
            sink(ev);
        } else {
            sink(AcpEvent::RawUpdate(params));
        }
    }
}

pub fn parse_acp_session_update(params: &Value) -> Option<AcpEvent> {
    let update = params.get("update").unwrap_or(params);
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(|v| v.as_str())?;

    match kind {
        "agent_message_chunk" => {
            let text = update
                .pointer("/content/text")
                .or_else(|| update.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(AcpEvent::TextDelta(text))
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .pointer("/content/text")
                .or_else(|| update.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(AcpEvent::ThinkingDelta(text))
            }
        }
        "tool_call" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("tc")
                .to_string();
            let name = update
                .get("title")
                .or_else(|| update.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            Some(AcpEvent::ToolCallStart { id, name })
        }
        "tool_call_update" => {
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(status, "completed" | "failed") {
                let id = update
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tc")
                    .to_string();
                let name = update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                Some(AcpEvent::ToolCallEnd {
                    id,
                    name,
                    is_error: status == "failed",
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Run a headless `--eval-acp` prompt against an external ACP agent and return a canonical `SuperEvalReport`.
pub async fn run_acp_eval(
    cfg: AcpLaunchConfig,
    model_label: &str,
    prompt: &str,
    timeout_secs: u64,
) -> Result<crate::SuperEvalReport> {
    let t_start = Instant::now();
    let backend_str = cfg.backend.as_str().to_string();
    let cwd_str = cfg.cwd.to_string_lossy().into_owned();

    #[derive(Default)]
    struct Acc {
        text: String,
        ttft_ms: Option<u64>,
        first_delta_at: Option<Instant>,
        last_delta_at: Option<Instant>,
        tool_calls: u32,
        tool_errors: u32,
        tool_hist: BTreeMap<String, u32>,
    }
    let acc = Arc::new(Mutex::new(Acc::default()));
    let prompt_t0 = Arc::new(Mutex::new(None::<Instant>));

    let acc_s = Arc::clone(&acc);
    let pt0_s = Arc::clone(&prompt_t0);
    let sink: AcpEventSink = Arc::new(move |ev| {
        let mut g = acc_s.lock().unwrap();
        match ev {
            AcpEvent::TextDelta(t) => {
                let now = Instant::now();
                if g.ttft_ms.is_none() {
                    if let Some(p0) = *pt0_s.lock().unwrap() {
                        g.ttft_ms = Some(p0.elapsed().as_millis() as u64);
                    }
                    g.first_delta_at = Some(now);
                }
                g.last_delta_at = Some(now);
                g.text.push_str(&t);
            }
            AcpEvent::ThinkingDelta(_) => {
                let now = Instant::now();
                if g.ttft_ms.is_none() {
                    if let Some(p0) = *pt0_s.lock().unwrap() {
                        g.ttft_ms = Some(p0.elapsed().as_millis() as u64);
                    }
                    g.first_delta_at = Some(now);
                }
                g.last_delta_at = Some(now);
            }
            AcpEvent::ToolCallStart { name, .. } => {
                g.tool_calls += 1;
                *g.tool_hist.entry(name).or_insert(0) += 1;
            }
            AcpEvent::ToolCallEnd { is_error: true, .. } => {
                g.tool_errors += 1;
            }
            _ => {}
        }
    });

    let client = AcpClient::spawn_and_initialize(cfg, sink).await?;
    let startup_ms = t_start.elapsed().as_millis() as u64;
    let peak_rss = Arc::new(AtomicU64::new(client.rss_bytes()));
    let peak_bg = Arc::clone(&peak_rss);
    let pid_bg = client.pid;
    let done_flag = Arc::new(AtomicBool::new(false));
    let done_bg = Arc::clone(&done_flag);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        while !done_bg.load(Ordering::Relaxed) {
            tick.tick().await;
            peak_bg.fetch_max(process_tree_rss_bytes(pid_bg), Ordering::Relaxed);
        }
    });

    *prompt_t0.lock().unwrap() = Some(Instant::now());
    let prompt_res = client
        .prompt(prompt, Duration::from_secs(timeout_secs))
        .await;
    done_flag.store(true, Ordering::Relaxed);
    client.kill();

    let (status, err_msg) = match prompt_res {
        Ok(_) => ("completed".to_string(), None),
        Err(e) => {
            let s = e.to_string();
            let st = if s.contains("timed out") {
                "timeout"
            } else {
                "error"
            };
            (st.to_string(), Some(s))
        }
    };

    let elapsed_ms = t_start.elapsed().as_millis() as u64;
    let g = acc.lock().unwrap();
    let gen_ms = match (g.first_delta_at, g.last_delta_at) {
        (Some(a), Some(b)) => b.saturating_duration_since(a).as_millis().max(50) as u64,
        _ => elapsed_ms.saturating_sub(startup_ms).max(50),
    };

    let (provider, model_id) = model_label
        .split_once('/')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or_else(|| ("acp".to_string(), model_label.to_string()));

    let _ = Utc::now();
    Ok(crate::SuperEvalReport {
        harness: format!("acp:{backend_str}"),
        backend: backend_str,
        version: env!("CARGO_PKG_VERSION").into(),
        provider,
        model: model_id,
        cwd: cwd_str,
        status: status.clone(),
        success: status == "completed" && !g.text.trim().is_empty(),
        final_text: g.text.clone(),
        elapsed_ms,
        ttft_ms: g.ttft_ms,
        llm_ttft_ms: g.ttft_ms,
        gen_duration_ms: gen_ms,
        startup_ms,
        tool_calls: g.tool_calls,
        tool_errors: g.tool_errors,
        tool_histogram: g.tool_hist.clone(),
        turns: 1,
        input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: None,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        token_telemetry_complete: false,
        cost_usd: 0.0,
        tokens_per_second: 0.0,
        gen_tokens_per_second: 0.0,
        peak_rss_bytes: peak_rss.load(Ordering::Relaxed),
        recovery_attempts: 0,
        recovery_succeeded: false,
        host_tool_calls: 0,
        protocol_version: 1,
        merkle_root: String::new(),
        merkle_refresh_ms: 0.0,
        merkle_file_count: 0,
        graph_symbol_count: 0,
        prefix_stable: true,
        prefix_cache_hit_pct: 0.0,
        lakeview_compressions: 0,
        lakeview_chars_saved: 0,
        loop_nudges: 0,
        http_retries: 0,
        active_decode_ms: 0,
        active_decode_tps: 0.0,
        e2e_tps: 0.0,
        wire_dialect: "acp".into(),
        truncated_stream_retries: 0,
        stall_retries: 0,
        verify_gate_nudges: 0,
        narration_nudges: 0,
        interleaved_reasoning_turns: 0,
        sap_repairs: 0,
        oscillation_nudges: 0,
        hedge_wins: 0,
        error: err_msg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_acp_session_updates_and_enforces_permission_rules() {
        let chunk = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello from ACP!" }
            }
        });
        match parse_acp_session_update(&chunk) {
            Some(AcpEvent::TextDelta(t)) => assert_eq!(t, "Hello from ACP!"),
            other => panic!("unexpected event: {other:?}"),
        }

        let tc = json!({
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc-1",
                "title": "read_file"
            }
        });
        assert!(matches!(
            parse_acp_session_update(&tc),
            Some(AcpEvent::ToolCallStart { .. })
        ));

        // Default zero-restriction rules in YOLO allow `.env`, normal files, and shell commands
        // even when workspace_trusted == false (Steer #22 Full-Freedom Default).
        let perm_req = json!({
            "toolCall": { "title": "write", "rawInput": { "path": "secrets/.env" } },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once" },
                { "optionId": "reject_once", "kind": "reject_once" }
            ]
        });
        let resp_default_allow = build_acp_permission_response(
            &json!(7),
            &perm_req,
            &PermissionsEngine::default_rules(),
            false,
            ApprovalMode::Yolo,
        );
        assert_eq!(resp_default_allow["id"], 7);
        assert_eq!(resp_default_allow["result"]["outcome"]["optionId"], "allow_once");

        // Opt-in strict safety rules STILL deny `.env` even in YOLO!
        let resp_deny = build_acp_permission_response(
            &json!(71),
            &perm_req,
            &PermissionsEngine::strict_safety_rules(),
            true,
            ApprovalMode::Yolo,
        );
        assert_eq!(resp_deny["id"], 71);
        assert_eq!(resp_deny["result"]["outcome"]["optionId"], "reject_once");

        // Normal file write in trusted YOLO -> allow_once
        let perm_ok = json!({
            "toolCall": { "title": "write", "rawInput": { "path": "src/main.rs" } },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once" },
                { "optionId": "reject_once", "kind": "reject_once" }
            ]
        });
        let resp_allow = build_acp_permission_response(
            &json!(8),
            &perm_ok,
            &PermissionsEngine::default_rules(),
            true,
            ApprovalMode::Yolo,
        );
        assert_eq!(resp_allow["result"]["outcome"]["optionId"], "allow_once");

        // Security Fix #6a: Opt-in strict rules deny ACP `execute` with `rm -rf /` (`tool: "bash"`) even in YOLO!
        let perm_rm = json!({
            "toolCall": { "title": "execute", "kind": "execute", "rawInput": { "command": "rm -rf /" } },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once" },
                { "optionId": "reject_once", "kind": "reject_once" }
            ]
        });
        let resp_rm_default = build_acp_permission_response(
            &json!(9),
            &perm_rm,
            &PermissionsEngine::default_rules(),
            true,
            ApprovalMode::Yolo,
        );
        assert_eq!(resp_rm_default["result"]["outcome"]["optionId"], "allow_once");

        let resp_rm = build_acp_permission_response(
            &json!(91),
            &perm_rm,
            &PermissionsEngine::strict_safety_rules(),
            true,
            ApprovalMode::Yolo,
        );
        assert_eq!(
            resp_rm["result"]["outcome"]["optionId"], "reject_once",
            "ACP execute rm -rf / must be denied by opt-in strict bash deny rule"
        );

        // Security Fix #6b: exact glob allow rule `npm test*` on `bash` matches extracted `rawInput.command`!
        let mut custom_rules = PermissionsEngine::default_rules();
        custom_rules.push(PermissionRule {
            id: "ws-allow-npm".into(),
            scope: crate::permissions::PermissionScope::Workspace,
            workspace_id: Some("w1".into()),
            action: crate::permissions::PermissionAction::Allow,
            tool: "bash".into(),
            match_pattern: "npm test*".into(),
            note: "allow tests".into(),
        });
        let perm_npm = json!({
            "toolCall": { "title": "shell", "rawInput": { "command": "npm test --watch=false" } },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once" },
                { "optionId": "reject_once", "kind": "reject_once" }
            ]
        });
        let resp_npm = build_acp_permission_response(
            &json!(10),
            &perm_npm,
            &custom_rules,
            true,
            ApprovalMode::AlwaysAsk,
        );
        assert_eq!(
            resp_npm["result"]["outcome"]["optionId"], "allow_once",
            "extracted rawInput.command should match npm test* allow rule"
        );
    }

    #[test]
    fn backend_detection_always_exposes_native_omni_super_default() {
        let list = detect_all_backends(None);
        assert_eq!(list.len(), 6);
        assert_eq!(list[0].id, HarnessBackendId::OmniSuper);
        assert!(list[0].available);
        assert!(list[0].is_default);
    }
}
