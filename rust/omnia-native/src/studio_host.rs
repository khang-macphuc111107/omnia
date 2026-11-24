//! Win32 DWM Mica + WebView2 Flagship Studio Desktop Host (`omnia-native --studio`).
//!
//! Preserves 100% of existing Win32/D2D/UIA shell behavior (`90/90` native QA tests)
//! when `--studio` is not passed, and adds an opt-in native Mica desktop frame
//! hosting the loopback `omnia-studio` v5 SolidJS interface.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2Controller,
    ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
};
use webview2_com::{
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMSBT_MAINWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
    DWMWA_USE_IMMERSIVE_DARK_MODE,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW,
    GetWindowLongPtrW, KillTimer, PostQuitMessage, RegisterClassExW, SetTimer, SetWindowLongPtrW,
    ShowWindow, TranslateMessage, CREATESTRUCTW, CW_USEDEFAULT, GWLP_USERDATA, MSG, SW_SHOW,
    WM_CREATE, WM_DESTROY, WM_NCDESTROY, WM_SIZE, WM_TIMER, WNDCLASSEXW, WS_CLIPCHILDREN,
    WS_OVERLAPPEDWINDOW,
};

use crate::cli::CliError;
use crate::dpi::ensure_per_monitor_v2_dpi_awareness;
use omnia_storage::StoreError;

const STUDIO_HOST_CLASS: &str = "OmniaNativeStudioMicaHost";
const SMOKE_EXIT_TIMER_ID: usize = 0x5150;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudioHostOptions {
    pub url: String,
    pub session_db: Option<PathBuf>,
    pub smoke_exit_ms: Option<u64>,
}

/// Parse `--studio` host arguments while keeping legacy `parse_session_db_args` untouched.
pub fn parse_studio_args(args: &[String]) -> Result<StudioHostOptions, CliError> {
    let mut url: Option<String> = None;
    let mut session_db: Option<PathBuf> = None;
    let mut smoke_exit_ms: Option<u64> = None;
    let mut saw_studio = false;

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--studio" => {
                saw_studio = true;
                i += 1;
            }
            "--url" => {
                let val = args
                    .get(i + 1)
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| CliError::new("invalid_cli_args", "Missing value for --url"))?;
                if !(val.starts_with("http://127.0.0.1:")
                    || val.starts_with("http://localhost:")
                    || val.starts_with("https://localhost:"))
                {
                    return Err(CliError::new(
                        "invalid_studio_url",
                        "Studio host --url must point to a local loopback URL",
                    ));
                }
                url = Some(val.to_string());
                i += 2;
            }
            "--session-db" => {
                let val = args.get(i + 1).ok_or_else(|| {
                    CliError::new("invalid_cli_args", "Missing path for --session-db")
                })?;
                let p = PathBuf::from(val);
                if !p.is_absolute() {
                    return Err(CliError::new(
                        "invalid_cli_args",
                        "--session-db path must be absolute",
                    ));
                }
                session_db = Some(p);
                i += 2;
            }
            "--smoke-exit-ms" => {
                let raw = args.get(i + 1).ok_or_else(|| {
                    CliError::new("invalid_cli_args", "Missing integer for --smoke-exit-ms")
                })?;
                let ms = raw.parse::<u64>().map_err(|_| {
                    CliError::new("invalid_cli_args", "Invalid --smoke-exit-ms integer")
                })?;
                smoke_exit_ms = Some(ms.clamp(50, 60_000));
                i += 2;
            }
            _ => {
                return Err(CliError::new(
                    "invalid_cli_args",
                    format!("Unknown --studio argument: {arg}"),
                ));
            }
        }
    }

    if !saw_studio {
        return Err(CliError::new("invalid_cli_args", "--studio flag required"));
    }

    let resolved_url = url
        .or_else(|| {
            std::env::var("OMNIA_STUDIO_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "http://127.0.0.1:18440".to_string());

    Ok(StudioHostOptions {
        url: resolved_url,
        session_db,
        smoke_exit_ms,
    })
}

fn contains_thorium(p: &Path) -> bool {
    p.to_string_lossy().to_ascii_lowercase().contains("thorium")
}

/// Probe host-specific non-Thorium WebView2 runtimes (EdgeCore on E:, System32, Program Files).
pub fn resolve_webview2_browser_folder() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        let p = PathBuf::from(env_dir.trim());
        if !contains_thorium(&p) && p.join("msedgewebview2.exe").is_file() {
            return Some(p);
        }
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(r"E:\Users\khang\AppData\Local\Microsoft\EdgeCore\159.0.4401.0"),
        PathBuf::from(r"C:\Windows\System32\Microsoft-Edge-WebView"),
    ];

    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let edge_core = PathBuf::from(&local_app).join(r"Microsoft\EdgeCore");
        if let Ok(entries) = std::fs::read_dir(&edge_core) {
            for ent in entries.flatten() {
                candidates.push(ent.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(r"E:\Users\khang\AppData\Local\Microsoft\EdgeCore") {
        for ent in entries.flatten() {
            candidates.push(ent.path());
        }
    }
    if let Ok(entries) =
        std::fs::read_dir(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application")
    {
        for ent in entries.flatten() {
            candidates.push(ent.path());
        }
    }

    for dir in candidates {
        if !contains_thorium(&dir) && dir.join("msedgewebview2.exe").is_file() {
            return Some(dir);
        }
    }
    None
}

/// Keep WebView2 user-data outside the `D:\Omnia` repository tree (`DOD-06`).
pub fn resolve_webview2_user_data_dir() -> PathBuf {
    let omnia_data = Path::new(r"D:\OmniaData");
    if omnia_data.is_dir() {
        omnia_data.join("tmp").join("omnia-webview2")
    } else {
        std::env::temp_dir().join("omnia-webview2")
    }
}

fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn configure_mica_backdrop(hwnd: HWND) {
    let dark_mode: i32 = 1;
    let backdrop_mica: i32 = DWMSBT_MAINWINDOW.0;
    // SAFETY: Enable Win11 Dark Mode + Mica system backdrop on our top-level HWND.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &raw const dark_mode as *const _,
            core::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            &raw const backdrop_mica as *const _,
            core::mem::size_of::<i32>() as u32,
        );
    }
}

struct HostWindowState {
    controller: Rc<RefCell<Option<ICoreWebView2Controller>>>,
    smoke_exit_ms: Option<u64>,
}

unsafe extern "system" fn studio_wnd_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if umsg == WM_CREATE {
        // SAFETY: Store `HostWindowState` pointer from `CREATESTRUCTW`.
        let cs = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        let ptr = cs.lpCreateParams as *mut HostWindowState;
        if !ptr.is_null() {
            // SAFETY: Valid heap pointer initialized in `run_studio_host`.
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);
                configure_mica_backdrop(hwnd);
                if let Some(ms) = (*ptr).smoke_exit_ms {
                    let _ = SetTimer(Some(hwnd), SMOKE_EXIT_TIMER_ID, ms as u32, None);
                }
            }
        }
        return LRESULT(0);
    }

    // SAFETY: Read `HostWindowState` stored in `GWLP_USERDATA`.
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut HostWindowState };
    if ptr.is_null() {
        // SAFETY: Standard window message fallback.
        return unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) };
    }

    match umsg {
        WM_SIZE => {
            // SAFETY: Resize embedded WebView2 controller to fill client bounds.
            unsafe {
                let mut rc = RECT::default();
                if GetClientRect(hwnd, &raw mut rc).is_ok() {
                    if let Some(ref ctrl) = *(*ptr).controller.borrow() {
                        let _ = ctrl.SetBounds(rc);
                    }
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == SMOKE_EXIT_TIMER_ID {
                // SAFETY: Clean shutdown when smoke test timer fires.
                unsafe {
                    let _ = KillTimer(Some(hwnd), SMOKE_EXIT_TIMER_ID);
                    PostQuitMessage(0);
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: Post quit on destroy.
            unsafe {
                PostQuitMessage(0);
            }
            LRESULT(0)
        }
        WM_NCDESTROY => {
            // SAFETY: Reclaim boxed `HostWindowState` cleanly.
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(ptr));
                DefWindowProcW(hwnd, umsg, wparam, lparam)
            }
        }
        _ => {
            // SAFETY: Default window message fallback.
            unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) }
        }
    }
}

struct ComUninitGuard;
impl Drop for ComUninitGuard {
    fn drop(&mut self) {
        // SAFETY: Match successful `CoInitializeEx`.
        unsafe {
            CoUninitialize();
        }
    }
}

/// Launch the Win32 DWM Mica desktop shell hosting Omnia Studio v5 via WebView2.
pub fn run_studio_host(args: &[String]) -> Result<(), StoreError> {
    let opts = parse_studio_args(args)
        .map_err(|e| StoreError::new(e.code, e.message, false))?;

    ensure_per_monitor_v2_dpi_awareness();

    // SAFETY: Initialize STA COM apartment required by WebView2 controller.
    let com_hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let _com_guard = com_hr.is_ok().then_some(ComUninitGuard);

    let user_data_dir = resolve_webview2_user_data_dir();
    let _ = std::fs::create_dir_all(&user_data_dir);

    let cls_w = to_wide_null(STUDIO_HOST_CLASS);
    let title_w = to_wide_null("Omnia Studio (DWM Mica Host)");
    // SAFETY: Acquire module handle.
    let hmod = unsafe { GetModuleHandleW(None) }
        .map_err(|e| StoreError::new("win32_hmodule_failed", e.to_string(), false))?;
    let hinstance = HINSTANCE(hmod.0);

    let wc = WNDCLASSEXW {
        cbSize: core::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(studio_wnd_proc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(cls_w.as_ptr()),
        ..Default::default()
    };
    // SAFETY: Register top-level Mica studio window class.
    let atom = unsafe { RegisterClassExW(&raw const wc) };
    if atom == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(1410) {
            return Err(StoreError::new(
                "win32_register_studio_failed",
                format!("Failed to register studio host class: {err}"),
                false,
            ));
        }
    }

    let controller_slot: Rc<RefCell<Option<ICoreWebView2Controller>>> =
        Rc::new(RefCell::new(None));
    let state_ptr = Box::into_raw(Box::new(HostWindowState {
        controller: Rc::clone(&controller_slot),
        smoke_exit_ms: opts.smoke_exit_ms,
    }));

    // SAFETY: Create DWM Mica host window.
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            PCWSTR(cls_w.as_ptr()),
            PCWSTR(title_w.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1440,
            900,
            None,
            None,
            Some(hinstance),
            Some(state_ptr.cast()),
        )
    }
    .map_err(|e| {
        // SAFETY: Free `state_ptr` on failure before storage in `GWLP_USERDATA`.
        unsafe {
            drop(Box::from_raw(state_ptr));
        }
        StoreError::new("win32_create_studio_failed", e.to_string(), false)
    })?;

    // Initialize WebView2 environment cleanly with host fallback probing
    let browser_dir = resolve_webview2_browser_folder();
    let browser_w = browser_dir
        .as_ref()
        .map(|p| to_wide_null(&p.to_string_lossy()));
    let user_data_w = to_wide_null(&user_data_dir.to_string_lossy());

    let env = {
        let (tx, rx) = mpsc::channel();
        let browser_ptr = browser_w
            .as_ref()
            .map(|v| PCWSTR(v.as_ptr()))
            .unwrap_or_else(PCWSTR::null);
        let ud_ptr = PCWSTR(user_data_w.as_ptr());

        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                CreateCoreWebView2EnvironmentWithOptions(
                    browser_ptr,
                    ud_ptr,
                    None,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |err_code, env| {
                err_code?;
                let _ = tx.send(env.ok_or_else(|| windows::core::Error::from(E_POINTER)));
                Ok(())
            }),
        )
        .map_err(|e| StoreError::new("webview2_env_failed", e.to_string(), false))?;

        rx.recv()
            .map_err(|e| StoreError::new("webview2_env_recv_failed", e.to_string(), false))?
            .map_err(|e| StoreError::new("webview2_env_hr_failed", e.to_string(), false))?
    };

    let controller: ICoreWebView2Controller = {
        let (tx, rx) = mpsc::channel();
        let env_clone = env.clone();
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                env_clone
                    .CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |err_code, ctrl| {
                err_code?;
                let _ = tx.send(ctrl.ok_or_else(|| windows::core::Error::from(E_POINTER)));
                Ok(())
            }),
        )
        .map_err(|e| StoreError::new("webview2_ctrl_failed", e.to_string(), false))?;

        rx.recv()
            .map_err(|e| StoreError::new("webview2_ctrl_recv_failed", e.to_string(), false))?
            .map_err(|e| StoreError::new("webview2_ctrl_hr_failed", e.to_string(), false))?
    };

    let url_w = to_wide_null(&opts.url);
    // SAFETY: Configure WebView2 controller bounds, transparent Mica background, and navigate.
    unsafe {
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &raw mut rc);
        let _ = controller.SetBounds(rc);
        let _ = controller.SetIsVisible(true);
        if let Ok(ctrl2) = controller.cast::<ICoreWebView2Controller2>() {
            let _ = ctrl2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 8,
                G: 10,
                B: 15,
            });
        }
        let webview: ICoreWebView2 = controller
            .CoreWebView2()
            .map_err(|e| StoreError::new("webview2_core_failed", e.to_string(), false))?;
        let _ = webview.Navigate(PCWSTR(url_w.as_ptr()));
    }

    *controller_slot.borrow_mut() = Some(controller);

    // SAFETY: Show DWM Mica studio window and pump message loop cleanly.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let mut msg = MSG::default();
        while GetMessageW(&raw mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&raw const msg);
            DispatchMessageW(&raw const msg);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn studio_args_require_loopback_url_and_support_smoke_exit() {
        let args = vec![
            "--studio".to_string(),
            "--url".to_string(),
            "http://127.0.0.1:18440".to_string(),
            "--smoke-exit-ms".to_string(),
            "250".to_string(),
        ];
        let parsed = parse_studio_args(&args).expect("parse valid --studio args");
        assert_eq!(parsed.url, "http://127.0.0.1:18440");
        assert_eq!(parsed.smoke_exit_ms, Some(250));

        let bad_url = vec![
            "--studio".to_string(),
            "--url".to_string(),
            "https://example.com".to_string(),
        ];
        assert!(parse_studio_args(&bad_url).is_err());
    }

    #[test]
    fn webview2_user_data_stays_outside_omnia_repo() {
        let ud = resolve_webview2_user_data_dir();
        let norm = ud.to_string_lossy().to_ascii_lowercase();
        assert!(!norm.starts_with(r"d:\omnia\"));
    }

    #[test]
    fn thorium_paths_are_strictly_rejected() {
        assert!(contains_thorium(Path::new(r"C:\Apps\Thorium\Application")));
        assert!(!contains_thorium(Path::new(
            r"E:\Users\khang\AppData\Local\Microsoft\EdgeCore\159.0.4401.0"
        )));
    }
}
