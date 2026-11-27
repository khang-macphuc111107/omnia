use omnia_core::{is_valid_utf8, utf8_has_control_chars};
use omnia_storage::{AgentSessionPage, StoreError};

/// Main shell mode button control IDs (`WM_COMMAND` + UIA `AutomationId`).
pub const ID_MODE_CHAT: i32 = 101;
pub const ID_MODE_BROWSER: i32 = 102;
pub const ID_MODE_IDE: i32 = 103;

/// Main shell workspace control IDs.
pub const ID_HEADING: i32 = 110;
pub const ID_DRAFT_LABEL: i32 = 111;
pub const ID_DRAFT: i32 = 112;
pub const ID_FOOTER: i32 = 113;
pub const ID_COMPOSER_CMD: i32 = 114;
pub const ID_SYM_MATH: i32 = 115;
pub const ID_SYM_PHYS: i32 = 116;
pub const ID_SYM_CHEM: i32 = 117;
pub const ID_COMPOSER_BADGE: i32 = 118;

/// Session panel container & child control IDs.
pub const ID_PANEL_HOST: i32 = 140;
pub const ID_SESSION_HEADER: i32 = 119;
pub const ID_SESSION_LIST: i32 = 120;
pub const ID_NEW_SESSION: i32 = 121;
pub const ID_SESSION_TITLE: i32 = 122;
pub const ID_SESSION_MODEL: i32 = 123;
pub const ID_SESSION_EFFORT: i32 = 124;
pub const ID_SAVE_SETTINGS: i32 = 125;
pub const ID_SESSION_STATUS: i32 = 126;
pub const ID_REFRESH_SESSIONS: i32 = 127;
pub const ID_PREV_PAGE: i32 = 128;
pub const ID_NEXT_PAGE: i32 = 129;
pub const ID_TITLE_LABEL: i32 = 130;
pub const ID_MODEL_LABEL: i32 = 131;
pub const ID_EFFORT_LABEL: i32 = 132;

/// Window message posted from the background session worker to the panel HWND (`WM_APP + 25`).
pub const WM_SESSION_WORKER_WAKE: u32 = 0x8000 + 25;

/// Internal placeholder stored in `omnia_storage::AgentSessionSummary::model` when UI model is unset.
/// Companion `native_session_meta.model_unconfigured` records that the UI text box `123` is blank `""`.
pub const UNCONFIGURED_MODEL_SENTINEL: &str = "__omnia_unconfigured__";

/// Supported reasoning effort choices rendered inside `124` (`COMBOBOX`).
pub const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Maximum codepoints allowed in a session title or model ID from the native UI.
pub const MAX_SETTING_CHARS: usize = 512;

/// Win32 STATIC control styles omitted from `windows-sys` `WindowsAndMessaging`.
pub const SS_LEFT: u32 = 0x0000;
pub const SS_NOPREFIX: u32 = 0x0080;
pub const SS_CENTERIMAGE: u32 = 0x0200;
pub const SS_ENDELLIPSIS: u32 = 0x4000;

/// Win32 color constants (`0x00BBGGRR` for GDI `COLORREF`).
pub const COLOR_WINDOW_BG: u32 = 0x001B_130E; // RGB(14, 19, 27)
pub const COLOR_TOP_BAR_BG: u32 = 0x0026_1B13; // RGB(19, 27, 38)
pub const COLOR_CARD_BG: u32 = 0x002B_1E15; // RGB(21, 30, 43)
pub const COLOR_INPUT_BG: u32 = 0x001C_130D; // RGB(13, 19, 28)
pub const COLOR_BORDER: u32 = 0x004D_3728; // RGB(40, 55, 77)
pub const COLOR_ACCENT: u32 = 0x00F8_BD38; // RGB(56, 189, 248)
pub const COLOR_TEXT_PRIMARY: u32 = 0x00FA_F2EC; // RGB(236, 242, 250)
pub const COLOR_TEXT_MUTED: u32 = 0x00B8_A394; // RGB(148, 163, 184)
pub const COLOR_TEXT_SOFT: u32 = 0x00C7_B09F; // RGB(159, 176, 199)
pub const COLOR_DWM_CAPTION: u32 = 0x001D_140F; // RGB(15, 20, 29)

/// Header studio badge text rendered with Direct2D/DirectWrite and GDI fallback.
pub const STUDIO_BADGE_TEXT: &str = "OMNIA STUDIO  \u{00B7}  RUST / DWM MICA / DIRECT2D / UIA";

/// Active workspace mode toggled via buttons `101`, `102`, and `103`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Chat,
    Browser,
    Ide,
}

impl Mode {
    /// Resolve a mode from its Win32 button control ID.
    #[must_use]
    pub const fn from_control_id(id: i32) -> Option<Self> {
        match id {
            ID_MODE_CHAT => Some(Self::Chat),
            ID_MODE_BROWSER => Some(Self::Browser),
            ID_MODE_IDE => Some(Self::Ide),
            _ => None,
        }
    }

    /// Return the Win32 button control ID for this mode.
    #[must_use]
    pub const fn control_id(self) -> i32 {
        match self {
            Self::Chat => ID_MODE_CHAT,
            Self::Browser => ID_MODE_BROWSER,
            Self::Ide => ID_MODE_IDE,
        }
    }

    /// Return the button label used for Win32 and UIA rendering.
    #[must_use]
    pub const fn button_label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Browser => "Browser",
            Self::Ide => "IDE",
        }
    }

    /// Return the first-line heading prefix expected by UIA smoke/session checks.
    #[must_use]
    pub const fn heading_title(self) -> &'static str {
        match self {
            Self::Chat => "Chat / No project",
            Self::Browser => "Browser",
            Self::Ide => "IDE",
        }
    }

    /// Return the full two-line heading text shown in control `110`.
    #[must_use]
    pub fn heading_text(self) -> String {
        match self {
            Self::Chat => {
                "Chat / No project\nDirect native prompt composer and SQLite session controls ready."
                    .to_owned()
            }
            Self::Browser => {
                "Browser\nIsolated WebView inspection workspace ready; draft preserved.".to_owned()
            }
            Self::Ide => {
                "IDE\nNative Rust workspace mode ready; active draft and session preserved."
                    .to_owned()
            }
        }
    }
}

/// Normalize effort string to a canonical value, returning `None` if unrecognized.
#[must_use]
pub fn normalize_effort(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    EFFORTS
        .iter()
        .copied()
        .find(|candidate| candidate.eq_ignore_ascii_case(trimmed))
}

/// Return index of effort inside [`EFFORTS`], defaulting to `"medium"` (index `3`).
#[must_use]
pub fn effort_index(value: &str) -> usize {
    normalize_effort(value)
        .and_then(|norm| EFFORTS.iter().position(|e| *e == norm))
        .unwrap_or(3)
}

/// Form baseline / live state mirrored from controls `122`, `123`, `124`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionForm {
    pub title: String,
    pub model: String,
    pub effort: String,
}

impl Default for SessionForm {
    fn default() -> Self {
        Self {
            title: String::new(),
            model: String::new(),
            effort: "medium".to_owned(),
        }
    }
}

impl SessionForm {
    /// Construct a normalized UI baseline from persisted title, UI model, and effort.
    #[must_use]
    pub fn from_persisted(title: &str, ui_model: &str, effort: &str) -> Self {
        Self {
            title: title.to_owned(),
            model: ui_model.to_owned(),
            effort: normalize_effort(effort).unwrap_or("medium").to_owned(),
        }
    }

    /// Return `true` when any editable field differs from `baseline`.
    #[must_use]
    pub fn is_dirty(&self, baseline: &Self) -> bool {
        self.title.trim() != baseline.title.trim()
            || self.model.trim() != baseline.model.trim()
            || normalize_effort(&self.effort).unwrap_or("medium")
                != normalize_effort(&baseline.effort).unwrap_or("medium")
    }
}

/// UI-facing session projection combining `omnia_storage::AgentSessionSummary` with `native_session_meta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeUiSessionSummary {
    pub id: String,
    pub title: String,
    pub ui_model: String,
    pub reasoning_effort: String,
    pub updated_at_ms: i64,
    pub created_at_ms: i64,
    pub revision: i64,
    pub message_count: i64,
}

/// UI-facing snapshot returned asynchronously by [`crate::sessions::NativeSessionStore`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSessionsSnapshot {
    pub page: AgentSessionPage,
    pub active_session_id: Option<String>,
    pub active_session: Option<NativeUiSessionSummary>,
    pub active_on_page: bool,
    pub page_limit: usize,
    pub can_go_prev: bool,
    pub can_go_next: bool,
    pub navigation_revision: i64,
}

/// Validate editable settings before submitting a CAS save to SQLite.
pub fn validate_session_settings_input(
    title: &str,
    model: &str,
    effort: &str,
) -> Result<SessionForm, StoreError> {
    if !is_valid_utf8(title.as_bytes()) || !is_valid_utf8(model.as_bytes()) {
        return Err(StoreError::new(
            "invalid_input",
            "Session settings must be valid UTF-8.",
            false,
        ));
    }
    if utf8_has_control_chars(title) || utf8_has_control_chars(model) {
        return Err(StoreError::new(
            "invalid_input",
            "Session settings cannot contain ASCII control characters.",
            false,
        ));
    }
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err(StoreError::new(
            "invalid_input",
            "Session title cannot be empty.",
            false,
        ));
    }
    if trimmed_title.chars().count() > MAX_SETTING_CHARS {
        return Err(StoreError::new(
            "invalid_input",
            "Session title exceeds maximum length.",
            false,
        ));
    }

    let trimmed_model = model.trim();
    if trimmed_model.is_empty() || trimmed_model == UNCONFIGURED_MODEL_SENTINEL {
        return Err(StoreError::new(
            "invalid_input",
            "Model ID is required before saving session settings.",
            false,
        ));
    }
    if trimmed_model.chars().count() > MAX_SETTING_CHARS {
        return Err(StoreError::new(
            "invalid_input",
            "Model ID exceeds maximum length.",
            false,
        ));
    }

    let normalized_effort = normalize_effort(effort).ok_or_else(|| {
        StoreError::new(
            "invalid_input",
            "Effort must be one of none, minimal, low, medium, high, xhigh, max.",
            false,
        )
    })?;

    Ok(SessionForm {
        title: trimmed_title.to_owned(),
        model: trimmed_model.to_owned(),
        effort: normalized_effort.to_owned(),
    })
}

/// Encode a Rust UTF-8 string into a NUL-terminated UTF-16 buffer for Win32 calls.
#[must_use]
pub fn utf8_to_wide(input: &str) -> Vec<u16> {
    input.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Decode a NUL-terminated or exact UTF-16 slice into UTF-8 losslessly without trailing NULs.
#[must_use]
pub fn wide_to_utf8(wide: &[u16]) -> String {
    let end = wide.iter().position(|&ch| ch == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

/// Strip Win32 `&` mnemonic accelerator markers (`"Save && Quit"` -> `"Save & Quit"`, `"&Yes"` -> `"Yes"`).
#[must_use]
pub fn strip_mnemonic_ampersands(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                let _ = chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Format status text for control `126` from a loaded [`NativeSessionsSnapshot`].
#[must_use]
pub fn format_snapshot_status(snapshot: &NativeSessionsSnapshot) -> String {
    let Some(active) = &snapshot.active_session else {
        return "No active session.".to_owned();
    };
    let page_note = if snapshot.active_on_page {
        ""
    } else {
        " · Active session is outside this page."
    };
    format!(
        "Settings revision {} · {} of {} shown{}",
        active.revision,
        snapshot.page.items.len(),
        snapshot.page.total_count,
        page_note
    )
}

/// Format a [`StoreError`] cleanly for status control `126`.
#[must_use]
pub fn format_store_error_status(err: &StoreError) -> String {
    if err.code == "invalid_input" {
        format!("{}: {}", err.code, err.message)
    } else {
        format!(
            "{}: {}\nNo automatic retry. Select a session to reload.",
            err.code, err.message
        )
    }
}
