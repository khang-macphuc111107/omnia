use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};

use crate::types::Mode;

/// Canonical baseline DPI used as the 100% scale denominator.
pub const BASE_DPI: u32 = 96;

/// Logical 96-DPI initial outer window dimensions matching the flagship shell specification.
pub const LOGICAL_WINDOW_WIDTH: i32 = 1220;
pub const LOGICAL_WINDOW_HEIGHT: i32 = 820;

/// Logical 96-DPI minimum outer window track dimensions (clamped to monitor workarea at high DPI).
pub const LOGICAL_MIN_WINDOW_WIDTH: i32 = 900;
pub const LOGICAL_MIN_WINDOW_HEIGHT: i32 = 620;

/// Integer rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RectPx {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl RectPx {
    /// Construct a rectangle from origin and dimensions.
    #[must_use]
    pub const fn from_xywh(x: i32, y: i32, width: i32, height: i32) -> Self {
        let w = if width < 0 { 0 } else { width };
        let h = if height < 0 { 0 } else { height };
        Self {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        }
    }

    /// Rectangle width in pixels.
    #[must_use]
    pub const fn width(self) -> i32 {
        if self.right > self.left {
            self.right - self.left
        } else {
            0
        }
    }

    /// Rectangle height in pixels.
    #[must_use]
    pub const fn height(self) -> i32 {
        if self.bottom > self.top {
            self.bottom - self.top
        } else {
            0
        }
    }

    /// Return `true` when `inner` fits completely inside `self` with non-negative area.
    #[must_use]
    pub const fn contains_rect(self, inner: Self) -> bool {
        inner.width() > 0
            && inner.height() > 0
            && inner.left >= self.left
            && inner.top >= self.top
            && inner.right <= self.right
            && inner.bottom <= self.bottom
    }

    /// Return `true` when two non-empty rectangles overlap in area.
    #[must_use]
    pub const fn overlaps(self, other: Self) -> bool {
        self.width() > 0
            && self.height() > 0
            && other.width() > 0
            && other.height() > 0
            && self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }

    /// Convert into a Win32 `RECT`.
    #[must_use]
    pub const fn to_win32(self) -> RECT {
        RECT {
            left: self.left,
            top: self.top,
            right: self.right,
            bottom: self.bottom,
        }
    }

    /// Convert from a Win32 `RECT`.
    #[must_use]
    pub const fn from_win32(rect: RECT) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

/// Complete physical-pixel layout for the top-level Win32 shell window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellLayoutRects {
    pub client: RectPx,
    pub top_bar: RectPx,
    pub badge: RectPx,
    pub active_pill: RectPx,
    pub mode_chat: RectPx,
    pub mode_browser: RectPx,
    pub mode_ide: RectPx,
    pub left_card: RectPx,
    pub right_card: RectPx,
    pub heading: RectPx,
    pub draft_label: RectPx,
    pub draft: RectPx,
    pub composer_cmd: RectPx,
    pub sym_math: RectPx,
    pub sym_phys: RectPx,
    pub sym_chem: RectPx,
    pub composer_badge: RectPx,
    pub panel_host: RectPx,
    pub footer: RectPx,
}

/// Complete physical-pixel layout for controls inside `OmniaNativeSessionPanel` (`140`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionPanelLayoutRects {
    pub bounds: RectPx,
    pub header: RectPx,
    pub new_button: RectPx,
    pub list: RectPx,
    pub prev_button: RectPx,
    pub next_button: RectPx,
    pub title_label: RectPx,
    pub title_edit: RectPx,
    pub model_label: RectPx,
    pub model_edit: RectPx,
    pub effort_label: RectPx,
    pub effort_combo: RectPx,
    pub save_button: RectPx,
    pub status: RectPx,
    pub refresh_button: RectPx,
}

/// Scale a 96-DPI logical pixel length to `dpi` with symmetric rounding.
#[must_use]
pub fn scale_px(logical: i32, dpi: u32) -> i32 {
    if logical <= 0 {
        return 0;
    }
    let effective_dpi = dpi.max(BASE_DPI / 2) as i64;
    let scaled =
        (i64::from(logical) * effective_dpi + i64::from(BASE_DPI / 2)) / i64::from(BASE_DPI);
    (scaled as i32).max(1)
}

/// Enable Per-Monitor V2 DPI awareness if not already satisfied by the embedded manifest.
pub fn ensure_per_monitor_v2_dpi_awareness() {
    // SAFETY: Calling SetProcessDpiAwarenessContext with the documented static handle
    // is thread-safe and harmless when already configured by app.manifest.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// Query the system DPI, defaulting safely to `96`.
#[must_use]
pub fn system_dpi() -> u32 {
    // SAFETY: GetDpiForSystem takes no pointers and always returns a valid DPI or 0.
    let dpi = unsafe { GetDpiForSystem() };
    if dpi >= 48 {
        dpi
    } else {
        BASE_DPI
    }
}

/// Query a window's effective DPI, falling back to `system_dpi()`.
#[must_use]
pub(crate) fn window_dpi(hwnd: HWND) -> u32 {
    if hwnd.is_null() {
        return system_dpi();
    }
    // SAFETY: Caller passes an HWND belonging to this thread/process; GetDpiForWindow returns 0 if invalid.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi >= 48 {
        dpi
    } else {
        system_dpi()
    }
}

/// Query the primary monitor work area via `SystemParametersInfoW(SPI_GETWORKAREA)`.
#[must_use]
pub fn primary_work_area() -> RectPx {
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 1280,
        bottom: 860,
    };
    // SAFETY: `rc` is stack-allocated and matches `RECT` expected by `SPI_GETWORKAREA`.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            (&raw mut rc).cast::<core::ffi::c_void>(),
            0,
        )
    };
    if ok != 0 {
        RectPx::from_win32(rc)
    } else {
        RectPx::from_xywh(0, 0, 1280, 860)
    }
}

/// Query the monitor work area containing `hwnd`, falling back to `primary_work_area()`.
#[must_use]
pub(crate) fn window_work_area(hwnd: HWND) -> RectPx {
    if hwnd.is_null() {
        return primary_work_area();
    }
    // SAFETY: MonitorFromWindow returns a valid HMONITOR for MONITOR_DEFAULTTONEAREST.
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return primary_work_area();
    }
    let mut info = MONITORINFO {
        cbSize: core::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
        rcWork: RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
        dwFlags: 0,
    };
    // SAFETY: `info.cbSize` is initialized accurately before calling `GetMonitorInfoW`.
    let ok = unsafe { GetMonitorInfoW(monitor, &raw mut info) };
    if ok != 0 {
        RectPx::from_win32(info.rcWork)
    } else {
        primary_work_area()
    }
}

/// Compute initial outer window bounds scaled to `dpi` and clamped strictly inside `workarea`.
#[must_use]
pub fn clamped_initial_window_bounds(dpi: u32, workarea: RectPx) -> RectPx {
    let wa_w = workarea.width().max(1);
    let wa_h = workarea.height().max(1);
    let desired_w = scale_px(LOGICAL_WINDOW_WIDTH, dpi);
    let desired_h = scale_px(LOGICAL_WINDOW_HEIGHT, dpi);
    let width = desired_w.min(wa_w).max(1);
    let height = desired_h.min(wa_h).max(1);
    let x = workarea.left + (wa_w - width) / 2;
    let y = workarea.top + (wa_h - height) / 2;
    RectPx::from_xywh(x, y, width, height)
}

/// Compute minimum track width/height clamped to `workarea` so `WM_GETMINMAXINFO` never clips high-DPI windows.
#[must_use]
pub fn clamped_min_track_size(dpi: u32, workarea: RectPx) -> (i32, i32) {
    let wa_w = workarea.width().max(320);
    let wa_h = workarea.height().max(240);
    let min_w = scale_px(LOGICAL_MIN_WINDOW_WIDTH, dpi).min(wa_w);
    let min_h = scale_px(LOGICAL_MIN_WINDOW_HEIGHT, dpi).min(wa_h);
    (min_w, min_h)
}

/// Compute unclipped layout geometry for the main Win32 shell window.
#[must_use]
pub fn compute_shell_layout(
    client_w: i32,
    client_h: i32,
    dpi: u32,
    active_mode: Mode,
) -> ShellLayoutRects {
    let cw = client_w.max(320);
    let ch = client_h.max(240);
    let client = RectPx::from_xywh(0, 0, cw, ch);

    let margin = scale_px(16, dpi)
        .min((cw / 32).max(6))
        .min((ch / 28).max(6));
    let gap = scale_px(10, dpi).min((ch / 48).max(4));
    let top_bar_h = scale_px(56, dpi).min((ch / 8).max(34));
    let top_bar = RectPx::from_xywh(0, 0, cw, top_bar_h);

    let btn_gap = scale_px(8, dpi).min((cw / 80).max(4));
    let btn_w = scale_px(96, dpi).min(((cw - margin * 2 - btn_gap * 2) / 5).max(56));
    let btn_h = scale_px(34, dpi).min((top_bar_h - gap).max(24));
    let btn_y = ((top_bar_h - btn_h) / 2).max(2);

    let mode_chat = RectPx::from_xywh(margin, btn_y, btn_w, btn_h);
    let mode_browser = RectPx::from_xywh(mode_chat.right + btn_gap, btn_y, btn_w, btn_h);
    let mode_ide = RectPx::from_xywh(mode_browser.right + btn_gap, btn_y, btn_w, btn_h);

    let active_btn = match active_mode {
        Mode::Chat => mode_chat,
        Mode::Browser => mode_browser,
        Mode::Ide => mode_ide,
    };
    let pill_pad = scale_px(2, dpi).min(2);
    let active_pill = RectPx::from_xywh(
        (active_btn.left - pill_pad).max(0),
        (active_btn.top - pill_pad).max(0),
        active_btn.width() + pill_pad * 2,
        active_btn.height() + pill_pad * 2,
    );

    let badge_left = (mode_ide.right + margin).min(cw - margin);
    let badge_w = (cw - margin - badge_left).max(0);
    let badge = RectPx::from_xywh(badge_left, btn_y, badge_w, btn_h);

    let footer_h = scale_px(22, dpi).min((ch / 20).max(16));
    let footer_y = (ch - margin - footer_h).max(top_bar.bottom + gap + 80);
    let footer = RectPx::from_xywh(margin, footer_y, (cw - margin * 2).max(40), footer_h);

    let cards_top = top_bar.bottom + gap;
    let cards_bottom = (footer.top - gap).max(cards_top + 80).min(ch - margin);
    let cards_h = (cards_bottom - cards_top).max(40);

    let avail_w = (cw - margin * 2 - gap).max(160);
    let right_w = scale_px(370, dpi)
        .min((avail_w * 42) / 100)
        .max(scale_px(240, dpi).min(avail_w / 2));
    let left_w = (avail_w - right_w).max(120);

    let left_card = RectPx::from_xywh(margin, cards_top, left_w, cards_h);
    let right_card = RectPx::from_xywh(left_card.right + gap, cards_top, right_w, cards_h);

    let card_pad = scale_px(16, dpi)
        .min(left_card.width() / 16)
        .min(left_card.height() / 16)
        .max(6);
    let inner_left = left_card.left + card_pad;
    let inner_w = (left_card.width() - card_pad * 2).max(80);
    let inner_top = left_card.top + card_pad;
    let inner_bottom = (left_card.bottom - card_pad).max(inner_top + 60);
    let inner_h = inner_bottom - inner_top;

    let mut row_gap = scale_px(8, dpi).min((inner_h / 36).max(3));
    let mut heading_h = scale_px(48, dpi).min((inner_h * 18) / 100).max(26);
    let mut label_h = scale_px(20, dpi).min((inner_h / 16).max(14));
    let mut toolbar_h = scale_px(30, dpi).min((inner_h / 10).max(22));
    let min_draft_h = scale_px(64, dpi).min(inner_h / 3);

    let fixed_left = heading_h + label_h + toolbar_h + row_gap * 3;
    if fixed_left + min_draft_h > inner_h {
        let usable = (inner_h - min_draft_h).max(48);
        let denom = fixed_left.max(1);
        heading_h = (heading_h * usable / denom).max(22);
        label_h = (label_h * usable / denom).max(12);
        toolbar_h = (toolbar_h * usable / denom).max(20);
        row_gap = (row_gap * usable / denom).max(2);
    }

    let heading = RectPx::from_xywh(inner_left, inner_top, inner_w, heading_h);
    let draft_label = RectPx::from_xywh(inner_left, heading.bottom + row_gap, inner_w, label_h);
    let toolbar_y = (inner_bottom - toolbar_h).max(draft_label.bottom + row_gap * 2 + 24);
    let draft_top = draft_label.bottom + row_gap;
    let draft_h = (toolbar_y - row_gap - draft_top).max(20);
    let draft = RectPx::from_xywh(inner_left, draft_top, inner_w, draft_h);

    let sym_w = scale_px(72, dpi).min((inner_w / 7).max(44));
    let sym_gap = scale_px(6, dpi).min(4);
    let badge_chip_w = scale_px(92, dpi).min((inner_w / 6).max(48));
    let cmd_w = (inner_w - sym_w * 3 - badge_chip_w - sym_gap * 4).max(60);

    let composer_cmd = RectPx::from_xywh(inner_left, toolbar_y, cmd_w, toolbar_h);
    let sym_math = RectPx::from_xywh(composer_cmd.right + sym_gap, toolbar_y, sym_w, toolbar_h);
    let sym_phys = RectPx::from_xywh(sym_math.right + sym_gap, toolbar_y, sym_w, toolbar_h);
    let sym_chem = RectPx::from_xywh(sym_phys.right + sym_gap, toolbar_y, sym_w, toolbar_h);
    let badge_x = sym_chem.right + sym_gap;
    let badge_rem_w = (inner_left + inner_w - badge_x).max(24);
    let composer_badge = RectPx::from_xywh(badge_x, toolbar_y, badge_rem_w, toolbar_h);

    let panel_pad = scale_px(12, dpi)
        .min(right_card.width() / 16)
        .min(right_card.height() / 24)
        .max(4);
    let panel_host = RectPx::from_xywh(
        right_card.left + panel_pad,
        right_card.top + panel_pad,
        (right_card.width() - panel_pad * 2).max(80),
        (right_card.height() - panel_pad * 2).max(80),
    );

    ShellLayoutRects {
        client,
        top_bar,
        badge,
        active_pill,
        mode_chat,
        mode_browser,
        mode_ide,
        left_card,
        right_card,
        heading,
        draft_label,
        draft,
        composer_cmd,
        sym_math,
        sym_phys,
        sym_chem,
        composer_badge,
        panel_host,
        footer,
    }
}

/// Compute unclipped responsive geometry inside `OmniaNativeSessionPanel` (`140`).
///
/// Guarantees `refresh_button` and `status` stay strictly within `panel_h` across `96..=192` DPI.
#[must_use]
pub fn compute_session_panel_layout(
    panel_w: i32,
    panel_h: i32,
    dpi: u32,
) -> SessionPanelLayoutRects {
    let w = panel_w.max(120);
    let h = panel_h.max(180);
    let bounds = RectPx::from_xywh(0, 0, w, h);

    let mut gap = scale_px(6, dpi);
    let mut header_h = scale_px(22, dpi);
    let mut btn_h = scale_px(28, dpi);
    let mut pager_h = scale_px(26, dpi);
    let mut label_h = scale_px(17, dpi);
    let mut edit_h = scale_px(25, dpi);
    let mut combo_h = scale_px(26, dpi);
    let mut status_h = scale_px(54, dpi);
    let min_list_h = scale_px(72, dpi).min((h / 5).max(36));

    // Exact vertical sum of all fixed rows + gaps (9*gap + 3*2px label tight gaps).
    let fixed_without_list = header_h
        + btn_h
        + pager_h
        + label_h * 3
        + edit_h * 2
        + combo_h
        + btn_h * 2
        + status_h
        + gap * 9
        + 6;

    if fixed_without_list + min_list_h > h {
        let target_fixed = (h - min_list_h).max(150);
        let scale_num = target_fixed;
        let scale_den = fixed_without_list.max(1);
        let shrink = |val: i32, floor: i32| -> i32 { ((val * scale_num) / scale_den).max(floor) };
        gap = shrink(gap, 2);
        header_h = shrink(header_h, 14);
        btn_h = shrink(btn_h, 18);
        pager_h = shrink(pager_h, 18);
        label_h = shrink(label_h, 12);
        edit_h = shrink(edit_h, 18);
        combo_h = shrink(combo_h, 18);
        status_h = shrink(status_h, 24);
    }

    let top_block_h = header_h + gap + btn_h + gap;
    let bottom_block_h =
        pager_h + label_h * 3 + edit_h * 2 + combo_h + btn_h * 2 + status_h + gap * 7 + 6;
    let list_h = (h - top_block_h - bottom_block_h).max(24);

    let header = RectPx::from_xywh(0, 0, w, header_h);
    let new_button = RectPx::from_xywh(0, header.bottom + gap, w, btn_h);
    let list = RectPx::from_xywh(0, new_button.bottom + gap, w, list_h);

    let mut y = list.bottom + gap;
    let half_w = ((w - gap) / 2).max(40);
    let prev_button = RectPx::from_xywh(0, y, half_w, pager_h);
    let next_x = prev_button.right + gap;
    let next_button = RectPx::from_xywh(next_x, y, (w - next_x).max(40), pager_h);
    y = prev_button.bottom + gap;

    let title_label = RectPx::from_xywh(0, y, w, label_h);
    y = title_label.bottom + 2;
    let title_edit = RectPx::from_xywh(0, y, w, edit_h);
    y = title_edit.bottom + gap;

    let model_label = RectPx::from_xywh(0, y, w, label_h);
    y = model_label.bottom + 2;
    let model_edit = RectPx::from_xywh(0, y, w, edit_h);
    y = model_edit.bottom + gap;

    let effort_label = RectPx::from_xywh(0, y, w, label_h);
    y = effort_label.bottom + 2;
    let effort_combo = RectPx::from_xywh(0, y, w, combo_h);
    y = effort_combo.bottom + gap;

    let save_button = RectPx::from_xywh(0, y, w, btn_h);
    y = save_button.bottom + gap;

    let refresh_y = (h - btn_h).max(0);
    let final_status_h = (refresh_y - gap - y).max(12);
    let status = RectPx::from_xywh(0, y, w, final_status_h);
    let refresh_button = RectPx::from_xywh(0, refresh_y, w, btn_h);

    SessionPanelLayoutRects {
        bounds,
        header,
        new_button,
        list,
        prev_button,
        next_button,
        title_label,
        title_edit,
        model_label,
        model_edit,
        effort_label,
        effort_combo,
        save_button,
        status,
        refresh_button,
    }
}
