use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use omnia_harness::{search_symbol_palette, ComposerModel};
use omnia_storage::StoreError;
use windows_sys::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    FrameRect, InvalidateRect, SetBkColor, SetBkMode, SetTextColor, CLEARTYPE_QUALITY,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_RIGHT, DT_SINGLELINE, DT_VCENTER,
    FF_SWISS, FW_NORMAL, FW_SEMIBOLD, HBRUSH, HDC, HFONT, OUT_DEFAULT_PRECIS, PAINTSTRUCT,
    TRANSPARENT,
};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    InitCommonControlsEx, EM_REPLACESEL, EM_SETLIMITTEXT, ICC_STANDARD_CLASSES, ICC_WIN95_CLASSES,
    INITCOMMONCONTROLSEX,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW,
    GetWindowLongPtrW, IsDialogMessageW, LoadCursorW, MoveWindow, PostQuitMessage,
    RegisterClassExW, SendMessageW, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    TranslateMessage, BS_PUSHBUTTON, CREATESTRUCTW, EN_CHANGE, ES_AUTOHSCROLL, ES_AUTOVSCROLL,
    ES_LEFT, ES_MULTILINE, ES_WANTRETURN, GWLP_USERDATA, IDC_ARROW, IDYES, MB_DEFBUTTON2,
    MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, MINMAXINFO, MSG, SWP_NOACTIVATE, SWP_NOZORDER,
    SW_SHOW, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_CTLCOLORBTN, WM_CTLCOLOREDIT, WM_CTLCOLORSTATIC,
    WM_DPICHANGED, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_NCDESTROY, WM_PAINT, WM_SETFONT, WM_SIZE,
    WNDCLASSEXW, WS_BORDER, WS_CHILD, WS_CLIPCHILDREN, WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE,
    WS_VSCROLL,
};

use crate::cli::parse_session_db_args;
use crate::d2d::{configure_dwm_shell_window, D2dShellPainter};
use crate::dpi::{
    clamped_initial_window_bounds, clamped_min_track_size, compute_shell_layout,
    ensure_per_monitor_v2_dpi_awareness, primary_work_area, scale_px, system_dpi, window_dpi,
    window_work_area, RectPx,
};
use crate::session_panel::{
    create_session_panel, session_panel_apply_fonts_and_relayout, session_panel_can_close,
};
use crate::types::{
    utf8_to_wide, Mode, COLOR_ACCENT, COLOR_BORDER, COLOR_CARD_BG, COLOR_INPUT_BG,
    COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY, COLOR_TEXT_SOFT, COLOR_TOP_BAR_BG, COLOR_WINDOW_BG,
    ID_COMPOSER_BADGE, ID_COMPOSER_CMD, ID_DRAFT, ID_DRAFT_LABEL, ID_FOOTER, ID_HEADING,
    ID_MODE_BROWSER, ID_MODE_CHAT, ID_MODE_IDE, ID_SYM_CHEM, ID_SYM_MATH, ID_SYM_PHYS, SS_LEFT,
    SS_NOPREFIX, STUDIO_BADGE_TEXT,
};
use crate::uia_provider::{attach_button, attach_edit, modal_message_box, read_hwnd_text_utf8};

const SHELL_CLASS_NAME: &str = "OmniaNativeShellClass";

#[derive(Default)]
struct ShellHandles {
    mode_chat: HWND,
    mode_browser: HWND,
    mode_ide: HWND,
    heading: HWND,
    draft_label: HWND,
    draft: HWND,
    composer_cmd: HWND,
    sym_math: HWND,
    sym_phys: HWND,
    sym_chem: HWND,
    composer_badge: HWND,
    footer: HWND,
    panel: HWND,
}

struct ShellState {
    hwnd: HWND,
    handles: ShellHandles,
    db_path: Option<PathBuf>,
    active_mode: Mode,
    composer: ComposerModel,
    math_idx: usize,
    phys_idx: usize,
    chem_idx: usize,
    font: HFONT,
    bold_font: HFONT,
    bg_brush: HBRUSH,
    card_brush: HBRUSH,
    input_brush: HBRUSH,
    border_brush: HBRUSH,
    accent_brush: HBRUSH,
    top_brush: HBRUSH,
    painter: D2dShellPainter,
}

impl ShellState {
    fn cleanup_gdi(&mut self) {
        for font in [self.font, self.bold_font] {
            if !font.is_null() {
                // SAFETY: Destroy HFONT handles created by `create_scaled_font`.
                unsafe {
                    let _ = DeleteObject(font);
                }
            }
        }
        self.font = null_mut();
        self.bold_font = null_mut();

        for brush in [
            self.bg_brush,
            self.card_brush,
            self.input_brush,
            self.border_brush,
            self.accent_brush,
            self.top_brush,
        ] {
            if !brush.is_null() {
                // SAFETY: Destroy HBRUSH handles created via `CreateSolidBrush`.
                unsafe {
                    let _ = DeleteObject(brush);
                }
            }
        }
        self.bg_brush = null_mut();
        self.card_brush = null_mut();
        self.input_brush = null_mut();
        self.border_brush = null_mut();
        self.accent_brush = null_mut();
        self.top_brush = null_mut();
    }
}

struct ComAptGuard {
    initialized: bool,
}

impl Drop for ComAptGuard {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: Balance successful `CoInitializeEx` on this UI thread.
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn create_scaled_font(dpi: u32, weight: u32, logical_px: i32) -> HFONT {
    let face = utf8_to_wide("Segoe UI");
    let height = -scale_px(logical_px, dpi);
    // SAFETY: Creating a ClearType Segoe UI GDI font owned by `ShellState`.
    unsafe {
        CreateFontW(
            height,
            0,
            0,
            0,
            weight as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            (DEFAULT_PITCH | FF_SWISS) as u32,
            face.as_ptr(),
        )
    }
}

fn set_text_utf8(hwnd: HWND, text: &str) {
    if hwnd.is_null() {
        return;
    }
    let w = utf8_to_wide(text);
    // SAFETY: Updating Win32 control caption/text cleanly.
    unsafe {
        let _ = SetWindowTextW(hwnd, w.as_ptr());
    }
}

fn move_rect(hwnd: HWND, rect: RectPx) {
    if hwnd.is_null() {
        return;
    }
    // SAFETY: Positioning child control inside main shell client coordinates.
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

fn create_child(
    parent: HWND,
    instance: HINSTANCE,
    class_name: &str,
    text: &str,
    style: u32,
    id: i32,
) -> HWND {
    let cls_w = utf8_to_wide(class_name);
    let txt_w = utf8_to_wide(text);
    // SAFETY: Creating child HWND inside `parent` with unique control ID.
    unsafe {
        CreateWindowExW(
            0,
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
    }
}

fn update_footer(state: &ShellState) {
    let chars = read_hwnd_text_utf8(state.handles.draft).chars().count();
    let msg = format!(
        "Mode: {}  \u{00B7}  Draft: {} chars",
        state.active_mode.button_label(),
        chars
    );
    set_text_utf8(state.handles.footer, &msg);
}

fn apply_shell_fonts(state: &ShellState) {
    let h = &state.handles;
    for ctrl in [
        h.mode_chat,
        h.mode_browser,
        h.mode_ide,
        h.draft_label,
        h.draft,
        h.composer_cmd,
        h.sym_math,
        h.sym_phys,
        h.sym_chem,
        h.composer_badge,
        h.footer,
    ] {
        if !ctrl.is_null() && !state.font.is_null() {
            // SAFETY: Assigning owned `HFONT` to shell child controls.
            unsafe {
                let _ = SendMessageW(ctrl, WM_SETFONT, state.font as usize, 1);
            }
        }
    }
    if !h.heading.is_null() && !state.bold_font.is_null() {
        // SAFETY: Assigning bold `HFONT` to mode heading control.
        unsafe {
            let _ = SendMessageW(h.heading, WM_SETFONT, state.bold_font as usize, 1);
        }
    }
}

fn apply_shell_layout(state: &ShellState) {
    if state.hwnd.is_null() {
        return;
    }
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: Retrieve main window client area size.
    if unsafe { GetClientRect(state.hwnd, &raw mut rc) } == 0 {
        return;
    }
    let dpi = window_dpi(state.hwnd);
    let rects = compute_shell_layout(
        rc.right - rc.left,
        rc.bottom - rc.top,
        dpi,
        state.active_mode,
    );
    let h = &state.handles;
    move_rect(h.mode_chat, rects.mode_chat);
    move_rect(h.mode_browser, rects.mode_browser);
    move_rect(h.mode_ide, rects.mode_ide);
    move_rect(h.heading, rects.heading);
    move_rect(h.draft_label, rects.draft_label);
    move_rect(h.draft, rects.draft);
    move_rect(h.composer_cmd, rects.composer_cmd);
    move_rect(h.sym_math, rects.sym_math);
    move_rect(h.sym_phys, rects.sym_phys);
    move_rect(h.sym_chem, rects.sym_chem);
    move_rect(h.composer_badge, rects.composer_badge);
    move_rect(h.panel, rects.panel_host);
    move_rect(h.footer, rects.footer);
}

fn insert_category_symbol(state: &mut ShellState, category: &str) {
    let matching: Vec<_> = ComposerModel::templates()
        .into_iter()
        .filter(|t| t.category.eq_ignore_ascii_case(category))
        .collect();
    if matching.is_empty() {
        return;
    }
    let idx_slot = match category {
        "Math" => &mut state.math_idx,
        "Physics" => &mut state.phys_idx,
        _ => &mut state.chem_idx,
    };
    let chosen = &matching[*idx_slot % matching.len()];
    *idx_slot = (*idx_slot + 1) % matching.len();

    let snippet = if chosen.display_mode {
        format!("$${}$$ ", chosen.latex_snippet)
    } else {
        format!("${}$ ", chosen.latex_snippet)
    };
    let wide_snip = utf8_to_wide(&snippet);
    // SAFETY: Insert snippet cleanly at current caret inside multiline `EDIT` `112`.
    unsafe {
        let _ = SendMessageW(
            state.handles.draft,
            EM_REPLACESEL,
            1,
            wide_snip.as_ptr() as LPARAM,
        );
    }
    let updated_draft = read_hwnd_text_utf8(state.handles.draft);
    let len_cp = updated_draft.chars().count();
    state.composer.set_draft(updated_draft, len_cp);
    set_text_utf8(state.handles.composer_badge, &chosen.unicode_preview);
    update_footer(state);
}

fn paint_shell_gdi_fallback(hdc: HDC, layout: &crate::dpi::ShellLayoutRects, state: &ShellState) {
    let client_rc = layout.client.to_win32();
    let top_rc = layout.top_bar.to_win32();
    let left_rc = layout.left_card.to_win32();
    let right_rc = layout.right_card.to_win32();
    let pill_rc = layout.active_pill.to_win32();
    let mut badge_rc = layout.badge.to_win32();
    let badge_w = utf8_to_wide(STUDIO_BADGE_TEXT);

    // SAFETY: All GDI handles (`bg_brush`, `top_brush`, etc.) belong to `state` on the UI thread.
    unsafe {
        let _ = FillRect(hdc, &raw const client_rc, state.bg_brush);
        let _ = FillRect(hdc, &raw const top_rc, state.top_brush);
        let _ = FillRect(hdc, &raw const left_rc, state.card_brush);
        let _ = FrameRect(hdc, &raw const left_rc, state.border_brush);
        let _ = FillRect(hdc, &raw const right_rc, state.card_brush);
        let _ = FrameRect(hdc, &raw const right_rc, state.border_brush);
        let _ = FrameRect(hdc, &raw const pill_rc, state.accent_brush);
        if layout.badge.width() > 40 {
            let _ = SetBkMode(hdc, TRANSPARENT as i32);
            let _ = SetTextColor(hdc, 0x00FC_D37D); // RGB(125, 211, 252)
            let _ = DrawTextW(
                hdc,
                badge_w.as_ptr(),
                -1,
                &raw mut badge_rc,
                DT_RIGHT | DT_VCENTER | DT_SINGLELINE,
            );
        }
    }
}

fn init_shell_controls(hwnd: HWND, instance: HINSTANCE, state: &mut ShellState) {
    let btn_style = WS_CHILD | WS_VISIBLE | WS_TABSTOP | (BS_PUSHBUTTON as u32);
    let static_style = WS_CHILD | WS_VISIBLE | (SS_LEFT | SS_NOPREFIX);
    let draft_style = WS_CHILD
        | WS_VISIBLE
        | WS_BORDER
        | WS_VSCROLL
        | WS_TABSTOP
        | (ES_LEFT | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32;
    let cmd_style =
        WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | (ES_LEFT | ES_AUTOHSCROLL) as u32;

    let mode_chat = create_child(hwnd, instance, "BUTTON", "Chat", btn_style, ID_MODE_CHAT);
    attach_button(mode_chat, None);

    let mode_browser = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Browser",
        btn_style,
        ID_MODE_BROWSER,
    );
    attach_button(mode_browser, None);

    let mode_ide = create_child(hwnd, instance, "BUTTON", "IDE", btn_style, ID_MODE_IDE);
    attach_button(mode_ide, None);

    let heading = create_child(
        hwnd,
        instance,
        "STATIC",
        &state.active_mode.heading_text(),
        static_style,
        ID_HEADING,
    );
    let draft_label = create_child(
        hwnd,
        instance,
        "STATIC",
        "Prompt draft (Unicode, LaTeX & multimodal composer ready)",
        static_style,
        ID_DRAFT_LABEL,
    );

    // IMPORTANT: Do NOT call `attach_edit` on `112`! Must remain default Win32 `Document` + `TextPattern`.
    let draft = create_child(hwnd, instance, "Edit", "", draft_style, ID_DRAFT);
    if !draft.is_null() {
        // SAFETY: Allow large Unicode prompt drafts without truncation.
        unsafe {
            let _ = SendMessageW(draft, EM_SETLIMITTEXT, 0, 0);
        }
    }

    // `114` exposes `ControlType.Edit` + `IValueProvider` cleanly for UIA checks (`qa-smoke`).
    let composer_cmd = create_child(hwnd, instance, "Edit", "", cmd_style, ID_COMPOSER_CMD);
    attach_edit(composer_cmd, Some("Composer command"));

    let sym_math = create_child(
        hwnd,
        instance,
        "BUTTON",
        "\u{2211} Math",
        btn_style,
        ID_SYM_MATH,
    );
    attach_button(sym_math, Some("Math symbols"));

    let sym_phys = create_child(
        hwnd,
        instance,
        "BUTTON",
        "\u{210F} Phys",
        btn_style,
        ID_SYM_PHYS,
    );
    attach_button(sym_phys, Some("Physics symbols"));

    let sym_chem = create_child(
        hwnd,
        instance,
        "BUTTON",
        "\u{21CC} Chem",
        btn_style,
        ID_SYM_CHEM,
    );
    attach_button(sym_chem, Some("Chemistry symbols"));

    let composer_badge = create_child(
        hwnd,
        instance,
        "STATIC",
        "Rich LaTeX/Unicode",
        static_style,
        ID_COMPOSER_BADGE,
    );

    let footer = create_child(hwnd, instance, "STATIC", "", static_style, ID_FOOTER);

    let panel = create_session_panel(hwnd, state.db_path.clone(), state.font, state.bold_font)
        .unwrap_or(null_mut());

    state.handles = ShellHandles {
        mode_chat,
        mode_browser,
        mode_ide,
        heading,
        draft_label,
        draft,
        composer_cmd,
        sym_math,
        sym_phys,
        sym_chem,
        composer_badge,
        footer,
        panel,
    };
    apply_shell_fonts(state);
    update_footer(state);
    apply_shell_layout(state);

    if !state.handles.draft.is_null() {
        // SAFETY: Place initial keyboard focus in prompt draft editor.
        unsafe {
            let _ = SetFocus(state.handles.draft);
        }
    }
}

unsafe extern "system" fn shell_wnd_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if umsg == WM_CREATE {
        // SAFETY: Extract `ShellState` passed into `CreateWindowExW`.
        let cs = unsafe { &*(lparam as *const CREATESTRUCTW) };
        let state_ptr = cs.lpCreateParams.cast::<ShellState>();
        if state_ptr.is_null() {
            return -1;
        }
        // SAFETY: Store `ShellState` pointer in `GWLP_USERDATA`, configure DWM, create GDI resources & child controls.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
            let state = &mut *state_ptr;
            state.hwnd = hwnd;
            configure_dwm_shell_window(hwnd);
            let dpi = window_dpi(hwnd);
            state.font = create_scaled_font(dpi, FW_NORMAL, 15);
            state.bold_font = create_scaled_font(dpi, FW_SEMIBOLD, 18);
            state.bg_brush = CreateSolidBrush(COLOR_WINDOW_BG);
            state.top_brush = CreateSolidBrush(COLOR_TOP_BAR_BG);
            state.card_brush = CreateSolidBrush(COLOR_CARD_BG);
            state.input_brush = CreateSolidBrush(COLOR_INPUT_BG);
            state.border_brush = CreateSolidBrush(COLOR_BORDER);
            state.accent_brush = CreateSolidBrush(COLOR_ACCENT);
            init_shell_controls(hwnd, cs.hInstance, state);
        }
        return 0;
    }

    // SAFETY: Read `ShellState` pointer stored in `GWLP_USERDATA` on the UI thread.
    let state_ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ShellState };
    if state_ptr.is_null() {
        // SAFETY: Default window processing before `WM_CREATE` / after `WM_NCDESTROY`.
        return unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) };
    }
    // SAFETY: `state_ptr` remains exclusively owned by this UI thread until `WM_NCDESTROY`.
    let state = unsafe { &mut *state_ptr };

    match umsg {
        WM_GETMINMAXINFO => {
            if lparam != 0 {
                let dpi = window_dpi(hwnd);
                let wa = window_work_area(hwnd);
                let (min_w, min_h) = clamped_min_track_size(dpi, wa);
                // SAFETY: `lparam` points to writable Win32 `MINMAXINFO`.
                unsafe {
                    let mmi = &mut *(lparam as *mut MINMAXINFO);
                    mmi.ptMinTrackSize.x = min_w;
                    mmi.ptMinTrackSize.y = min_h;
                }
            }
            0
        }
        WM_DPICHANGED => {
            let new_dpi = (wparam & 0xFFFF) as u32;
            let new_font = create_scaled_font(new_dpi, FW_NORMAL, 15);
            let new_bold = create_scaled_font(new_dpi, FW_SEMIBOLD, 18);
            let old_font = state.font;
            let old_bold = state.bold_font;
            state.font = new_font;
            state.bold_font = new_bold;
            state.painter.invalidate_device_resources();

            apply_shell_fonts(state);
            session_panel_apply_fonts_and_relayout(
                state.handles.panel,
                state.font,
                state.bold_font,
            );

            if !old_font.is_null() {
                // SAFETY: Replace old GDI font only after children received the new font.
                unsafe {
                    let _ = DeleteObject(old_font);
                }
            }
            if !old_bold.is_null() {
                // SAFETY: Replace old GDI bold font only after children received the new font.
                unsafe {
                    let _ = DeleteObject(old_bold);
                }
            }

            if lparam != 0 {
                // SAFETY: Clamp suggested Win32 rect against monitor workarea (`QUALITY-01`).
                let suggested = unsafe { *(lparam as *const RECT) };
                let wa = window_work_area(hwnd);
                let w = (suggested.right - suggested.left).min(wa.width()).max(1);
                let h = (suggested.bottom - suggested.top).min(wa.height()).max(1);
                let x = suggested.left.max(wa.left).min(wa.right - w);
                let y = suggested.top.max(wa.top).min(wa.bottom - h);
                // SAFETY: Resize/reposition window using suggested DPI rect clamped to workarea.
                unsafe {
                    let _ =
                        SetWindowPos(hwnd, null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
            apply_shell_layout(state);
            // SAFETY: Request full repaint at updated DPI.
            unsafe {
                let _ = InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_SIZE => {
            apply_shell_layout(state);
            // SAFETY: Repaint D2D backdrop & cards to match resized client rect.
            unsafe {
                let _ = InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = unsafe { core::mem::zeroed() };
            // SAFETY: Begin/EndPaint bracket every WM_PAINT cleanly on `hwnd`.
            let hdc = unsafe { BeginPaint(hwnd, &raw mut ps) };
            let mut client_rc = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // SAFETY: Read full client rectangle for Direct2D `BindDC` and layout geometry.
            unsafe {
                let _ = GetClientRect(hwnd, &raw mut client_rc);
            }
            let dpi = window_dpi(hwnd);
            let layout = compute_shell_layout(
                client_rc.right - client_rc.left,
                client_rc.bottom - client_rc.top,
                dpi,
                state.active_mode,
            );
            if !state.painter.paint(hdc, client_rc, &layout, dpi) {
                paint_shell_gdi_fallback(hdc, &layout, state);
            }
            // SAFETY: Finish WM_PAINT bracket.
            unsafe {
                let _ = EndPaint(hwnd, &raw const ps);
            }
            0
        }
        WM_COMMAND => {
            let ctrl_id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            if let Some(mode) = Mode::from_control_id(ctrl_id) {
                if state.active_mode != mode {
                    state.active_mode = mode;
                    set_text_utf8(state.handles.heading, &mode.heading_text());
                    update_footer(state);
                    // SAFETY: Repaint active mode indicator pill cleanly.
                    unsafe {
                        let _ = InvalidateRect(hwnd, null(), 0);
                    }
                }
                return 0;
            }
            match ctrl_id {
                ID_SYM_MATH => {
                    insert_category_symbol(state, "Math");
                    0
                }
                ID_SYM_PHYS => {
                    insert_category_symbol(state, "Physics");
                    0
                }
                ID_SYM_CHEM => {
                    insert_category_symbol(state, "Chemistry");
                    0
                }
                ID_DRAFT if code == EN_CHANGE => {
                    update_footer(state);
                    0
                }
                ID_COMPOSER_CMD if code == EN_CHANGE => {
                    let query = read_hwnd_text_utf8(state.handles.composer_cmd);
                    if query.trim().is_empty() {
                        set_text_utf8(state.handles.composer_badge, "Rich LaTeX/Unicode");
                    } else {
                        let matches = search_symbol_palette(query.trim());
                        let label = if let Some(first) = matches.first() {
                            format!("{} ({})", first.unicode_preview, matches.len())
                        } else {
                            "0 symbol matches".to_owned()
                        };
                        set_text_utf8(state.handles.composer_badge, &label);
                    }
                    0
                }
                _ => {
                    // SAFETY: Default handling for unhandled commands.
                    unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) }
                }
            }
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as HDC;
            let ctrl = lparam as HWND;
            let text_col: COLORREF = if ctrl == state.handles.heading {
                COLOR_TEXT_PRIMARY
            } else if ctrl == state.handles.composer_badge {
                COLOR_TEXT_SOFT
            } else {
                COLOR_TEXT_MUTED
            };
            let (bg_col, brush) = if ctrl == state.handles.footer {
                (COLOR_WINDOW_BG, state.bg_brush)
            } else {
                (COLOR_CARD_BG, state.card_brush)
            };
            // SAFETY: Style static labels cleanly against window/card backdrop.
            unsafe {
                SetTextColor(hdc, text_col);
                SetBkColor(hdc, bg_col);
            }
            brush as LRESULT
        }
        WM_CTLCOLOREDIT => {
            let hdc = wparam as HDC;
            // SAFETY: Style `112` draft & `114` composer_cmd edits with crisp dark palette.
            unsafe {
                SetTextColor(hdc, COLOR_TEXT_PRIMARY);
                SetBkColor(hdc, COLOR_INPUT_BG);
            }
            state.input_brush as LRESULT
        }
        WM_CTLCOLORBTN => {
            let hdc = wparam as HDC;
            // SAFETY: Style mode/symbol buttons against top bar/card background.
            unsafe {
                SetTextColor(hdc, COLOR_TEXT_PRIMARY);
                SetBkColor(hdc, COLOR_CARD_BG);
            }
            state.card_brush as LRESULT
        }
        WM_CLOSE => {
            let live_draft = read_hwnd_text_utf8(state.handles.draft);
            if !live_draft.is_empty() {
                let choice = modal_message_box(
                    hwnd,
                    "This draft is not saved. Close and discard it?",
                    "Omnia \u{2014} unsaved draft",
                    MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
                );
                if choice != IDYES {
                    return 0;
                }
            }
            if !session_panel_can_close(state.handles.panel) {
                return 0;
            }
            // SAFETY: All dirty checks passed; destroy main shell window cleanly.
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            0
        }
        WM_NCDESTROY => {
            // SAFETY: Release state, GDI objects, and exit message loop cleanly (`exitCode = 0`).
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let mut boxed = Box::from_raw(state_ptr);
                boxed.cleanup_gdi();
                drop(boxed);
                PostQuitMessage(0);
                DefWindowProcW(hwnd, umsg, wparam, lparam)
            }
        }
        _ => {
            // SAFETY: Default window processing.
            unsafe { DefWindowProcW(hwnd, umsg, wparam, lparam) }
        }
    }
}

/// Display a native modal startup error dialog when CLI args or initialization fail cleanly.
pub fn show_startup_error(message: &str) {
    let _ = modal_message_box(
        null_mut(),
        message,
        "Omnia \u{2014} startup error",
        MB_OK | MB_ICONERROR,
    );
}

/// Launch the native Win32/D2D/UIA shell and run its Windows message loop until closed.
pub fn run_native_shell() -> Result<(), StoreError> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let db_path = parse_session_db_args(&args)
        .map_err(|err| StoreError::new(err.code, err.message, false))?;

    ensure_per_monitor_v2_dpi_awareness();

    // SAFETY: Initialize COM apartment for UIAutomation and Direct2D/DirectWrite interop.
    let com_hr = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
    let _com_guard = ComAptGuard {
        initialized: com_hr >= 0,
    };

    let icc = INITCOMMONCONTROLSEX {
        dwSize: core::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_STANDARD_CLASSES | ICC_WIN95_CLASSES,
    };
    // SAFETY: Register ComCtl32 v6 standard & Win95 controls per embedded manifest.
    unsafe {
        let _ = InitCommonControlsEx(&raw const icc);
    }

    // SAFETY: Obtain module handle of current executable.
    let instance = unsafe { GetModuleHandleW(null()) };
    let cls_w = utf8_to_wide(SHELL_CLASS_NAME);
    // SAFETY: Load default system arrow cursor.
    let cursor = unsafe { LoadCursorW(null_mut(), IDC_ARROW) };

    let wc = WNDCLASSEXW {
        cbSize: core::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(shell_wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: null_mut(),
        hCursor: cursor,
        hbrBackground: null_mut(),
        lpszMenuName: null(),
        lpszClassName: cls_w.as_ptr(),
        hIconSm: null_mut(),
    };
    // SAFETY: Register top-level shell window class.
    let atom = unsafe { RegisterClassExW(&raw const wc) };
    if atom == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(1410) {
            return Err(StoreError::new(
                "win32_register_shell_failed",
                format!("Failed to register shell window class: {err}"),
                false,
            ));
        }
    }

    let dpi = system_dpi();
    let wa = primary_work_area();
    let bounds = clamped_initial_window_bounds(dpi, wa);

    let state = Box::new(ShellState {
        hwnd: null_mut(),
        handles: ShellHandles::default(),
        db_path,
        active_mode: Mode::Chat,
        composer: ComposerModel::new(),
        math_idx: 0,
        phys_idx: 0,
        chem_idx: 0,
        font: null_mut(),
        bold_font: null_mut(),
        bg_brush: null_mut(),
        card_brush: null_mut(),
        input_brush: null_mut(),
        border_brush: null_mut(),
        accent_brush: null_mut(),
        top_brush: null_mut(),
        painter: D2dShellPainter::new(),
    });
    let state_ptr = Box::into_raw(state);
    let title_w = utf8_to_wide("Omnia Studio");

    // SAFETY: Create main window with DPI-scaled, workarea-clamped outer dimensions.
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            cls_w.as_ptr(),
            title_w.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            bounds.left,
            bounds.top,
            bounds.width(),
            bounds.height(),
            null_mut(),
            null_mut(),
            instance,
            state_ptr.cast(),
        )
    };
    if hwnd.is_null() {
        // SAFETY: Creation failed cleanly before storing `state_ptr` in window user data.
        unsafe {
            drop(Box::from_raw(state_ptr));
        }
        return Err(StoreError::new(
            "win32_create_shell_failed",
            "Failed to create main shell window.",
            false,
        ));
    }

    // SAFETY: Display main window cleanly and pump UI message loop until `WM_QUIT`.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let mut msg: MSG = core::mem::zeroed();
        while GetMessageW(&raw mut msg, null_mut(), 0, 0) > 0 {
            if IsDialogMessageW(hwnd, &raw const msg) == 0 {
                let _ = TranslateMessage(&raw const msg);
                let _ = DispatchMessageW(&raw const msg);
            }
        }
    }
    Ok(())
}
