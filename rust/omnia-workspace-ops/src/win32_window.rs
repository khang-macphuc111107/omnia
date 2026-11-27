//! Win32 live window enumeration (`EnumWindows`), bounded GDI `PrintWindow` capture
//! encoded to lossless PNG, and zero-flash `STARTF_USESHOWWINDOW(SW_HIDE)` child launcher.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Live Win32 top-level window descriptor returned by [`list_visible_windows`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
    pub width: i32,
    pub height: i32,
    pub is_visible: bool,
    pub is_minimized: bool,
}

/// Captured lossless RGBA PNG output from [`capture_window_png`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapturedWindowPng {
    pub hwnd: isize,
    pub width: u32,
    pub height: u32,
    pub png_bytes: Vec<u8>,
}

/// Lists visible, titled top-level windows via Win32 `EnumWindows`.
pub fn list_visible_windows() -> Result<Vec<LiveWindowInfo>, String> {
    #[cfg(windows)]
    {
        list_visible_windows_win32()
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Captures a specific HWND's visual contents into a lossless PNG clamped to `max_dim` (`<= 8192`).
pub fn capture_window_png(hwnd: isize, max_dim: u32) -> Result<CapturedWindowPng, String> {
    if hwnd == 0 {
        return Err("invalid HWND 0".into());
    }
    let _clamped = max_dim.clamp(64, 8192);
    #[cfg(windows)]
    {
        capture_window_png_win32(hwnd, _clamped)
    }
    #[cfg(not(windows))]
    {
        Err("Win32 window capture unavailable on non-Windows host".into())
    }
}

/// Spawns a GUI/console helper child with `CREATE_NO_WINDOW | CREATE_SUSPENDED` +
/// `STARTF_USESHOWWINDOW(SW_HIDE)` + JobObject(`KILL_ON_JOB_CLOSE`), returning `(pid, job_raw_handle)`.
/// Used by isolated CDP browser launches (`omnia-media-capture`) so zero console/splash flashes occur.
pub fn spawn_hidden_suspended_detached(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &BTreeMap<String, String>,
) -> Result<(u32, usize), String> {
    #[cfg(windows)]
    {
        spawn_hidden_suspended_win32(program, args, cwd, extra_env)
    }
    #[cfg(not(windows))]
    {
        let _ = (program, args, cwd, extra_env);
        Err("Win32 hidden suspended launch requires Windows".into())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub fn close_job_handle(raw_job: usize) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    if raw_job != 0 {
        let h = raw_job as HANDLE;
        unsafe {
            TerminateJobObject(h, 0);
            CloseHandle(h);
        }
    }
}

#[cfg(not(windows))]
pub fn close_job_handle(_raw_job: usize) {}

/// Zero-flash hidden Win32 child process bound to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// handle with inherited stdin/stdout pipes. Dropping kills the entire child tree cleanly.
#[derive(Debug)]
pub struct HiddenStdioProcess {
    pub pid: u32,
    job_raw: usize,
    pub stdin: Option<std::fs::File>,
    pub stdout: Option<std::fs::File>,
}

impl HiddenStdioProcess {
    pub fn take_stdin(&mut self) -> Option<std::fs::File> {
        self.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<std::fs::File> {
        self.stdout.take()
    }

    pub fn kill(&mut self) {
        self.stdin.take();
        self.stdout.take();
        if self.job_raw != 0 {
            let job = self.job_raw;
            self.job_raw = 0;
            close_job_handle(job);
        }
    }
}

impl Drop for HiddenStdioProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Spawns `program` with `CREATE_SUSPENDED` + `CREATE_NO_WINDOW` + `STARTF_USESHOWWINDOW(SW_HIDE)`
/// + `STARTF_USESTDHANDLES`, assigns it to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object,
///   and resumes the primary thread. Secrets (`API_KEY`/`AUTH_TOKEN`/`SECRET`) are stripped unless
///   explicitly passed in `extra_env`.
pub fn spawn_hidden_suspended_stdio(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &BTreeMap<String, String>,
) -> Result<HiddenStdioProcess, String> {
    #[cfg(windows)]
    {
        spawn_hidden_suspended_stdio_win32(program, args, cwd, extra_env)
    }
    #[cfg(not(windows))]
    {
        let _ = (program, args, cwd, extra_env);
        Err("Win32 hidden stdio launch requires Windows".into())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn list_visible_windows_win32() -> Result<Vec<LiveWindowInfo>, String> {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut Vec<LiveWindowInfo>);
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return TRUE;
        }
        let mut title_buf = vec![0u16; (len as usize).min(512) + 1];
        let copied = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        if copied <= 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&title_buf[..copied as usize])
            .trim()
            .to_owned();
        if title.is_empty() {
            return TRUE;
        }
        let mut class_buf = [0u16; 256];
        let clen = GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32);
        let class_name = if clen > 0 {
            String::from_utf16_lossy(&class_buf[..clen as usize])
        } else {
            String::new()
        };
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return TRUE;
        }
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        let mut pid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, &mut pid);
        let is_minimized = IsIconic(hwnd) != 0;

        out.push(LiveWindowInfo {
            hwnd: hwnd as isize,
            pid,
            title,
            class_name,
            width,
            height,
            is_visible: true,
            is_minimized,
        });
        TRUE
    }

    let mut list: Vec<LiveWindowInfo> = Vec::new();
    let ok = unsafe { EnumWindows(Some(enum_cb), (&mut list as *mut Vec<LiveWindowInfo>) as LPARAM) };
    if ok == 0 && list.is_empty() {
        return Err(format!(
            "EnumWindows failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(list)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn capture_window_png_win32(hwnd_val: isize, max_dim: u32) -> Result<CapturedWindowPng, String> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindow};

    const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;
    let hwnd = hwnd_val as HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("window HWND {hwnd_val} no longer exists"));
    }
    if unsafe { IsIconic(hwnd) } != 0 {
        return Err(format!("window HWND {hwnd_val} is minimized"));
    }
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(format!(
            "GetWindowRect failed for HWND {hwnd_val}: {}",
            std::io::Error::last_os_error()
        ));
    }
    let raw_w = (rect.right - rect.left).max(0) as u32;
    let raw_h = (rect.bottom - rect.top).max(0) as u32;
    if raw_w == 0 || raw_h == 0 {
        return Err(format!("window HWND {hwnd_val} has zero size ({raw_w}x{raw_h})"));
    }
    let width = raw_w.min(max_dim);
    let height = raw_h.min(max_dim);

    let screen_dc = unsafe { GetDC(std::ptr::null_mut()) };
    if screen_dc.is_null() {
        return Err("GetDC(NULL) returned null".into());
    }
    let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if mem_dc.is_null() {
        unsafe { ReleaseDC(std::ptr::null_mut(), screen_dc) };
        return Err("CreateCompatibleDC failed".into());
    }
    let bmp = unsafe { CreateCompatibleBitmap(screen_dc, width as i32, height as i32) };
    if bmp.is_null() {
        unsafe {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
        }
        return Err("CreateCompatibleBitmap failed".into());
    }

    let prev = unsafe { SelectObject(mem_dc, bmp) };
    let pw_ok = unsafe { PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT) };
    if pw_ok == 0 {
        let _ = unsafe { PrintWindow(hwnd, mem_dc, 0) };
    }

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32), // top-down BGRA
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [unsafe { std::mem::zeroed() }],
    };

    let pixel_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "capture buffer size overflow".to_owned())?;
    let mut bgra = vec![0u8; pixel_bytes];
    let scanlines = unsafe {
        GetDIBits(
            mem_dc,
            bmp,
            0,
            height,
            bgra.as_mut_ptr().cast(),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(mem_dc, prev);
        DeleteObject(bmp);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
    }
    if scanlines == 0 {
        return Err("GetDIBits failed capturing window buffer".into());
    }

    // Convert BGRA -> RGBA in place.
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        if px[3] == 0 {
            px[3] = 255;
        }
    }

    let png_bytes = encode_rgba_png(width, height, &bgra)?;
    Ok(CapturedWindowPng {
        hwnd: hwnd_val,
        width,
        height,
        png_bytes,
    })
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn spawn_hidden_suspended_win32(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &BTreeMap<String, String>,
) -> Result<(u32, usize), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, ResumeThread, TerminateProcess, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW,
    };

    fn to_wide_nul(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
            return arg.to_owned();
        }
        let mut out = String::from("\"");
        for ch in arg.chars() {
            if ch == '"' {
                out.push_str("\\\"");
            } else {
                out.push(ch);
            }
        }
        out.push('"');
        out
    }

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!("CreateJobObjectW failed: {}", std::io::Error::last_os_error()));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err("SetInformationJobObject failed".into());
    }

    let mut clean_env: BTreeMap<String, String> = std::env::vars().collect();
    for (k, v) in extra_env {
        clean_env.insert(k.clone(), v.clone());
    }
    let mut env_block: Vec<u16> = Vec::new();
    for (k, v) in &clean_env {
        env_block.extend(OsStr::new(&format!("{k}={v}")).encode_wide());
        env_block.push(0);
    }
    env_block.push(0);

    let mut cmdline = quote_arg(program);
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(&quote_arg(a));
    }
    let mut cmdline_w = to_wide_nul(&cmdline);
    let cwd_w = to_wide_nul(&cwd.to_string_lossy());

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = 0; // SW_HIDE

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmdline_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr().cast(),
            cwd_w.as_ptr(),
            &si,
            &mut pi,
        )
    };
    if created == 0 {
        unsafe { CloseHandle(job) };
        return Err(format!(
            "CreateProcessW failed for `{program}`: {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { AssignProcessToJobObject(job, pi.hProcess) } == 0 {
        unsafe {
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            TerminateJobObject(job, 1);
            CloseHandle(job);
        }
        return Err("AssignProcessToJobObject failed".into());
    }
    let _ = unsafe { ResumeThread(pi.hThread) };
    let pid = pi.dwProcessId;
    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    Ok((pid, job as usize))
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn spawn_hidden_suspended_stdio_win32(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &BTreeMap<String, String>,
) -> Result<HiddenStdioProcess, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle};
    use windows_sys::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, TRUE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, ResumeThread, TerminateProcess, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
        STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    fn to_wide_nul(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn quote_arg(arg: &str) -> String {
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

    let (in_r, in_w) = std::io::pipe().map_err(|e| format!("stdin pipe: {e}"))?;
    let (out_r, out_w) = std::io::pipe().map_err(|e| format!("stdout pipe: {e}"))?;
    let (mut err_r, err_w) = std::io::pipe().map_err(|e| format!("stderr pipe: {e}"))?;

    let in_r_h = in_r.as_raw_handle() as HANDLE;
    let out_w_h = out_w.as_raw_handle() as HANDLE;
    let err_w_h = err_w.as_raw_handle() as HANDLE;
    if unsafe { SetHandleInformation(in_r_h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
        || unsafe { SetHandleInformation(out_w_h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
        || unsafe { SetHandleInformation(err_w_h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
    {
        return Err(format!(
            "SetHandleInformation failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!("CreateJobObjectW failed: {}", std::io::Error::last_os_error()));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err("SetInformationJobObject failed".into());
    }

    let mut clean_env: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in std::env::vars() {
        let up = k.to_ascii_uppercase();
        if up.contains("API_KEY") || up.contains("AUTH_TOKEN") || up.contains("SECRET") {
            continue;
        }
        clean_env.insert(k, v);
    }
    for (k, v) in extra_env {
        clean_env.insert(k.clone(), v.clone());
    }
    let mut env_block: Vec<u16> = Vec::new();
    for (k, v) in &clean_env {
        env_block.extend(OsStr::new(&format!("{k}={v}")).encode_wide());
        env_block.push(0);
    }
    env_block.push(0);

    let mut cmdline = quote_arg(program);
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(&quote_arg(a));
    }
    let mut cmdline_w = to_wide_nul(&cmdline);
    let cwd_w = to_wide_nul(&cwd.to_string_lossy());

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    si.wShowWindow = 0; // SW_HIDE
    si.hStdInput = in_r_h;
    si.hStdOutput = out_w_h;
    si.hStdError = err_w_h;

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmdline_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            TRUE,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr().cast(),
            cwd_w.as_ptr(),
            &si,
            &mut pi,
        )
    };
    drop(in_r);
    drop(out_w);
    drop(err_w);
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut err_r, &mut std::io::sink());
    });

    if created == 0 {
        unsafe { CloseHandle(job) };
        return Err(format!(
            "CreateProcessW failed for `{program}`: {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { AssignProcessToJobObject(job, pi.hProcess) } == 0 {
        unsafe {
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            TerminateJobObject(job, 1);
            CloseHandle(job);
        }
        return Err("AssignProcessToJobObject failed".into());
    }
    let _ = unsafe { ResumeThread(pi.hThread) };
    let pid = pi.dwProcessId;
    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    let stdin_file = unsafe { std::fs::File::from_raw_handle(in_w.into_raw_handle()) };
    let stdout_file = unsafe { std::fs::File::from_raw_handle(out_r.into_raw_handle()) };
    Ok(HiddenStdioProcess {
        pid,
        job_raw: job as usize,
        stdin: Some(stdin_file),
        stdout: Some(stdout_file),
    })
}

/// Encodes an RGBA8 image into a standards-compliant PNG using stored DEFLATE blocks (zero external deps).
pub fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "PNG dimensions overflow".to_owned())?;
    if rgba.len() != expected {
        return Err(format!(
            "RGBA length mismatch: expected {expected}, got {}",
            rgba.len()
        ));
    }

    let row_bytes = (width as usize) * 4;
    let mut raw_scanlines = Vec::with_capacity((row_bytes + 1) * (height as usize));
    for row in rgba.chunks_exact(row_bytes) {
        raw_scanlines.push(0); // filter type 0 (None)
        raw_scanlines.extend_from_slice(row);
    }

    let zlib_stream = zlib_stored(&raw_scanlines);
    let mut png = Vec::with_capacity(64 + zlib_stream.len());
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    write_png_chunk(&mut png, b"IHDR", &ihdr);
    write_png_chunk(&mut png, b"IDAT", &zlib_stream);
    write_png_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn write_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_buf = Vec::with_capacity(4 + data.len());
    crc_buf.extend_from_slice(kind);
    crc_buf.extend_from_slice(data);
    out.extend_from_slice(&ieee_crc32(&crc_buf).to_be_bytes());
}

fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 32);
    out.push(0x78);
    out.push(0x01);
    if raw.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xFF, 0xFF]);
    } else {
        let chunks: Vec<&[u8]> = raw.chunks(65_535).collect();
        for (idx, chunk) in chunks.iter().enumerate() {
            let is_last = idx + 1 == chunks.len();
            out.push(u8::from(is_last));
            let len = chunk.len() as u16;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(chunk);
        }
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + u32::from(byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

fn ieee_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_valid_png_signature_and_chunks() {
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];
        let png = encode_rgba_png(2, 1, &rgba).expect("png");
        assert_eq!(&png[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert_eq!(&png[12..16], b"IHDR");
        assert!(png.windows(4).any(|w| w == b"IDAT"));
        assert!(png.windows(4).any(|w| w == b"IEND"));
    }
}
