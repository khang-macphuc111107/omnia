//! Original Win32 shell. All HWNDs and borrowed Win32 state stay on the UI
//! thread. GetMessage blocks at idle; session storage starts one worker only
//! when an explicit database is supplied. No renderer or polling timer.
use omnia_native::Mode;
use std::{io, mem::size_of, ptr};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        LibraryLoader::GetModuleHandleW,
    },
    UI::{Controls::EM_SETLIMITTEXT, Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
};

#[derive(Clone, Copy)]
struct WindowState {
    buttons: [HWND; 3],
    heading: HWND,
    draft_label: HWND,
    draft: HWND,
    status: HWND,
    font: HFONT,
    sessions: HWND,
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
    let heading = child(hwnd, "STATIC", Mode::Chat.description(), 0, 110)?;
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
    let font = CreateFontW(
        -17,
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
        return Err(format!("CreateFontW: {}", io::Error::last_os_error()));
    }
    for control in buttons
        .into_iter()
        .chain([heading, draft_label, draft, status])
    {
        SendMessageW(control, WM_SETFONT, font as usize, 1);
    }
    let sessions = match crate::session_panel::create(hwnd, font) {
        Ok(panel) => panel,
        Err(error) => {
            DeleteObject(font);
            return Err(error);
        }
    };
    Ok(Box::new(WindowState {
        buttons,
        heading,
        draft_label,
        draft,
        status,
        font,
        sessions,
    }))
}

unsafe fn layout(hwnd: HWND, state: WindowState) {
    let mut rect: RECT = std::mem::zeroed();
    if GetClientRect(hwnd, &mut rect) == 0 {
        return;
    }
    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);
    for (index, button) in state.buttons.iter().enumerate() {
        MoveWindow(*button, 20 + index as i32 * 112, 18, 104, 36, 1);
    }
    MoveWindow(
        state.heading,
        336,
        82,
        (width - 360).max(1),
        (height - 310).max(70),
        1,
    );
    MoveWindow(
        state.draft_label,
        336,
        (height - 202).max(155),
        (width - 360).max(1),
        24,
        1,
    );
    MoveWindow(
        state.draft,
        336,
        (height - 172).max(185),
        (width - 360).max(1),
        112,
        1,
    );
    MoveWindow(
        state.status,
        24,
        (height - 38).max(310),
        (width - 48).max(1),
        24,
        1,
    );
    MoveWindow(state.sessions, 24, 82, 282, (height - 125).max(610), 1);
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
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);
                0
            }
            Err(error) => {
                show_error(&error);
                -1
            }
        },
        WM_GETMINMAXINFO => {
            let info = &mut *(lparam as *mut MINMAXINFO);
            info.ptMinTrackSize = POINT { x: 1000, y: 820 };
            0
        }
        WM_SIZE => {
            if let Some(state) =
                (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState).as_ref()
            {
                // Copy handles before Win32 calls that can synchronously reenter.
                layout(hwnd, *state);
            }
            0
        }
        WM_COMMAND => {
            // Only route actual button notifications, never edit notifications
            // or an unrelated command sharing the same numeric identifier.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
            if let Some(state) = state_ptr.as_ref().copied() {
                if wparam >> 16 == BN_CLICKED as usize {
                    let id = (wparam & 0xffff) as u16;
                    if let Some(mode) = Mode::from_command(id) {
                        if state.buttons[(id - 101) as usize] == lparam as HWND {
                            SetWindowTextW(state.heading, wide(mode.description()).as_ptr());
                            SetFocus(state.draft);
                        }
                    }
                }
            }
            0
        }
        WM_CLOSE => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
            if let Some(state) = state_ptr.as_ref().copied() {
                if !crate::session_panel::can_close(state.sessions) {
                    return 0;
                }
                if GetWindowTextLengthW(state.draft) > 0
                    && MessageBoxW(
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
