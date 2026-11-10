//! Error type shared by every module of the crate.

use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, DownloadError>;

#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "camelCase")]
pub enum DownloadError {
    /// Network / protocol level failure (retryable).
    #[error("network error: {0}")]
    Network(String),
    /// Non-success HTTP status.
    #[error("unexpected HTTP status {0}")]
    Status(u16),
    #[error("i/o error: {0}")]
    Io(String),
    /// The stream is protected by DRM (SAMPLE-AES, Widevine, PlayReady, FairPlay, CENC...).
    /// Omnia never attempts to circumvent DRM.
    #[error("content is DRM protected and cannot be downloaded: {0}")]
    DrmProtected(String),
    #[error("download cancelled")]
    Cancelled,
    #[error("parse error: {0}")]
    Parse(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("{0}")]
    Other(String),
}

impl DownloadError {
    /// Whether a retry with backoff makes sense.
    pub fn is_retryable(&self) -> bool {
        match self {
            DownloadError::Network(_) => true,
            DownloadError::Status(code) => *code >= 500 || *code == 429 || *code == 408,
            _ => false,
        }
    }
}

impl From<reqwest::Error> for DownloadError {
    fn from(e: reqwest::Error) -> Self {
        DownloadError::Network(e.to_string())
    }
}

impl From<std::io::Error> for DownloadError {
    fn from(e: std::io::Error) -> Self {
        DownloadError::Io(e.to_string())
    }
}

impl From<url::ParseError> for DownloadError {
    fn from(e: url::ParseError) -> Self {
        DownloadError::InvalidRequest(e.to_string())
    }
}
