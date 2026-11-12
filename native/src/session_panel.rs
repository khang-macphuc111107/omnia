//! Native session metadata UI using the shared Rust authority. All storage
//! borrows finish before any Win32 call that may synchronously reenter.
//!
//! Includes dynamic `WM_SIZE` & per-window DPI layout (`QUALITY-01`) so the
//! session status readout (`ID = 126`) never clips above `Refresh sessions`
//! (`ID = 127`) at `1220x820` or under display scaling.
use omnia_native::session_form::SessionForm;
use omnia_native::sessions::{SessionCommand, SessionWorker, EFFORTS};
use omnia_session_store::session_navigation::AgentSessionPageCursor;
use omnia_session_store::AgentSessionSummary;
use std::{cell::RefCell, path::PathBuf, ptr, rc::Rc};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
    UI::{
        Controls::EM_SETLIMITTEXT, Input::KeyboardAndMouse::EnableWindow, WindowsAndMessaging::*,
    },
};

#[derive(Clone, Copy)]
struct Handles {
    header_label: HWND,
    list: HWND,
    new: HWND,
    title_label: HWND,
    title: HWND,
    model_label: HWND,
    model: HWND,
    effort_label: HWND,
    effort: HWND,
    apply: HWND,
    status: HWND,
    refresh: HWND,
    previous: HWND,
    next: HWND,
}

struct Model {
    worker: SessionWorker,
    pending: bool,
    rows: Vec<AgentSessionSummary>,
    active: Option<AgentSessionSummary>,
    nav_revision: i64,
    cursor: Option<AgentSessionPageCursor>,
    next_cursor: Option<AgentSessionPageCursor>,
    history: Vec<Option<AgentSessionPageCursor>>,
    pending_history: Option<Vec<Option<AgentSessionPageCursor>>>,
    baseline: Option<SessionForm>,
}

struct Panel {
    handles: Handles,
    state: Option<Rc<RefCell<Model>>>,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

pub(crate) unsafe fn window_dpi(hwnd: HWND) -> u32 {
    type GetDpiForWindowFn = unsafe extern "system" fn(HWND) -> u32;
    let user32 = GetModuleHandleW(wide("user32.dll").as_ptr());
    if !user32.is_null() {
        if let Some(proc_addr) = GetProcAddress(user32, b"GetDpiForWindow\0".as_ptr()) {
            let get_dpi: GetDpiForWindowFn = std::mem::transmute(proc_addr);
            let dpi = get_dpi(hwnd);
            if dpi >= 72 {
                return dpi;
            }
        }
    }
    96
}

#[inline]
pub(crate) fn scale_px(px: i32, dpi: u32) -> i32 {
    ((px as i64 * dpi as i64 + 48) / 96) as i32
}

unsafe fn text(hwnd: HWND, value: &str) {
    SetWindowTextW(hwnd, wide(value).as_ptr());
}

unsafe fn read(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 1025];
    let length = SendMessageW(hwnd, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as isize);
    String::from_utf16_lossy(&buffer[..(length.max(0) as usize).min(1024)])
}

unsafe fn control(
    parent: HWND,
    class: &str,
    label: &str,
    style: u32,
    id: u16,
    y: i32,
    height: i32,
) -> Result<HWND, String> {
    let handle = CreateWindowExW(
        0,
        wide(class).as_ptr(),
        wide(label).as_ptr(),
        WS_CHILD | WS_VISIBLE | style,
        0,
        y,
        282,
        height,
        parent,
        id as usize as HMENU,
        GetModuleHandleW(ptr::null()),
        ptr::null(),
    );
    if handle.is_null() {
        Err(format!("Session control {id} could not be created"))
    } else {
        Ok(handle)
    }
}

fn requested_database() -> Result<Option<PathBuf>, String> {
    let mut args = std::env::args_os().skip(1);
    let mut database = None;
    while let Some(arg) = args.next() {
        if arg != "--session-db" || database.is_some() {
            return Err(
                "Usage: omnia-native [--session-db <absolute isolated database path>]".into(),
            );
        }
        let path = PathBuf::from(args.next().ok_or("--session-db requires a path")?);
        if !path.is_absolute() || !path.parent().is_some_and(|parent| parent.is_dir()) {
            return Err(
                "Session database must be an absolute path with an existing parent directory"
                    .into(),
            );
        }
        database = Some(path);
    }
    Ok(database)
}

unsafe fn layout_panel(hwnd: HWND, handles: Handles) {
    let mut rect: RECT = std::mem::zeroed();
    if GetClientRect(hwnd, &mut rect) == 0 {
        return;
    }
    let dpi = window_dpi(hwnd);
    let s = |v: i32| scale_px(v, dpi);
    let width = (rect.right - rect.left).max(s(220));
    let height = (rect.bottom - rect.top).max(s(560));

    // Reserve generous room for the multi-line status label (`126`) above `Refresh sessions` (`127`).
    let extra_vertical = (height - s(650)).max(0);
    let list_h = s(100) + (extra_vertical / 2);

    let mut y = 0;
    MoveWindow(handles.header_label, 0, y, width, s(22), 1);
    y += s(25);
    MoveWindow(handles.new, 0, y, width, s(30), 1);
    y += s(35);
    MoveWindow(handles.list, 0, y, width, list_h, 1);
    y += list_h + s(6);

    let half_gap = s(8);
    let page_btn_w = ((width - half_gap) / 2).max(s(60));
    MoveWindow(handles.previous, 0, y, page_btn_w, s(28), 1);
    MoveWindow(
        handles.next,
        page_btn_w + half_gap,
        y,
        (width - page_btn_w - half_gap).max(s(60)),
        s(28),
        1,
    );
    y += s(34);

    MoveWindow(handles.title_label, 0, y, width, s(20), 1);
    y += s(22);
    MoveWindow(handles.title, 0, y, width, s(26), 1);
    y += s(32);

    MoveWindow(handles.model_label, 0, y, width, s(20), 1);
    y += s(22);
    MoveWindow(handles.model, 0, y, width, s(26), 1);
    y += s(32);

    MoveWindow(handles.effort_label, 0, y, width, s(20), 1);
    y += s(22);
    // Note: For CBS_DROPDOWNLIST, height specifies the expanded dropdown box height.
    MoveWindow(handles.effort, 0, y, width, s(220), 1);
    y += s(34);

    MoveWindow(handles.apply, 0, y, width, s(30), 1);
    y += s(38);

    let refresh_h = s(30);
    let refresh_y = (height - refresh_h - s(2)).max(y + s(156));
    let status_h = (refresh_y - y - s(6)).max(s(150));
    MoveWindow(handles.status, 0, y, width, status_h, 1);
    MoveWindow(handles.refresh, 0, refresh_y, width, refresh_h, 1);
}

unsafe fn initialize(hwnd: HWND) -> Result<Box<Panel>, String> {
    let header_label = control(hwnd, "STATIC", "Sessions · native SQLite", 0, 119, 0, 22)?;
    let new = control(
        hwnd,
        "BUTTON",
        "New projectless chat",
        WS_TABSTOP,
        121,
        25,
        30,
    )?;
    crate::uia_edit::attach_button(new, "121", "New projectless chat");
    let list = control(
        hwnd,
        "LISTBOX",
        "",
        WS_TABSTOP | WS_BORDER | WS_VSCROLL | LBS_NOTIFY as u32,
        120,
        60,
        104,
    )?;
    let previous = control(hwnd, "BUTTON", "Previous page", WS_TABSTOP, 128, 170, 28)?;
    crate::uia_edit::attach_button(previous, "128", "Previous page");
    let next = control(hwnd, "BUTTON", "Next page", WS_TABSTOP, 129, 170, 28)?;
    crate::uia_edit::attach_button(next, "129", "Next page");
    let title_label = control(hwnd, "STATIC", "Session title", 0, 130, 204, 20)?;
    let title = control(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        122,
        226,
        26,
    )?;
    let model_label = control(
        hwnd,
        "STATIC",
        "Model ID (profile not connected)",
        0,
        131,
        258,
        20,
    )?;
    let model = control(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        123,
        280,
        26,
    )?;
    let effort_label = control(hwnd, "STATIC", "Effort", 0, 132, 312, 20)?;
    let effort = control(
        hwnd,
        "COMBOBOX",
        "",
        WS_TABSTOP | CBS_DROPDOWNLIST as u32 | WS_VSCROLL,
        124,
        334,
        220,
    )?;
    for name in EFFORTS {
        SendMessageW(effort, CB_ADDSTRING, 0, wide(name).as_ptr() as isize);
    }
    let apply = control(
        hwnd,
        "BUTTON",
        "Save session settings",
        WS_TABSTOP,
        125,
        368,
        30,
    )?;
    crate::uia_edit::attach_button(apply, "125", "Save session settings");
    let status = control(hwnd, "STATIC", "", 0, 126, 406, 210)?;
    let refresh = control(hwnd, "BUTTON", "Refresh sessions", WS_TABSTOP, 127, 622, 30)?;
    crate::uia_edit::attach_button(refresh, "127", "Refresh sessions");
    for edit in [title, model] {
        SendMessageW(edit, EM_SETLIMITTEXT, 256, 0);
    }
    let handles = Handles {
        header_label,
        list,
        new,
        title_label,
        title,
        model_label,
        model,
        effort_label,
        effort,
        apply,
        status,
        refresh,
        previous,
        next,
    };
    layout_panel(hwnd, handles);

    let state = if let Some(path) = requested_database()? {
        let target = hwnd as usize;
        let worker = SessionWorker::start(path, move || unsafe {
            PostMessageW(target as HWND, WM_APP + 25, 0, 0);
        })
        .map_err(|error| error.message)?;
        Some(Rc::new(RefCell::new(Model {
            worker,
            pending: true,
            rows: Vec::new(),
            active: None,
            nav_revision: 0,
            cursor: None,
            next_cursor: None,
            history: Vec::new(),
            pending_history: None,
            baseline: None,
        })))
    } else {
        None
    };
    if state.is_none() {
        for item in [
            new, list, title, model, effort, apply, refresh, previous, next,
        ] {
            EnableWindow(item, 0);
        }
        text(
            status,
            "Storage disconnected.\n\nLaunch with --session-db <isolated absolute path> to evaluate durable sessions.\n\nNo personal database is opened automatically.",
        );
    }
    let panel = Box::new(Panel { handles, state });
    if let Some(state) = &panel.state {
        render(handles, state);
        set_busy(handles, true);
    }
    Ok(panel)
}

unsafe fn render(handles: Handles, state: &Rc<RefCell<Model>>) {
    let (rows, active, previous_enabled, next_enabled) = {
        let model = state.borrow();
        (
            model.rows.clone(),
            model.active.clone(),
            !model.history.is_empty(),
            model.next_cursor.is_some(),
        )
    };
    EnableWindow(handles.previous, i32::from(previous_enabled));
    EnableWindow(handles.next, i32::from(next_enabled));
    SendMessageW(handles.list, LB_RESETCONTENT, 0, 0);
    for (index, row) in rows.iter().enumerate() {
        SendMessageW(
            handles.list,
            LB_ADDSTRING,
            0,
            wide(&row.title).as_ptr() as isize,
        );
        if active.as_ref().is_some_and(|item| item.id == row.id) {
            SendMessageW(handles.list, LB_SETCURSEL, index, 0);
        }
    }
    let active_exists = active.is_some();
    for item in [handles.title, handles.model, handles.effort, handles.apply] {
        EnableWindow(item, i32::from(active_exists));
    }
    if let Some(active) = active {
        let location = if rows.iter().any(|row| row.id == active.id) {
            "Active session is on this page."
        } else {
            "Active session is outside this page; settings remain selected."
        };
        text(handles.title, &active.title);
        text(handles.model, &active.model);
        let index = active
            .reasoning_effort
            .as_deref()
            .and_then(|effort| EFFORTS.iter().position(|name| *name == effort));
        SendMessageW(handles.effort, CB_SETCURSEL, index.unwrap_or(3), 0);
        text(
            handles.status,
            &format!(
                "Settings revision {}\n{} rows (limit 50). {}\n\nProvider unconfigured; no request sent. Draft is unsaved.",
                active.settings_revision,
                rows.len(),
                location
            ),
        );
    } else {
        text(handles.title, "");
        text(handles.model, "");
        SendMessageW(handles.effort, CB_SETCURSEL, usize::MAX, 0);
        text(
            handles.status,
            "No active session.\nCreate or select a session. Draft below is a separate, unsaved scratch buffer.",
        );
    }
    let baseline = active_exists.then(|| read_form(handles));
    state.borrow_mut().baseline = baseline;
}

unsafe fn read_form(handles: Handles) -> SessionForm {
    let index = SendMessageW(handles.effort, CB_GETCURSEL, 0, 0);
    SessionForm {
        title: read(handles.title),
        model: read(handles.model),
        effort_index: usize::try_from(index).ok(),
    }
}

unsafe fn confirm_discard(handles: Handles, state: &Rc<RefCell<Model>>) -> bool {
    let current = read_form(handles);
    let dirty = current.changed_from(state.borrow().baseline.as_ref());
    // Release all RefCell borrows before entering the nested Win32 modal loop.
    !dirty
        || crate::uia_edit::modal_message_box(
            GetAncestor(handles.list, GA_ROOT),
            wide("Session settings have unsaved changes. Discard them?\n\nChoose No to keep editing, or save the settings before navigating.").as_ptr(),
            wide("Omnia — unsaved session settings").as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
}

unsafe fn restore_selection(handles: Handles, state: &Rc<RefCell<Model>>) {
    let selection = {
        let model = state.borrow();
        model
            .active
            .as_ref()
            .and_then(|active| model.rows.iter().position(|row| row.id == active.id))
    };
    SendMessageW(
        handles.list,
        LB_SETCURSEL,
        selection.unwrap_or(usize::MAX),
        0,
    );
}

/// A close request must not silently discard metadata or race an in-flight write.
pub unsafe fn can_close(hwnd: HWND) -> bool {
    let snapshot = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Panel)
        .as_ref()
        .and_then(|panel| {
            panel
                .state
                .as_ref()
                .map(|state| (panel.handles, Rc::clone(state)))
        });
    if let Some((handles, state)) = snapshot {
        if state.borrow().pending {
            crate::uia_edit::modal_message_box(
                GetAncestor(hwnd, GA_ROOT),
                wide("A storage operation is still pending. Wait for its result before closing.")
                    .as_ptr(),
                wide("Omnia — storage pending").as_ptr(),
                MB_OK | MB_ICONINFORMATION,
            );
            return false;
        }
        return confirm_discard(handles, &state);
    }
    true
}

pub unsafe fn apply_font_and_relayout(hwnd: HWND, font: HFONT) {
    let mut child = GetWindow(hwnd, GW_CHILD);
    while !child.is_null() {
        SendMessageW(child, WM_SETFONT, font as usize, 1);
        child = GetWindow(child, GW_HWNDNEXT);
    }
    if let Some(handles) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Panel)
        .as_ref()
        .map(|p| p.handles)
    {
        layout_panel(hwnd, handles);
    }
}

unsafe fn set_busy(handles: Handles, busy: bool) {
    for item in [
        handles.new,
        handles.list,
        handles.apply,
        handles.refresh,
        handles.previous,
        handles.next,
    ] {
        EnableWindow(item, i32::from(!busy));
    }
    if busy {
        for input in [handles.title, handles.model, handles.effort] {
            EnableWindow(input, 0);
        }
        text(
            handles.status,
            "Storage operation pending on one bounded worker. UI remains interactive.",
        );
    }
}

unsafe fn command(
    handles: Handles,
    state: Rc<RefCell<Model>>,
    id: u16,
    notification: u16,
    sender: HWND,
) {
    if state.borrow().pending {
        return;
    }
    let mut paging_history = None;
    // Read native controls before borrowing application state.
    let request = if id == 129 && notification == BN_CLICKED as u16 && sender == handles.next {
        let model = state.borrow();
        model.next_cursor.clone().map(|cursor| {
            let mut history = model.history.clone();
            // Bound navigation memory independently of library size. Refresh
            // always returns to the first page when older cursors are evicted.
            if history.len() == 256 {
                history.remove(0);
            }
            history.push(model.cursor.clone());
            paging_history = Some(history);
            SessionCommand::Page {
                cursor: Some(cursor),
            }
        })
    } else if id == 128 && notification == BN_CLICKED as u16 && sender == handles.previous {
        let model = state.borrow();
        let mut history = model.history.clone();
        history.pop().map(|cursor| {
            paging_history = Some(history);
            SessionCommand::Page { cursor }
        })
    } else if id == 127 && notification == BN_CLICKED as u16 && sender == handles.refresh {
        Some(SessionCommand::Refresh)
    } else if id == 121 && notification == BN_CLICKED as u16 && sender == handles.new {
        Some(SessionCommand::Create {
            expected_revision: state.borrow().nav_revision,
        })
    } else if id == 120 && notification == LBN_SELCHANGE as u16 && sender == handles.list {
        let index = SendMessageW(handles.list, LB_GETCURSEL, 0, 0);
        let model = state.borrow();
        model
            .rows
            .get(index as usize)
            .map(|row| SessionCommand::Select {
                id: row.id.clone(),
                expected_revision: model.nav_revision,
            })
    } else if id == 125 && notification == BN_CLICKED as u16 && sender == handles.apply {
        let title = read(handles.title);
        let model_id = read(handles.model);
        let index = SendMessageW(handles.effort, CB_GETCURSEL, 0, 0);
        let model = state.borrow();
        model.active.as_ref().and_then(|active| {
            EFFORTS
                .get(index as usize)
                .map(|effort| SessionCommand::Update {
                    id: active.id.clone(),
                    expected_revision: active.settings_revision,
                    title,
                    model: model_id,
                    effort: (*effort).to_owned(),
                })
        })
    } else {
        None
    };
    if let Some(request) = request {
        if !matches!(&request, SessionCommand::Update { .. }) && !confirm_discard(handles, &state) {
            restore_selection(handles, &state);
            return;
        }
        let result = {
            let mut model = state.borrow_mut();
            let result = model.worker.submit(request);
            if result.is_ok() {
                model.pending = true;
                model.pending_history = paging_history;
            }
            result
        };
        match result {
            Ok(()) => set_busy(handles, true),
            Err(error) => {
                restore_selection(handles, &state);
                text(
                    handles.status,
                    &format!("{}: {}", error.code, error.message),
                );
            }
        }
    }
}

unsafe fn completed(handles: Handles, state: Rc<RefCell<Model>>) {
    let response = {
        let mut model = state.borrow_mut();
        match model.worker.poll() {
            Some(Ok(snapshot)) => {
                model.rows = snapshot.rows;
                model.active = snapshot.active;
                model.nav_revision = snapshot.navigation_revision;
                model.cursor = snapshot.cursor;
                model.next_cursor = snapshot.next_cursor;
                model.history = model.pending_history.take().unwrap_or_default();
                model.pending = false;
                model.pending_history = None;
                Some(Ok(()))
            }
            Some(Err(error)) => {
                model.pending = false;
                model.pending_history = None;
                Some(Err(error))
            }
            None => None,
        }
    };
    match response {
        Some(Ok(())) => {
            set_busy(handles, false);
            render(handles, &state);
        }
        Some(Err(error)) => {
            restore_selection(handles, &state);
            set_busy(handles, false);
            let (active_exists, has_previous, has_next) = {
                let model = state.borrow();
                (
                    model.active.is_some(),
                    !model.history.is_empty(),
                    model.next_cursor.is_some(),
                )
            };
            EnableWindow(handles.apply, i32::from(active_exists));
            for input in [handles.title, handles.model, handles.effort] {
                EnableWindow(input, i32::from(active_exists));
            }
            EnableWindow(handles.previous, i32::from(has_previous));
            EnableWindow(handles.next, i32::from(has_next));
            text(
                handles.status,
                &format!(
                    "{}: {}\nNo automatic retry. Select a session to reload.",
                    error.code, error.message
                ),
            );
        }
        None => (),
    }
}

unsafe extern "system" fn proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match message {
        WM_CREATE => match initialize(hwnd) {
            Ok(panel) => {
                let handles = panel.handles;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(panel) as isize);
                layout_panel(hwnd, handles);
                0
            }
            Err(error) => {
                super::win32::show_error(&error);
                -1
            }
        },
        WM_SIZE => {
            if let Some(handles) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Panel)
                .as_ref()
                .map(|p| p.handles)
            {
                layout_panel(hwnd, handles);
            }
            0
        }
        message if message == WM_APP + 25 => {
            let snapshot = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Panel)
                .as_ref()
                .and_then(|panel| {
                    panel
                        .state
                        .as_ref()
                        .map(|state| (panel.handles, Rc::clone(state)))
                });
            if let Some((handles, state)) = snapshot {
                completed(handles, state);
            }
            0
        }
        WM_COMMAND => {
            let snapshot = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Panel)
                .as_ref()
                .and_then(|panel| {
                    panel
                        .state
                        .as_ref()
                        .map(|state| (panel.handles, Rc::clone(state)))
                });
            if let Some((handles, state)) = snapshot {
                command(
                    handles,
                    state,
                    (wp & 0xffff) as u16,
                    (wp >> 16) as u16,
                    lp as HWND,
                );
            }
            0
        }
        WM_NCDESTROY => {
            let panel = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Panel;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if !panel.is_null() {
                drop(Box::from_raw(panel));
            }
            DefWindowProcW(hwnd, message, wp, lp)
        }
        _ => DefWindowProcW(hwnd, message, wp, lp),
    }
}

pub unsafe fn create(parent: HWND, font: HFONT) -> Result<HWND, String> {
    let instance = GetModuleHandleW(ptr::null());
    let name = wide("OmniaNativeSessionPanel");
    let class = WNDCLASSW {
        lpfnWndProc: Some(proc),
        hInstance: instance,
        hbrBackground: (COLOR_WINDOW + 1) as usize as HBRUSH,
        lpszClassName: name.as_ptr(),
        ..std::mem::zeroed()
    };
    if RegisterClassW(&class) == 0 {
        return Err("Register session panel class failed".into());
    }
    let panel = CreateWindowExW(
        WS_EX_CONTROLPARENT,
        name.as_ptr(),
        wide("Session metadata").as_ptr(),
        WS_VISIBLE | WS_CHILD | WS_CLIPCHILDREN,
        24,
        80,
        282,
        650,
        parent,
        140usize as HMENU,
        instance,
        ptr::null(),
    );
    if panel.is_null() {
        return Err("Create session panel failed".into());
    }
    apply_font_and_relayout(panel, font);
    Ok(panel)
}
