//! Cross-platform zero-orphan process-tree supervision & process-tree RSS measurement.
//!
//! On Windows, every child process is spawned with `CREATE_NO_WINDOW | CREATE_SUSPENDED`,
//! assigned to a Win32 Job Object carrying `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and
//! then resumed via `ResumeThread` so no grandchild can escape supervision.

use anyhow::Result;
use std::process::{Child, Command};
use std::sync::atomic::Ordering;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::sync::atomic::AtomicPtr;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::sync::atomic::AtomicI32;

/// Win32 creation flag preventing console window flash for child spawns.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Win32 creation flag suspending the primary thread until Job assignment completes.
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE, PROCESS_VM_READ, THREAD_SUSPEND_RESUME,
};

#[cfg(windows)]
pub struct ProcessSupervisor {
    job: AtomicPtr<core::ffi::c_void>,
}

#[cfg(unix)]
pub struct ProcessSupervisor {
    pgid: AtomicI32,
}

/// Provider API key environment variables stripped from every workspace/tool child process.
pub const SENSITIVE_PROVIDER_ENV_VARS: &[&str] = &[
    "OMNIA_API_KEY",
    "HTMUSTC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
];

/// Strip provider credential environment variables from a `std::process::Command`.
pub fn strip_provider_secrets(cmd: &mut Command) {
    for var in SENSITIVE_PROVIDER_ENV_VARS {
        cmd.env_remove(var);
    }
}

/// Strip provider credential environment variables from a `tokio::process::Command`.
pub fn strip_provider_secrets_tokio(cmd: &mut tokio::process::Command) {
    for var in SENSITIVE_PROVIDER_ENV_VARS {
        cmd.env_remove(var);
    }
}

impl ProcessSupervisor {
    #[cfg(unix)]
    pub fn prepare(cmd: &mut Command) {
        strip_provider_secrets(cmd);
        cmd.process_group(0);
    }

    #[cfg(windows)]
    pub fn prepare(cmd: &mut Command) {
        strip_provider_secrets(cmd);
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    #[must_use]
    pub fn attach(child: &Child) -> Self {
        let pgid = i32::try_from(child.id()).unwrap_or(0);
        Self {
            pgid: AtomicI32::new(pgid),
        }
    }

    #[cfg(windows)]
    #[must_use]
    pub fn attach(child: &Child) -> Self {
        Self::attach_process(child.as_raw_handle())
    }

    #[cfg(windows)]
    #[allow(clippy::not_unsafe_ptr_arg_deref)]
    #[must_use]
    pub fn attach_process(process: HANDLE) -> Self {
        let job: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Self::unsupervised();
        }

        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };

        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .unwrap_or_default(),
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(job) };
            return Self::unsupervised();
        }

        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        if assigned == 0 {
            unsafe { CloseHandle(job) };
            return Self::unsupervised();
        }

        Self {
            job: AtomicPtr::new(job),
        }
    }

    #[cfg(windows)]
    #[must_use]
    pub fn attach_pid(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return Self::unsupervised();
        }
        let sup = Self::attach_process(handle);
        unsafe { CloseHandle(handle) };
        sup
    }

    #[cfg(windows)]
    #[must_use]
    pub const fn unsupervised() -> Self {
        Self {
            job: AtomicPtr::new(std::ptr::null_mut()),
        }
    }

    #[cfg(unix)]
    #[must_use]
    pub const fn unsupervised() -> Self {
        Self {
            pgid: AtomicI32::new(0),
        }
    }

    #[cfg(unix)]
    pub fn kill_tree(&self) {
        let pgid = self.pgid.swap(0, Ordering::AcqRel);
        if pgid != 0 {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }

    #[cfg(windows)]
    pub fn kill_tree(&self) {
        let job = self.job.swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !job.is_null() {
            unsafe {
                CloseHandle(job);
            }
        }
    }

    #[cfg(windows)]
    #[must_use]
    pub fn is_supervised(&self) -> bool {
        !self.job.load(Ordering::Acquire).is_null()
    }

    #[cfg(unix)]
    #[must_use]
    pub fn is_supervised(&self) -> bool {
        self.pgid.load(Ordering::Acquire) != 0
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        self.kill_tree();
    }
}

#[cfg(windows)]
fn resume_process_threads(pid: u32) {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snap == INVALID_HANDLE_VALUE || snap.is_null() {
        return;
    }
    let mut te = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    if unsafe { Thread32First(snap, &mut te) } != 0 {
        loop {
            if te.th32OwnerProcessID == pid {
                let th = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID) };
                if !th.is_null() {
                    unsafe {
                        ResumeThread(th);
                        CloseHandle(th);
                    }
                }
            }
            if unsafe { Thread32Next(snap, &mut te) } == 0 {
                break;
            }
        }
    }
    unsafe { CloseHandle(snap) };
}

/// Spawn a `std::process::Command` with zero-race Job Object supervision and
/// stripped provider credential env vars.
pub fn spawn_supervised_command(cmd: &mut Command) -> Result<(Child, ProcessSupervisor)> {
    strip_provider_secrets(cmd);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let child = cmd.spawn()?;
        let pid = child.id();
        let sup = ProcessSupervisor::attach(&child);
        resume_process_threads(pid);
        Ok((child, sup))
    }

    #[cfg(unix)]
    {
        ProcessSupervisor::prepare(cmd);
        let child = cmd.spawn()?;
        let sup = ProcessSupervisor::attach(&child);
        Ok((child, sup))
    }
}

/// Check if a process is still alive.
#[cfg(windows)]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut code = 0u32;
    let queried = unsafe { GetExitCodeProcess(process, std::ptr::addr_of_mut!(code)) };
    unsafe { CloseHandle(process) };
    queried == 0 || code == STILL_ACTIVE.cast_unsigned()
}

#[cfg(unix)]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Compute total Working Set RSS in bytes for `root_pid` plus all recursive descendants.
#[cfg(windows)]
#[must_use]
pub fn process_tree_rss_bytes(root_pid: u32) -> u64 {
    let mut children_map: std::collections::HashMap<u32, Vec<u32>> =
        std::collections::HashMap::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap != INVALID_HANDLE_VALUE && !snap.is_null() {
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snap, &mut pe) } != 0 {
            loop {
                children_map
                    .entry(pe.th32ParentProcessID)
                    .or_default()
                    .push(pe.th32ProcessID);
                if unsafe { Process32NextW(snap, &mut pe) } == 0 {
                    break;
                }
            }
        }
        unsafe { CloseHandle(snap) };
    }

    let mut stack = vec![root_pid];
    let mut visited = std::collections::HashSet::new();
    let mut total_rss: u64 = 0;

    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        let proc_h =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if !proc_h.is_null() {
            let mut counters = PROCESS_MEMORY_COUNTERS {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ..Default::default()
            };
            let ok = unsafe {
                K32GetProcessMemoryInfo(
                    proc_h,
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                )
            };
            if ok != 0 {
                total_rss = total_rss.saturating_add(counters.WorkingSetSize as u64);
            }
            unsafe { CloseHandle(proc_h) };
        }
        if let Some(kids) = children_map.get(&pid) {
            for &kid in kids {
                if !visited.contains(&kid) {
                    stack.push(kid);
                }
            }
        }
    }

    total_rss
}

#[cfg(unix)]
#[must_use]
pub fn process_tree_rss_bytes(_root_pid: u32) -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive_and_has_nonzero_rss() {
        let pid = std::process::id();
        assert!(pid_is_alive(pid));
        #[cfg(windows)]
        assert!(process_tree_rss_bytes(pid) > 0);
    }

    #[cfg(windows)]
    #[test]
    fn supervised_spawn_kills_child_tree_on_drop() {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
        let (mut child, sup) = spawn_supervised_command(&mut cmd).expect("spawn supervised");
        assert!(sup.is_supervised());
        let pid = child.id();
        assert!(pid_is_alive(pid));
        sup.kill_tree();
        let _ = child.wait();
        drop(child);
        std::thread::sleep(std::time::Duration::from_millis(120));
        assert!(!pid_is_alive(pid));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_command_strips_provider_api_keys_from_child_env() {
        let mut cmd = Command::new("cmd.exe");
        cmd.env("OMNIA_API_KEY", "sk-test-must-not-leak-12345678")
            .env("OPENAI_API_KEY", "sk-test-must-not-leak-87654321")
            .args(["/d", "/c", "echo OMNIA=[%OMNIA_API_KEY%] OPENAI=[%OPENAI_API_KEY%]"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let (child, _sup) = spawn_supervised_command(&mut cmd).expect("spawn supervised");
        let out = child.wait_with_output().expect("wait output");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            !stdout.contains("sk-test-must-not-leak"),
            "child shell must NEVER inherit provider API keys: {stdout}"
        );
    }
}
