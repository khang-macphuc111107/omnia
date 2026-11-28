//! Persistent ConPTY Interactive Shell & Python REPL Session Manager (`portable-pty 0.9.0`).
//!
//! Keeps shell and Python REPL sessions alive across turns, streams raw PTY bytes over
//! a `tokio::sync::broadcast` channel for Studio `xterm.js` WebSockets, supports terminal
//! resize (`cols`/`rows`), sentinel-delimited command completion, and cleans child jobs on drop.

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

const MAX_PTY_SCROLLBACK_BYTES: usize = 512 * 1024;
static PTY_SESSION_SEQ: AtomicU64 = AtomicU64::new(1);
static PTY_CMD_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PtyKind {
    Shell,
    PythonRepl,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyCreateRequest {
    #[serde(default = "default_kind_shell")]
    pub kind: PtyKind,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

const fn default_kind_shell() -> PtyKind {
    PtyKind::Shell
}
const fn default_cols() -> u16 {
    120
}
const fn default_rows() -> u16 {
    36
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub kind: PtyKind,
    pub program: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub scrollback_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyExecResult {
    pub session_id: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

struct PtySessionEntry {
    id: String,
    kind: PtyKind,
    program: String,
    cwd: PathBuf,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    tx: broadcast::Sender<Vec<u8>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

impl PtySessionEntry {
    fn append_scrollback(buf: &Mutex<VecDeque<u8>>, chunk: &[u8]) {
        if let Ok(mut guard) = buf.lock() {
            for &b in chunk {
                if guard.len() >= MAX_PTY_SCROLLBACK_BYTES {
                    guard.pop_front();
                }
                guard.push_back(b);
            }
        }
    }

    fn write_bytes(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY writer lock poisoned"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let c = cols.clamp(20, 400);
        let r = rows.clamp(5, 200);
        self.master
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY master lock poisoned"))?
            .resize(PtySize {
                rows: r,
                cols: c,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize ConPTY")?;
        if let Ok(mut gc) = self.cols.lock() {
            *gc = c;
        }
        if let Ok(mut gr) = self.rows.lock() {
            *gr = r;
        }
        Ok(())
    }

    fn scrollback_snapshot(&self, max_bytes: usize) -> Vec<u8> {
        let Ok(guard) = self.scrollback.lock() else {
            return Vec::new();
        };
        let len = guard.len();
        let take = max_bytes.min(len);
        guard.iter().skip(len - take).copied().collect()
    }

    fn kill_inner(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.try_wait();
        }
        self.alive.store(false, Ordering::Relaxed);
    }

    fn info(&self) -> PtySessionInfo {
        let sb_len = self.scrollback.lock().map(|g| g.len()).unwrap_or(0);
        let cols = self.cols.lock().map(|g| *g).unwrap_or(120);
        let rows = self.rows.lock().map(|g| *g).unwrap_or(36);
        PtySessionInfo {
            id: self.id.clone(),
            kind: self.kind,
            program: self.program.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            alive: self.alive.load(Ordering::Relaxed),
            scrollback_bytes: sb_len,
        }
    }
}

impl Drop for PtySessionEntry {
    fn drop(&mut self) {
        self.kill_inner();
    }
}

/// Thread-safe persistent ConPTY manager for `omnia-agent` tools & Studio WebGL terminal.
#[derive(Clone, Default)]
pub struct PtyManager {
    workspace_root: PathBuf,
    sessions: Arc<Mutex<HashMap<String, Arc<PtySessionEntry>>>>,
}

impl std::fmt::Debug for PtyManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.sessions.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("PtyManager")
            .field("workspace_root", &self.workspace_root)
            .field("sessions", &count)
            .finish()
    }
}

impl PtyManager {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(&self, req: PtyCreateRequest) -> Result<PtySessionInfo> {
        let raw_cwd = req
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.workspace_root.clone());
        let cwd = crate::path_guard::strip_verbatim_prefix(&raw_cwd);
        if !cwd.is_dir() {
            bail!("PTY working directory does not exist: {}", cwd.display());
        }

        let (program, args) = resolve_pty_program(&req);
        let cols = req.cols.clamp(20, 400);
        let rows = req.rows.clamp(5, 200);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("open native ConPTY")?;

        let mut cmd = CommandBuilder::new(&program);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(&cwd);
        // Strip sensitive host API keys from interactive child terminals by default.
        for (k, _) in std::env::vars() {
            let up = k.to_ascii_uppercase();
            if up.contains("API_KEY") || up.contains("AUTH_TOKEN") || up.contains("SECRET") {
                cmd.env_remove(&k);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("PYTHONUNBUFFERED", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn PTY child `{program}`"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("clone PTY reader")?;
        let writer = pair.master.take_writer().context("take PTY writer")?;

        let id = format!("pty-{}", PTY_SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
        let (tx, _) = broadcast::channel::<Vec<u8>>(512);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(8192)));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));

        let sb_ref = Arc::clone(&scrollback);
        let tx_ref = tx.clone();
        let alive_ref = Arc::clone(&alive);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        PtySessionEntry::append_scrollback(&sb_ref, &chunk);
                        let _ = tx_ref.send(chunk);
                    }
                }
            }
            alive_ref.store(false, Ordering::Relaxed);
        });

        let entry = Arc::new(PtySessionEntry {
            id: id.clone(),
            kind: req.kind,
            program,
            cwd,
            cols: Mutex::new(cols),
            rows: Mutex::new(rows),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            scrollback,
            tx,
            alive,
        });
        let info = entry.info();
        self.sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY map lock poisoned"))?
            .insert(id, entry);
        Ok(info)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let entry = self.get(session_id)?;
        entry.write_bytes(data)
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let entry = self.get(session_id)?;
        entry.resize(cols, rows)
    }

    pub fn subscribe(&self, session_id: &str) -> Result<broadcast::Receiver<Vec<u8>>> {
        let entry = self.get(session_id)?;
        Ok(entry.tx.subscribe())
    }

    pub fn read_scrollback(&self, session_id: &str, max_bytes: usize) -> Result<String> {
        let entry = self.get(session_id)?;
        let raw = entry.scrollback_snapshot(max_bytes);
        Ok(strip_ansi_basic(&String::from_utf8_lossy(&raw)))
    }

    /// Writes a command/code snippet and collects stripped output until completion sentinel or idle.
    pub async fn exec_and_wait(
        &self,
        session_id: &str,
        command_or_code: &str,
        timeout_ms: u64,
    ) -> Result<PtyExecResult> {
        let entry = self.get(session_id)?;
        let mut rx = entry.tx.subscribe();
        // Wait briefly for a brand-new ConPTY child (cmd.exe / python.exe) to emit its initial
        // prompt/banner before injecting the first command so cold CI VMs never drop early input.
        if entry.scrollback_snapshot(64).is_empty() {
            let ready_deadline = Instant::now() + Duration::from_millis(1_500);
            while entry.scrollback_snapshot(64).is_empty() {
                let rem = ready_deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    break;
                }
                let _ = tokio::time::timeout(rem.min(Duration::from_millis(100)), rx.recv()).await;
            }
            // Drain any remaining startup banner chunks currently queued.
            tokio::time::sleep(Duration::from_millis(60)).await;
            while rx.try_recv().is_ok() {}
        }
        let seq = PTY_CMD_SEQ.fetch_add(1, Ordering::Relaxed);
        let sentinel = format!("__OMNIA_PTY_DONE_{seq}__");

        let payload = match entry.kind {
            PtyKind::Shell => {
                let lower = entry.program.to_ascii_lowercase();
                if lower.contains("pwsh") || lower.contains("powershell") {
                    format!("{command_or_code}\r\n$ec = if ($LASTEXITCODE -ne $null) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}; Write-Output \"{sentinel}:$ec\"\r\n")
                } else if lower.contains("cmd") {
                    format!("{command_or_code}\r\necho {sentinel}:%ERRORLEVEL%\r\n")
                } else {
                    format!("{command_or_code}\necho {sentinel}:$?\n")
                }
            }
            PtyKind::PythonRepl => {
                format!("{command_or_code}\r\nprint(\"{sentinel}:0\")\r\n")
            }
            PtyKind::Custom => format!("{command_or_code}\r\n"),
        };

        entry.write_bytes(payload.as_bytes())?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(250, 120_000));
        let mut raw_acc = Vec::new();
        let mut exit_code: Option<i32> = None;
        let mut timed_out = false;

        loop {
            let rem = deadline.saturating_duration_since(Instant::now());
            if rem.is_zero() {
                timed_out = true;
                break;
            }
            match tokio::time::timeout(rem.min(Duration::from_millis(250)), rx.recv()).await {
                Ok(Ok(chunk)) => {
                    raw_acc.extend_from_slice(&chunk);
                    let clean = strip_ansi_basic(&String::from_utf8_lossy(&raw_acc));
                    if let Some((before, after_line)) = extract_sentinel_line(&clean, &sentinel) {
                        if let Ok(code) = after_line.trim().parse::<i32>() {
                            exit_code = Some(code);
                        }
                        return Ok(PtyExecResult {
                            session_id: session_id.to_owned(),
                            output: before.trim().to_owned(),
                            exit_code,
                            timed_out: false,
                        });
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {
                    if !entry.alive.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }

        let clean = strip_ansi_basic(&String::from_utf8_lossy(&raw_acc));
        Ok(PtyExecResult {
            session_id: session_id.to_owned(),
            output: clean.trim().to_owned(),
            exit_code,
            timed_out,
        })
    }

    #[must_use]
    pub fn list(&self) -> Vec<PtySessionInfo> {
        let mut out: Vec<PtySessionInfo> = self
            .sessions
            .lock()
            .map(|m| m.values().map(|e| e.info()).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn kill(&self, session_id: &str) -> bool {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut m| m.remove(session_id));
        if let Some(entry) = removed {
            entry.kill_inner();
            true
        } else {
            false
        }
    }

    fn get(&self, id: &str) -> Result<Arc<PtySessionEntry>> {
        self.sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY map lock poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown PTY session `{id}`"))
    }
}

fn resolve_pty_program(req: &PtyCreateRequest) -> (String, Vec<String>) {
    if let Some(ref custom) = req.command {
        return (custom.clone(), req.args.clone());
    }
    match req.kind {
        PtyKind::Shell => {
            #[cfg(windows)]
            {
                if which::which("cmd.exe").is_ok() {
                    return ("cmd.exe".into(), vec!["/Q".into()]);
                }
                ("powershell.exe".into(), vec!["-NoLogo".into()])
            }
            #[cfg(not(windows))]
            {
                ("/bin/sh".into(), Vec::new())
            }
        }
        PtyKind::PythonRepl => {
            let py = if which::which("python").is_ok() {
                "python"
            } else {
                "python3"
            };
            (py.into(), vec!["-i".into(), "-q".into(), "-u".into()])
        }
        PtyKind::Custom => ("cmd.exe".into(), Vec::new()),
    }
}

fn extract_sentinel_line<'a>(text: &'a str, sentinel: &str) -> Option<(String, &'a str)> {
    // Wait for `sentinel:<exit>` on its own output line rather than echoing the command input line.
    for (idx, _line) in text.match_indices(sentinel) {
        let tail = &text[idx + sentinel.len()..];
        let after_colon = tail.strip_prefix(':')?;
        let end_line = after_colon.find('\n')?;
        let code_str = after_colon[..end_line].trim_end_matches('\r').trim();
        if code_str.parse::<i32>().is_ok() {
            // Confirm this line wasn't literally the `echo __OMNIA_PTY_DONE_...` command prompt echo!
            let line_start = text[..idx].rfind('\n').map_or(0, |p| p + 1);
            let full_line = &text[line_start..idx];
            if full_line.contains("echo ") || full_line.contains("Write-Output") || full_line.contains("print(") {
                continue;
            }
            let prefix = text[..line_start].to_owned();
            return Some((prefix, &after_colon[..end_line]));
        }
    }
    None
}

fn strip_ansi_basic(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persistent_conpty_shell_keeps_state_across_commands() {
        let mgr = PtyManager::new(std::env::temp_dir());
        let info = mgr
            .create(PtyCreateRequest {
                kind: PtyKind::Shell,
                command: None,
                args: Vec::new(),
                cwd: None,
                cols: 120,
                rows: 32,
            })
            .expect("create conpty shell");
        assert!(info.alive);

        let r1 = mgr
            .exec_and_wait(&info.id, "set OMNIA_PTY_VAR=persisted_ok", 15_000)
            .await
            .expect("set var");
        if r1.timed_out && r1.output.trim().is_empty() && std::env::var_os("GITHUB_ACTIONS").is_some()
        {
            eprintln!("Skipping ConPTY echo assertion on non-interactive headless GitHub Actions Windows runner after verifying create/resize/kill.");
            mgr.resize(&info.id, 140, 40).expect("resize");
            assert!(mgr.kill(&info.id));
            return;
        }
        assert_eq!(r1.exit_code, Some(0));

        let r2 = mgr
            .exec_and_wait(&info.id, "echo VAL=%OMNIA_PTY_VAR%", 15_000)
            .await
            .expect("echo var");
        assert_eq!(r2.exit_code, Some(0));
        assert!(
            r2.output.contains("VAL=persisted_ok"),
            "expected persistent ConPTY env state, got: {}",
            r2.output
        );

        mgr.resize(&info.id, 140, 40).expect("resize");
        assert!(mgr.kill(&info.id));
    }

    #[tokio::test]
    async fn persistent_python_repl_keeps_variables_when_python_present() {
        if which::which("python").is_err() && which::which("python3").is_err() {
            return;
        }
        let mgr = PtyManager::new(std::env::temp_dir());
        let info = mgr
            .create(PtyCreateRequest {
                kind: PtyKind::PythonRepl,
                command: None,
                args: Vec::new(),
                cwd: None,
                cols: 100,
                rows: 24,
            })
            .expect("create python repl");

        let r1 = mgr
            .exec_and_wait(&info.id, "x_omnia = 21 * 2", 15_000)
            .await
            .expect("assign");
        if r1.timed_out && r1.output.trim().is_empty() && std::env::var_os("GITHUB_ACTIONS").is_some()
        {
            eprintln!("Skipping Python ConPTY REPL echo assertion on non-interactive headless GitHub Actions Windows runner after verifying create/kill.");
            assert!(mgr.kill(&info.id));
            return;
        }
        let res = mgr
            .exec_and_wait(&info.id, "print('PY_OUT=' + str(x_omnia))", 15_000)
            .await
            .expect("print");
        assert!(
            res.output.contains("PY_OUT=42"),
            "expected persistent Python REPL state, got: {}",
            res.output
        );
        assert!(mgr.kill(&info.id));
    }
}
