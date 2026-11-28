//! Omnia pure-Rust Windows computer-use engine: lets the agent see and operate
//! desktop applications safely and non-intrusively.
//!
//! Design:
//! - Structured first (cached 17-property Windows UI Automation trees with
//!   versioned `[ref=wNeM]` handles and pattern-first actions), pixels second
//!   (DPI-aware screenshots, WinRT `Windows.Media.Ocr`, and virtual-screen math).
//! - Non-intrusive background window control (`computer_window_*`) via
//!   per-window DPI switching, `PrintWindow`, `ChildWindowFromPointEx`,
//!   `PostMessageW`, `GetGUIThreadInfo`, and `SendMessageTimeoutW`.
//! - Steer #22 YOLO default (`ComputerPolicy::unrestricted_default()`) with
//!   unconditional OS/UAC/UIPI/own-process boundaries, global [`KillSwitch`],
//!   and `GetProcessTimes` `process_create_time_100ns` PID-reuse continuity.
//! - Zero external image/async-trait crates (`flate2` + `crc32fast` PNG codec).
//! - All Win32/COM work runs on one dedicated MTA + Per-Monitor-V2 DPI worker
//!   thread; non-Windows targets compile cleanly with `Unsupported` stubs.

pub mod backend;
pub mod bg;
pub mod computer;
mod computer_bg;
pub mod encode;
pub mod format;
pub mod geometry;
pub mod keys;
pub mod launch;
pub mod ocr;
pub mod safety;
pub mod tools;
pub mod types;

#[cfg(windows)]
mod bgwin;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod ocr_win;
#[cfg(windows)]
mod screen;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod winapi;

pub use computer::{ClickTarget, Computer, ComputerConfig, OcrOutput, Screenshot, ShotTarget};
pub use computer_bg::{BgOcr, BgShot};
pub use encode::{decode_png, encode_image, encode_rgb_png, encode_rgba_png, sha256_hex, ImageFormat};
pub use geometry::ImageMap;
pub use safety::{
    default_blocked_apps, hard_blocked_apps, strict_blocked_apps, ComputerPolicy, KillSwitch,
    ProcessIdentity, Safety,
};
pub use tools::{
    computer_tools, computer_tools_for, ComputerTools, ContentBlock, ToolContext, ToolEffect,
    ToolOutput, ToolSpec,
};
pub use types::*;

#[derive(Debug, thiserror::Error)]
pub enum ComputerError {
    #[error("computer use is unsupported on this platform")]
    Unsupported,
    #[error("refused: {0}")]
    Blocked(String),
    #[error("stopped: the computer-use kill switch is engaged")]
    Killed,
    #[error("cancelled")]
    Cancelled,
    #[error("rate limit reached ({0} actions/minute); wait a moment")]
    RateLimited(u32),
    #[error("stale target: {0}")]
    StaleTarget(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
}

impl From<String> for ComputerError {
    fn from(s: String) -> Self {
        ComputerError::Invalid(s)
    }
}
