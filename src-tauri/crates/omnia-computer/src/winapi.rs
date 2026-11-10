//! Win32 plumbing: thread init, monitors, top-level windows, window operations.

use std::ffi::c_void;
use std::time::Duration;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::AttachThreadInput as AttachInput;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow, WindowFromPoint,
    GA_ROOT, GWL_EXSTYLE, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOOLWINDOW,
};

use crate::types::{MonitorInfo, Rect, WindowAction, WindowInfo};
use crate::ComputerError;

fn fail(what: &str, e: impl std::fmt::Display) -> ComputerError {
    ComputerError::Failed(format!("{what}: {e}"))
}

pub fn hwnd_of(h: isize) -> HWND {
    HWND(h as *mut c_void)
}

/// Per-thread initialisation: MTA COM + per-monitor-v2 DPI awareness.
pub fn init_thread() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn rect_of(r: RECT) -> Rect {
    Rect::from_ltrb(r.left, r.top, r.right, r.bottom)
}

// ---------------------------------------------------------------- monitors

unsafe extern "system" fn monitor_cb(h: HMONITOR, _: HDC, _: *mut RECT, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<MonitorInfo>);
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(h, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let len = mi
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(mi.szDevice.len());
        out.push(MonitorInfo {
            index: out.len(),
            name: String::from_utf16_lossy(&mi.szDevice[..len]),
            bounds: rect_of(mi.monitorInfo.rcMonitor),
            work_area: rect_of(mi.monitorInfo.rcWork),
            dpi: dx,
            scale: dx as f64 / 96.0,
            primary: mi.monitorInfo.dwFlags & 1 != 0,
        });
    }
    TRUE
}

/// Monitors with the primary first (index 0), then left-to-right / top-to-bottom.
pub fn monitors() -> Result<Vec<MonitorInfo>, ComputerError> {
    let mut list: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let ok = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_cb),
            LPARAM(&mut list as *mut _ as isize),
        );
        if !ok.as_bool() || list.is_empty() {
            return Err(ComputerError::Failed("no monitors found".into()));
        }
    }
    list.sort_by_key(|m| (!m.primary, m.bounds.x, m.bounds.y));
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i;
    }
    Ok(list)
}

// ----------------------------------------------------------------- windows

pub(crate) fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let res =
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        if res.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn visible_bounds(hwnd: HWND) -> Rect {
    unsafe {
        let mut r = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
            && r.right > r.left
        {
            return rect_of(r);
        }
        let _ = GetWindowRect(hwnd, &mut r);
        rect_of(r)
    }
}

/// Full-window rect (including invisible resize borders), as used by `PrintWindow`.
pub fn outer_rect(hwnd: isize) -> Rect {
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd_of(hwnd), &mut r);
    }
    rect_of(r)
}

pub fn frame_rect(hwnd: isize) -> Rect {
    visible_bounds(hwnd_of(hwnd))
}

fn info_for(hwnd: HWND, fg: HWND) -> WindowInfo {
    unsafe {
        let mut t = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut t).max(0) as usize;
        let mut c = [0u16; 256];
        let cn = GetClassNameW(hwnd, &mut c).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        WindowInfo {
            hwnd: hwnd.0 as isize,
            title: String::from_utf16_lossy(&t[..n]),
            process: process_name(pid),
            pid,
            class: String::from_utf16_lossy(&c[..cn]),
            bounds: visible_bounds(hwnd),
            minimized: IsIconic(hwnd).as_bool(),
            focused: hwnd == fg,
        }
    }
}

unsafe extern "system" fn window_cb(h: HWND, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<HWND>);
    if !IsWindowVisible(h).as_bool() {
        return TRUE;
    }
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        h,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return TRUE;
    }
    let mut t = [0u16; 4];
    if GetWindowTextW(h, &mut t) == 0 {
        return TRUE;
    }
    out.push(h);
    TRUE
}

/// Visible, titled, non-cloaked top-level windows in z-order (top first).
pub fn list_windows() -> Result<Vec<WindowInfo>, ComputerError> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(window_cb), LPARAM(&mut handles as *mut _ as isize))
            .map_err(|e| fail("EnumWindows", e))?;
        let fg = GetForegroundWindow();
        Ok(handles.into_iter().map(|h| info_for(h, fg)).collect())
    }
}

/// Any window by handle, without the list filters.
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    unsafe {
        let h = hwnd_of(hwnd);
        IsWindow(Some(h))
            .as_bool()
            .then(|| info_for(h, GetForegroundWindow()))
    }
}

pub fn foreground() -> Option<WindowInfo> {
    unsafe {
        let fg = GetForegroundWindow();
        (!fg.0.is_null()).then(|| info_for(fg, fg))
    }
}

/// Top-level window under a physical screen point.
pub fn window_at_point(x: i32, y: i32) -> Option<WindowInfo> {
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.0.is_null() {
            return None;
        }
        let root = GetAncestor(h, GA_ROOT);
        let root = if root.0.is_null() { h } else { root };
        Some(info_for(root, GetForegroundWindow()))
    }
}

pub fn set_foreground(hwnd: isize) -> Result<String, ComputerError> {
    unsafe {
        let h = hwnd_of(hwnd);
        if !IsWindow(Some(h)).as_bool() {
            return Err(ComputerError::NotFound(format!(
                "window {hwnd} no longer exists"
            )));
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let try_once = || {
            let fg = GetForegroundWindow();
            if fg == h {
                return true;
            }
            let cur = GetCurrentThreadId();
            let fg_thread = if fg.0.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg, None)
            };
            let attached =
                fg_thread != 0 && fg_thread != cur && AttachInput(cur, fg_thread, true).as_bool();
            let _ = BringWindowToTop(h);
            let _ = SetForegroundWindow(h);
            if attached {
                let _ = AttachInput(cur, fg_thread, false);
            }
            std::thread::sleep(Duration::from_millis(60));
            GetForegroundWindow() == h
        };
        if try_once() {
            return Ok("window focused".into());
        }
        // Foreground lock: a synthetic ALT press lets SetForegroundWindow through.
        crate::input::tap_alt();
        if try_once() {
            return Ok("window focused".into());
        }
        Ok("requested focus but another window kept the foreground (flashing in taskbar?)".into())
    }
}

pub fn window_op(
    hwnd: isize,
    action: WindowAction,
    rect: Option<Rect>,
) -> Result<String, ComputerError> {
    let h = hwnd_of(hwnd);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return Err(ComputerError::NotFound(format!(
                "window {hwnd} no longer exists"
            )));
        }
        match action {
            WindowAction::Focus => set_foreground(hwnd),
            WindowAction::Minimize => {
                let _ = ShowWindow(h, SW_MINIMIZE);
                Ok("window minimized".into())
            }
            WindowAction::Maximize => {
                let _ = ShowWindow(h, SW_MAXIMIZE);
                Ok("window maximized".into())
            }
            WindowAction::Restore => {
                let _ = ShowWindow(h, SW_RESTORE);
                Ok("window restored".into())
            }
            WindowAction::Close => {
                PostMessageW(Some(h), WM_CLOSE, Default::default(), Default::default())
                    .map_err(|e| fail("close", e))?;
                Ok("close requested (the app may ask to save first)".into())
            }
            WindowAction::Move | WindowAction::Resize => {
                let r = rect.ok_or_else(|| {
                    ComputerError::Invalid("`rect` [x,y,w,h] is required for move/resize".into())
                })?;
                if IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                let mut flags: SET_WINDOW_POS_FLAGS = SWP_NOZORDER | SWP_NOACTIVATE;
                if action == WindowAction::Move {
                    flags |= SWP_NOSIZE;
                } else {
                    flags |= SWP_NOMOVE;
                }
                SetWindowPos(h, None, r.x, r.y, r.w.max(1), r.h.max(1), flags)
                    .map_err(|e| fail("SetWindowPos", e))?;
                let b = frame_rect(hwnd);
                Ok(format!(
                    "window now at ({},{}) size {}x{}",
                    b.x, b.y, b.w, b.h
                ))
            }
        }
    }
}
