//! Core domain types, errors, security/path policies, and Wave 3 Studio/CLI DTOs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use omnia_connector_gateway::artifact_intake::{
    sanitize_download_filename, ArtifactIntakeError, HttpValidatorStrength,
};
use omnia_workspace_ops::path_guard::{
    is_reparse_point_metadata, resolve_workspace_root, strip_verbatim_drive_prefix,
};
use omnia_workspace_ops::range_downloader::{
    validate_download_url_with_policy, RangeDownloadError, RangeUrlPolicy, ValidatedDownloadUrl,
    MAX_RANGE_STREAMS, MIN_RANGE_STREAMS,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::handoff::VisibleHandoffTicket;
use crate::pacing::PacingMode;

/// Hard compliance invariant: commercial DRM decryption is strictly unsupported.
pub const DRM_SUPPORTED: bool = false;

/// Minimum concurrent HTTP Range streams allowed per download.
pub const MIN_STREAMS: usize = MIN_RANGE_STREAMS;

/// Maximum concurrent HTTP Range streams allowed per download.
pub const MAX_STREAMS: usize = MAX_RANGE_STREAMS;

/// Default minimum chunk split size for dynamic midpoint work-stealing (256 KiB).
pub const DEFAULT_MIN_SPLIT_BYTES: u64 = 256 * 1024;

/// Default connect/request timeout in seconds for individual HTTP range probes.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Returns non-negative current UTC epoch timestamp in milliseconds (`u64`).
#[must_use]
pub fn current_epoch_ms() -> u64 {
    omnia_core::now_epoch_ms().max(0) as u64
}

/// Unified error type for `omnia-downloader`.
#[derive(Debug, Error)]
pub enum DownloaderError {
    /// Underlying HTTP transport error.
    #[error("HTTP request failed: {0}")]
    Network(#[from] reqwest::Error),

    /// Filesystem I/O failure.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON serialization/deserialization failure.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// SQLite persistence error via `omnia-winsqlite`.
    #[error("SQLite error: {0}")]
    Sqlite(#[from] omnia_winsqlite::WinSqliteError),

    /// Range planner or URL/staging guard error from `omnia-workspace-ops`.
    #[error("range/SSRF policy error: {0}")]
    RangePolicy(#[from] RangeDownloadError),

    /// Artifact intake / filename sanitization error from `omnia-connector-gateway`.
    #[error("intake validation error: {0}")]
    Intake(#[from] ArtifactIntakeError),

    /// UNC/SMB network path (`\\server\share`) or forbidden device prefix rejected.
    #[error("forbidden UNC/SMB or device path rejected: `{path}` ({reason})")]
    ForbiddenPath { path: String, reason: &'static str },

    /// Commercial DRM stream/box detected (`drm_supported = false`); never decrypted.
    #[error("DRM-protected media is strictly unsupported (drm_supported=false): {detail}")]
    DrmUnsupported { detail: String },

    /// HTTP `429 AUTH_CHALLENGE_REQUIRED` or CAPTCHA/sorry interstitial: zero-retry fail-closed.
    #[error("HTTP 429 AUTH_CHALLENGE_REQUIRED (zero-retry fail-closed; manual visible browser handoff required): {detail}")]
    AuthChallengeRequired {
        detail: String,
        ticket: Box<VisibleHandoffTicket>,
    },

    /// HTTP `403 BLOCKED_ACL_403` (`can_download = false`): zero-retry fail-closed.
    #[error("HTTP 403 BLOCKED_ACL_403 (can_download=false, zero-retry fail-closed): {detail}")]
    BlockedAcl403 {
        detail: String,
        can_download: bool,
    },

    /// HTTP `401` / sign-in required: routed to `MANUAL_VISIBLE_BROWSER_ONLY` handoff.
    #[error("authentication required (MANUAL_VISIBLE_BROWSER_ONLY): {detail}")]
    SignInRequired {
        detail: String,
        ticket: Box<VisibleHandoffTicket>,
    },

    /// Server returned an unexpected HTTP status code.
    #[error("unexpected HTTP status {status}: {detail}")]
    HttpStatus { status: u16, detail: String },

    /// Server does not support byte ranges or returned `200 OK` on a ranged request.
    #[error("server rejected byte range with HTTP {0}")]
    RangeNotSupported(u16),

    /// Integrity verification (SHA-256 or CRC32C) failed.
    #[error("{algorithm} integrity mismatch: expected `{expected}`, actual `{actual}`")]
    IntegrityMismatch {
        algorithm: &'static str,
        expected: String,
        actual: String,
    },

    /// Corrupt, truncated, or bounds-violating `OMNF` binary resume journal.
    #[error("corrupt OMNF resume journal: {detail}")]
    CorruptJournal { detail: String },

    /// Invalid Google Drive URL, manifest, or batch pattern.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// Security policy violation (XXE, zip/expansion bomb, unsafe redirect, etc.).
    #[error("security policy rejected request: {0}")]
    SecurityRejected(String),

    /// Download was paused by caller; state persisted for interval resume.
    #[error("download paused: {job_id}")]
    Paused { job_id: String },

    /// Download was cancelled by caller.
    #[error("download cancelled: {job_id}")]
    Cancelled { job_id: String },

    /// Job identifier was not found in store or manager.
    #[error("download job not found: {0}")]
    JobNotFound(String),
}

impl DownloaderError {
    /// Returns `true` strictly when automatic retry is permitted.
    ///
    /// Security invariant: `AuthChallengeRequired` (`429 AUTH_CHALLENGE_REQUIRED`),
    /// `BlockedAcl403`, `SignInRequired`, `DrmUnsupported`, `SecurityRejected`,
    /// `ForbiddenPath`, `RangePolicy`, `Cancelled`, and `Paused` ALWAYS return `false`.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        match self {
            Self::AuthChallengeRequired { .. }
            | Self::BlockedAcl403 { .. }
            | Self::SignInRequired { .. }
            | Self::DrmUnsupported { .. }
            | Self::SecurityRejected(_)
            | Self::ForbiddenPath { .. }
            | Self::RangePolicy(_)
            | Self::Intake(_)
            | Self::IntegrityMismatch { .. }
            | Self::CorruptJournal { .. }
            | Self::InvalidInput(_)
            | Self::Paused { .. }
            | Self::Cancelled { .. }
            | Self::JobNotFound(_)
            | Self::RangeNotSupported(_)
            | Self::Json(_)
            | Self::Sqlite(_) => false,
            Self::Network(_) | Self::Io(_) => true,
            Self::HttpStatus { status, .. } => matches!(*status, 408 | 429 | 500 | 502 | 503 | 504),
        }
    }

    /// Stable machine-readable error code for Studio/CLI/SQLite receipts.
    #[must_use]
    pub const fn error_code(&self) -> &'static str {
        match self {
            Self::AuthChallengeRequired { .. } => "AUTH_CHALLENGE_REQUIRED",
            Self::BlockedAcl403 { .. } => "BLOCKED_ACL_403",
            Self::SignInRequired { .. } => "SIGN_IN_REQUIRED",
            Self::DrmUnsupported { .. } => "DRM_UNSUPPORTED",
            Self::ForbiddenPath { .. } => "FORBIDDEN_PATH",
            Self::RangePolicy(_) => "SSRF_OR_RANGE_POLICY_BLOCKED",
            Self::SecurityRejected(_) => "SECURITY_REJECTED",
            Self::IntegrityMismatch { .. } => "INTEGRITY_MISMATCH",
            Self::CorruptJournal { .. } => "CORRUPT_JOURNAL",
            Self::RangeNotSupported(_) => "RANGE_NOT_SUPPORTED",
            Self::HttpStatus { .. } => "HTTP_STATUS_ERROR",
            Self::Network(_) => "NETWORK_ERROR",
            Self::Io(_) => "IO_ERROR",
            Self::Json(_) => "JSON_ERROR",
            Self::Sqlite(_) => "SQLITE_ERROR",
            Self::Intake(_) => "INTAKE_ERROR",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::Paused { .. } => "PAUSED",
            Self::Cancelled { .. } => "CANCELLED",
            Self::JobNotFound(_) => "JOB_NOT_FOUND",
        }
    }
}

/// Security and SSRF validation policy for `omnia-downloader`.
///
/// In production builds, loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) are ALWAYS
/// rejected. The `allow_loopback_for_tests` opt-in exists strictly behind `#[cfg(test)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecurityPolicy {
    allow_loopback: bool,
    /// Hard compliance invariant — always `false`.
    pub drm_supported: bool,
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self::strict()
    }
}

impl SecurityPolicy {
    /// Strict production security policy: blocks loopback, RFC-1918 private networks,
    /// link-local/IMDS, ULA, embedded credentials, UNC paths, and commercial DRM.
    #[must_use]
    pub const fn strict() -> Self {
        Self {
            allow_loopback: false,
            drm_supported: DRM_SUPPORTED,
        }
    }

    /// Test-only hook permitting local loopback (`127.0.0.1` / `localhost` / `[::1]`)
    /// mock servers while still unconditionally blocking RFC-1918, IMDS, ULA, and DRM.
    #[cfg(test)]
    #[must_use]
    pub const fn allow_loopback_for_tests() -> Self {
        Self {
            allow_loopback: true,
            drm_supported: DRM_SUPPORTED,
        }
    }

    /// Converts into `omnia_workspace_ops::range_downloader::RangeUrlPolicy`.
    #[must_use]
    pub const fn to_range_url_policy(self) -> RangeUrlPolicy {
        RangeUrlPolicy {
            allow_loopback_for_testing: self.allow_loopback,
        }
    }

    /// Returns whether loopback is currently permitted (always `false` outside `#[cfg(test)]`).
    #[must_use]
    pub const fn loopback_allowed(self) -> bool {
        self.allow_loopback
    }

    /// Validates an HTTP(S) URL against SSRF, embedded credentials, and scheme rules.
    pub fn validate_url(self, raw_url: &str) -> Result<ValidatedDownloadUrl, DownloaderError> {
        validate_download_url_with_policy(raw_url, self.to_range_url_policy()).map_err(Into::into)
    }
}

/// Returns `true` only for a strict Windows verbatim ASCII drive prefix (`\\?\C:\` or `//?/C:/`).
/// Rejects `\\?\UNC\`, `\\?\GLOBALROOT\`, `\\?\Pipe\`, `\\?\Volume{...}\`, etc.
fn is_valid_verbatim_drive_prefix(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() < 7 {
        return false;
    }
    let win_verbatim = &bytes[0..4] == br"\\?\" && bytes[6] == b'\\';
    let slash_verbatim = &bytes[0..4] == b"//?/" && bytes[6] == b'/';
    (win_verbatim || slash_verbatim) && bytes[4].is_ascii_alphabetic() && bytes[5] == b':'
}

/// Rejects UNC/SMB network paths (`\\server\share`, `//server/share`, `\\?\UNC\`),
/// Win32/NT device namespace paths (`\\.\...`, `\\?\GLOBALROOT\...`, `\\?\Pipe\...`,
/// `\\?\Volume{...}\...`), NUL bytes, parent traversal (`..`), and reparse points along
/// EVERY existing ancestor up to root; canonicalizes the deepest existing ancestor before
/// verifying strict external containment outside `workspace_root` (`DOD-06`).
pub fn validate_safe_local_path(
    target_path: &Path,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, DownloaderError> {
    let raw = target_path.to_string_lossy();
    if raw.trim().is_empty() {
        return Err(DownloaderError::ForbiddenPath {
            path: String::new(),
            reason: "empty_path",
        });
    }
    if raw.contains('\0') {
        return Err(DownloaderError::ForbiddenPath {
            path: raw.into_owned(),
            reason: "nul_byte_in_path",
        });
    }

    // Block all NT verbatim device namespaces except strict ASCII drive prefixes (`\\?\<A-Z>:\`),
    // plus all Win32 device (`\\.\`) and UNC/SMB (`\\server\share`, `//server/share`) prefixes.
    let is_verbatim_prefix = raw.starts_with(r"\\?\") || raw.starts_with("//?/");
    if is_verbatim_prefix && !is_valid_verbatim_drive_prefix(&raw) {
        return Err(DownloaderError::ForbiddenPath {
            path: raw.into_owned(),
            reason: "nt_device_or_unc_verbatim_namespace_blocked",
        });
    }
    if raw.starts_with(r"\\.\")
        || raw.starts_with("//./")
        || (!is_verbatim_prefix && (raw.starts_with(r"\\") || raw.starts_with("//")))
    {
        return Err(DownloaderError::ForbiddenPath {
            path: raw.into_owned(),
            reason: "unc_smb_or_device_path_blocked",
        });
    }

    let clean = strip_verbatim_drive_prefix(target_path);

    // Reject parent traversal segments in unnormalized paths.
    for comp in clean.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err(DownloaderError::ForbiddenPath {
                path: raw.into_owned(),
                reason: "parent_traversal_blocked",
            });
        }
    }

    let candidate_abs = if clean.is_absolute() {
        clean.clone()
    } else {
        std::env::current_dir()?.join(&clean)
    };

    // Walk EVERY existing ancestor all the way to filesystem root to catch intermediate
    // junctions/symlinks (e.g., `D:\junction_to_workspace\existing_subdir\out.part`)!
    let mut probe = candidate_abs.clone();
    let mut deepest_existing: Option<PathBuf> = None;
    loop {
        match fs::symlink_metadata(&probe) {
            Ok(meta) => {
                if is_reparse_point_metadata(&meta) {
                    return Err(DownloaderError::ForbiddenPath {
                        path: probe.display().to_string(),
                        reason: "reparse_point_detected",
                    });
                }
                if deepest_existing.is_none() {
                    deepest_existing = Some(probe.clone());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(DownloaderError::Io(err)),
        }
        if !probe.pop() {
            break;
        }
    }

    // Enforce external staging containment outside `workspace_root` (DOD-06),
    // canonicalizing the deepest existing ancestor to defeat 8.3 short paths & hidden links.
    if let Some(root) = workspace_root {
        let canonical_root = resolve_workspace_root(root)
            .map_err(|e| DownloaderError::RangePolicy(RangeDownloadError::WorkspacePath(e)))?;
        let resolved_candidate = match deepest_existing {
            Some(existing) => {
                let canon_existing = strip_verbatim_drive_prefix(&fs::canonicalize(&existing)?);
                match candidate_abs.strip_prefix(&existing) {
                    Ok(tail) if !tail.as_os_str().is_empty() => canon_existing.join(tail),
                    _ => canon_existing,
                }
            }
            None => candidate_abs,
        };
        let norm_root = normalize_cmp_path(&canonical_root);
        let norm_cand = normalize_cmp_path(&resolved_candidate);
        if norm_cand == norm_root || norm_cand.starts_with(&format!("{norm_root}/")) {
            return Err(DownloaderError::ForbiddenPath {
                path: resolved_candidate.display().to_string(),
                reason: "staging_path_inside_workspace_root",
            });
        }
    }

    Ok(clean)
}

fn normalize_cmp_path(path: &Path) -> String {
    let stripped = strip_verbatim_drive_prefix(path);
    let s = stripped.to_string_lossy().replace('\\', "/");
    let trimmed = s.trim_end_matches('/');
    #[cfg(windows)]
    {
        trimmed.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

/// Sanitizes a filename using `omnia-connector-gateway`'s Win32/POSIX sanitizer.
pub fn safe_output_filename(raw_name: &str) -> Result<String, DownloaderError> {
    sanitize_download_filename(raw_name).map_err(Into::into)
}

/// Inclusive byte-range chunk state tracked during multi-stream downloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRange {
    pub chunk_id: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub is_completed: bool,
}

impl ChunkRange {
    /// Creates a new unstarted inclusive byte range `[start, end]`.
    #[must_use]
    pub const fn new(chunk_id: usize, start: u64, end: u64) -> Self {
        Self {
            chunk_id,
            start,
            end,
            downloaded: 0,
            is_completed: false,
        }
    }

    /// Inclusive byte length (`end - start + 1`).
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }

    /// Always `false` for valid inclusive ranges.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        false
    }

    /// Number of bytes remaining to download in this chunk (`remainingForThisChunk`).
    #[must_use]
    pub const fn remaining(&self) -> u64 {
        if self.is_completed {
            0
        } else {
            self.len().saturating_sub(self.downloaded)
        }
    }

    /// Current file write offset (`start + downloaded`).
    #[must_use]
    pub const fn current_offset(&self) -> u64 {
        self.start.saturating_add(self.downloaded)
    }

    /// Returns `true` when this chunk has at least `2 * min_split_bytes` remaining.
    #[must_use]
    pub const fn can_split(&self, min_split_bytes: u64) -> bool {
        let min_req = min_split_bytes.saturating_mul(2);
        min_split_bytes > 0 && !self.is_completed && self.remaining() >= min_req
    }

    /// Formats the RFC 9110 `Range` header for the uncompleted tail of this chunk.
    #[must_use]
    pub fn remaining_range_header(&self) -> String {
        format!("bytes={}-{}", self.current_offset(), self.end)
    }
}

/// Lifecycle state of a download job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    Probing,
    Downloading,
    Paused,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    BlockedPolicy,
    AwaitingManualHandoff,
}

impl DownloadStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Paused => "paused",
            Self::Verifying => "verifying",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::BlockedPolicy => "blocked_policy",
            Self::AwaitingManualHandoff => "awaiting_manual_handoff",
        }
    }

    #[must_use]
    pub fn from_db_str(s: &str) -> Self {
        match s {
            "queued" => Self::Queued,
            "probing" => Self::Probing,
            "downloading" => Self::Downloading,
            "paused" => Self::Paused,
            "verifying" => Self::Verifying,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "blocked_policy" => Self::BlockedPolicy,
            "awaiting_manual_handoff" => Self::AwaitingManualHandoff,
            _ => Self::Failed,
        }
    }
}

/// Server probe metadata gathered prior to multi-stream transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeInfo {
    /// Secret-redacted URL safe for receipts.
    pub sanitized_url: String,
    /// Total content length when known (`0` if unknown/chunked).
    pub total_size: u64,
    /// True when the server advertises `Accept-Ranges: bytes` or answered `206`.
    pub supports_ranges: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub validator_strength: HttpValidatorStrength,
    pub suggested_filename: String,
    pub content_type: Option<String>,
    /// Optional expected CRC32C (base64) extracted from `X-Goog-Hash`.
    pub goog_crc32c_b64: Option<String>,
    /// Optional expected MD5 (base64) extracted from `X-Goog-Hash`.
    pub goog_md5_b64: Option<String>,
}

/// Engine-level configuration defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadConfig {
    pub default_streams: usize,
    pub min_split_bytes: u64,
    pub user_agent: String,
    pub timeout_secs: u64,
    pub pacing_mode: PacingMode,
    pub speed_limit_bps: Option<u64>,
    pub polite_segment_delay_ms: u64,
    pub max_retries: u32,
    pub no_proxy: bool,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            default_streams: 16,
            min_split_bytes: DEFAULT_MIN_SPLIT_BYTES,
            user_agent: "OmniaDownloader/3.0 (NativeRust)".to_string(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            pacing_mode: PacingMode::Adaptive,
            speed_limit_bps: None,
            polite_segment_delay_ms: 250,
            max_retries: 3,
            no_proxy: false,
        }
    }
}

/// Public download request submitted to [`crate::DownloadManager`] or [`crate::DownloadEngine`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    /// Target HTTP(S) URL.
    pub url: String,
    /// External destination directory (must not be UNC/SMB or inside `workspace_root`).
    pub staging_dir: PathBuf,
    /// Optional workspace root to enforce `DOD-06` external staging containment.
    pub workspace_root: Option<PathBuf>,
    /// Optional explicit output filename (sanitized via Win32/POSIX rules).
    pub filename: Option<String>,
    /// Requested parallel streams (`1..=128`; overridden to `1` in `Polite`/`LinearRateGuarded`).
    pub streams: Option<usize>,
    /// Minimum chunk split size in bytes for midpoint work-stealing.
    pub min_split_bytes: Option<u64>,
    /// Pacing mode (`turbo`, `adaptive`, `polite`, `linear_rate_guarded`).
    pub pacing_mode: Option<PacingMode>,
    /// Optional per-job bandwidth cap in bytes/second.
    pub speed_limit_bps: Option<u64>,
    /// Optional extra HTTP request headers (never persisted to receipts/SQLite).
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Optional expected lowercase/uppercase 64-hex SHA-256 checksum.
    pub expected_sha256: Option<String>,
    /// Optional expected base64 CRC32C checksum (`X-Goog-Hash` format).
    pub expected_crc32c_b64: Option<String>,
    /// Whether to resume from `.part.meta` v2 / `OMNF` journal if validators match.
    #[serde(default = "default_true")]
    pub resume: bool,
}

const fn default_true() -> bool {
    true
}

impl DownloadRequest {
    /// Creates a new download request targeting `url` into `staging_dir`.
    #[must_use]
    pub fn new(url: impl Into<String>, staging_dir: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            staging_dir: staging_dir.into(),
            workspace_root: None,
            filename: None,
            streams: None,
            min_split_bytes: None,
            pacing_mode: None,
            speed_limit_bps: None,
            headers: BTreeMap::new(),
            expected_sha256: None,
            expected_crc32c_b64: None,
            resume: true,
        }
    }
}

/// Real-time progress event emitted over `tokio::sync::broadcast` for Studio SSE / CLI UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub job_id: String,
    pub status: DownloadStatus,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub active_streams: usize,
    pub eta_secs: Option<u64>,
    pub completed_ranges: Vec<(u64, u64)>,
    pub fallback_to_single_stream: bool,
    pub error_code: Option<String>,
    pub timestamp_ms: u64,
}

/// Persistent / API-ready snapshot of a download job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadJobSnapshot {
    pub job_id: String,
    pub sanitized_url: String,
    pub provider_id: String,
    pub destination_path: PathBuf,
    pub part_path: PathBuf,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub status: DownloadStatus,
    pub pacing_mode: PacingMode,
    pub streams: usize,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub validator_strength: HttpValidatorStrength,
    pub sha256_expected: Option<String>,
    pub sha256_actual: Option<String>,
    pub crc32c_expected: Option<String>,
    pub crc32c_actual: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub drm_supported: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Receipt returned after a completed and verified download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletedDownload {
    pub job_id: String,
    pub output_path: PathBuf,
    pub sanitized_url: String,
    pub total_bytes: u64,
    pub sha256_hex: String,
    pub crc32c_b64: String,
    pub streams_used: usize,
    pub resumed_bytes: u64,
    pub fallback_to_single_stream: bool,
    pub drm_supported: bool,
}
