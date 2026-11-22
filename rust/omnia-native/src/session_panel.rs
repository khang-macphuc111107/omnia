use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use omnia_storage::StoreError;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateSolidBrush, DeleteObject, InvalidateRect, SetBkColor, SetTextColor, HBRUSH, HDC, HFONT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{EM_SETLIMITTEXT, WC_EDITW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetAncestor, GetClientRect, GetWindowLongPtrW, MoveWindow,
    PostMessageW, RegisterClassExW, SendMessageW, SetWindowLongPtrW, SetWindowTextW, ShowWindow,
    BS_PUSHBUTTON, CBS_DROPDOWNLIST, CB_ADDSTRING, CB_GETCURSEL, CB_SETCURSEL, CREATESTRUCTW,
    EN_CHANGE, ES_AUTOHSCROLL, ES_LEFT, GWLP_USERDATA, IDYES, LBN_SELCHANGE, LBS_NOINTEGRALHEIGHT,
    LBS_NOTIFY, LB_ADDSTRING, LB_GETCURSEL, LB_RESETCONTENT, LB_SETCURSEL, MB_DEFBUTTON2,
    MB_ICONWARNING, MB_OK, MB_YESNO, SW_SHOW, WM_COMMAND, WM_CREATE, WM_CTLCOLORBTN,
    WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_CTLCOLORSTATIC, WM_NCDESTROY, WM_SETFONT, WM_SIZE,
    WNDCLASSEXW, WS_BORDER, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_TABSTOP, WS_VISIBLE,
    WS_VSCROLL,
};

use crate::dpi::{compute_session_panel_layout, window_dpi, RectPx};
use crate::sessions::{NativeSessionCommand, NativeSessionEvent, NativeSessionWorker};
use crate::types::{
    effort_index, format_snapshot_status, format_store_error_status, utf8_to_wide,
    validate_session_settings_input, NativeSessionsSnapshot, SessionForm, COLOR_CARD_BG,
    COLOR_INPUT_BG, COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY, EFFORTS, ID_EFFORT_LABEL, ID_MODEL_LABEL,
    ID_NEW_SESSION, ID_NEXT_PAGE, ID_PANEL_HOST, ID_PREV_PAGE, ID_REFRESH_SESSIONS,
    ID_SAVE_SETTINGS, ID_SESSION_EFFORT, ID_SESSION_HEADER, ID_SESSION_LIST, ID_SESSION_MODEL,
    ID_SESSION_STATUS, ID_SESSION_TITLE, ID_TITLE_LABEL, MAX_SETTING_CHARS, SS_LEFT, SS_NOPREFIX,
    WM_SESSION_WORKER_WAKE,
};
use crate::uia_provider::{attach_button, attach_edit, modal_message_box, read_hwnd_text_utf8};

const PANEL_CLASS_NAME: &str = "OmniaNativeSessionPanel";
const GA_ROOT: u32 = 2;
const CBN_SELCHANGE: u32 = 1;

#[link(name = "uxtheme")]
unsafe extern "system" {
    fn SetWindowTheme(hwnd: HWND, sub_app_name: PCWSTR, sub_id_list: PCWSTR) -> i32;
}

/// Child window handles inside `OmniaNativeSessionPanel`.
#[derive(Default)]
struct PanelHandles {
    header: HWND,
    new_button: HWND,
    list: HWND,
    prev_button: HWND,
    next_button: HWND,
    title_label: HWND,
    title_edit: HWND,
    model_label: HWND,
    model_edit: HWND,
    effort_label: HWND,
    effort_combo: HWND,
    save_button: HWND,
    status: HWND,
    refresh_button: HWND,
}

/// Runtime state attached to `OmniaNativeSessionPanel` (`GWLP_USERDATA`).
pub struct SessionPanelState {
    hwnd: HWND,
    handles: PanelHandles,
    font: HFONT,
    bold_font: HFONT,
    card_brush: HBRUSH,
    input_brush: HBRUSH,
    db_path: Option<PathBuf>,
    worker: Option<NativeSessionWorker>,
    pending: bool,
    startup_failed: bool,
    last_snapshot: Option<NativeSessionsSnapshot>,
    row_ids: Vec<String>,
    prior_list_selection: isize,
    baseline: SessionForm,
    expected_revision: i64,
    suppress_notifications: bool,
}

impl SessionPanelState {
    fn cleanup_brushes(&mut self) {
        if !self.card_brush.is_null() {
            // SAFETY: `card_brush` was created via `CreateSolidBrush` inside `WM_CREATE`.
            unsafe {
                let _ = DeleteObject(self.card_brush);
            }
            self.card_brush = null_mut();
        }
        if !self.input_brush.is_null() {
            // SAFETY: `input_brush` was created via `CreateSolidBrush` inside `WM_CREATE`.
            unsafe {
                let _ = DeleteObject(self.input_brush);
            }
            self.input_brush = null_mut();
        }
    }
}

fn enable_hwnd(hwnd: HWND, enabled: bool) {
    if !hwnd.is_null() {
        // SAFETY: `EnableWindow` safely toggles child control enabled state.
        unsafe {
            let _ = windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(
                hwnd,
                i32::from(enabled),
            );
        }
    }
}

fn set_text_utf8(hwnd: HWND, text: &str) {
    if hwnd.is_null() {
        return;
    }
    let wide = utf8_to_wide(text);
    // SAFETY: `wide` is NUL-terminated UTF-16 for a live Win32 child control.
    unsafe {
        let _ = SetWindowTextW(hwnd, wide.as_ptr());
    }
}

fn move_rect(hwnd: HWND, rect: RectPx) {
    if hwnd.is_null() {
        return;
    }
    // SAFETY: `MoveWindow` repositions child window in parent client coordinates.
    unsafe {
        let _ = MoveWindow(
            hwnd,
            rect.left,
            rect.top,
            rect.width().max(1),
            rect.height().max(1),
            1,
        );
    }
}

fn read_selected_effort(combo: HWND) -> String {
    if combo.is_null() {
        return "medium".to_owned();
    }
    // SAFETY: Query selected index from `124` (`COMBOBOX`).
    let idx = unsafe { SendMessageW(combo, CB_GETCURSEL, 0, 0) as isize };
    if idx >= 0 && (idx as usize) < EFFORTS.len() {
        EFFORTS[idx as usize].to_owned()
    } else {
        "medium".to_owned()
    }
}

fn read_live_form(handles: &PanelHandles) -> SessionForm {
    SessionForm {
        title: read_hwnd_text_utf8(handles.title_edit),
        model: read_hwnd_text_utf8(handles.model_edit),
        effort: read_selected_effort(handles.effort_combo),
    }
}

fn set_list_selection(list: HWND, idx: isize) {
    if list.is_null() {
        return;
    }
    let wp = if idx < 0 { usize::MAX } else { idx as usize };
    // SAFETY: `LB_SETCURSEL` accepts `-1` (`usize::MAX`) to clear selection or 0-based index.
    unsafe {
        let _ = SendMessageW(list, LB_SETCURSEL, wp, 0);
    }
}

fn restore_prior_selection(state: &SessionPanelState) {
    set_list_selection(state.handles.list, state.prior_list_selection);
}

fn sync_control_enabled_states(state: &SessionPanelState) {
    let h = &state.handles;
    if state.db_path.is_none() || state.startup_failed {
        for ctrl in [
            h.new_button,
            h.list,
            h.prev_button,
            h.next_button,
            h.title_edit,
            h.model_edit,
            h.effort_combo,
            h.save_button,
            h.refresh_button,
        ] {
            enable_hwnd(ctrl, false);
        }
        return;
    }

    if state.pending {
        for ctrl in [
            h.new_button,
            h.list,
            h.prev_button,
            h.next_button,
            h.title_edit,
            h.model_edit,
            h.effort_combo,
            h.save_button,
            h.refresh_button,
        ] {
            enable_hwnd(ctrl, false);
        }
        return;
    }

    let (has_active, can_prev, can_next) = match state.last_snapshot {
        Some(ref snap) => (
            snap.active_session.is_some(),
            snap.can_go_prev,
            snap.can_go_next,
        ),
        None => (false, false, false),
    };

    enable_hwnd(h.new_button, true);
    enable_hwnd(h.list, true);
    enable_hwnd(h.refresh_button, true);
    enable_hwnd(h.prev_button, can_prev);
    enable_hwnd(h.next_button, can_next);
    enable_hwnd(h.title_edit, has_active);
    enable_hwnd(h.model_edit, has_active);
    enable_hwnd(h.effort_combo, has_active);
    enable_hwnd(h.save_button, has_active);
}

fn layout_panel_controls(state: &SessionPanelState) {
    if state.hwnd.is_null() {
        return;
    }
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: Retrieve current client dimensions of `OmniaNativeSessionPanel`.
    let ok = unsafe { GetClientRect(state.hwnd, &raw mut rc) };
    if ok == 0 {
        return;
    }
    let dpi = window_dpi(state.hwnd);
    let rects = compute_session_panel_layout(rc.right - rc.left, rc.bottom - rc.top, dpi);
    let h = &state.handles;
    move_rect(h.header, rects.header);
    move_rect(h.new_button, rects.new_button);
    move_rect(h.list, rects.list);
    move_rect(h.prev_button, rects.prev_button);
    move_rect(h.next_button, rects.next_button);
    move_rect(h.title_label, rects.title_label);
    move_rect(h.title_edit, rects.title_edit);
    move_rect(h.model_label, rects.model_label);
    move_rect(h.model_edit, rects.model_edit);
    move_rect(h.effort_label, rects.effort_label);
    // Keep Win32 combobox dropdown list tall enough to expose all 7 options when expanded.
    if !h.effort_combo.is_null() {
        let drop_h = rects.effort_combo.height() + crate::dpi::scale_px(180, dpi);
        // SAFETY: `MoveWindow` for CBS_DROPDOWNLIST uses total height including dropdown area.
        unsafe {
            let _ = MoveWindow(
                h.effort_combo,
                rects.effort_combo.left,
                rects.effort_combo.top,
                rects.effort_combo.width().max(1),
                drop_h,
                1,
            );
        }
    }
    move_rect(h.save_button, rects.save_button);
    move_rect(h.status, rects.status);
    move_rect(h.refresh_button, rects.refresh_button);
}

fn apply_snapshot(state: &mut SessionPanelState, snap: NativeSessionsSnapshot) {
    state.suppress_notifications = true;
    state.row_ids = snap.page.items.iter().map(|s| s.id.clone()).collect();

    // SAFETY: Repopulate Win32 LISTBOX `120` with current page item titles.
    unsafe {
        let _ = SendMessageW(state.handles.list, LB_RESETCONTENT, 0, 0);
        for item in &snap.page.items {
            let wide = utf8_to_wide(&item.title);
            let _ = SendMessageW(state.handles.list, LB_ADDSTRING, 0, wide.as_ptr() as LPARAM);
        }
    }

    let active_idx = snap
        .active_session_id
        .as_ref()
        .and_then(|aid| state.row_ids.iter().position(|id| id == aid))
        .map(|i| i as isize)
        .unwrap_or(-1);
    set_list_selection(state.handles.list, active_idx);
    state.prior_list_selection = active_idx;

    if let Some(ref active) = snap.active_session {
        set_text_utf8(state.handles.title_edit, &active.title);
        set_text_utf8(state.handles.model_edit, &active.ui_model);
        let eff_idx = effort_index(&active.reasoning_effort);
        // SAFETY: Select persisted effort index in `124` (`COMBOBOX`).
        unsafe {
            let _ = SendMessageW(state.handles.effort_combo, CB_SETCURSEL, eff_idx, 0);
        }
        state.baseline =
            SessionForm::from_persisted(&active.title, &active.ui_model, &active.reasoning_effort);
        state.expected_revision = active.revision;
    } else {
        set_text_utf8(state.handles.title_edit, "");
        set_text_utf8(state.handles.model_edit, "");
        // SAFETY: Reset effort combo to `"medium"` (`3`) when no session is active.
        unsafe {
            let _ = SendMessageW(state.handles.effort_combo, CB_SETCURSEL, 3, 0);
        }
        state.baseline = SessionForm::default();
        state.expected_revision = 0;
    }

    set_text_utf8(state.handles.status, &format_snapshot_status(&snap));
    state.last_snapshot = Some(snap);
    state.suppress_notifications = false;
    sync_control_enabled_states(state);
}

fn confirm_discard_if_dirty(state: &SessionPanelState) -> bool {
    if state.db_path.is_none() || state.startup_failed {
        return true;
    }
    let Some(ref snap) = state.last_snapshot else {
        return true;
    };
    if snap.active_session.is_none() {
        return true;
    }
    let live = read_live_form(&state.handles);
    if !live.is_dirty(&state.baseline) {
        return true;
    }
    // SAFETY: Resolve root owner HWND for proper modal centering and Win32 parent lock.
    let root = unsafe { GetAncestor(state.hwnd, GA_ROOT) };
    let choice = modal_message_box(
        root,
        "Session settings have unsaved changes. Discard them?\n\nChoose No to keep editing, or save the settings before navigating.",
        "Omnia \u{2014} unsaved session settings",
        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
    );
    choice == IDYES
}

fn submit_worker_command(state: &mut SessionPanelState, cmd: NativeSessionCommand) {
    if state.db_path.is_none() || state.startup_failed || state.pending {
        return;
    }
    let Some(ref worker) = state.worker else {
        return;
    };
    match worker.submit(cmd) {
        Ok(_op_id) => {
            state.pending = true;
            set_text_utf8(state.handles.status, "Storage operation pending...");
            sync_control_enabled_states(state);
        }
        Err(err) => {
            set_text_utf8(state.handles.status, &format_store_error_status(&err));
            restore_prior_selection(state);
        }
    }
}

fn handle_save_clicked(state: &mut SessionPanelState) {
    if state.pending || state.db_path.is_none() || state.startup_failed {
        return;
    }
    let Some(ref snap) = state.last_snapshot else {
        return;
    };
    let Some(ref active) = snap.active_session else {
        return;
    };
    let live = read_live_form(&state.handles);
    match validate_session_settings_input(&live.title, &live.model, &live.effort) {
        Ok(validated) => {
            let cmd = NativeSessionCommand::UpdateSettings {
                session_id: active.id.clone(),
                expected_revision: state.expected_revision,
                title: validated.title,
                model: validated.model,
                effort: validated.effort,
            };
            submit_worker_command(state, cmd);
        }
        Err(err) => {
            // Preserve dirty edits & keep fields enabled on validation error (`qa-guard`).
            set_text_utf8(state.handles.status, &format_store_error_status(&err));
        }
    }
}

fn handle_worker_wake(state: &mut SessionPanelState) {
    let Some(event) = state
        .worker
        .as_ref()
        .and_then(NativeSessionWorker::take_completed)
    else {
        return;
    };
    let NativeSessionEvent {
        op_id: _,
        is_startup_open,
        result,
    } = event;
    state.pending = false;
    match result {
        Ok(snap) => {
            state.startup_failed = false;
            apply_snapshot(state, snap);
        }
        Err(err) => {
            if is_startup_open {
                state.startup_failed = true;
            }
            // Do NOT wipe edited fields (`122`/`123`/`124`), but restore active list selection (`qa-guard`).
            restore_prior_selection(state);
            set_text_utf8(state.handles.status, &format_store_error_status(&err));
            sync_control_enabled_states(state);
        }
    }
}

fn create_child_control(
    parent: HWND,
    instance: HINSTANCE,
    class_name: &str,
    text: &str,
    style: u32,
    ex_style: u32,
    id: i32,
) -> HWND {
    let cls_w = utf8_to_wide(class_name);
    let txt_w = utf8_to_wide(text);
    // SAFETY: Creating a child control owned by `parent` with a unique integer HMENU control ID.
    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            cls_w.as_ptr(),
            txt_w.as_ptr(),
            style,
            0,
            0,
            10,
            10,
            parent,
            id as isize as *mut c_void,
            instance,
            null(),
        )
    };
    if !hwnd.is_null() {
        let theme = utf8_to_wide("DarkMode_Explorer");
        // SAFETY: Request dark scrollbars/chrome when supported by Windows 11 UxTheme.
        unsafe {
            let _ = SetWindowTheme(hwnd, theme.as_ptr(), null());
        }
    }
    hwnd
}

fn init_panel_controls(hwnd: HWND, instance: HINSTANCE, state: &mut SessionPanelState) {
    let static_cls = "STATIC";
    let button_cls = "BUTTON";
    let list_cls = "LISTBOX";
    let combo_cls = "COMBOBOX";

    // Resolve `WC_EDITW` UTF-16 class name (`"Edit"`).
    let edit_cls = "Edit";

    let mut h = PanelHandles::default();
    let static_style = WS_CHILD | WS_VISIBLE | (SS_LEFT | SS_NOPREFIX);
    let btn_style = WS_CHILD | WS_VISIBLE | WS_TABSTOP | (BS_PUSHBUTTON as u32);
    let list_style = WS_CHILD
        | WS_VISIBLE
        | WS_BORDER
        | WS_VSCROLL
        | WS_TABSTOP
        | (LBS_NOTIFY | LBS_NOINTEGRALHEIGHT) as u32;
    let edit_style =
        WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | (ES_LEFT | ES_AUTOHSCROLL) as u32;
    let combo_style = WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_TABSTOP | (CBS_DROPDOWNLIST as u32);

    h.header = create_child_control(
        hwnd,
        instance,
        static_cls,
        "Sessions",
        static_style,
        0,
        ID_SESSION_HEADER,
    );
    h.new_button = create_child_control(
        hwnd,
        instance,
        button_cls,
        "New projectless chat",
        btn_style,
        0,
        ID_NEW_SESSION,
    );
    attach_button(h.new_button, None);

    h.list = create_child_control(hwnd, instance, list_cls, "", list_style, 0, ID_SESSION_LIST);

    h.prev_button = create_child_control(
        hwnd,
        instance,
        button_cls,
        "Previous page",
        btn_style,
        0,
        ID_PREV_PAGE,
    );
    attach_button(h.prev_button, None);

    h.next_button = create_child_control(
        hwnd,
        instance,
        button_cls,
        "Next page",
        btn_style,
        0,
        ID_NEXT_PAGE,
    );
    attach_button(h.next_button, None);

    h.title_label = create_child_control(
        hwnd,
        instance,
        static_cls,
        "Session title",
        static_style,
        0,
        ID_TITLE_LABEL,
    );
    let _ = WC_EDITW;
    h.title_edit = create_child_control(
        hwnd,
        instance,
        edit_cls,
        "",
        edit_style,
        0,
        ID_SESSION_TITLE,
    );
    attach_edit(h.title_edit, Some("Session title"));

    h.model_label = create_child_control(
        hwnd,
        instance,
        static_cls,
        "Model ID (profile not connected)",
        static_style,
        0,
        ID_MODEL_LABEL,
    );
    h.model_edit = create_child_control(
        hwnd,
        instance,
        edit_cls,
        "",
        edit_style,
        0,
        ID_SESSION_MODEL,
    );
    attach_edit(h.model_edit, Some("Model ID (profile not connected)"));

    h.effort_label = create_child_control(
        hwnd,
        instance,
        static_cls,
        "Effort",
        static_style,
        0,
        ID_EFFORT_LABEL,
    );
    h.effort_combo = create_child_control(
        hwnd,
        instance,
        combo_cls,
        "",
        combo_style,
        0,
        ID_SESSION_EFFORT,
    );
    // SAFETY: Populate effort dropdown with canonical ordered options and select `"medium"`.
    unsafe {
        let _ = SendMessageW(h.title_edit, EM_SETLIMITTEXT, MAX_SETTING_CHARS, 0);
        let _ = SendMessageW(h.model_edit, EM_SETLIMITTEXT, MAX_SETTING_CHARS, 0);
        for effort in EFFORTS {
            let w = utf8_to_wide(effort);
            let _ = SendMessageW(h.effort_combo, CB_ADDSTRING, 0, w.as_ptr() as LPARAM);
        }
        let _ = SendMessageW(h.effort_combo, CB_SETCURSEL, 3, 0);
    }

    h.save_button = create_child_control(
        hwnd,
        instance,
        button_cls,
        "Save session settings",
        btn_style,
        0,
        ID_SAVE_SETTINGS,
    );
    attach_button(h.save_button, None);

    h.status = create_child_control(
        hwnd,
        instance,
        static_cls,
        if state.db_path.is_some() {
            "Opening session storage..."
        } else {
            "Storage disconnected.\n\nLaunch with --session-db <isolated absolute path> to evaluate durable sessions.\n\nNo personal database is opened automatically."
        },
        static_style,
        0,
        ID_SESSION_STATUS,
    );

    h.refresh_button = create_child_control(
        hwnd,
        instance,
        button_cls,
        "Refresh sessions",
        btn_style,
        0,
        ID_REFRESH_SESSIONS,
    );
    attach_button(h.refresh_button, None);

    state.handles = h;
    apply_fonts_to_panel_controls(state);
    layout_panel_controls(state);

    if let Some(ref db_path) = state.db_path {
        let target_hwnd = hwnd as isize;
        state.pending = true;
        let worker = NativeSessionWorker::spawn(db_path.clone(), move || {
            // SAFETY: Posting custom `WM_SESSION_WORKER_WAKE` is thread-safe for a live HWND.
            unsafe {
                let _ = PostMessageW(target_hwnd as HWND, WM_SESSION_WORKER_WAKE, 0, 0);
            }
        });
        state.worker = Some(worker);
    }
    sync_control_enabled_states(state);
}

fn apply_fonts_to_panel_controls(state: &SessionPanelState) {
    let h = &state.handles;
    let regular = [
        h.new_button,
        h.list,
        h.prev_button,
        h.next_button,
        h.title_label,
        h.title_edit,
        h.model_label,
        h.model_edit,
        h.effort_label,
        h.effort_combo,
        h.save_button,
        h.status,
        h.refresh_button,
    ];
    for ctrl in regular {
        if !ctrl.is_null() && !state.font.is_null() {
            // SAFETY: Send `WM_SETFONT` with owned `HFONT`.
            unsafe {
                let _ = SendMessageW(ctrl, WM_SETFONT, state.font as usize, 1);
            }
        }
    }
    if !h.header.is_null() && !state.bold_font.is_null() {
        // SAFETY: Send bold `HFONT` to panel header static control.
        unsafe {
            let _ = SendMessageW(h.header, WM_SETFONT, state.bold_font as usize, 1);
        }
    }
}

unsafe extern "system" fn panel_wnd_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if umsg == WM_CREATE {
        // SAFETY: Retrieve `SessionPanelState` pointer passed via `lpCreateParams` in `CreateWindowExW`.
        let cs = unsafe { &*(lparam as *const CREATESTRUCTW) };
        let state_ptr = cs.lpCreateParams.cast::<SessionPanelState>();
        if state_ptr.is_null() {
            return -1;
        }
        // SAFETY: Associate `SessionPanelState` with `hwnd` and initialize child controls.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
            let state = &mut *state_ptr;
            state.hwnd = hwnd;
            state.card_brush = CreateSolidBrush(COLOR_CARD_BG);
            state.input_brush = CreateSolidBrush(COLOR_INPUT_BG);
            init_panel_controls(hwnd, cs.hInstance, state);
        }
        return 0;
    }

    // SAFETY: Recover panel state pointer stored in `GWLP_USERDATA` on this UI thread.
    let state_ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SessionPanelState };
    if state_ptr.is_null() {
        // SAFETY: Default window processing before/after state lifetime.
        return unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) };
    }
    // SAFETY: `state_ptr` lives from `WM_CREATE` until `WM_NCDESTROY` on the UI thread.
    let state = unsafe { &mut *state_ptr };

    match umsg {
        WM_SIZE => {
            layout_panel_controls(state);
            0
        }
        WM_SESSION_WORKER_WAKE => {
            handle_worker_wake(state);
            0
        }
        WM_COMMAND => {
            if state.suppress_notifications {
                return 0;
            }
            let ctrl_id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            match ctrl_id {
                ID_NEW_SESSION => {
                    if confirm_discard_if_dirty(state) {
                        submit_worker_command(
                            state,
                            NativeSessionCommand::CreateProjectless {
                                title: "New chat".to_owned(),
                            },
                        );
                    }
                    0
                }
                ID_REFRESH_SESSIONS => {
                    if confirm_discard_if_dirty(state) {
                        submit_worker_command(state, NativeSessionCommand::FirstPage);
                    }
                    0
                }
                ID_PREV_PAGE => {
                    if confirm_discard_if_dirty(state) {
                        submit_worker_command(state, NativeSessionCommand::PrevPage);
                    }
                    0
                }
                ID_NEXT_PAGE => {
                    if confirm_discard_if_dirty(state) {
                        submit_worker_command(state, NativeSessionCommand::NextPage);
                    }
                    0
                }
                ID_SAVE_SETTINGS => {
                    handle_save_clicked(state);
                    0
                }
                ID_SESSION_LIST if code == LBN_SELCHANGE => {
                    // SAFETY: Query currently highlighted listbox row index.
                    let sel =
                        unsafe { SendMessageW(state.handles.list, LB_GETCURSEL, 0, 0) as isize };
                    if sel >= 0 && (sel as usize) < state.row_ids.len() {
                        let target_id = state.row_ids[sel as usize].clone();
                        let already_active = state
                            .last_snapshot
                            .as_ref()
                            .and_then(|s| s.active_session_id.as_deref())
                            == Some(target_id.as_str());
                        if !already_active {
                            if confirm_discard_if_dirty(state) {
                                submit_worker_command(
                                    state,
                                    NativeSessionCommand::Select {
                                        session_id: target_id,
                                    },
                                );
                            } else {
                                restore_prior_selection(state);
                            }
                        }
                    }
                    0
                }
                ID_SESSION_TITLE | ID_SESSION_MODEL if code == EN_CHANGE => 0,
                ID_SESSION_EFFORT if code == CBN_SELCHANGE => 0,
                _ => {
                    // SAFETY: Forward unhandled commands cleanly.
                    unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) }
                }
            }
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as HDC;
            let ctrl = lparam as HWND;
            let text_col: COLORREF = if ctrl == state.handles.header {
                COLOR_TEXT_PRIMARY
            } else {
                COLOR_TEXT_MUTED
            };
            // SAFETY: Configure dark card text & background colors matching main shell.
            unsafe {
                SetTextColor(hdc, text_col);
                SetBkColor(hdc, COLOR_CARD_BG);
            }
            state.card_brush as LRESULT
        }
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            let hdc = wparam as HDC;
            // SAFETY: Configure dark input background and crisp text color.
            unsafe {
                SetTextColor(hdc, COLOR_TEXT_PRIMARY);
                SetBkColor(hdc, COLOR_INPUT_BG);
            }
            state.input_brush as LRESULT
        }
        WM_CTLCOLORBTN => {
            let hdc = wparam as HDC;
            // SAFETY: Style button background cleanly with dark card brush.
            unsafe {
                SetTextColor(hdc, COLOR_TEXT_PRIMARY);
                SetBkColor(hdc, COLOR_CARD_BG);
            }
            state.card_brush as LRESULT
        }
        WM_NCDESTROY => {
            // SAFETY: Stop worker thread synchronously (releasing StoreOwnership lock BEFORE exit!) and free state.
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let mut boxed = Box::from_raw(state_ptr);
                if let Some(ref mut worker) = boxed.worker {
                    worker.stop_and_wait();
                }
                boxed.cleanup_brushes();
                drop(boxed);
                DefWindowProcW(hwnd, umsg, wparam, lparam)
            }
        }
        _ => {
            // SAFETY: Default window procedure for all other messages.
            unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) }
        }
    }
}

/// Register the `OmniaNativeSessionPanel` window class (idempotent per process).
pub fn register_session_panel_class(instance: HINSTANCE) -> Result<(), StoreError> {
    let cls_w = utf8_to_wide(PANEL_CLASS_NAME);
    let wc = WNDCLASSEXW {
        cbSize: core::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(panel_wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: null_mut(),
        hCursor: null_mut(),
        hbrBackground: null_mut(),
        lpszMenuName: null(),
        lpszClassName: cls_w.as_ptr(),
        hIconSm: null_mut(),
    };
    // SAFETY: `wc` is fully initialized on stack with static WndProc callback.
    let atom = unsafe { RegisterClassExW(&raw const wc) };
    if atom == 0 {
        let err = std::io::Error::last_os_error();
        // Class already exists (`ERROR_CLASS_ALREADY_EXISTS = 1410`) is fine on repeat calls.
        if err.raw_os_error() != Some(1410) {
            return Err(StoreError::new(
                "win32_register_panel_failed",
                format!("Failed to register session panel window class: {err}"),
                false,
            ));
        }
    }
    Ok(())
}

/// Create the `OmniaNativeSessionPanel` child (`ID_PANEL_HOST = 140`) inside `parent`.
pub fn create_session_panel(
    parent: HWND,
    db_path: Option<PathBuf>,
    font: HFONT,
    bold_font: HFONT,
) -> Result<HWND, StoreError> {
    // SAFETY: Retrieve current module handle for child window registration & creation.
    let instance = unsafe { GetModuleHandleW(null()) };
    register_session_panel_class(instance)?;

    let state = Box::new(SessionPanelState {
        hwnd: null_mut(),
        handles: PanelHandles::default(),
        font,
        bold_font,
        card_brush: null_mut(),
        input_brush: null_mut(),
        db_path,
        worker: None,
        pending: false,
        startup_failed: false,
        last_snapshot: None,
        row_ids: Vec::new(),
        prior_list_selection: -1,
        baseline: SessionForm::default(),
        expected_revision: 0,
        suppress_notifications: false,
    });
    let state_ptr = Box::into_raw(state);
    let cls_w = utf8_to_wide(PANEL_CLASS_NAME);
    let title_w = utf8_to_wide("Session Panel");

    // SAFETY: `CreateWindowExW` triggers `WM_CREATE` synchronously, transferring ownership of `state_ptr` to `hwnd`.
    let panel = unsafe {
        CreateWindowExW(
            0,
            cls_w.as_ptr(),
            title_w.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            320,
            600,
            parent,
            ID_PANEL_HOST as isize as *mut c_void,
            instance,
            state_ptr.cast(),
        )
    };
    if panel.is_null() {
        // SAFETY: Creation failed before `WM_CREATE` stored `state_ptr`; reclaim Box cleanly.
        unsafe {
            drop(Box::from_raw(state_ptr));
        }
        return Err(StoreError::new(
            "win32_create_panel_failed",
            "Failed to create session panel window.",
            false,
        ));
    }
    // SAFETY: Make newly created panel visible immediately.
    unsafe {
        let _ = ShowWindow(panel, SW_SHOW);
        let _ = InvalidateRect(panel, null(), 0);
    }
    Ok(panel)
}

/// Update fonts and re-run responsive layout inside `OmniaNativeSessionPanel` after DPI change.
pub fn session_panel_apply_fonts_and_relayout(panel: HWND, font: HFONT, bold_font: HFONT) {
    if panel.is_null() {
        return;
    }
    // SAFETY: Read `GWLP_USERDATA` on the UI thread owning `panel`.
    let state_ptr = unsafe { GetWindowLongPtrW(panel, GWLP_USERDATA) as *mut SessionPanelState };
    if state_ptr.is_null() {
        return;
    }
    // SAFETY: Valid `SessionPanelState` while `panel` is alive.
    let state = unsafe { &mut *state_ptr };
    state.font = font;
    state.bold_font = bold_font;
    apply_fonts_to_panel_controls(state);
    layout_panel_controls(state);
}

/// Check if the panel has no pending DB work and either no dirty form or user confirmed discard.
pub fn session_panel_can_close(panel: HWND) -> bool {
    if panel.is_null() {
        return true;
    }
    // SAFETY: Read `GWLP_USERDATA` on the UI thread owning `panel`.
    let state_ptr = unsafe { GetWindowLongPtrW(panel, GWLP_USERDATA) as *mut SessionPanelState };
    if state_ptr.is_null() {
        return true;
    }
    // SAFETY: Valid `SessionPanelState` while `panel` is alive.
    let state = unsafe { &*state_ptr };
    if state.pending {
        // SAFETY: Resolve root owner HWND for modal dialog positioning.
        let root = unsafe { GetAncestor(panel, GA_ROOT) };
        let _ = modal_message_box(
            root,
            "A storage operation is still pending. Wait for its result before closing.",
            "Omnia \u{2014} storage pending",
            MB_OK | MB_ICONWARNING,
        );
        return false;
    }
    confirm_discard_if_dirty(state)
}
