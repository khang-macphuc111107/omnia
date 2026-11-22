//! Bounded subprocess execution with workspace-contained `cwd`, Win32 Job Object process-tree
//! supervision (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), zero-busy-poll timeout enforcement, and
//! capped stdout/stderr capture.

use crate::path_guard::{
    is_reparse_point_metadata, relative_posix_path, resolve_contained_path, resolve_workspace_root,
};
use crate::{io_err, WorkspaceOpsError};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::fs;
use std::io::{self, Read};
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

/// RAII process-tree supervisor backed by a Win32 Job Object (`KILL_ON_JOB_CLOSE`) on Windows.
///
/// Dropping or calling [`ProcessSupervisor::kill_tree`] guarantees that the child and every
/// descendant grandchild process are terminated synchronously by the OS kernel with zero orphans.
#[derive(Debug)]
pub struct ProcessSupervisor {
    #[cfg(windows)]
    job_handle: isize,
    root_pid: u32,
}

impl ProcessSupervisor {
    /// Creates an empty Win32 Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    pub fn new(root_pid: u32) -> io::Result<Self> {
        use core::ffi::c_void;
        use core::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: Creating an unnamed Job Object with null security attributes and null name is
        // valid; handle is checked for null before use and closed on error or Drop.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let info_len = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .unwrap_or(u32::MAX);
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                info_len,
            ) == 0
            {
                let err = io::Error::last_os_error();
                let _ = CloseHandle(job);
                return Err(err);
            }

            Ok(Self {
                job_handle: job as isize,
                root_pid,
            })
        }
    }

    #[cfg(not(windows))]
    pub fn new(root_pid: u32) -> io::Result<Self> {
        Ok(Self { root_pid })
    }

    /// Returns the supervised root child PID.
    #[must_use]
    pub const fn root_pid(&self) -> u32 {
        self.root_pid
    }

    /// Assigns an existing `Child` process handle to this Win32 Job Object.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    pub fn assign_child(&mut self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        if self.job_handle == 0 {
            return Err(io::Error::other("process supervisor job handle is closed"));
        }
        self.root_pid = child.id();
        // SAFETY: Both `self.job_handle` and `child.as_raw_handle()` are valid open Win32 handles.
        unsafe {
            if AssignProcessToJobObject(self.job_handle as HANDLE, child.as_raw_handle() as HANDLE)
                == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn assign_child(&mut self, child: &Child) -> io::Result<()> {
        self.root_pid = child.id();
        Ok(())
    }

    /// Terminates every process in the supervised tree immediately and releases the Job handle.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    pub fn kill_tree(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        if self.job_handle != 0 {
            let handle = self.job_handle as HANDLE;
            self.job_handle = 0;
            // SAFETY: `handle` is an owned Job Object handle created by `CreateJobObjectW`.
            unsafe {
                let _ = TerminateJobObject(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }

    #[cfg(not(windows))]
    pub fn kill_tree(&mut self) {
        let _ = self.root_pid;
    }
}

#[cfg(windows)]
impl Drop for ProcessSupervisor {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

        if self.job_handle != 0 {
            let handle = self.job_handle as HANDLE;
            self.job_handle = 0;
            // SAFETY: Closing the last Job Object handle with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
            // terminates any remaining descendant processes and frees the kernel handle.
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }
}

/// Spawns `cmd` inside a dedicated Win32 Job Object (`CREATE_NO_WINDOW | CREATE_SUSPENDED` ->
/// `AssignProcessToJobObject` -> resume threads) so no grandchild can escape supervision.
#[cfg(windows)]
pub fn spawn_supervised_command(cmd: &mut Command) -> io::Result<(Child, ProcessSupervisor)> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let mut supervisor = match ProcessSupervisor::new(pid) {
        Ok(sup) => sup,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };

    if let Err(err) = supervisor.assign_child(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    if let Err(err) = resume_process_threads(pid) {
        supervisor.kill_tree();
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    Ok((child, supervisor))
}

/// Spawns `cmd` with a portable supervisor wrapper on non-Windows targets.
#[cfg(not(windows))]
pub fn spawn_supervised_command(cmd: &mut Command) -> io::Result<(Child, ProcessSupervisor)> {
    let child = cmd.spawn()?;
    let supervisor = ProcessSupervisor::new(child.id())?;
    Ok((child, supervisor))
}

/// Returns `true` if `pid` currently refers to a live (non-exited) OS process.
#[cfg(windows)]
#[allow(unsafe_code)]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }
    // SAFETY: `OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION` is read-only and closed
    // unconditionally before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code) != 0;
        let _ = CloseHandle(handle);
        ok && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Collects `root_pid` and all currently running descendant PIDs via Toolhelp32 process snapshot.
#[cfg(windows)]
#[allow(unsafe_code)]
#[must_use]
pub fn collect_process_tree_pids(root_pid: u32) -> Vec<u32> {
    use core::mem::{size_of, zeroed};
    use std::collections::{HashMap, HashSet, VecDeque};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    if root_pid == 0 {
        return Vec::new();
    }

    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut existing_pids: HashSet<u32> = HashSet::new();

    // SAFETY: Toolhelp32 snapshot handle is checked against `INVALID_HANDLE_VALUE` and closed.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return Vec::new();
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or(0);
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                existing_pids.insert(entry.th32ProcessID);
                children_by_parent
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    if !existing_pids.contains(&root_pid) {
        return Vec::new();
    }

    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    let mut tree = Vec::new();
    visited.insert(root_pid);
    queue.push_back(root_pid);

    while let Some(pid) = queue.pop_front() {
        tree.push(pid);
        if let Some(kids) = children_by_parent.get(&pid) {
            for &kid in kids {
                if visited.insert(kid) {
                    queue.push_back(kid);
                }
            }
        }
    }

    tree
}

#[cfg(not(windows))]
#[must_use]
pub fn collect_process_tree_pids(root_pid: u32) -> Vec<u32> {
    if pid_is_alive(root_pid) {
        vec![root_pid]
    } else {
        Vec::new()
    }
}

/// Sums the working set (RSS) in bytes across `root_pid` and all currently live descendants.
#[cfg(windows)]
#[allow(unsafe_code)]
#[must_use]
pub fn process_tree_rss_bytes(root_pid: u32) -> u64 {
    use core::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    let mut total = 0u64;
    for pid in collect_process_tree_pids(root_pid) {
        // SAFETY: Querying process memory counters on an open process handle closed before next step.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if handle.is_null() {
                continue;
            }
            let mut counters: PROCESS_MEMORY_COUNTERS = zeroed();
            counters.cb = u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>()).unwrap_or(0);
            if GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
                total = total.saturating_add(u64::try_from(counters.WorkingSetSize).unwrap_or(0));
            }
            let _ = CloseHandle(handle);
        }
    }
    total
}

#[cfg(not(windows))]
#[must_use]
pub fn process_tree_rss_bytes(_root_pid: u32) -> u64 {
    0
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn resume_process_threads(pid: u32) -> io::Result<()> {
    use core::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };

    // SAFETY: Toolhelp32 thread snapshot enumerates threads for `pid`; each opened thread handle
    // is resumed and closed unconditionally.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut resumed_any = false;
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = u32::try_from(size_of::<THREADENTRY32>()).unwrap_or(0);
        if Thread32First(snap, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == pid {
                    let thread_handle = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread_handle.is_null() {
                        let _ = ResumeThread(thread_handle);
                        let _ = CloseHandle(thread_handle);
                        resumed_any = true;
                    }
                }
                if Thread32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);

        if resumed_any {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "no threads found to resume for supervised pid {pid}"
            )))
        }
    }
}

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

/// Executes `spec` with verified workspace `cwd`, Win32 Job Object supervision, zero-busy-poll
/// `timeout_ms` kill enforcement, and capped stdout/stderr capture.
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

    let (mut child, mut supervisor) = spawn_supervised_command(&mut cmd)
        .map_err(|e| io_err("spawn_command", Path::new(&spec.program), e))?;
    let start = Instant::now();
    let pid = Some(child.id());

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let (stdout_buf, stdout_done) = spawn_stream_drainer(stdout_pipe, spec.max_stdout_bytes);
    let (stderr_buf, stderr_done) = spawn_stream_drainer(stderr_pipe, spec.max_stderr_bytes);

    let timeout = Duration::from_millis(spec.timeout_ms);
    let wait_outcome = wait_child_bounded(&mut child, &mut supervisor, timeout)
        .map_err(|e| io_err("wait_bounded", Path::new(&spec.program), e))?;

    let (exit_code, success, timed_out, termination_reason) = match wait_outcome {
        WaitOutcome::Exited(status) => {
            let code = status.code();
            let ok = status.success();
            let reason = if !ok && code.is_none() {
                Some("terminated_by_signal".to_string())
            } else {
                None
            };
            (code, ok, false, reason)
        }
        WaitOutcome::TimedOut => (None, false, true, Some("timeout_killed".to_string())),
    };

    // Ensure any lingering background grandchildren spawned by a short-lived parent are reaped.
    // Because the Win32 Job Object closes all descendant write-ends synchronously, the drainer
    // threads reach EOF promptly as soon as the OS schedules them.
    supervisor.kill_tree();

    let drain_grace = Duration::from_secs(2);
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

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn wait_child_bounded(
    child: &mut Child,
    supervisor: &mut ProcessSupervisor,
    timeout: Duration,
) -> io::Result<WaitOutcome> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        let remaining_ms = if now >= deadline {
            0u32
        } else {
            let rem = deadline.saturating_duration_since(now).as_millis();
            u32::try_from(rem.min(u128::from(u32::MAX - 1))).unwrap_or(u32::MAX - 1)
        };

        // SAFETY: `child.as_raw_handle()` is a valid process handle owned by `child`.
        let wait_rc = unsafe { WaitForSingleObject(child.as_raw_handle() as HANDLE, remaining_ms) };
        if wait_rc == WAIT_OBJECT_0 {
            let status = child.wait()?;
            return Ok(WaitOutcome::Exited(status));
        }
        if wait_rc == WAIT_TIMEOUT {
            if Instant::now() >= deadline {
                supervisor.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                return Ok(WaitOutcome::TimedOut);
            }
            continue;
        }
        supervisor.kill_tree();
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::last_os_error());
    }
}

#[cfg(not(windows))]
fn wait_child_bounded(
    child: &mut Child,
    supervisor: &mut ProcessSupervisor,
    timeout: Duration,
) -> io::Result<WaitOutcome> {
    let deadline = Instant::now() + timeout;
    let poll_step = Duration::from_millis(10);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(WaitOutcome::Exited(status));
        }
        let now = Instant::now();
        if now >= deadline {
            supervisor.kill_tree();
            let _ = child.kill();
            let _ = child.wait();
            return Ok(WaitOutcome::TimedOut);
        }
        thread::sleep(deadline.saturating_duration_since(now).min(poll_step));
    }
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
                "echo partial_before_sleep & ping -n 15 127.0.0.1 >nul",
            ])
            .with_timeout_ms(1_500);

        #[cfg(not(windows))]
        let spec = CommandSpec::new("sh")
            .with_args(["-c", "echo partial_before_sleep && sleep 15"])
            .with_timeout_ms(1_500);

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
        assert!(receipt.duration_ms >= 1_400);
        assert!(
            elapsed < Duration::from_secs(8),
            "process kill took too long: {elapsed:?}"
        );
        assert!(
            receipt.stdout.contains("partial_before_sleep"),
            "expected partial stdout before timeout, got stdout={:?} stderr={:?}",
            receipt.stdout,
            receipt.stderr
        );
    }

    #[cfg(windows)]
    #[test]
    fn win32_job_object_kills_child_and_grandchild_without_orphans() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/C", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let (mut child, mut supervisor) =
            spawn_supervised_command(&mut cmd).expect("spawn supervised cmd");
        let root_pid = child.id();
        assert_eq!(supervisor.root_pid(), root_pid);

        // Wait up to 3s for cmd.exe to spawn grandchild ping.exe.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut tree_pids = Vec::new();
        while Instant::now() < deadline {
            tree_pids = collect_process_tree_pids(root_pid);
            if tree_pids.len() >= 2 {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            tree_pids.len() >= 2,
            "expected cmd.exe + grandchild ping.exe in process tree, got {tree_pids:?}"
        );
        assert!(process_tree_rss_bytes(root_pid) > 0);
        for &pid in &tree_pids {
            assert!(pid_is_alive(pid), "expected pid {pid} to be alive before kill");
        }

        supervisor.kill_tree();
        let _ = child.wait();

        // Allow brief kernel teardown window and assert zero surviving child or grandchild PIDs.
        let verify_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < verify_deadline {
            if tree_pids.iter().all(|&pid| !pid_is_alive(pid)) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        for &pid in &tree_pids {
            assert!(
                !pid_is_alive(pid),
                "orphan process {pid} survived Win32 Job Object kill_tree"
            );
        }
    }
}
