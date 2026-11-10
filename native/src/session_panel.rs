//! Native session metadata UI using the shared Rust authority. All storage
//! borrows finish before any Win32 call that may synchronously reenter.
use omnia_native::session_form::SessionForm;
use omnia_native::sessions::{SessionCommand, SessionWorker, EFFORTS};
use omnia_session_store::session_navigation::AgentSessionPageCursor;
use omnia_session_store::AgentSessionSummary;
use std::{cell::RefCell, path::PathBuf, ptr, rc::Rc};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Controls::EM_SETLIMITTEXT, Input::KeyboardAndMouse::EnableWindow, WindowsAndMessaging::*,
    },
};

#[derive(Clone, Copy)]
struct Handles {
    list: HWND,
    new: HWND,
    title: HWND,
    model: HWND,
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

unsafe fn initialize(hwnd: HWND) -> Result<Box<Panel>, String> {
    control(hwnd, "STATIC", "Sessions · native SQLite", 0, 119, 0, 24)?;
    let new = control(
        hwnd,
        "BUTTON",
        "New projectless chat",
        WS_TABSTOP,
        121,
        28,
        32,
    )?;
    let list = control(
        hwnd,
        "LISTBOX",
        "",
        WS_TABSTOP | WS_BORDER | WS_VSCROLL | LBS_NOTIFY as u32,
        120,
        68,
        140,
    )?;
    let previous = control(hwnd, "BUTTON", "Previous page", WS_TABSTOP, 128, 212, 30)?;
    let next = control(hwnd, "BUTTON", "Next page", WS_TABSTOP, 129, 212, 30)?;
    MoveWindow(previous, 0, 212, 137, 30, 0);
    MoveWindow(next, 145, 212, 137, 30, 0);
    control(hwnd, "STATIC", "Session title", 0, 130, 252, 22)?;
    let title = control(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        122,
        277,
        28,
    )?;
    control(
        hwnd,
        "STATIC",
        "Model ID (profile not connected)",
        0,
        131,
        317,
        22,
    )?;
    let model = control(
        hwnd,
        "EDIT",
        "",
        WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        123,
        342,
        28,
    )?;
    control(hwnd, "STATIC", "Effort", 0, 132, 382, 22)?;
    let effort = control(
        hwnd,
        "COMBOBOX",
        "",
        WS_TABSTOP | CBS_DROPDOWNLIST as u32 | WS_VSCROLL,
        124,
        407,
        240,
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
        447,
        32,
    )?;
    let status = control(hwnd, "STATIC", "", 0, 126, 491, 115)?;
    let refresh = control(hwnd, "BUTTON", "Refresh sessions", WS_TABSTOP, 127, 610, 30)?;
    for edit in [title, model] {
        SendMessageW(edit, EM_SETLIMITTEXT, 256, 0);
    }
    let handles = Handles {
        list,
        new,
        title,
        model,
        effort,
        apply,
        status,
        refresh,
        previous,
        next,
    };
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
        text(status, "Storage disconnected.\n\nLaunch with --session-db <isolated absolute path> to evaluate durable sessions.\n\nNo personal database is opened automatically.");
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
        text(handles.status, &format!("Settings revision {}\n{} rows (limit 50). {}\n\nProvider unconfigured; no request sent. Draft is unsaved.", active.settings_revision, rows.len(), location));
    } else {
        text(handles.title, "");
        text(handles.model, "");
        SendMessageW(handles.effort, CB_SETCURSEL, usize::MAX, 0);
        text(handles.status, "No active session.\nCreate or select a session. Draft below is a separate, unsaved scratch buffer.");
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
    !dirty || MessageBoxW(
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
            MessageBoxW(
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
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(panel) as isize);
                0
            }
            Err(error) => {
                super::win32::show_error(&error);
                -1
            }
        },
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
        610,
        parent,
        140usize as HMENU,
        instance,
        ptr::null(),
    );
    if panel.is_null() {
        return Err("Create session panel failed".into());
    }
    let mut child = GetWindow(panel, GW_CHILD);
    while !child.is_null() {
        SendMessageW(child, WM_SETFONT, font as usize, 1);
        child = GetWindow(child, GW_HWNDNEXT);
    }
    Ok(panel)
}
