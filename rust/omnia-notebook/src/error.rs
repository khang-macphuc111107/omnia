//! Typed error taxonomy for `omnia-notebook` with deterministic HTTP status and error codes.

use omnia_connector_gateway::{
    artifact_intake::ArtifactIntakeError, gemini_share::GeminiShareError,
};
use omnia_winsqlite::WinSqliteError;
use thiserror::Error;

use crate::policy::VisibleHandoffTicket;

/// Unified error type returned across all `omnia-notebook` subsystems.
#[derive(Debug, Error)]
pub enum NotebookError {
    /// Underlying SQLite WAL storage error from `omnia-winsqlite`.
    #[error("notebook SQLite storage error: {0}")]
    Storage(#[from] WinSqliteError),

    /// Canonical artifact intake validation error from `omnia-connector-gateway`.
    #[error("artifact intake rejected: {0}")]
    Intake(#[from] ArtifactIntakeError),

    /// Public Gemini share URL / WIZ payload error from `omnia-connector-gateway`.
    #[error("public Gemini share error: {0}")]
    GeminiShare(#[from] GeminiShareError),

    /// Requested notebook, source, chunk, turn, BTW thread, or artifact does not exist.
    #[error("{entity} '{id}' not found")]
    NotFound { entity: &'static str, id: String },

    /// Caller supplied malformed, empty, or out-of-range input.
    #[error("invalid notebook input: {0}")]
    InvalidInput(String),

    /// Title-based citation reference matched multiple distinct sources; caller must use `source_id`.
    #[error("ambiguous citation title '{title}' matches multiple source IDs: {matching_source_ids:?}")]
    AmbiguousCitation {
        title: String,
        matching_source_ids: Vec<String>,
    },

    /// Notebook source quota reached and `allow_overflow_notebook` is strictly `false`.
    #[error("notebook '{notebook_id}' reached capacity ({current}/{max}) and overflow notebooks are disabled")]
    OverflowDisallowed {
        notebook_id: String,
        current: usize,
        max: usize,
    },

    /// `remote_id` is already immutably bound to another source in the same notebook.
    #[error("remote_id '{remote_id}' is already bound to source '{existing_source_id}'")]
    RemoteIdConflict {
        remote_id: String,
        existing_source_id: String,
    },

    /// Security invariant violated (XXE, zip bomb, archive depth, XML cap, encrypted PDF, MIME allowlist, path traversal).
    #[error("security policy rejected ({code}): {reason}")]
    SecurityRejected { code: &'static str, reason: String },

    /// Compliance policy boundary blocked action (DRM, CAPTCHA/anti-bot, manual visible browser required).
    #[error("compliance policy blocked ({code}): {reason}")]
    PolicyBlocked { code: &'static str, reason: String },

    /// Zero-retry fail-closed `429 AUTH_CHALLENGE_REQUIRED` circuit-breaker refusal with visible handoff ticket.
    #[error("HTTP {status} {code}: {detail} (handoff ticket: {})", handoff.ticket_id)]
    AuthChallengeRequired {
        status: u16,
        code: &'static str,
        detail: String,
        handoff: Box<VisibleHandoffTicket>,
    },

    /// Multi-part or staged ingestion failure after transactional sibling rollback.
    #[error("ingestion failed at {stage}: {detail} (rolled back {rolled_back_siblings} sibling part(s))")]
    IngestionFailed {
        stage: String,
        detail: String,
        rolled_back_siblings: usize,
    },

    /// Live HTTP fetch error (non-challenge network/protocol error).
    #[error("HTTP transport error: {0}")]
    Http(String),

    /// Local filesystem I/O error.
    #[error("I/O error: {0}")]
    Io(String),

    /// JSON serialization/deserialization error.
    #[error("JSON serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl NotebookError {
    /// Canonical machine-readable error code suitable for Wave 3 `/api/notebooks/*` responses.
    #[must_use]
    pub const fn error_code(&self) -> &'static str {
        match self {
            Self::Storage(_) => "NOTEBOOK_STORAGE_ERROR",
            Self::Intake(ArtifactIntakeError::PolicyBlocked { .. }) => "POLICY_BLOCKED",
            Self::Intake(ArtifactIntakeError::SecurityRejected { .. }) => "SECURITY_REJECTED",
            Self::Intake(_) => "ARTIFACT_INTAKE_INVALID",
            Self::GeminiShare(GeminiShareError::AuthRequired { .. }) => "AUTH_CHALLENGE_REQUIRED",
            Self::GeminiShare(GeminiShareError::CaptchaBlocked { .. }) => "AUTH_CHALLENGE_REQUIRED",
            Self::GeminiShare(_) => "GEMINI_SHARE_INVALID",
            Self::NotFound { .. } => "NOT_FOUND",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::AmbiguousCitation { .. } => "AMBIGUOUS_CITATION",
            Self::OverflowDisallowed { .. } => "OVERFLOW_NOTEBOOK_DISALLOWED",
            Self::RemoteIdConflict { .. } => "REMOTE_ID_CONFLICT",
            Self::SecurityRejected { code, .. } => code,
            Self::PolicyBlocked { code, .. } => code,
            Self::AuthChallengeRequired { code, .. } => code,
            Self::IngestionFailed { .. } => "INGESTION_FAILED",
            Self::Http(_) => "HTTP_TRANSPORT_ERROR",
            Self::Io(_) => "IO_ERROR",
            Self::Serialization(_) => "SERIALIZATION_ERROR",
        }
    }

    /// Deterministic HTTP status code for Wave 3 Studio API mounting.
    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::NotFound { .. } => 404,
            Self::InvalidInput(_) | Self::Serialization(_) => 400,
            Self::AmbiguousCitation { .. }
            | Self::OverflowDisallowed { .. }
            | Self::RemoteIdConflict { .. } => 409,
            Self::SecurityRejected { .. }
            | Self::PolicyBlocked { .. }
            | Self::Intake(ArtifactIntakeError::PolicyBlocked { .. })
            | Self::Intake(ArtifactIntakeError::SecurityRejected { .. }) => 403,
            Self::Intake(_) => 422,
            Self::AuthChallengeRequired { status, .. } => *status,
            Self::GeminiShare(
                GeminiShareError::AuthRequired { .. } | GeminiShareError::CaptchaBlocked { .. },
            ) => 429,
            Self::GeminiShare(_) => 422,
            Self::IngestionFailed { .. } => 422,
            Self::Http(_) => 502,
            Self::Storage(_) | Self::Io(_) => 500,
        }
    }
}
