//! Omnia computer use: lets the agent see and operate desktop apps.
//!
//! Design: structured first (Windows UI Automation trees with refs), pixels
//! second (screenshots + coordinates for apps with poor accessibility).
//! No Tauri dependency. All OS work runs on one dedicated worker thread;
//! non-Windows targets compile to a stub that reports "unsupported".
//!
//! Entry point: [`computer_tools`] builds the harness tools that share one
//! [`Computer`] handle.

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

pub use computer::{ClickTarget, Computer, ComputerConfig, Screenshot, ShotTarget};
pub use encode::ImageFormat;
pub use geometry::ImageMap;
pub use safety::{default_blocked_apps, ComputerPolicy, KillSwitch, Safety};
pub use tools::computer_tools;
pub use types::*;

#[derive(Debug, thiserror::Error)]
pub enum ComputerError {
    #[error("computer use is unsupported on this platform")]
    Unsupported,
    #[error("refused: {0}")]
    Blocked(String),
    #[error("stopped: the computer-use kill switch is engaged")]
    Killed,
    #[error("rate limit reached ({0} actions/minute); wait a moment")]
    RateLimited(u32),
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
