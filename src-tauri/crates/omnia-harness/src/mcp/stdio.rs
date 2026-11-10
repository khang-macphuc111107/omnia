//! Newline-delimited JSON-RPC over any `AsyncRead`/`AsyncWrite` pair, plus the
//! child-process spawning used for real stdio servers.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::rpc::{
    cancelled_params, classify, is_tools_changed, reply_to_request, Incoming, Transport,
};
use super::{McpError, McpResult};

type Writer = Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<McpResult<Value>>>>>;

const STDERR_MAX_LINES: usize = 200;
const STDERR_MAX_LINE_CHARS: usize = 2000;

pub(crate) type StderrBuf = Arc<Mutex<VecDeque<String>>>;

pub(crate) struct PipeTransport {
    writer: Writer,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: JoinHandle<()>,
    guard: Option<ProcessGuard>,
    stderr: Option<StderrBuf>,
}

impl PipeTransport {
    pub(crate) fn new<R, W>(
        reader: R,
        writer: W,
        tools_changed: Arc<AtomicBool>,
        guard: Option<ProcessGuard>,
        stderr: Option<StderrBuf>,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let writer: Writer = Arc::new(AsyncMutex::new(Box::new(writer)));
        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn(read_loop(
            reader,
            writer.clone(),
            pending.clone(),
            closed.clone(),
            tools_changed,
        ));
        Self {
            writer,
            pending,
            next_id: AtomicU64::new(1),
            closed,
            reader,
            guard,
            stderr,
        }
    }

    async fn write(&self, msg: &Value) -> McpResult<()> {
        write_line(&self.writer, msg).await
    }

    fn forget(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }
}

async fn write_line(writer: &Writer, msg: &Value) -> McpResult<()> {
    let mut line = serde_json::to_vec(msg).map_err(|e| McpError::Protocol(e.to_string()))?;
    line.push(b'\n');
    let mut w = writer.lock().await;
    w.write_all(&line)
        .await
        .map_err(|e| McpError::Transport(format!("write failed: {e}")))?;
    w.flush()
        .await
        .map_err(|e| McpError::Transport(format!("flush failed: {e}")))
}

async fn read_loop<R>(
    reader: R,
    writer: Writer,
    pending: Pending,
    closed: Arc<AtomicBool>,
    tools_changed: Arc<AtomicBool>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Some servers print banners on stdout; ignore anything that isn't JSON.
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match classify(&msg) {
            Some(Incoming::Response {
                id: Some(id),
                outcome,
            }) => {
                let tx = pending.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(outcome);
                }
            }
            Some(Incoming::Request { id, method }) => {
                let _ = write_line(&writer, &reply_to_request(id, &method)).await;
            }
            Some(Incoming::Notification { method }) if is_tools_changed(&method) => {
                tools_changed.store(true, Ordering::SeqCst);
            }
            _ => {}
        }
    }
    closed.store(true, Ordering::SeqCst);
    let drained: Vec<_> = pending.lock().unwrap().drain().collect();
    for (_, tx) in drained {
        let _ = tx.send(Err(McpError::Closed));
    }
}

#[async_trait]
impl Transport for PipeTransport {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> McpResult<Value> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(McpError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.closed.load(Ordering::SeqCst) {
            self.forget(id);
            return Err(McpError::Closed);
        }
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(error) = self.write(&msg).await {
            self.forget(id);
            return Err(error);
        }
        let cancelled = async {
            match cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let failure = tokio::select! {
            r = rx => return r.unwrap_or(Err(McpError::Closed)),
            _ = tokio::time::sleep(timeout) => McpError::Timeout(timeout),
            _ = cancelled => McpError::Cancelled,
        };
        self.forget(id);
        let reason = match failure {
            McpError::Timeout(_) => "timeout",
            _ => "cancelled by client",
        };
        let _ = self
            .notify("notifications/cancelled", cancelled_params(id, reason))
            .await;
        Err(failure)
    }

    async fn notify(&self, method: &str, params: Value) -> McpResult<()> {
        self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    fn diagnostics(&self) -> Option<String> {
        let buf = self.stderr.as_ref()?.lock().unwrap();
        if buf.is_empty() {
            return None;
        }
        let tail: Vec<&str> = buf.iter().rev().take(20).map(String::as_str).collect();
        Some(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }

    async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.reader.abort();
        if let Ok(mut w) = self.writer.try_lock() {
            let _ = w.shutdown().await;
        }
        if let Some(guard) = &self.guard {
            guard.kill();
        }
    }
}

impl Drop for PipeTransport {
    fn drop(&mut self) {
        self.reader.abort();
        // `guard` kills the process tree in its own Drop.
    }
}

/// Owns a spawned server process and kills its whole tree on drop.
pub(crate) struct ProcessGuard {
    child: Mutex<Option<tokio::process::Child>>,
    #[cfg_attr(not(windows), allow(dead_code))]
    pid: Option<u32>,
}

impl ProcessGuard {
    pub(crate) fn kill(&self) {
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        let _ = child.start_kill();
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Find an executable for `command`, trying Windows shim extensions (`npx` is
/// `npx.cmd`). `dirs` are the PATH entries; `exts` the candidate suffixes in
/// priority order for extension-less commands.
pub(crate) fn resolve_with(command: &str, dirs: &[PathBuf], exts: &[&str]) -> Option<PathBuf> {
    let has_ext = Path::new(command).extension().is_some();
    let mut candidates: Vec<String> = Vec::new();
    if has_ext {
        candidates.push(command.to_string());
    }
    for ext in exts {
        candidates.push(format!("{command}{ext}"));
    }
    if !has_ext {
        candidates.push(command.to_string());
    }
    if command.contains('/') || command.contains('\\') {
        return candidates.iter().map(PathBuf::from).find(|p| p.is_file());
    }
    for dir in dirs {
        for cand in &candidates {
            let path = dir.join(cand);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn resolve_command(command: &str, path_override: Option<&OsStr>) -> PathBuf {
    if !cfg!(windows) {
        return PathBuf::from(command);
    }
    let path_var = path_override
        .map(OsStr::to_os_string)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    resolve_with(command, &dirs, &[".exe", ".cmd", ".bat", ".com"])
        .unwrap_or_else(|| PathBuf::from(command))
}

pub(crate) fn spawn_stdio(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: Option<&str>,
    tools_changed: Arc<AtomicBool>,
) -> McpResult<PipeTransport> {
    let path_override = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| OsStr::new(v.as_str()));
    let program = resolve_command(command, path_override);
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| McpError::Transport(format!("failed to spawn `{command}`: {e}")))?;
    let pid = child.id();
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let buf: StderrBuf = Arc::default();
    let sink = buf.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line: String = line.chars().take(STDERR_MAX_LINE_CHARS).collect();
            let mut b = sink.lock().unwrap();
            if b.len() >= STDERR_MAX_LINES {
                b.pop_front();
            }
            b.push_back(line);
        }
    });
    let guard = ProcessGuard {
        child: Mutex::new(Some(child)),
        pid,
    };
    Ok(PipeTransport::new(
        stdout,
        stdin,
        tools_changed,
        Some(guard),
        Some(buf),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cmd_shim() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("npx"), "").unwrap();
        std::fs::write(dir.path().join("npx.cmd"), "").unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        let found = resolve_with("npx", &dirs, &[".exe", ".cmd"]).unwrap();
        assert_eq!(found.file_name().unwrap(), "npx.cmd");
        let found = resolve_with("npx.cmd", &dirs, &[".exe"]).unwrap();
        assert_eq!(found.file_name().unwrap(), "npx.cmd");
        assert!(resolve_with("nope", &dirs, &[".exe"]).is_none());
    }

    #[tokio::test]
    async fn spawn_failure_is_reported() {
        let err = spawn_stdio(
            "definitely-not-a-real-binary-xyz",
            &[],
            &BTreeMap::new(),
            None,
            Arc::default(),
        )
        .err()
        .expect("should fail");
        assert!(err.to_string().contains("failed to spawn"));
    }
}
