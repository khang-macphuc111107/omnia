//! Omnia Native Rust Win32 / Direct2D / UIA Desktop Shell.

pub mod cli;
pub(crate) mod d2d;
pub mod dpi;
pub(crate) mod session_panel;
pub mod sessions;
pub mod types;
pub mod uia_provider;
pub(crate) mod win32_shell;

pub use cli::{
    parse_qa_seed_directory_arg, parse_session_db_args, validate_session_db_path, CliError,
    USAGE_TEXT,
};
pub use dpi::{
    clamped_initial_window_bounds, clamped_min_track_size, compute_session_panel_layout,
    compute_shell_layout, scale_px, RectPx, SessionPanelLayoutRects, ShellLayoutRects, BASE_DPI,
    LOGICAL_MIN_WINDOW_HEIGHT, LOGICAL_MIN_WINDOW_WIDTH, LOGICAL_WINDOW_HEIGHT,
    LOGICAL_WINDOW_WIDTH,
};
pub use sessions::{
    NativeSessionCommand, NativeSessionEvent, NativeSessionStore, NativeSessionWorker,
    MAX_PENDING_SESSION_COMMANDS,
};
pub use types::{
    effort_index, format_snapshot_status, format_store_error_status, normalize_effort,
    strip_mnemonic_ampersands, utf8_to_wide, validate_session_settings_input, wide_to_utf8, Mode,
    NativeSessionsSnapshot, NativeUiSessionSummary, SessionForm, EFFORTS, ID_COMPOSER_BADGE,
    ID_COMPOSER_CMD, ID_DRAFT, ID_DRAFT_LABEL, ID_EFFORT_LABEL, ID_FOOTER, ID_HEADING,
    ID_MODEL_LABEL, ID_MODE_BROWSER, ID_MODE_CHAT, ID_MODE_IDE, ID_NEW_SESSION, ID_NEXT_PAGE,
    ID_PANEL_HOST, ID_PREV_PAGE, ID_REFRESH_SESSIONS, ID_SAVE_SETTINGS, ID_SESSION_EFFORT,
    ID_SESSION_HEADER, ID_SESSION_LIST, ID_SESSION_MODEL, ID_SESSION_STATUS, ID_SESSION_TITLE,
    ID_SYM_CHEM, ID_SYM_MATH, ID_SYM_PHYS, ID_TITLE_LABEL, MAX_SETTING_CHARS, STUDIO_BADGE_TEXT,
    UNCONFIGURED_MODEL_SENTINEL, WM_SESSION_WORKER_WAKE,
};
pub use win32_shell::{run_native_shell, show_startup_error};
