//! Win32 side of background window control: enumeration, `PrintWindow`
//! capture, posted mouse/keyboard messages. Nothing here raises a window or
//! moves the real cursor.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::Duration;

use windows::core::BOOL;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ACCESS_DENIED, ERROR_TIMEOUT, HANDLE, HWND,
    LPARAM, POINT, TRUE, WIN32_ERROR, WPARAM,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::MapWindowPoints;
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetWindowDpiAwarenessContext, SetThreadDpiAwarenessContext};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardState, MapVirtualKeyW, SetKeyboardState, MAPVK_VK_TO_VSC,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumWindows, GetAncestor, GetClassNameW, GetClientRect,
    GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, PostMessageW,
    SendMessageTimeoutW, SetForegroundWindow, ShowWindow, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT,
    GA_ROOT, GUITHREADINFO, GWL_EXSTYLE, SMTO_ABORTIFHUNG, SMTO_NORMAL, SW_SHOWNOACTIVATE, WM_CHAR,
    WS_EX_TOOLWINDOW,
};

use crate::bg::{self, BgWindow, KeyPlan};
use crate::keys::{KeyChord, KeyStep};
use crate::types::{InputTiming, MouseButton};
use crate::winapi::{frame_rect, hwnd_of, process_name};
use crate::ComputerError;

const SEND_TIMEOUT_MS: u32 = 1500;

fn fail(what: &str, e: impl std::fmt::Display) -> ComputerError {
    ComputerError::Failed(format!("{what}: {e}"))
}

/// Run `f` with this thread in the target window's DPI-awareness context, so
/// coordinates (client size, hit tests, mouse lParams, PrintWindow bitmaps) are
/// in the units the window itself uses. DPI-unaware apps on scaled displays
/// otherwise see our physical coordinates as the wrong place.
pub(crate) fn with_window_dpi<R>(hwnd: isize, f: impl FnOnce() -> R) -> R {
    unsafe {
        let ctx = GetWindowDpiAwarenessContext(hwnd_of(hwnd));
        if ctx.0.is_null() {
            return f();
        }
        let old = SetThreadDpiAwarenessContext(ctx);
        let r = f();
        if !old.0.is_null() {
            SetThreadDpiAwarenessContext(old);
        }
        r
    }
}

fn rect_wh(hwnd: HWND) -> (i32, i32) {
    with_window_dpi(hwnd.0 as isize, || {
        let mut r = windows::Win32::Foundation::RECT::default();
        unsafe {
            let _ = GetClientRect(hwnd, &mut r);
        }
        (r.right - r.left, r.bottom - r.top)
    })
}

fn class_of(hwnd: HWND) -> String {
    let mut c = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut c) }.max(0) as usize;
    String::from_utf16_lossy(&c[..n])
}

// ------------------------------------------------------------- elevation

fn query_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut elev = TOKEN_ELEVATION::default();
        let mut got = 0u32;
        let res = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut TOKEN_ELEVATION as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut got,
        );
        let _ = CloseHandle(token);
        res.ok().map(|_| elev.TokenIsElevated != 0)
    }
}

/// Is this process elevated?
pub fn self_elevated() -> bool {
    static CELL: OnceLock<bool> = OnceLock::new();
    *CELL.get_or_init(|| query_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false))
}

/// `Some(true)` elevated, `Some(false)` not, `None` when the token cannot be
/// opened (typically a more privileged or protected process).
fn process_elevated(pid: u32) -> Option<bool> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let r = query_elevated(h);
        let _ = CloseHandle(h);
        r
    }
}

// ----------------------------------------------------------- enumeration

pub fn bg_info(hwnd: isize) -> Option<BgWindow> {
    let h = hwnd_of(hwnd);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return None;
        }
        let mut t = [0u16; 512];
        let n = GetWindowTextW(h, &mut t).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        );
        let (cw, ch) = rect_wh(h);
        let root = GetAncestor(h, GA_ROOT);
        let elevated = if pid == std::process::id() {
            Some(self_elevated())
        } else {
            process_elevated(pid)
        };
        Some(BgWindow {
            hwnd,
            title: String::from_utf16_lossy(&t[..n]),
            process: process_name(pid),
            pid,
            class: class_of(h),
            bounds: frame_rect(hwnd),
            client_w: cw,
            client_h: ch,
            minimized: IsIconic(h).as_bool(),
            visible: IsWindowVisible(h).as_bool(),
            cloaked: cloaked != 0,
            root: if root.0.is_null() {
                hwnd
            } else {
                root.0 as isize
            },
            elevated,
            uipi_blocked: !self_elevated() && elevated != Some(false),
            own: false,
        })
    }
}

unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<HWND>);
    if !IsWindowVisible(h).as_bool() {
        return TRUE;
    }
    if GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    let mut t = [0u16; 4];
    if GetWindowTextW(h, &mut t) == 0 {
        return TRUE;
    }
    out.push(h);
    TRUE
}

/// Visible titled top-level windows in z-order, cloaked and minimized ones
/// included (flagged), tool windows excluded.
pub fn bg_list() -> Result<Vec<BgWindow>, ComputerError> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(enum_cb), LPARAM(&mut handles as *mut _ as isize))
            .map_err(|e| fail("EnumWindows", e))?;
    }
    Ok(handles
        .into_iter()
        .filter_map(|h| bg_info(h.0 as isize))
        .collect())
}

// --------------------------------------------------------------- restore

/// `SW_SHOWNOACTIVATE`: show a minimized window again. Windows activates a
/// window that leaves the minimized state regardless, so when that happens the
/// previous foreground window gets the focus back (best effort). Returns
/// whether the window is no longer minimized plus a note about the focus.
pub fn bg_restore(hwnd: isize) -> Result<(bool, String), ComputerError> {
    let h = hwnd_of(hwnd);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return Err(ComputerError::NotFound(format!(
                "window {hwnd} no longer exists"
            )));
        }
        let prev = GetForegroundWindow();
        let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(40));
            if !IsIconic(h).as_bool() {
                std::thread::sleep(Duration::from_millis(120));
                let fg = GetForegroundWindow();
                let took = fg == h || (!fg.0.is_null() && GetAncestor(fg, GA_ROOT) == h);
                let note = if !took {
                    String::new()
                } else if prev.0.is_null() || prev == h {
                    "Windows made the restored window the active window.".to_string()
                } else {
                    let _ = SetForegroundWindow(prev);
                    std::thread::sleep(Duration::from_millis(80));
                    if GetForegroundWindow() == prev {
                        "Windows briefly activated the restored window; focus was handed back."
                            .to_string()
                    } else {
                        "Windows activated the restored window and focus could not be handed back."
                            .to_string()
                    }
                };
                return Ok((true, note));
            }
        }
        Ok((false, String::new()))
    }
}

// ----------------------------------------------------------------- click

/// Deepest descendant of `top` under client point `(x, y)`, with the point
/// translated into that descendant's client coordinates.
pub fn deepest_child(top: HWND, x: i32, y: i32) -> (HWND, i32, i32) {
    let (mut cur, mut px, mut py) = (top, x, y);
    for _ in 0..32 {
        let child = unsafe {
            ChildWindowFromPointEx(
                cur,
                POINT { x: px, y: py },
                CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT,
            )
        };
        if child.0.is_null() || child == cur {
            break;
        }
        let mut pt = [POINT { x: px, y: py }];
        unsafe {
            MapWindowPoints(Some(cur), Some(child), &mut pt);
        }
        cur = child;
        px = pt[0].x;
        py = pt[0].y;
    }
    (cur, px, py)
}

fn post(h: HWND, msg: u32, w: usize, l: isize) -> Result<(), ComputerError> {
    unsafe {
        PostMessageW(Some(h), msg, WPARAM(w), LPARAM(l)).map_err(|e| {
            ComputerError::Failed(format!(
                "PostMessage failed ({e}); the window may be gone or more privileged than Omnia (UIPI)"
            ))
        })
    }
}

/// Send synchronously with a timeout (needed while a modifier state is faked).
fn send(h: HWND, msg: u32, w: usize, l: isize) -> Result<(), ComputerError> {
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let mut res = 0usize;
        let sent = SendMessageTimeoutW(
            h,
            msg,
            WPARAM(w),
            LPARAM(l),
            SMTO_ABORTIFHUNG | SMTO_NORMAL,
            SEND_TIMEOUT_MS,
            Some(&mut res),
        );
        if sent.0 != 0 {
            return Ok(());
        }
        let e = GetLastError();
        // A timeout may leave the last-error code at zero. The API return
        // value, rather than GetLastError alone, determines whether it sent.
        if e == ERROR_TIMEOUT || e.0 == 0 {
            return Err(ComputerError::Failed(
                "the window did not respond (hung or busy)".into(),
            ));
        }
        if e == ERROR_ACCESS_DENIED {
            return Err(ComputerError::Failed(
                "access denied sending to the window (UIPI: it is more privileged than Omnia)"
                    .into(),
            ));
        }
        Err(ComputerError::Failed(format!(
            "SendMessageTimeoutW failed (Windows error {}); the target window may be gone",
            e.0,
        )))
    }
}

pub fn bg_click(
    hwnd: isize,
    cx: i32,
    cy: i32,
    button: MouseButton,
    double: bool,
    t: &InputTiming,
) -> Result<(String, isize), ComputerError> {
    let top = hwnd_of(hwnd);
    unsafe {
        if !IsWindow(Some(top)).as_bool() {
            return Err(ComputerError::NotFound(format!(
                "window {hwnd} no longer exists"
            )));
        }
    }
    let (target, x, y) = with_window_dpi(hwnd, || -> Result<_, ComputerError> {
        let (target, x, y) = deepest_child(top, cx, cy);
        let lp = bg::make_lparam(x, y);
        for (msg, w) in bg::mouse_sequence(button, double) {
            post(target, msg, w, lp)?;
            std::thread::sleep(Duration::from_millis(t.click_delay_ms.min(200)));
        }
        Ok((target, x, y))
    })?;
    Ok((
        format!(
            "posted {}{:?} click to {} hwnd={} at its client ({x},{y}) (window client ({cx},{cy})); the real cursor was not moved",
            if double { "double " } else { "" },
            button,
            class_of(target),
            target.0 as isize
        ),
        target.0 as isize,
    ))
}

// ------------------------------------------------------------ key / type

/// The window that has keyboard focus inside `hwnd`'s thread (when it belongs
/// to the same top-level window), else `hwnd` itself.
pub fn input_target(hwnd: isize, hint: Option<isize>) -> HWND {
    let top = hwnd_of(hwnd);
    unsafe {
        let tid = GetWindowThreadProcessId(top, None);
        let mut gti = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if tid != 0 && GetGUIThreadInfo(tid, &mut gti).is_ok() {
            let f = gti.hwndFocus;
            if !f.0.is_null() && (f == top || GetAncestor(f, GA_ROOT) == top) {
                return f;
            }
        }
        // No focus inside this window (an inactive window has none): use the
        // control that was last clicked, if it is still part of this window.
        if let Some(c) = hint.map(hwnd_of) {
            if IsWindow(Some(c)).as_bool() && (c == top || GetAncestor(c, GA_ROOT) == top) {
                return c;
            }
        }
    }
    top
}

pub fn bg_type(
    hwnd: isize,
    units: &[u16],
    hint: Option<isize>,
    t: &InputTiming,
) -> Result<String, ComputerError> {
    let target = input_target(hwnd, hint);
    for &u in units {
        post(target, WM_CHAR, u as usize, 1)?;
        if t.key_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(t.key_delay_ms.min(50)));
        }
    }
    Ok(format!(
        "posted {} UTF-16 WM_CHAR unit(s) to {} hwnd={}",
        units.len(),
        class_of(target),
        target.0 as isize
    ))
}

fn scan_of(vk: u16) -> u32 {
    let s = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) };
    if s != 0 {
        s
    } else {
        bg::scan_fallback(vk)
    }
}

fn key_msgs(plan: &KeyPlan) -> (u32, u32, u32) {
    if plan.sys {
        (bg::WM_SYSKEYDOWN, bg::WM_SYSKEYUP, bg::WM_SYSCHAR)
    } else {
        (bg::WM_KEYDOWN, bg::WM_KEYUP, bg::WM_CHAR)
    }
}

fn lp(step: KeyStep, sys: bool, up: bool) -> isize {
    bg::key_lparam(scan_of(step.vk), step.extended, sys, up)
}

/// Plain chord (no modifiers): post down/up and let the target's own message
/// loop translate to characters, exactly like keyboard input.
fn post_chord(target: HWND, plan: &KeyPlan, t: &InputTiming) -> Result<(), ComputerError> {
    let (down, up, _) = key_msgs(plan);
    post(
        target,
        down,
        plan.key.vk as usize,
        lp(plan.key, plan.sys, false),
    )?;
    std::thread::sleep(Duration::from_millis(t.key_delay_ms.clamp(4, 50)));
    post(
        target,
        up,
        plan.key.vk as usize,
        lp(plan.key, plan.sys, true),
    )
}

/// Chord with modifiers: attach to the target's input queue, make its key
/// state show the modifiers (what GetKeyState reads), deliver synchronously,
/// then restore. Returns false when the state could not be faked.
fn send_chord(target: HWND, plan: &KeyPlan, t: &InputTiming) -> Result<bool, ComputerError> {
    let (down, up, chr) = key_msgs(plan);
    let me = unsafe { GetCurrentThreadId() };
    let tid = unsafe { GetWindowThreadProcessId(target, None) };
    let attached = tid != 0 && tid != me && unsafe { AttachThreadInput(me, tid, true) }.as_bool();
    let mut saved = [0u8; 256];
    let mut faked = false;
    if attached && unsafe { GetKeyboardState(&mut saved) }.is_ok() {
        let state = bg::modifier_state(&saved, &plan.mods);
        faked = unsafe { SetKeyboardState(&state) }.is_ok();
    }
    let run = || -> Result<(), ComputerError> {
        for m in &plan.mods {
            send(target, down, m.vk as usize, lp(*m, plan.sys, false))?;
        }
        send(
            target,
            down,
            plan.key.vk as usize,
            lp(plan.key, plan.sys, false),
        )?;
        if let Some(c) = plan.chr {
            send(target, chr, c as usize, lp(plan.key, plan.sys, false))?;
        }
        std::thread::sleep(Duration::from_millis(t.key_delay_ms.clamp(4, 50)));
        send(
            target,
            up,
            plan.key.vk as usize,
            lp(plan.key, plan.sys, true),
        )?;
        for m in plan.mods.iter().rev() {
            send(target, up, m.vk as usize, lp(*m, plan.sys, true))?;
        }
        Ok(())
    };
    let res = run();
    unsafe {
        if faked {
            let _ = SetKeyboardState(&saved);
        }
        if attached {
            let _ = AttachThreadInput(me, tid, false);
        }
    }
    res.map(|_| faked)
}

const EM_SETSEL: u32 = 0x00B1;

fn is_select_all(plan: &KeyPlan) -> bool {
    plan.key.vk == 0x41 && plan.mods.len() == 1 && plan.mods[0].vk == crate::keys::VK_CONTROL
}

fn is_edit_class(class: &str) -> bool {
    let c = class.to_ascii_lowercase();
    c == "edit" || c.starts_with("richedit")
}

pub fn bg_key(
    hwnd: isize,
    chords: &[KeyChord],
    hint: Option<isize>,
    t: &InputTiming,
) -> Result<String, ComputerError> {
    let plans: Vec<KeyPlan> = chords
        .iter()
        .map(bg::plan_chord)
        .collect::<Result<_, _>>()
        .map_err(ComputerError::Invalid)?;
    let target = input_target(hwnd, hint);
    let mut note = String::new();
    for plan in &plans {
        if is_select_all(plan) && is_edit_class(&class_of(target)) {
            // The stock EDIT control has no Ctrl+A handler of its own (apps add it
            // through accelerators/subclassing), so do what that would do.
            send(target, EM_SETSEL, 0, -1)?;
            note = " (select-all done with EM_SETSEL, as the edit control has no native Ctrl+A)"
                .into();
        } else if plan.needs_state() {
            if !send_chord(target, plan, t)? {
                note =
                    " (could not fake the modifier key state; modifier shortcuts may not register)"
                        .into();
            }
        } else {
            post_chord(target, plan, t)?;
        }
        std::thread::sleep(Duration::from_millis(t.key_delay_ms.clamp(4, 50)));
    }
    Ok(format!(
        "sent {} key chord(s) to {} hwnd={}{note}",
        plans.len(),
        class_of(target),
        target.0 as isize
    ))
}

#[cfg(test)]
mod tests;
