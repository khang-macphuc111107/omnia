//! Debug Adapter Protocol (DAP) JSON-RPC Content-Length Client (`debugpy`, `lldb-dap`, `dlv`).
//!
//! Manages concurrent debug sessions over framed stdin/stdout (`Content-Length: N\r\n\r\n`),
//! tracking stopped/thread/breakpoint/output events and killing child adapters cleanly.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const DEFAULT_DAP_TIMEOUT_MS: u64 = 15_000;
const MAX_DAP_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_RING_BYTES: usize = 256 * 1024;

static DAP_SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// Supported Debug Adapter Protocol backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DapAdapterKind {
    DebugPy,
    LldbDap,
    Dlv,
    Custom,
}

impl DapAdapterKind {
    #[must_use]
    pub const fn adapter_id(self) -> &'static str {
        match self {
            Self::DebugPy => "debugpy",
            Self::LldbDap => "lldb-dap",
            Self::Dlv => "dlv",
            Self::Custom => "custom",
        }
    }

    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debugpy" | "python" | "py" => Some(Self::DebugPy),
            "lldb" | "lldb-dap" | "lldb-vscode" | "cpp" | "rust" => Some(Self::LldbDap),
            "dlv" | "delve" | "go" => Some(Self::Dlv),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

/// Lifecycle state of a DAP debug session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DapSessionStatus {
    Launching,
    Running,
    Stopped,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DapLaunchRequest {
    pub adapter: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub stop_on_entry: bool,
    /// Optional explicit command override for custom adapters or tests.
    #[serde(default)]
    pub adapter_command: Option<Vec<String>>,
    #[serde(default)]
    pub breakpoints: Vec<DapInitialBreakpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DapInitialBreakpoint {
    pub file: String,
    pub line: u32,
    #[serde(default)]
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DapAttachRequest {
    pub adapter: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub adapter_command: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DapSessionSummary {
    pub session_id: String,
    pub adapter: String,
    pub status: DapSessionStatus,
    pub program: String,
    pub active_thread_id: Option<i64>,
    pub stop_reason: Option<String>,
    pub breakpoints_verified: usize,
    pub output_tail: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedDapCommand {
    pub kind: DapAdapterKind,
    pub executable: String,
    pub args: Vec<String>,
}

/// Probes PATH and standard Windows locations for `debugpy`, `lldb-dap`, or `dlv`.
#[must_use]
pub fn resolve_adapter_command(adapter: &str, program: Option<&str>) -> Option<ResolvedDapCommand> {
    let kind = DapAdapterKind::parse_str(adapter).or_else(|| {
        let p = program?.to_ascii_lowercase();
        if p.ends_with(".py") {
            Some(DapAdapterKind::DebugPy)
        } else if p.ends_with(".go") {
            Some(DapAdapterKind::Dlv)
        } else {
            Some(DapAdapterKind::LldbDap)
        }
    })?;

    match kind {
        DapAdapterKind::DebugPy => {
            if let Ok(exe) = which_bin("debugpy-adapter") {
                return Some(ResolvedDapCommand {
                    kind,
                    executable: exe,
                    args: Vec::new(),
                });
            }
            for py in ["python", "python3", "py"] {
                if let Ok(exe) = which_bin(py) {
                    return Some(ResolvedDapCommand {
                        kind,
                        executable: exe,
                        args: vec!["-m".into(), "debugpy.adapter".into()],
                    });
                }
            }
            None
        }
        DapAdapterKind::LldbDap => {
            for bin in ["lldb-dap", "lldb-vscode"] {
                if let Ok(exe) = which_bin(bin) {
                    return Some(ResolvedDapCommand {
                        kind,
                        executable: exe,
                        args: Vec::new(),
                    });
                }
            }
            None
        }
        DapAdapterKind::Dlv => {
            if let Ok(exe) = which_bin("dlv") {
                return Some(ResolvedDapCommand {
                    kind,
                    executable: exe,
                    args: vec!["dap".into()],
                });
            }
            None
        }
        DapAdapterKind::Custom => None,
    }
}

fn which_bin(name: &str) -> Result<String> {
    which::which(name)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| anyhow::anyhow!("binary `{name}` not found: {e}"))
}

#[derive(Debug, Default)]
struct DapLiveState {
    status: Option<DapSessionStatus>,
    active_thread_id: Option<i64>,
    stop_reason: Option<String>,
    breakpoints_verified: usize,
    output_ring: VecDeque<u8>,
    events: Vec<Value>,
}

impl DapLiveState {
    fn push_output(&mut self, chunk: &str) {
        for &b in chunk.as_bytes() {
            if self.output_ring.len() >= MAX_OUTPUT_RING_BYTES {
                self.output_ring.pop_front();
            }
            self.output_ring.push_back(b);
        }
    }

    fn output_string(&self) -> String {
        let bytes: Vec<u8> = self.output_ring.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

struct DapSessionHandle {
    session_id: String,
    adapter: String,
    program: String,
    next_seq: AtomicI64,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>>,
    state: Arc<Mutex<DapLiveState>>,
    initialized_rx: Arc<AsyncMutex<Option<oneshot::Receiver<()>>>>,
    child: Arc<AsyncMutex<Option<tokio::process::Child>>>,
}

impl DapSessionHandle {
    async fn from_streams<R, W>(
        session_id: String,
        adapter: String,
        program: String,
        reader: R,
        writer: W,
        child: Option<tokio::process::Child>,
    ) -> Arc<Self>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let state = Arc::new(Mutex::new(DapLiveState {
            status: Some(DapSessionStatus::Launching),
            ..Default::default()
        }));
        let (init_tx, init_rx) = oneshot::channel();
        let init_tx_slot = Arc::new(Mutex::new(Some(init_tx)));

        let reader_pending = Arc::clone(&pending);
        let reader_state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut buf_reader = BufReader::new(reader);
            while let Ok(Some(msg)) = read_dap_frame(&mut buf_reader).await {
                let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");
                match msg_type {
                    "response" => {
                        let req_seq = msg.get("request_seq").and_then(Value::as_i64).unwrap_or(-1);
                        let ok = msg.get("success").and_then(Value::as_bool).unwrap_or(false);
                        let sender = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut map| map.remove(&req_seq));
                        if let Some(tx) = sender {
                            if ok {
                                let _ = tx.send(Ok(msg.get("body").cloned().unwrap_or(Value::Null)));
                            } else {
                                let err_msg = msg
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("DAP request failed")
                                    .to_owned();
                                let _ = tx.send(Err(anyhow::anyhow!(err_msg)));
                            }
                        }
                    }
                    "event" => {
                        let event_name = msg.get("event").and_then(Value::as_str).unwrap_or("");
                        let body = msg.get("body").cloned().unwrap_or(Value::Null);
                        if event_name == "initialized" {
                            if let Some(tx) = init_tx_slot.lock().ok().and_then(|mut g| g.take()) {
                                let _ = tx.send(());
                            }
                        }
                        if let Ok(mut st) = reader_state.lock() {
                            if st.events.len() >= 256 {
                                st.events.remove(0);
                            }
                            st.events.push(msg.clone());
                            match event_name {
                                "stopped" => {
                                    st.status = Some(DapSessionStatus::Stopped);
                                    st.active_thread_id =
                                        body.get("threadId").and_then(Value::as_i64);
                                    st.stop_reason = body
                                        .get("reason")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned);
                                }
                                "continued" => {
                                    st.status = Some(DapSessionStatus::Running);
                                    st.stop_reason = None;
                                }
                                "terminated" | "exited" => {
                                    st.status = Some(DapSessionStatus::Terminated);
                                }
                                "output" => {
                                    if let Some(text) = body.get("output").and_then(Value::as_str) {
                                        st.push_output(text);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Ok(mut st) = reader_state.lock() {
                if st.status != Some(DapSessionStatus::Terminated) {
                    st.status = Some(DapSessionStatus::Terminated);
                }
            }
        });

        Arc::new(Self {
            session_id,
            adapter,
            program,
            next_seq: AtomicI64::new(1),
            writer: Arc::new(AsyncMutex::new(Box::new(writer))),
            pending,
            state,
            initialized_rx: Arc::new(AsyncMutex::new(Some(init_rx))),
            child: Arc::new(AsyncMutex::new(child)),
        })
    }

    async fn request(&self, command: &str, arguments: Option<Value>, timeout_ms: u64) -> Result<Value> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let mut req = json!({
            "seq": seq,
            "type": "request",
            "command": command,
        });
        if let Some(args) = arguments {
            req["arguments"] = args;
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| anyhow::anyhow!("DAP pending map poisoned"))?
            .insert(seq, tx);

        if let Err(err) = write_dap_frame(&mut *self.writer.lock().await, &req).await {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&seq);
            }
            return Err(err);
        }

        let res = tokio::time::timeout(Duration::from_millis(timeout_ms), rx)
            .await
            .map_err(|_| {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&seq);
                }
                anyhow::anyhow!("DAP command `{command}` timed out after {timeout_ms}ms")
            })?;
        res.context("DAP response channel closed")?
    }

    async fn wait_initialized(&self, timeout_ms: u64) {
        let rx = self.initialized_rx.lock().await.take();
        if let Some(rx) = rx {
            let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await;
        }
    }

    fn summary(&self) -> DapSessionSummary {
        let st = self.state.lock().ok();
        let (status, active_thread_id, stop_reason, breakpoints_verified, output_tail) =
            if let Some(ref guard) = st {
                let tail_full = guard.output_string();
                let tail = if tail_full.len() > 2048 {
                    let start = tail_full.floor_char_boundary(tail_full.len() - 2048);
                    tail_full[start..].to_owned()
                } else {
                    tail_full
                };
                (
                    guard.status.unwrap_or(DapSessionStatus::Launching),
                    guard.active_thread_id,
                    guard.stop_reason.clone(),
                    guard.breakpoints_verified,
                    tail,
                )
            } else {
                (DapSessionStatus::Terminated, None, None, 0, String::new())
            };

        DapSessionSummary {
            session_id: self.session_id.clone(),
            adapter: self.adapter.clone(),
            status,
            program: self.program.clone(),
            active_thread_id,
            stop_reason,
            breakpoints_verified,
            output_tail,
        }
    }

    async fn terminate_process(&self) {
        let _ = self
            .request(
                "disconnect",
                Some(json!({ "restart": false, "terminateDebuggee": true })),
                2_000,
            )
            .await;
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Ok(mut st) = self.state.lock() {
            st.status = Some(DapSessionStatus::Terminated);
        }
    }
}

/// Manager owning active DAP sessions for `omnia-agent` tools and `omnia-studio`.
#[derive(Clone, Default)]
pub struct DapManager {
    workspace_root: PathBuf,
    sessions: Arc<Mutex<HashMap<String, Arc<DapSessionHandle>>>>,
}

impl std::fmt::Debug for DapManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.sessions.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("DapManager")
            .field("workspace_root", &self.workspace_root)
            .field("active_sessions", &count)
            .finish()
    }
}

impl DapManager {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn launch(&self, req: DapLaunchRequest) -> Result<DapSessionSummary> {
        let (kind, exe, args) = if let Some(ref explicit) = req.adapter_command {
            let Some((first, rest)) = explicit.split_first() else {
                bail!("adapter_command must not be empty");
            };
            (
                DapAdapterKind::parse_str(&req.adapter).unwrap_or(DapAdapterKind::Custom),
                first.clone(),
                rest.to_vec(),
            )
        } else {
            let resolved = resolve_adapter_command(&req.adapter, Some(&req.program))
                .ok_or_else(|| anyhow::anyhow!("DAP adapter `{}` not available on host PATH", req.adapter))?;
            (resolved.kind, resolved.executable, resolved.args)
        };

        let cwd = req
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.workspace_root.clone());
        let mut cmd = build_hidden_dap_command(&exe, &args, &cwd);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn DAP adapter `{exe}`"))?;
        let stdin = child.stdin.take().context("DAP child missing stdin")?;
        let stdout = child.stdout.take().context("DAP child missing stdout")?;

        let session_id = format!("dap-{}", DAP_SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
        let handle = DapSessionHandle::from_streams(
            session_id.clone(),
            kind.adapter_id().to_owned(),
            req.program.clone(),
            stdout,
            stdin,
            Some(child),
        )
        .await;

        self.insert_handle(session_id.clone(), Arc::clone(&handle))?;

        let init_res = handle
            .request(
                "initialize",
                Some(json!({
                    "clientID": "omnia",
                    "clientName": "Omnia Studio",
                    "adapterID": kind.adapter_id(),
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                    "supportsVariableType": true,
                    "supportsEvaluateForHovers": true,
                })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await;
        if let Err(err) = init_res {
            self.terminate(&session_id).await;
            return Err(err);
        }

        let launch_res = handle
            .request(
                "launch",
                Some(json!({
                    "name": "Omnia Launch",
                    "type": kind.adapter_id(),
                    "request": "launch",
                    "program": req.program,
                    "args": req.args,
                    "cwd": cwd.to_string_lossy(),
                    "env": req.env,
                    "stopOnEntry": req.stop_on_entry,
                })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await;
        if let Err(err) = launch_res {
            self.terminate(&session_id).await;
            return Err(err);
        }

        handle.wait_initialized(4_000).await;

        let mut by_file: HashMap<String, Vec<DapInitialBreakpoint>> = HashMap::new();
        for bp in &req.breakpoints {
            by_file.entry(bp.file.clone()).or_default().push(bp.clone());
        }
        for (file, bps) in by_file {
            let _ = self.set_breakpoints_inner(&handle, &file, &bps).await;
        }

        let _ = handle
            .request("configurationDone", Some(json!({})), DEFAULT_DAP_TIMEOUT_MS)
            .await;
        if let Ok(mut st) = handle.state.lock() {
            if st.status == Some(DapSessionStatus::Launching) {
                st.status = Some(DapSessionStatus::Running);
            }
        }
        Ok(handle.summary())
    }

    pub async fn attach(&self, req: DapAttachRequest) -> Result<DapSessionSummary> {
        let (kind, exe, args) = if let Some(ref explicit) = req.adapter_command {
            let Some((first, rest)) = explicit.split_first() else {
                bail!("adapter_command must not be empty");
            };
            (
                DapAdapterKind::parse_str(&req.adapter).unwrap_or(DapAdapterKind::Custom),
                first.clone(),
                rest.to_vec(),
            )
        } else {
            let resolved = resolve_adapter_command(&req.adapter, None)
                .ok_or_else(|| anyhow::anyhow!("DAP adapter `{}` not available on PATH", req.adapter))?;
            (resolved.kind, resolved.executable, resolved.args)
        };
        let cwd = req
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.workspace_root.clone());
        let mut cmd = build_hidden_dap_command(&exe, &args, &cwd);
        let mut child = cmd.spawn().with_context(|| format!("spawn DAP `{exe}`"))?;
        let stdin = child.stdin.take().context("DAP child missing stdin")?;
        let stdout = child.stdout.take().context("DAP child missing stdout")?;
        let session_id = format!("dap-{}", DAP_SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
        let handle = DapSessionHandle::from_streams(
            session_id.clone(),
            kind.adapter_id().to_owned(),
            format!(
                "attach:{}",
                req.pid
                    .map(|p| p.to_string())
                    .or_else(|| req.port.map(|p| p.to_string()))
                    .unwrap_or_else(|| "target".into())
            ),
            stdout,
            stdin,
            Some(child),
        )
        .await;
        self.insert_handle(session_id.clone(), Arc::clone(&handle))?;

        handle
            .request(
                "initialize",
                Some(json!({
                    "clientID": "omnia",
                    "clientName": "Omnia Studio",
                    "adapterID": kind.adapter_id(),
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await?;

        let mut attach_args = json!({
            "type": kind.adapter_id(),
            "request": "attach",
        });
        if let Some(pid) = req.pid {
            attach_args["processId"] = json!(pid);
        }
        if let Some(host) = req.host {
            attach_args["host"] = json!(host);
        }
        if let Some(port) = req.port {
            attach_args["port"] = json!(port);
        }
        handle
            .request("attach", Some(attach_args), DEFAULT_DAP_TIMEOUT_MS)
            .await?;
        handle.wait_initialized(4_000).await;
        let _ = handle
            .request("configurationDone", Some(json!({})), DEFAULT_DAP_TIMEOUT_MS)
            .await;
        Ok(handle.summary())
    }

    pub async fn set_breakpoints(
        &self,
        session_id: &str,
        file: &str,
        bps: &[DapInitialBreakpoint],
    ) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        self.set_breakpoints_inner(&handle, file, bps).await
    }

    async fn set_breakpoints_inner(
        &self,
        handle: &DapSessionHandle,
        file: &str,
        bps: &[DapInitialBreakpoint],
    ) -> Result<Value> {
        let payload_bps: Vec<Value> = bps
            .iter()
            .map(|b| {
                let mut o = json!({ "line": b.line });
                if let Some(ref cond) = b.condition {
                    o["condition"] = json!(cond);
                }
                o
            })
            .collect();
        let body = handle
            .request(
                "setBreakpoints",
                Some(json!({
                    "source": { "path": file },
                    "breakpoints": payload_bps,
                })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await?;
        let verified = body
            .get("breakpoints")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|b| b.get("verified").and_then(Value::as_bool).unwrap_or(false))
                    .count()
            })
            .unwrap_or(0);
        if let Ok(mut st) = handle.state.lock() {
            st.breakpoints_verified = verified;
        }
        Ok(body)
    }

    pub async fn continue_exec(&self, session_id: &str, thread_id: Option<i64>) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let tid = self.resolve_thread_id(&handle, thread_id).await?;
        let body = handle
            .request("continue", Some(json!({ "threadId": tid })), DEFAULT_DAP_TIMEOUT_MS)
            .await?;
        if let Ok(mut st) = handle.state.lock() {
            if st.status == Some(DapSessionStatus::Stopped) {
                st.status = Some(DapSessionStatus::Running);
            }
        }
        Ok(body)
    }

    pub async fn step_over(&self, session_id: &str, thread_id: Option<i64>) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let tid = self.resolve_thread_id(&handle, thread_id).await?;
        handle
            .request("next", Some(json!({ "threadId": tid })), DEFAULT_DAP_TIMEOUT_MS)
            .await
    }

    pub async fn step_in(&self, session_id: &str, thread_id: Option<i64>) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let tid = self.resolve_thread_id(&handle, thread_id).await?;
        handle
            .request("stepIn", Some(json!({ "threadId": tid })), DEFAULT_DAP_TIMEOUT_MS)
            .await
    }

    pub async fn step_out(&self, session_id: &str, thread_id: Option<i64>) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let tid = self.resolve_thread_id(&handle, thread_id).await?;
        handle
            .request("stepOut", Some(json!({ "threadId": tid })), DEFAULT_DAP_TIMEOUT_MS)
            .await
    }

    pub async fn stack_trace(
        &self,
        session_id: &str,
        thread_id: Option<i64>,
        levels: u32,
    ) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let tid = self.resolve_thread_id(&handle, thread_id).await?;
        handle
            .request(
                "stackTrace",
                Some(json!({ "threadId": tid, "startFrame": 0, "levels": levels })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await
    }

    pub async fn scopes(&self, session_id: &str, frame_id: i64) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        handle
            .request("scopes", Some(json!({ "frameId": frame_id })), DEFAULT_DAP_TIMEOUT_MS)
            .await
    }

    pub async fn variables(&self, session_id: &str, variables_reference: i64) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        handle
            .request(
                "variables",
                Some(json!({ "variablesReference": variables_reference })),
                DEFAULT_DAP_TIMEOUT_MS,
            )
            .await
    }

    pub async fn evaluate(
        &self,
        session_id: &str,
        expression: &str,
        frame_id: Option<i64>,
        context: Option<&str>,
    ) -> Result<Value> {
        let handle = self.get_handle(session_id)?;
        let mut args = json!({
            "expression": expression,
            "context": context.unwrap_or("repl"),
        });
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        handle
            .request("evaluate", Some(args), DEFAULT_DAP_TIMEOUT_MS)
            .await
    }

    pub fn summary(&self, session_id: &str) -> Result<DapSessionSummary> {
        Ok(self.get_handle(session_id)?.summary())
    }

    #[must_use]
    pub fn list_sessions(&self) -> Vec<DapSessionSummary> {
        self.sessions
            .lock()
            .map(|map| map.values().map(|h| h.summary()).collect())
            .unwrap_or_default()
    }

    pub async fn terminate(&self, session_id: &str) -> bool {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut map| map.remove(session_id));
        if let Some(handle) = removed {
            handle.terminate_process().await;
            true
        } else {
            false
        }
    }

    async fn resolve_thread_id(
        &self,
        handle: &DapSessionHandle,
        explicit: Option<i64>,
    ) -> Result<i64> {
        if let Some(tid) = explicit {
            return Ok(tid);
        }
        if let Some(tid) = handle.state.lock().ok().and_then(|s| s.active_thread_id) {
            return Ok(tid);
        }
        let body = handle.request("threads", None, DEFAULT_DAP_TIMEOUT_MS).await?;
        let first_tid = body
            .get("threads")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|t| t.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or(1);
        Ok(first_tid)
    }

    fn insert_handle(&self, id: String, handle: Arc<DapSessionHandle>) -> Result<()> {
        let mut map = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("DAP sessions lock poisoned"))?;
        map.insert(id, handle);
        Ok(())
    }

    fn get_handle(&self, id: &str) -> Result<Arc<DapSessionHandle>> {
        self.sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("DAP sessions lock poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown DAP session `{id}`"))
    }
}

fn build_hidden_dap_command(exe: &str, args: &[String], cwd: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Encodes and writes one Content-Length framed DAP JSON payload.
pub async fn write_dap_frame<W: AsyncWrite + Unpin>(writer: &mut W, payload: &Value) -> Result<()> {
    let body = serde_json::to_vec(payload)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

/// Reads one Content-Length framed DAP JSON payload from `reader`.
pub async fn read_dap_frame<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Option<Value>> {
    let mut content_len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if content_len.is_some() {
                break;
            }
            continue;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                let len = v
                    .trim()
                    .parse::<usize>()
                    .context("invalid DAP Content-Length header")?;
                if len > MAX_DAP_FRAME_BYTES {
                    bail!("DAP frame exceeds maximum allowed size ({len} bytes)");
                }
                content_len = Some(len);
            }
        }
    }

    let len = content_len.context("missing Content-Length header in DAP frame")?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    let val: Value = serde_json::from_slice(&body).context("parse DAP JSON frame")?;
    Ok(Some(val))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dap_framing_roundtrip_and_full_session_protocol() {
        let (client_io, mut server_io) = tokio::io::duplex(64 * 1024);
        let (client_r, client_w) = tokio::io::split(client_io);

        let handle = DapSessionHandle::from_streams(
            "dap-test".into(),
            "debugpy".into(),
            "sample.py".into(),
            client_r,
            client_w,
            None,
        )
        .await;

        let server_task = tokio::spawn(async move {
            let (sr, mut sw) = tokio::io::split(&mut server_io);
            let mut sbuf = BufReader::new(sr);
            while let Ok(Some(req)) = read_dap_frame(&mut sbuf).await {
                let seq = req.get("seq").and_then(Value::as_i64).unwrap_or(1);
                let cmd = req.get("command").and_then(Value::as_str).unwrap_or("");
                let body = match cmd {
                    "initialize" => json!({ "supportsConfigurationDoneRequest": true }),
                    "setBreakpoints" => json!({ "breakpoints": [{ "verified": true, "line": 4 }] }),
                    "stackTrace" => json!({ "stackFrames": [{ "id": 10, "name": "main", "line": 4 }], "totalFrames": 1 }),
                    "evaluate" => json!({ "result": "42", "type": "int" }),
                    "disconnect" => {
                        let _ = write_dap_frame(
                            &mut sw,
                            &json!({ "seq": seq + 100, "type": "response", "request_seq": seq, "success": true, "command": cmd }),
                        )
                        .await;
                        break;
                    }
                    _ => json!({}),
                };
                let _ = write_dap_frame(
                    &mut sw,
                    &json!({
                        "seq": seq + 100,
                        "type": "response",
                        "request_seq": seq,
                        "success": true,
                        "command": cmd,
                        "body": body,
                    }),
                )
                .await;
                if cmd == "initialize" {
                    let _ = write_dap_frame(
                        &mut sw,
                        &json!({ "seq": 900, "type": "event", "event": "initialized" }),
                    )
                    .await;
                    let _ = write_dap_frame(
                        &mut sw,
                        &json!({
                            "seq": 901,
                            "type": "event",
                            "event": "stopped",
                            "body": { "reason": "breakpoint", "threadId": 1 }
                        }),
                    )
                    .await;
                }
            }
        });

        handle.request("initialize", Some(json!({})), 3_000).await.expect("init");
        handle.wait_initialized(2_000).await;
        let bp_res = handle
            .request("setBreakpoints", Some(json!({"source": {"path": "sample.py"}, "breakpoints": [{"line": 4}]})), 3_000)
            .await
            .expect("setBreakpoints");
        assert_eq!(bp_res["breakpoints"][0]["verified"], json!(true));
        let st = handle
            .request("stackTrace", Some(json!({"threadId": 1})), 3_000)
            .await
            .expect("stackTrace");
        assert_eq!(st["stackFrames"][0]["name"], json!("main"));
        let ev = handle
            .request("evaluate", Some(json!({"expression": "x + 1", "frameId": 10})), 3_000)
            .await
            .expect("evaluate");
        assert_eq!(ev["result"], json!("42"));

        tokio::time::sleep(Duration::from_millis(20)).await;
        let summary = handle.summary();
        assert_eq!(summary.status, DapSessionStatus::Stopped);
        assert_eq!(summary.stop_reason.as_deref(), Some("breakpoint"));

        handle.terminate_process().await;
        let _ = server_task.await;
    }
}
