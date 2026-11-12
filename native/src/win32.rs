//! Original Win32 shell wired to the native `RichComposer` + Math/Phys/Chem
//! symbol palette (`PRODUCT-COMPOSER`) and per-window DPI + `WM_SIZE` layout
//! (`QUALITY-01`).
//!
//! All HWNDs and borrowed Win32 state stay on the UI thread. `GetMessage`
//! blocks at idle; session storage starts one worker only when an explicit
//! database is supplied. No renderer or polling timer.
use omnia_native::composer::{search_symbol_palette, RichComposer, SymbolDomain};
use omnia_native::Mode;
use std::{cell::RefCell, io, mem::size_of, ptr, rc::Rc};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        LibraryLoader::GetModuleHandleW,
    },
    UI::{Controls::EM_SETLIMITTEXT, Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
};

const WM_DPICHANGED_MSG: u32 = 0x02E0;

#[derive(Clone, Copy)]
struct Handles {
    buttons: [HWND; 3],
    heading: HWND,
    composer_cmd: HWND,
    sym_buttons: [HWND; 3],
    composer_badge: HWND,
    draft_label: HWND,
    draft: HWND,
    status: HWND,
    sessions: HWND,
}

struct WindowState {
    handles: Handles,
    font: HFONT,
    composer: Rc<RefCell<RichComposer>>,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

pub fn show_error(message: &str) {
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            wide(message).as_ptr(),
            wide("Omnia native startup error").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

unsafe fn read_window_text(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd).max(0) as usize;
    if len == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len + 1];
    let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
    String::from_utf16_lossy(&buf[..copied.min(len)])
}

unsafe fn create_scaled_font(dpi: u32) -> Result<HFONT, String> {
    let pixel_height = -crate::session_panel::scale_px(17, dpi);
    let font = CreateFontW(
        pixel_height,
        0,
        0,
        0,
        FW_NORMAL as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        OUT_DEFAULT_PRECIS as u32,
        CLIP_DEFAULT_PRECIS as u32,
        CLEARTYPE_QUALITY as u32,
        DEFAULT_PITCH as u32,
        wide("Segoe UI").as_ptr(),
    );
    if font.is_null() {
        Err(format!("CreateFontW: {}", io::Error::last_os_error()))
    } else {
        Ok(font)
    }
}

unsafe fn child(
    parent: HWND,
    class: &str,
    label: &str,
    style: u32,
    id: u16,
) -> Result<HWND, String> {
    let hwnd = CreateWindowExW(
        0,
        wide(class).as_ptr(),
        wide(label).as_ptr(),
        WS_CHILD | WS_VISIBLE | style,
        0,
        0,
        0,
        0,
        parent,
        id as usize as HMENU,
        GetModuleHandleW(ptr::null()),
        ptr::null(),
    );
    if hwnd.is_null() {
        Err(format!(
            "CreateWindowExW({class}): {}",
            io::Error::last_os_error()
        ))
    } else {
        Ok(hwnd)
    }
}

unsafe fn initialize(hwnd: HWND) -> Result<Box<WindowState>, String> {
    let buttons = [
        child(
            hwnd,
            "BUTTON",
            "Chat",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            101,
        )?,
        child(
            hwnd,
            "BUTTON",
            "Browser",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            102,
        )?,
        child(
            hwnd,
            "BUTTON",
            "IDE",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            103,
        )?,
    ];
    crate::uia_edit::attach_button(buttons[0], "101", "Chat");
    crate::uia_edit::attach_button(buttons[1], "102", "Browser");
    crate::uia_edit::attach_button(buttons[2], "103", "IDE");
    let heading = child(hwnd, "STATIC", Mode::Chat.description(), 0, 110)?;

    // Single-line accessible composer symbol/equation input (`ID = 114`), exposing
    // server-side UIA `ControlType.Edit` (`50004`) + `ValuePattern` (`QUALITY-01`),
    // while keeping multiline `draft` (`ID = 112`) as `ControlType.Document`.
    let composer_cmd = child(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        114,
    )?;
    SendMessageW(composer_cmd, EM_SETLIMITTEXT, 512, 0);
    crate::uia_edit::attach(composer_cmd, "114", "Rich composer symbol & command input");

    let sym_buttons = [
        child(
            hwnd,
            "BUTTON",
            "∑ Math",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            115,
        )?,
        child(
            hwnd,
            "BUTTON",
            "ℏ Phys",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            116,
        )?,
        child(
            hwnd,
            "BUTTON",
            "⇌ Chem",
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            117,
        )?,
    ];
    crate::uia_edit::attach_button(sym_buttons[0], "115", "∑ Math");
    crate::uia_edit::attach_button(sym_buttons[1], "116", "ℏ Phys");
    crate::uia_edit::attach_button(sym_buttons[2], "117", "⇌ Chem");
    let composer_badge = child(
        hwnd,
        "STATIC",
        "Palette: 15 Math/Phys/Chem templates • Tray: 0",
        0,
        118,
    )?;

    let draft_label = child(
        hwnd,
        "STATIC",
        "Shared scratch draft — kept across modes, not saved to a session",
        0,
        111,
    )?;
    let draft = child(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP
            | WS_BORDER
            | WS_VSCROLL
            | ES_MULTILINE as u32
            | ES_AUTOVSCROLL as u32
            | ES_WANTRETURN as u32,
        112,
    )?;
    // Bound control allocation; this is a draft, not a large-file editor.
    SendMessageW(draft, EM_SETLIMITTEXT, 64 * 1024, 0);
    let status = child(
        hwnd,
        "STATIC",
        "Rust / Win32  •  No WebView  •  No Node runtime  •  Migration shell — not full Omnia",
        0,
        113,
    )?;

    let dpi = crate::session_panel::window_dpi(hwnd);
    let font = create_scaled_font(dpi)?;
    for control in buttons.into_iter().chain(sym_buttons).chain([
        heading,
        composer_cmd,
        composer_badge,
        draft_label,
        draft,
        status,
    ]) {
        SendMessageW(control, WM_SETFONT, font as usize, 1);
    }
    let sessions = match crate::session_panel::create(hwnd, font) {
        Ok(panel) => panel,
        Err(error) => {
            DeleteObject(font);
            return Err(error);
        }
    };
    let handles = Handles {
        buttons,
        heading,
        composer_cmd,
        sym_buttons,
        composer_badge,
        draft_label,
        draft,
        status,
        sessions,
    };
    Ok(Box::new(WindowState {
        handles,
        font,
        composer: Rc::new(RefCell::new(RichComposer::new())),
    }))
}

unsafe fn layout(hwnd: HWND, handles: Handles) {
    let mut rect: RECT = std::mem::zeroed();
    if GetClientRect(hwnd, &mut rect) == 0 {
        return;
    }
    let dpi = crate::session_panel::window_dpi(hwnd);
    let s = |v: i32| crate::session_panel::scale_px(v, dpi);

    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);

    for (index, button) in handles.buttons.iter().enumerate() {
        MoveWindow(
            *button,
            s(20) + index as i32 * s(112),
            s(18),
            s(104),
            s(36),
            1,
        );
    }

    let left_panel_w = s(282);
    let right_x = s(336);
    let right_w = (width - right_x - s(24)).max(1);

    let footer_y = (height - s(36)).max(s(360));
    let draft_h = s(112);
    let draft_y = (footer_y - draft_h - s(10)).max(s(225));
    let draft_label_y = (draft_y - s(26)).max(s(195));
    let toolbar_y = (draft_label_y - s(34)).max(s(158));
    let heading_y = s(82);
    let heading_h = (toolbar_y - heading_y - s(12)).max(s(70));

    MoveWindow(handles.heading, right_x, heading_y, right_w, heading_h, 1);

    // Rich composer toolbar (`114` accessible Edit + `115..117` Math/Phys/Chem buttons + `118` telemetry).
    let cmd_w = s(220).min((right_w / 3).max(s(120)));
    MoveWindow(handles.composer_cmd, right_x, toolbar_y, cmd_w, s(28), 1);
    let btn_w = s(78);
    let mut cur_x = right_x + cmd_w + s(8);
    for sym_btn in handles.sym_buttons {
        MoveWindow(sym_btn, cur_x, toolbar_y, btn_w, s(28), 1);
        cur_x += btn_w + s(6);
    }
    let badge_w = (right_x + right_w - cur_x).max(s(60));
    MoveWindow(
        handles.composer_badge,
        cur_x,
        toolbar_y + s(4),
        badge_w,
        s(22),
        1,
    );

    MoveWindow(
        handles.draft_label,
        right_x,
        draft_label_y,
        right_w,
        s(24),
        1,
    );
    MoveWindow(handles.draft, right_x, draft_y, right_w, draft_h, 1);
    MoveWindow(
        handles.status,
        s(24),
        footer_y,
        (width - s(48)).max(1),
        s(24),
        1,
    );

    let panel_h = (footer_y - heading_y - s(8)).max(s(560));
    MoveWindow(handles.sessions, s(24), heading_y, left_panel_w, panel_h, 1);
}

unsafe fn insert_domain_symbol(
    handles: Handles,
    composer: &Rc<RefCell<RichComposer>>,
    domain: SymbolDomain,
) {
    let filter = read_window_text(handles.composer_cmd);
    let matches = search_symbol_palette(&filter, Some(domain));
    let Some(entry) = matches
        .first()
        .copied()
        .or_else(|| search_symbol_palette("", Some(domain)).first().copied())
    else {
        return;
    };

    let current_draft = read_window_text(handles.draft);
    let separator = if current_draft.is_empty() || current_draft.ends_with(char::is_whitespace) {
        ""
    } else {
        " "
    };
    let updated_draft = format!("{current_draft}{separator}{}", entry.glyph_preview);
    SetWindowTextW(handles.draft, wide(&updated_draft).as_ptr());

    let badge_summary = {
        let mut comp = composer.borrow_mut();
        comp.set_plain_text(&current_draft);
        let _ = comp.insert_symbol_at_caret(entry.id, usize::MAX, false);
        let preview = comp.render_live_preview();
        format!(
            "Inserted {} ({}) • Nodes: {} • Tray: {}",
            entry.glyph_preview,
            entry.title,
            comp.document.len(),
            preview.tray_attachment_chips.len()
        )
    };
    SetWindowTextW(handles.composer_badge, wide(&badge_summary).as_ptr());
    SetFocus(handles.draft);
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_CREATE => match initialize(hwnd) {
            Ok(state) => {
                let handles = state.handles;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);
                layout(hwnd, handles);
                0
            }
            Err(error) => {
                show_error(&error);
                -1
            }
        },
        WM_GETMINMAXINFO => {
            let dpi = crate::session_panel::window_dpi(hwnd);
            let info = &mut *(lparam as *mut MINMAXINFO);
            info.ptMinTrackSize = POINT {
                x: crate::session_panel::scale_px(1000, dpi),
                y: crate::session_panel::scale_px(820, dpi),
            };
            0
        }
        WM_SIZE => {
            if let Some(handles) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowState)
                .as_ref()
                .map(|s| s.handles)
            {
                // Copy handles before Win32 calls that can synchronously reenter.
                layout(hwnd, handles);
            }
            0
        }
        WM_DPICHANGED_MSG => {
            let new_dpi = ((wparam >> 16) & 0xffff) as u32;
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
            if let Some(state) = state_ptr.as_mut() {
                if let Ok(new_font) = create_scaled_font(new_dpi.max(96)) {
                    let old_font = state.font;
                    state.font = new_font;
                    let handles = state.handles;
                    for control in handles
                        .buttons
                        .into_iter()
                        .chain(handles.sym_buttons)
                        .chain([
                            handles.heading,
                            handles.composer_cmd,
                            handles.composer_badge,
                            handles.draft_label,
                            handles.draft,
                            handles.status,
                        ])
                    {
                        SendMessageW(control, WM_SETFONT, new_font as usize, 1);
                    }
                    crate::session_panel::apply_font_and_relayout(handles.sessions, new_font);
                    if !old_font.is_null() {
                        DeleteObject(old_font);
                    }
                    if lparam != 0 {
                        let suggested = &*(lparam as *const RECT);
                        SetWindowPos(
                            hwnd,
                            ptr::null_mut(),
                            suggested.left,
                            suggested.top,
                            (suggested.right - suggested.left).max(1),
                            (suggested.bottom - suggested.top).max(1),
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    layout(hwnd, handles);
                }
            }
            0
        }
        WM_COMMAND => {
            // Only route actual button notifications, never edit notifications
            // or an unrelated command sharing the same numeric identifier.
            let snapshot = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowState)
                .as_ref()
                .map(|s| (s.handles, Rc::clone(&s.composer)));
            if let Some((handles, composer)) = snapshot {
                if wparam >> 16 == BN_CLICKED as usize {
                    let id = (wparam & 0xffff) as u16;
                    let sender = lparam as HWND;
                    if let Some(mode) = Mode::from_command(id) {
                        if handles.buttons[(id - 101) as usize] == sender {
                            SetWindowTextW(handles.heading, wide(mode.description()).as_ptr());
                            SetFocus(handles.draft);
                        }
                    } else if id == 115 && handles.sym_buttons[0] == sender {
                        insert_domain_symbol(handles, &composer, SymbolDomain::Mathematics);
                    } else if id == 116 && handles.sym_buttons[1] == sender {
                        insert_domain_symbol(handles, &composer, SymbolDomain::Physics);
                    } else if id == 117 && handles.sym_buttons[2] == sender {
                        insert_domain_symbol(handles, &composer, SymbolDomain::Chemistry);
                    }
                }
            }
            0
        }
        WM_CLOSE => {
            let handles = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowState)
                .as_ref()
                .map(|s| s.handles);
            if let Some(handles) = handles {
                if !crate::session_panel::can_close(handles.sessions) {
                    return 0;
                }
                if GetWindowTextLengthW(handles.draft) > 0
                    && crate::uia_edit::modal_message_box(
                        hwnd,
                        wide("This draft is not saved. Close and discard it?").as_ptr(),
                        wide("Omnia — unsaved draft").as_ptr(),
                        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
                    ) != IDYES
                {
                    return 0;
                }
            }
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        WM_NCDESTROY => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if !state_ptr.is_null() {
                let state = Box::from_raw(state_ptr);
                DeleteObject(state.font);
            }
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

pub fn run() -> Result<(), String> {
    unsafe {
        let com = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if com < 0 {
            return Err(format!("CoInitializeEx failed: HRESULT {com:#x}"));
        }
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let instance = GetModuleHandleW(ptr::null());
        let class_name = wide("OmniaNativeShell");
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_WINDOW + 1) as usize as HBRUSH,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassExW(&class) == 0 {
            return Err(format!("RegisterClassExW: {}", io::Error::last_os_error()));
        }
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("Omnia — native Rust migration").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1220,
            820,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if hwnd.is_null() {
            return Err(format!("CreateWindowExW: {}", io::Error::last_os_error()));
        }
        ShowWindow(hwnd, SW_SHOW);
        let mut message: MSG = std::mem::zeroed();
        loop {
            let result = GetMessageW(&mut message, ptr::null_mut(), 0, 0);
            if result == -1 {
                return Err(format!("GetMessageW: {}", io::Error::last_os_error()));
            }
            if result == 0 {
                return Ok(());
            }
            if IsDialogMessageW(hwnd, &message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
}
