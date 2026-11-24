//! Fail-closed Win32 Sandbox (`CreateRestrictedToken` w/ `WRITE_RESTRICTED` +
//! deterministic synthetic workspace SID + `JobObject` + `STARTF_USESHOWWINDOW(SW_HIDE)`
//! + egress policy enforcement).
//!
//! If any token restriction, Job Object limit, or process assignment fails, spawning
//! fails closed (`Err`) and never degrades silently to an unrestricted shell.

use crate::egress::{apply_egress_env_to_command, EgressPolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// Sandbox configuration applied to confined subprocess execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxPolicy {
    pub workspace_root: PathBuf,
    /// Enable Win32 `CreateRestrictedToken(..., WRITE_RESTRICTED, ...)`. Fail-closed on error.
    pub enforce_restricted_token: bool,
    /// Maximum child process memory in bytes (enforced via Win32 Job Object).
    pub max_memory_bytes: Option<usize>,
    /// Maximum concurrent active processes inside the sandbox Job Object.
    pub active_process_limit: Option<u32>,
    /// Wall-clock timeout for bounded command execution.
    pub timeout_ms: u64,
    /// Network egress posture applied via proxy/environment isolation.
    pub egress: EgressPolicy,
    /// Grant the synthetic workspace SID modify/write ACE on `writable_roots` before spawn.
    pub writable_roots: Vec<PathBuf>,
}

impl SandboxPolicy {
    #[must_use]
    pub fn strict_workspace(workspace_root: impl Into<PathBuf>) -> Self {
        let ws = workspace_root.into();
        Self {
            writable_roots: vec![ws.clone()],
            workspace_root: ws,
            enforce_restricted_token: true,
            max_memory_bytes: Some(2 * 1024 * 1024 * 1024),
            active_process_limit: Some(32),
            timeout_ms: 30_000,
            egress: EgressPolicy::deny_all(),
        }
    }
}

/// Receipt proving what OS isolation primitives actually governed execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxReceipt {
    pub restricted_token_applied: bool,
    pub write_restricted: bool,
    pub synthetic_workspace_sid: String,
    pub job_object_kill_on_close: bool,
    pub hidden_no_window_sw_hide: bool,
    pub egress_mode: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Derives a deterministic 4-subauthority synthetic SID string `S-1-9-<a1>-<a2>-<a3>-<a4>`
/// bound to `workspace_root` (distinct from well-known OS SIDs).
#[must_use]
pub fn derive_workspace_sid_parts(workspace_root: &Path) -> [u32; 4] {
    let norm = workspace_root
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let digest = Sha256::digest(format!("omnia-sandbox-sid-v1:{norm}").as_bytes());
    [
        u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]),
        u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]),
        u32::from_le_bytes([digest[8], digest[9], digest[10], digest[11]]),
        u32::from_le_bytes([digest[12], digest[13], digest[14], digest[15]]),
    ]
}

#[must_use]
pub fn format_workspace_sid_string(workspace_root: &Path) -> String {
    let [a, b, c, d] = derive_workspace_sid_parts(workspace_root);
    format!("S-1-9-{a}-{b}-{c}-{d}")
}

/// Executes `program` + `args` inside a fail-closed Win32 restricted-token + JobObject sandbox.
pub fn run_sandboxed_command(
    program: &str,
    args: &[String],
    extra_env: &BTreeMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<SandboxReceipt, String> {
    if !policy.workspace_root.exists() {
        return Err(format!(
            "sandbox workspace root `{}` does not exist",
            policy.workspace_root.display()
        ));
    }
    #[cfg(windows)]
    {
        run_win32_sandboxed(program, args, extra_env, policy)
    }
    #[cfg(not(windows))]
    {
        run_non_windows_bounded(program, args, extra_env, policy)
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn run_win32_sandboxed(
    program: &str,
    args: &[String],
    extra_env: &BTreeMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<SandboxReceipt, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, TRUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
        TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AllocateAndInitializeSid, CreateRestrictedToken, FreeSid, ACL, DACL_SECURITY_INFORMATION,
        PSID, PSECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES, SID_IDENTIFIER_AUTHORITY,
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, WRITE_RESTRICTED,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, GetCurrentProcess, GetExitCodeProcess,
        OpenProcessToken, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
        STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const OBJECT_INHERIT_ACE_FLAG: u32 = 0x1;
    const CONTAINER_INHERIT_ACE_FLAG: u32 = 0x2;

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct SidGuard(PSID);
    impl Drop for SidGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    FreeSid(self.0);
                }
            }
        }
    }

    struct JobGuard(HANDLE);
    impl Drop for JobGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    TerminateJobObject(self.0, 1);
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide_nul(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn quote_win32_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
            return arg.to_owned();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0usize;
        for ch in arg.chars() {
            if ch == '\\' {
                backslashes += 1;
            } else if ch == '"' {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            } else {
                out.push_str(&"\\".repeat(backslashes));
                out.push(ch);
                backslashes = 0;
            }
        }
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    }

    let sid_parts = derive_workspace_sid_parts(&policy.workspace_root);
    let sid_text = format_workspace_sid_string(&policy.workspace_root);
    let auth = SID_IDENTIFIER_AUTHORITY {
        Value: [0, 0, 0, 0, 0, 9],
    };
    let mut raw_sid: PSID = std::ptr::null_mut();
    let sid_ok = unsafe {
        AllocateAndInitializeSid(
            &auth,
            4,
            sid_parts[0],
            sid_parts[1],
            sid_parts[2],
            sid_parts[3],
            0,
            0,
            0,
            0,
            &mut raw_sid,
        )
    };
    if sid_ok == 0 || raw_sid.is_null() {
        return Err(format!(
            "AllocateAndInitializeSid failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let _sid_guard = SidGuard(raw_sid);

    // Grant synthetic workspace SID access ONLY to explicit `writable_roots`.
    for root in &policy.writable_roots {
        if !root.exists() {
            continue;
        }
        let mut root_w = to_wide_nul(&root.to_string_lossy());
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut sec_desc: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let get_rc = unsafe {
            GetNamedSecurityInfoW(
                root_w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut old_dacl,
                std::ptr::null_mut(),
                &mut sec_desc,
            )
        };
        if get_rc == 0 {
            let ea = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_ALL_ACCESS,
                grfAccessMode: SET_ACCESS,
                grfInheritance: CONTAINER_INHERIT_ACE_FLAG | OBJECT_INHERIT_ACE_FLAG,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: raw_sid.cast(),
                },
            };
            let mut new_dacl: *mut ACL = std::ptr::null_mut();
            let set_rc = unsafe { SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl) };
            if set_rc == 0 && !new_dacl.is_null() {
                let _ = unsafe {
                    SetNamedSecurityInfoW(
                        root_w.as_mut_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        new_dacl,
                        std::ptr::null_mut(),
                    )
                };
                unsafe {
                    LocalFree(new_dacl.cast());
                }
            }
            if !sec_desc.is_null() {
                unsafe {
                    LocalFree(sec_desc);
                }
            }
        }
    }

    // Open base process token and create a WRITE_RESTRICTED token bound to our synthetic workspace SID.
    let mut base_token: HANDLE = std::ptr::null_mut();
    let tok_ok = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
            &mut base_token,
        )
    };
    if tok_ok == 0 || base_token.is_null() {
        return Err(format!(
            "OpenProcessToken failed (fail-closed): {}",
            std::io::Error::last_os_error()
        ));
    }
    let _base_tok_guard = HandleGuard(base_token);

    let mut restricted_token: HANDLE = std::ptr::null_mut();
    let mut restricted_applied = false;
    if policy.enforce_restricted_token {
        let mut restricting_sids = [SID_AND_ATTRIBUTES {
            Sid: raw_sid,
            Attributes: 0,
        }];
        let cr_ok = unsafe {
            CreateRestrictedToken(
                base_token,
                WRITE_RESTRICTED,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                1,
                restricting_sids.as_mut_ptr(),
                &mut restricted_token,
            )
        };
        if cr_ok == 0 || restricted_token.is_null() {
            return Err(format!(
                "CreateRestrictedToken(WRITE_RESTRICTED) failed (fail-closed): {}",
                std::io::Error::last_os_error()
            ));
        }
        restricted_applied = true;
    }
    let _restricted_tok_guard = HandleGuard(restricted_token);

    // Create Job Object with KILL_ON_JOB_CLOSE + optional active-process & memory limits.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "CreateJobObjectW failed (fail-closed): {}",
            std::io::Error::last_os_error()
        ));
    }
    let _job_guard = JobGuard(job);

    let mut limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    if let Some(limit) = policy.active_process_limit {
        limit_flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = limit;
    }
    if let Some(mem) = policy.max_memory_bytes {
        limit_flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = mem;
    }
    info.BasicLimitInformation.LimitFlags = limit_flags;
    let set_job_ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set_job_ok == 0 {
        return Err(format!(
            "SetInformationJobObject failed (fail-closed): {}",
            std::io::Error::last_os_error()
        ));
    }

    // Inheritable anonymous stdout/stderr pipes via safe std::io::pipe() + explicit inheritance on child write ends.
    let (mut out_r, out_w) = std::io::pipe().map_err(|e| format!("stdout pipe: {e}"))?;
    let (mut err_r, err_w) = std::io::pipe().map_err(|e| format!("stderr pipe: {e}"))?;
    let out_w_handle = out_w.as_raw_handle() as HANDLE;
    let err_w_handle = err_w.as_raw_handle() as HANDLE;
    if unsafe { SetHandleInformation(out_w_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
        || unsafe { SetHandleInformation(err_w_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
            == 0
    {
        return Err(format!(
            "SetHandleInformation failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    // Build sanitized environment block (strip secrets, apply egress policy).
    let mut clean_env: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in std::env::vars() {
        let up = k.to_ascii_uppercase();
        if up.contains("API_KEY") || up.contains("AUTH_TOKEN") || up.contains("SECRET") {
            continue;
        }
        clean_env.insert(k, v);
    }
    let mut dummy_cmd = std::process::Command::new(program);
    apply_egress_env_to_command(&mut dummy_cmd, &policy.egress);
    for (k, opt_v) in dummy_cmd.get_envs() {
        if let (Some(ks), Some(vs)) = (k.to_str(), opt_v.and_then(|o| o.to_str())) {
            clean_env.insert(ks.to_owned(), vs.to_owned());
        }
    }
    for (k, v) in extra_env {
        clean_env.insert(k.clone(), v.clone());
    }
    let mut env_block: Vec<u16> = Vec::new();
    for (k, v) in &clean_env {
        let entry = format!("{k}={v}");
        env_block.extend(OsStr::new(&entry).encode_wide());
        env_block.push(0);
    }
    env_block.push(0);

    let is_cmd_exe = Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("cmd.exe") || n.eq_ignore_ascii_case("cmd"));
    let mut cmdline = quote_win32_arg(program);
    for (idx, a) in args.iter().enumerate() {
        cmdline.push(' ');
        // `cmd.exe /c <raw>` does not unescape C-runtime `\"` inside outer quotes; pass the
        // trailing command string directly when it immediately follows `/c` or `/k`.
        let prev_is_c_or_k = idx > 0
            && (args[idx - 1].eq_ignore_ascii_case("/c")
                || args[idx - 1].eq_ignore_ascii_case("/k"));
        if is_cmd_exe && prev_is_c_or_k && idx + 1 == args.len() {
            cmdline.push_str(a);
        } else {
            cmdline.push_str(&quote_win32_arg(a));
        }
    }
    let mut cmdline_w = to_wide_nul(&cmdline);
    let cwd_w = to_wide_nul(&policy.workspace_root.to_string_lossy());

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    si.wShowWindow = 0; // SW_HIDE
    si.hStdOutput = out_w_handle;
    si.hStdError = err_w_handle;
    si.hStdInput = std::ptr::null_mut();

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    // DETACHED_PROCESS prevents Win32 csrss/conhost from connecting a restricted token
    // (`S-1-9-...` in `SidsToRestrict`) to `WinSta0` console objects (`STATUS_DLL_INIT_FAILED`),
    // while inherited stdout/stderr anonymous pipes capture all child output invisibly.
    let window_flag = if restricted_applied {
        DETACHED_PROCESS
    } else {
        CREATE_NO_WINDOW
    };
    let flags = window_flag | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

    let created = if restricted_applied {
        unsafe {
            CreateProcessAsUserW(
                restricted_token,
                std::ptr::null(),
                cmdline_w.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                TRUE,
                flags,
                env_block.as_ptr().cast(),
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            )
        }
    } else {
        unsafe {
            CreateProcessW(
                std::ptr::null(),
                cmdline_w.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                TRUE,
                flags,
                env_block.as_ptr().cast(),
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            )
        }
    };

    // Close parent's write ends immediately so reader threads observe EOF cleanly on child exit.
    drop(out_w);
    drop(err_w);

    if created == 0 {
        let err = std::io::Error::last_os_error();
        let code = unsafe { GetLastError() };
        return Err(format!(
            "sandboxed process creation failed (fail-closed, win32={code}): {err}"
        ));
    }
    let _proc_guard = HandleGuard(pi.hProcess);
    let _thread_guard = HandleGuard(pi.hThread);

    if unsafe { AssignProcessToJobObject(job, pi.hProcess) } == 0 {
        unsafe {
            TerminateProcess(pi.hProcess, 1);
        }
        return Err(format!(
            "AssignProcessToJobObject failed (fail-closed): {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { ResumeThread(pi.hThread) } == u32::MAX {
        unsafe {
            TerminateProcess(pi.hProcess, 1);
        }
        return Err(format!(
            "ResumeThread failed (fail-closed): {}",
            std::io::Error::last_os_error()
        ));
    }

    let t_out = std::thread::spawn(move || read_bounded_pipe(&mut out_r));
    let t_err = std::thread::spawn(move || read_bounded_pipe(&mut err_r));

    let wait_ms = u32::try_from(policy.timeout_ms.clamp(250, 300_000)).unwrap_or(30_000);
    let wait_rc = unsafe { WaitForSingleObject(pi.hProcess, wait_ms) };
    let timed_out = wait_rc != 0;
    if timed_out {
        unsafe {
            TerminateJobObject(job, 124);
        }
    }

    let mut exit_code_u32: u32 = 1;
    let _ = unsafe { GetExitCodeProcess(pi.hProcess, &mut exit_code_u32) };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();

    Ok(SandboxReceipt {
        restricted_token_applied: restricted_applied,
        write_restricted: restricted_applied,
        synthetic_workspace_sid: sid_text,
        job_object_kill_on_close: true,
        hidden_no_window_sw_hide: true,
        egress_mode: format!("{:?}", policy.egress.mode),
        exit_code: if timed_out { 124 } else { exit_code_u32 as i32 },
        timed_out,
        stdout,
        stderr,
    })
}

#[cfg(windows)]
fn read_bounded_pipe<R: std::io::Read>(reader: &mut R) -> String {
    let mut acc = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        let remain = 1_048_576usize.saturating_sub(acc.len());
        if remain == 0 {
            break;
        }
        acc.extend_from_slice(&buf[..n.min(remain)]);
    }
    String::from_utf8_lossy(&acc).into_owned()
}

#[cfg(not(windows))]
fn run_non_windows_bounded(
    program: &str,
    args: &[String],
    extra_env: &BTreeMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<SandboxReceipt, String> {
    if policy.enforce_restricted_token {
        return Err("Win32 restricted token sandbox unavailable on non-Windows host".into());
    }
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(&policy.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_egress_env_to_command(&mut cmd, &policy.egress);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(SandboxReceipt {
        restricted_token_applied: false,
        write_restricted: false,
        synthetic_workspace_sid: format_workspace_sid_string(&policy.workspace_root),
        job_object_kill_on_close: false,
        hidden_no_window_sw_hide: false,
        egress_mode: format!("{:?}", policy.egress.mode),
        exit_code: out.status.code().unwrap_or(-1),
        timed_out: false,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_sid_is_deterministic_and_case_normalized() {
        let s1 = format_workspace_sid_string(Path::new(r"D:\Omnia\Demo"));
        let s2 = format_workspace_sid_string(Path::new(r"d:/omnia/demo"));
        assert_eq!(s1, s2);
        assert!(s1.starts_with("S-1-9-"));
    }

    #[cfg(windows)]
    #[test]
    fn win32_write_restricted_sandbox_executes_and_blocks_outside_writes() {
        let base = std::env::temp_dir().join(format!("omnia_sbx_{}", std::process::id()));
        let ws = base.join("ws");
        let outside = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&ws).expect("mkdir ws");
        std::fs::create_dir_all(&outside).expect("mkdir outside");

        let policy = SandboxPolicy::strict_workspace(&ws);
        // Test 1: read-only echo inside sandbox succeeds cleanly with CreateRestrictedToken.
        let ok_rec = run_sandboxed_command(
            "cmd.exe",
            &["/d".into(), "/c".into(), "echo SANDBOX_OK".into()],
            &BTreeMap::new(),
            &policy,
        )
        .expect("run sandboxed echo");
        assert!(ok_rec.restricted_token_applied);
        assert!(ok_rec.write_restricted);
        assert!(ok_rec.job_object_kill_on_close);
        assert!(ok_rec.hidden_no_window_sw_hide);
        assert_eq!(ok_rec.exit_code, 0);
        assert!(ok_rec.stdout.contains("SANDBOX_OK"));

        // Test 1b: writing INSIDE workspace_root (which received the synthetic SID ACE) succeeds cleanly.
        let inside_file = ws.join("inside.txt");
        let inside_cmd = format!("echo INSIDE_OK > \"{}\"", inside_file.display());
        let in_rec = run_sandboxed_command(
            "cmd.exe",
            &["/d".into(), "/c".into(), inside_cmd],
            &BTreeMap::new(),
            &policy,
        )
        .expect("run inside write test");
        assert_eq!(
            in_rec.exit_code, 0,
            "workspace SID ACE must permit writes inside ws: stdout={} stderr={}",
            in_rec.stdout, in_rec.stderr
        );
        assert!(inside_file.exists(), "inside workspace file must exist");

        // Test 2: negative escape test — writing to an outside folder without workspace SID ACE must fail!
        let probe_file = outside.join("escape.txt");
        let cmd_str = format!("echo PWNED > \"{}\"", probe_file.display());
        let esc_rec = run_sandboxed_command(
            "cmd.exe",
            &["/d".into(), "/c".into(), cmd_str],
            &BTreeMap::new(),
            &policy,
        )
        .expect("run escape test");
        assert_ne!(
            esc_rec.exit_code, 0,
            "WRITE_RESTRICTED token must deny outside write! stdout={} stderr={}",
            esc_rec.stdout, esc_rec.stderr
        );
        assert!(
            esc_rec.stderr.to_ascii_lowercase().contains("denied")
                || esc_rec.stdout.to_ascii_lowercase().contains("denied"),
            "outside write must fail with Access is denied (not syntax error): stdout={} stderr={}",
            esc_rec.stdout, esc_rec.stderr
        );
        assert!(!probe_file.exists(), "outside escape file must not exist");

        let _ = std::fs::remove_dir_all(&base);
    }
}
