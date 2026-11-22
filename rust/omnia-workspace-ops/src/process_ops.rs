//! Bounded subprocess execution with workspace-contained `cwd`, timeout enforcement,
//! process-tree termination receipts, and capped stdout/stderr capture.

use crate::path_guard::{
    is_reparse_point_metadata, relative_posix_path, resolve_contained_path, resolve_workspace_root,
};
use crate::{io_err, WorkspaceOpsError};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Default stdout capture cap (64 KiB).
pub const DEFAULT_MAX_STDOUT_BYTES: usize = 64 * 1024;
/// Default stderr capture cap (64 KiB).
pub const DEFAULT_MAX_STDERR_BYTES: usize = 64 * 1024;
/// Default bounded execution timeout (10 seconds).
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Specification for running a bounded subprocess inside a workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout_ms: u64,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub env_overrides: Vec<(String, String)>,
    pub clear_env: bool,
}

impl CommandSpec {
    /// Creates a new specification with safe defaults (`10s` timeout, `64 KiB` stdout/stderr caps).
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_stdout_bytes: DEFAULT_MAX_STDOUT_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            env_overrides: Vec::new(),
            clear_env: false,
        }
    }

    pub fn with_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_cwd(mut self, cwd: impl AsRef<Path>) -> Self {
        self.cwd = Some(cwd.as_ref().to_path_buf());
        self
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub fn with_max_stdout_bytes(mut self, max_bytes: usize) -> Self {
        self.max_stdout_bytes = max_bytes;
        self
    }

    pub fn with_max_stderr_bytes(mut self, max_bytes: usize) -> Self {
        self.max_stderr_bytes = max_bytes;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.env_overrides.push((key.into(), val.into()));
        self
    }

    pub fn with_clear_env(mut self, clear_env: bool) -> Self {
        self.clear_env = clear_env;
        self
    }
}

/// Receipt returned by [`run_bounded_command`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReceipt {
    pub program: String,
    pub args: Vec<String>,
    pub resolved_cwd: PathBuf,
    pub relative_cwd: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub termination_reason: Option<String>,
    pub duration_ms: u64,
    pub timeout_ms: u64,
    pub stdout: String,
    pub stdout_truncated: bool,
    pub stdout_total_bytes: usize,
    pub stderr: String,
    pub stderr_truncated: bool,
    pub stderr_total_bytes: usize,
}

impl Serialize for CommandReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CommandReceipt", 17)?;
        s.serialize_field("program", &self.program)?;
        s.serialize_field("args", &self.args)?;
        s.serialize_field("resolved_cwd", &self.resolved_cwd.display().to_string())?;
        s.serialize_field("relative_cwd", &self.relative_cwd)?;
        s.serialize_field("pid", &self.pid)?;
        s.serialize_field("exit_code", &self.exit_code)?;
        s.serialize_field("success", &self.success)?;
        s.serialize_field("timed_out", &self.timed_out)?;
        s.serialize_field("termination_reason", &self.termination_reason)?;
        s.serialize_field("duration_ms", &self.duration_ms)?;
        s.serialize_field("timeout_ms", &self.timeout_ms)?;
        s.serialize_field("stdout", &self.stdout)?;
        s.serialize_field("stdout_truncated", &self.stdout_truncated)?;
        s.serialize_field("stdout_total_bytes", &self.stdout_total_bytes)?;
        s.serialize_field("stderr", &self.stderr)?;
        s.serialize_field("stderr_truncated", &self.stderr_truncated)?;
        s.serialize_field("stderr_total_bytes", &self.stderr_total_bytes)?;
        s.end()
    }
}

/// Executes `spec` with verified workspace `cwd`, `timeout_ms` kill enforcement, and capped
/// stdout/stderr capture.
pub fn run_bounded_command(
    root: impl AsRef<Path>,
    spec: &CommandSpec,
) -> Result<CommandReceipt, WorkspaceOpsError> {
    validate_spec(spec)?;

    let canonical_root = resolve_workspace_root(root)?;
    let resolved_cwd = match spec.cwd {
        Some(ref cwd) => resolve_contained_path(&canonical_root, cwd)?,
        None => canonical_root.clone(),
    };

    let cwd_meta = fs::symlink_metadata(&resolved_cwd)
        .map_err(|e| io_err("symlink_metadata", &resolved_cwd, e))?;
    if is_reparse_point_metadata(&cwd_meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: resolved_cwd.display().to_string(),
        });
    }
    if !cwd_meta.is_dir() {
        return Err(WorkspaceOpsError::NotADirectory {
            path: resolved_cwd.display().to_string(),
        });
    }
    let relative_cwd = relative_posix_path(&canonical_root, &resolved_cwd)?;

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&resolved_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if spec.clear_env {
        cmd.env_clear();
    }
    for (k, v) in &spec.env_overrides {
        cmd.env(k, v);
    }

    let start = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| io_err("spawn_command", Path::new(&spec.program), e))?;
    let pid = Some(child.id());

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let (stdout_buf, stdout_done) = spawn_stream_drainer(stdout_pipe, spec.max_stdout_bytes);
    let (stderr_buf, stderr_done) = spawn_stream_drainer(stderr_pipe, spec.max_stderr_bytes);

    let timeout = Duration::from_millis(spec.timeout_ms);
    let mut exit_code: Option<i32> = None;
    let mut success = false;
    let mut timed_out = false;
    let mut termination_reason: Option<String> = None;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                success = status.success();
                if !success && exit_code.is_none() {
                    termination_reason = Some("terminated_by_signal".to_string());
                }
                break;
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    termination_reason = Some("timeout_killed".to_string());
                    terminate_process_tree(&mut child);
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                terminate_process_tree(&mut child);
                return Err(io_err("try_wait", Path::new(&spec.program), e));
            }
        }
    }

    let drain_grace = if timed_out {
        Duration::from_millis(250)
    } else {
        Duration::from_secs(2)
    };
    let _ = stdout_done.recv_timeout(drain_grace);
    let _ = stderr_done.recv_timeout(drain_grace);

    let duration_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let out_cap = take_capture_snapshot(&stdout_buf);
    let err_cap = take_capture_snapshot(&stderr_buf);

    Ok(CommandReceipt {
        program: spec.program.clone(),
        args: spec.args.clone(),
        resolved_cwd,
        relative_cwd,
        pid,
        exit_code,
        success,
        timed_out,
        termination_reason,
        duration_ms,
        timeout_ms: spec.timeout_ms,
        stdout: String::from_utf8_lossy(&out_cap.bytes).into_owned(),
        stdout_truncated: out_cap.truncated,
        stdout_total_bytes: out_cap.total_bytes,
        stderr: String::from_utf8_lossy(&err_cap.bytes).into_owned(),
        stderr_truncated: err_cap.truncated,
        stderr_total_bytes: err_cap.total_bytes,
    })
}

fn validate_spec(spec: &CommandSpec) -> Result<(), WorkspaceOpsError> {
    if spec.program.trim().is_empty() {
        return Err(WorkspaceOpsError::InvalidCommandSpec {
            reason: "program cannot be empty".to_string(),
        });
    }
    if spec.program.contains('\0') {
        return Err(WorkspaceOpsError::NulByteInPath {
            context: "command_program",
        });
    }
    for arg in &spec.args {
        if arg.contains('\0') {
            return Err(WorkspaceOpsError::NulByteInPath {
                context: "command_arg",
            });
        }
    }
    for (k, v) in &spec.env_overrides {
        if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
            return Err(WorkspaceOpsError::InvalidCommandSpec {
                reason: format!("invalid environment override key `{k}`"),
            });
        }
    }
    if spec.timeout_ms == 0 {
        return Err(WorkspaceOpsError::InvalidCommandSpec {
            reason: "timeout_ms must be greater than zero".to_string(),
        });
    }
    Ok(())
}

#[derive(Default, Clone)]
struct StreamCapture {
    bytes: Vec<u8>,
    total_bytes: usize,
    truncated: bool,
}

fn spawn_stream_drainer<R: Read + Send + 'static>(
    stream: Option<R>,
    max_bytes: usize,
) -> (Arc<Mutex<StreamCapture>>, mpsc::Receiver<()>) {
    let cap = Arc::new(Mutex::new(StreamCapture::default()));
    let (tx, rx) = mpsc::channel();

    match stream {
        None => {
            let _ = tx.send(());
        }
        Some(mut reader) => {
            let cap_clone = Arc::clone(&cap);
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Ok(mut guard) = cap_clone.lock() {
                                guard.total_bytes = guard.total_bytes.saturating_add(n);
                                let remaining = max_bytes.saturating_sub(guard.bytes.len());
                                let take = remaining.min(n);
                                if take > 0 {
                                    guard.bytes.extend_from_slice(&buf[..take]);
                                }
                                if take < n {
                                    guard.truncated = true;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = tx.send(());
            });
        }
    }

    (cap, rx)
}

fn take_capture_snapshot(cap: &Arc<Mutex<StreamCapture>>) -> StreamCapture {
    match cap.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static PROC_SEQ: AtomicU64 = AtomicU64::new(1);

    struct ProcSandbox {
        base: PathBuf,
        root: PathBuf,
        outside: PathBuf,
    }

    impl ProcSandbox {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let seq = PROC_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "omnia-proc-ops-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            let root = base.join("workspace");
            let outside = base.join("outside");
            fs::create_dir_all(&root).expect("create workspace");
            fs::create_dir_all(&outside).expect("create outside");
            Self {
                base,
                root,
                outside,
            }
        }
    }

    impl Drop for ProcSandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn bounded_command_succeeds_in_contained_cwd() {
        let sb = ProcSandbox::new("success");
        fs::create_dir_all(sb.root.join("sub")).expect("mkdir sub");

        #[cfg(windows)]
        let spec = CommandSpec::new("cmd")
            .with_args(["/C", "cd && echo hello_stdout && echo hello_stderr 1>&2"])
            .with_cwd("sub")
            .with_timeout_ms(5_000);

        #[cfg(not(windows))]
        let spec = CommandSpec::new("sh")
            .with_args(["-c", "pwd && echo hello_stdout && echo hello_stderr >&2"])
            .with_cwd("sub")
            .with_timeout_ms(5_000);

        let receipt = run_bounded_command(&sb.root, &spec).expect("command succeeds");
        assert!(receipt.success);
        assert_eq!(receipt.exit_code, Some(0));
        assert!(!receipt.timed_out);
        assert_eq!(receipt.termination_reason, None);
        assert_eq!(receipt.relative_cwd, "sub");
        assert!(receipt.stdout.contains("hello_stdout"));
        assert!(receipt.stderr.contains("hello_stderr"));
        assert!(!receipt.stdout_truncated);
        assert!(!receipt.stderr_truncated);
    }

    #[test]
    fn bounded_command_rejects_escaped_cwd_and_zero_timeout() {
        let sb = ProcSandbox::new("reject");

        let traversal_spec = CommandSpec::new("cmd")
            .with_args(["/C", "echo no"])
            .with_cwd("../outside")
            .with_timeout_ms(1_000);
        let err = run_bounded_command(&sb.root, &traversal_spec)
            .expect_err("traversal cwd must be rejected");
        assert!(matches!(err, WorkspaceOpsError::PathTraversal { .. }));

        let outside_spec = CommandSpec::new("cmd")
            .with_args(["/C", "echo no"])
            .with_cwd(&sb.outside)
            .with_timeout_ms(1_000);
        let err =
            run_bounded_command(&sb.root, &outside_spec).expect_err("outside cwd must be rejected");
        assert!(matches!(err, WorkspaceOpsError::OutsideWorkspace { .. }));

        let zero_timeout = CommandSpec::new("cmd")
            .with_args(["/C", "echo no"])
            .with_timeout_ms(0);
        let err = run_bounded_command(&sb.root, &zero_timeout)
            .expect_err("zero timeout must be rejected");
        assert!(matches!(err, WorkspaceOpsError::InvalidCommandSpec { .. }));
    }

    #[test]
    fn bounded_command_caps_stdout_and_stderr_bytes() {
        let sb = ProcSandbox::new("caps");

        #[cfg(windows)]
        let spec = CommandSpec::new("cmd")
            .with_args([
                "/C",
                "for /L %i in (1,1,20) do @(echo STDOUT_LINE_0123456789ABCDEF & echo STDERR_LINE_0123456789ABCDEF 1>&2)",
            ])
            .with_timeout_ms(5_000)
            .with_max_stdout_bytes(32)
            .with_max_stderr_bytes(24);

        #[cfg(not(windows))]
        let spec = CommandSpec::new("sh")
            .with_args([
                "-c",
                "i=0; while [ $i -lt 20 ]; do echo STDOUT_LINE_0123456789ABCDEF; echo STDERR_LINE_0123456789ABCDEF >&2; i=$((i+1)); done",
            ])
            .with_timeout_ms(5_000)
            .with_max_stdout_bytes(32)
            .with_max_stderr_bytes(24);

        let receipt = run_bounded_command(&sb.root, &spec).expect("capped run");
        assert!(receipt.success);
        assert!(receipt.stdout_truncated);
        assert!(receipt.stdout.len() <= 32);
        assert!(receipt.stdout_total_bytes > 32);
        assert!(receipt.stderr_truncated);
        assert!(receipt.stderr.len() <= 24);
        assert!(receipt.stderr_total_bytes > 24);
    }

    #[test]
    fn bounded_command_enforces_timeout_and_emits_termination_receipt() {
        let sb = ProcSandbox::new("timeout");

        #[cfg(windows)]
        let spec = CommandSpec::new("cmd")
            .with_args([
                "/C",
                "echo partial_before_sleep & ping -n 10 127.0.0.1 >nul",
            ])
            .with_timeout_ms(180);

        #[cfg(not(windows))]
        let spec = CommandSpec::new("sh")
            .with_args(["-c", "echo partial_before_sleep && sleep 10"])
            .with_timeout_ms(180);

        let wall_start = Instant::now();
        let receipt = run_bounded_command(&sb.root, &spec).expect("timeout receipt");
        let elapsed = wall_start.elapsed();

        assert!(receipt.timed_out);
        assert!(!receipt.success);
        assert_eq!(receipt.exit_code, None);
        assert_eq!(
            receipt.termination_reason.as_deref(),
            Some("timeout_killed")
        );
        assert!(receipt.duration_ms >= 150);
        assert!(
            elapsed < Duration::from_secs(4),
            "process kill took too long: {elapsed:?}"
        );
        assert!(receipt.stdout.contains("partial_before_sleep"));
    }
}
