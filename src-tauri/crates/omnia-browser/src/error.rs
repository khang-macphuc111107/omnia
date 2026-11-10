//! Error type for the browser crate.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("CDP error {code}: {message}")]
    Cdp { code: i64, message: String },
    #[error("CDP call `{0}` timed out")]
    Timeout(String),
    #[error("browser connection closed")]
    Closed,
    #[error("websocket error: {0}")]
    Ws(String),
    #[error("browser launch failed: {0}")]
    Launch(String),
    #[error("no Microsoft Edge or Chrome installation found")]
    NoBrowser,
    /// A ref, selector, tab or request that does not exist (any more).
    #[error("{0}")]
    NotFound(String),
    #[error("javascript error: {0}")]
    Js(String),
    #[error("{0}")]
    Invalid(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, BrowserError>;
