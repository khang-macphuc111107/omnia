//! Integration test: drives a real top-level window (EDIT + BUTTON children,
//! created on its own thread, parked off-screen and never activated) through
//! the background tools.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{COLOR_WINDOW, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow, GetMessageW,
    GetWindowTextW, IsIconic, PostMessageW, PostQuitMessage, RegisterClassW, SetForegroundWindow,
    ShowWindow, TranslateMessage, BS_PUSHBUTTON, ES_AUTOHSCROLL, HMENU, MSG, SW_MINIMIZE,
    SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_COMMAND, WM_DESTROY, WNDCLASSW,
    WS_BORDER, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

use crate::bg::OwnProcess;
use crate::computer::{Computer, ComputerConfig};
use crate::types::MouseButton;
use crate::ComputerError;

static CLICKS: AtomicU32 = AtomicU32::new(0);
const ID_BUTTON: usize = 2;

unsafe extern "system" fn test_proc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_COMMAND => {
            // HIWORD(wParam) == BN_CLICKED (0), LOWORD == control id.
            if (wp.0 >> 16) & 0xFFFF == 0 && wp.0 & 0xFFFF == ID_BUTTON {
                CLICKS.fetch_add(1, Ordering::SeqCst);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}

struct TestWindow {
    top: isize,
    edit: isize,
    title: String,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    #[allow(clippy::manual_dangling_ptr)] // HMENU carries a child-window id, not a pointer
    fn spawn() -> Self {
        let title = format!("Omnia BG Test {}", std::process::id());
        let (tx, rx) = mpsc::channel::<(isize, isize)>();
        let t = title.clone();
        let thread = std::thread::spawn(move || unsafe {
            let hi = GetModuleHandleW(None).unwrap();
            let class = w!("OmniaBgTestWindow");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(test_proc),
                hInstance: hi.into(),
                lpszClassName: class,
                hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as isize as *mut _),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let wide: Vec<u16> = t.encode_utf16().chain(std::iter::once(0)).collect();
            let top = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                PCWSTR(wide.as_ptr()),
                WS_OVERLAPPEDWINDOW,
                -20000,
                -20000,
                420,
                320,
                None,
                None,
                Some(hi.into()),
                None,
            )
            .unwrap();
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                10,
                10,
                300,
                24,
                Some(top),
                Some(HMENU(1 as *mut _)),
                Some(hi.into()),
                None,
            )
            .unwrap();
            let _button = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("BUTTON"),
                w!("Go"),
                WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
                10,
                50,
                100,
                30,
                Some(top),
                Some(HMENU(ID_BUTTON as *mut _)),
                Some(hi.into()),
                None,
            )
            .unwrap();
            let _ = ShowWindow(top, SW_SHOWNOACTIVATE);
            tx.send((top.0 as isize, edit.0 as isize)).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        let (top, edit) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("test window did not start");
        Self {
            top,
            edit,
            title,
            thread: Some(thread),
        }
    }

    fn edit_text(&self) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(HWND(self.edit as *mut _), &mut buf) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..n])
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.top as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for: {what}");
}

fn test_computer() -> Computer {
    let c = Computer::new(ComputerConfig {
        observe: false,
        ..Default::default()
    });
    // The test window lives in this very process, which is otherwise refused.
    c.set_own_process(OwnProcess::none());
    c
}

fn foreground() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

/// Controls that call SetFocus (EDIT, BUTTON) make their own window active when
/// clicked, as they would for a real click, and this test process is allowed
/// to take the foreground. Hand it straight back so the test does not disturb
/// whatever the user (or another tool) is doing.
fn give_back_foreground(prev: isize, top: isize) {
    if prev != 0 && prev != top && foreground() == top {
        unsafe {
            let _ = SetForegroundWindow(HWND(prev as *mut _));
        }
    }
}

#[test]
fn background_message_rejects_missing_window() {
    let result = super::send(HWND::default(), 0, 0, 0);
    assert!(
        matches!(result, Err(ComputerError::Failed(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn background_window_end_to_end() {
    CLICKS.store(0, Ordering::SeqCst);
    let win = TestWindow::spawn();
    let c = test_computer();
    let top = win.top;

    // list finds it, with sane flags.
    let list = c.bg_windows().await.unwrap();
    let me = list
        .iter()
        .find(|w| w.hwnd == top)
        .expect("test window is listed");
    assert_eq!(me.title, win.title);
    assert_eq!(me.pid, std::process::id());
    assert_eq!(me.class, "OmniaBgTestWindow");
    assert!(me.visible && !me.minimized);
    assert!(me.client_w > 100 && me.client_h > 100);
    assert_eq!(me.root, top);
    assert!(!me.own, "own flag is off while the test override is active");
    let text = c.bg_windows_text().await.unwrap();
    assert!(text.contains(&format!("hwnd=\"{top}\"")));

    // screenshot while not foreground: non-empty PNG with real content.
    let prev_fg = foreground();
    assert_ne!(
        prev_fg, top,
        "test window must not be the foreground window"
    );
    // (a just-created window may need a moment before DWM has its first frame)
    let mut shot = c.bg_screenshot(top, None, false).await.unwrap();
    for _ in 0..40 {
        if !shot.blank {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
        shot = c.bg_screenshot(top, None, false).await.unwrap();
    }
    assert_eq!(&shot.bytes[..4], &[0x89, b'P', b'N', b'G']);
    assert!(shot.bytes.len() > 100);
    assert_eq!(
        (shot.map.src_w as i32, shot.map.src_h as i32),
        (me.client_w, me.client_h)
    );
    let mut reader = png::Decoder::new(&shot.bytes[..]).read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!((info.width, info.height), (shot.map.img_w, shot.map.img_h));
    let first = [buf[0], buf[1], buf[2]];
    #[allow(clippy::chunks_exact_to_as_chunks)]
    // as_chunks needs a newer toolchain than rust-version
    let varied = buf.chunks_exact(3).any(|p| p != first);
    assert!(varied, "capture shows the controls, not a flat colour");
    assert!(!shot.blank);

    // max_width scaling is reflected in the click map.
    let half = c
        .bg_screenshot(top, Some(me.client_w as u32 / 2), false)
        .await
        .unwrap();
    assert!(half.map.img_w <= me.client_w as u32 / 2);
    let _ = c.bg_screenshot(top, None, false).await.unwrap();

    // click into the EDIT (gives it focus), then type; the text lands in the EDIT.
    c.bg_click(top, 20.0, 20.0, MouseButton::Left, false)
        .await
        .unwrap();
    give_back_foreground(prev_fg, top);
    c.bg_type(top, "h\u{00E9}llo \u{1F600}").await.unwrap();
    wait_for("typed text", || win.edit_text() == "h\u{00E9}llo \u{1F600}");

    // Ctrl+A then Backspace clears it.
    c.bg_key(top, "ctrl+a").await.unwrap();
    c.bg_key(top, "backspace").await.unwrap();
    wait_for("edit cleared", || win.edit_text().is_empty());

    // plain keys work too, and newlines/Tab do not crash.
    c.bg_type(top, "ok").await.unwrap();
    wait_for("second text", || win.edit_text() == "ok");
    c.bg_key(top, "shift+home").await.unwrap();
    c.bg_key(top, "delete").await.unwrap();
    wait_for("selection deleted", || win.edit_text().is_empty());

    // click on the button child triggers BN_CLICKED.
    c.bg_click(top, 20.0, 60.0, MouseButton::Left, false)
        .await
        .unwrap();
    give_back_foreground(prev_fg, top);
    wait_for("BN_CLICKED", || CLICKS.load(Ordering::SeqCst) == 1);

    // Out-of-range clicks and bad keys are rejected before anything is sent.
    assert!(c
        .bg_click(top, 9999.0, 5.0, MouseButton::Left, false)
        .await
        .is_err());
    assert!(c.bg_key(top, "win+r").await.is_err());
    assert!(c.bg_key(top, "nonsensekey").await.is_err());
    assert!(c.bg_type(top, "").await.is_err());

    // Minimized: clear message, then restore_without_activate works.
    unsafe {
        let _ = ShowWindow(HWND(top as *mut _), SW_MINIMIZE);
    }
    wait_for("minimized", || {
        unsafe { IsIconic(HWND(top as *mut _)) }.as_bool()
    });
    let err = c
        .bg_screenshot(top, None, false)
        .await
        .err()
        .expect("minimized capture is refused");
    assert!(
        err.to_string().contains("restore_without_activate"),
        "{err}"
    );
    let again = c.bg_screenshot(top, None, true).await.unwrap();
    let note = again.restored.clone().expect("restored");
    assert!(
        foreground() != top || note.contains("could not"),
        "focus was not handed back: {note}"
    );
    assert!(!unsafe { IsIconic(HWND(top as *mut _)) }.as_bool());

    // With the default (real) own-process identity this window is off limits.
    let strict = Computer::new(ComputerConfig::default());
    let listed = strict.bg_windows().await.unwrap();
    assert!(listed.iter().find(|w| w.hwnd == top).unwrap().own);
    for res in [
        strict
            .bg_click(top, 20.0, 20.0, MouseButton::Left, false)
            .await
            .map(|_| ()),
        strict.bg_type(top, "x").await.map(|_| ()),
        strict.bg_key(top, "enter").await.map(|_| ()),
        strict.bg_screenshot(top, None, false).await.map(|_| ()),
    ] {
        assert!(matches!(res, Err(ComputerError::Blocked(_))), "{res:?}");
    }
    assert_eq!(win.edit_text(), "");

    // Gone windows are reported, not crashed on.
    assert!(matches!(
        c.bg_screenshot(1, None, false).await,
        Err(ComputerError::NotFound(_))
    ));

    // Kill switch stops everything.
    c.kill_switch().trigger();
    assert!(matches!(
        c.bg_key(top, "enter").await,
        Err(ComputerError::Killed)
    ));
}
