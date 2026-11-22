//! Security limits, compliance guards, preview headers, zero-retry `429 AUTH_CHALLENGE_REQUIRED`
//! circuit breaker, and `VisibleHandoffManager` (`MANUAL_VISIBLE_BROWSER_ONLY`).
//!
//! Non-negotiable compliance invariants:
//! - Zero automated CAPTCHA/Turnstile/hCaptcha/reCAPTCHA/Altcha solvers.
//! - Zero browser cookie database scanning or Chrome profile cloning.
//! - Zero DRM decryption or anti-devtools bypasses.
//! - Strict `X-Content-Type-Options: nosniff` + forced `attachment` disposition for HTML/SVG.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use omnia_connector_gateway::{
    artifact_intake::sanitize_download_filename, sanitize_and_inspect_url, UrlInspectionPolicy,
};
use omnia_core::{now_epoch_ms, SecretRedactor};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::NotebookError;

/// Maximum permitted XML document payload size before parsing (128 MiB).
pub const MAX_XML_BYTES: usize = 128 * 1024 * 1024;
/// Maximum permitted nested archive recursion depth.
pub const MAX_ARCHIVE_DEPTH: usize = 5;
/// Maximum permitted archive entry count (aligned with `artifact_intake`).
pub const MAX_ARCHIVE_ENTRIES: usize = 1_000;
/// Maximum permitted uncompressed/compressed expansion ratio (zip-bomb guard).
pub const MAX_EXPANSION_RATIO: f64 = 100.0;
/// Maximum permitted total decompressed bytes across an archive extraction pass (128 MiB).
pub const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
/// Maximum semantic chunk size in bytes (`<= 120 KiB`).
pub const MAX_CHUNK_BYTES: usize = 120 * 1024;
/// Maximum copied-text fallback slice size in bytes (`<= 40 KiB`).
pub const MAX_COPIED_TEXT_BYTES: usize = 40 * 1024;
/// Maximum binary hex preview window in bytes (`4 KiB`).
pub const MAX_BINARY_PREVIEW_BYTES: usize = 4 * 1024;
/// Maximum Java `.class` entries previewed inside a `.jar` archive.
pub const MAX_JAR_PREVIEW_CLASSES: usize = 60;
/// Default maximum source count per notebook when `allow_overflow_notebook == false`.
pub const DEFAULT_MAX_SOURCES_PER_NOTEBOOK: usize = 50;

/// Canonical HTTP status emitted when an upstream auth/CAPTCHA challenge trips the breaker.
pub const AUTH_CHALLENGE_HTTP_STATUS: u16 = 429;
/// Canonical machine error code emitted when an upstream auth/CAPTCHA challenge trips the breaker.
pub const AUTH_CHALLENGE_CODE: &str = "AUTH_CHALLENGE_REQUIRED";
/// Canonical visible-browser handoff execution mode.
pub const MANUAL_VISIBLE_BROWSER_ONLY: &str = "MANUAL_VISIBLE_BROWSER_ONLY";

/// Canonical `artifact_intake` allowlisted notebook document/media extensions (15 core formats).
pub const ARTIFACT_INTAKE_ALLOWED_EXTENSIONS: &[&str] = &[
    "md", "txt", "json", "csv", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "webp", "wav",
    "mp3", "html",
];

/// Extended safe textual/structured/document extensions accepted by native ingestion & preview.
pub const EXTENDED_NOTEBOOK_EXTENSIONS: &[&str] = &[
    "tsv", "xml", "ipynb", "epub", "odt", "rtf", "yaml", "yml", "toml", "svg", "htm", "xhtml",
    "mdx", "zip", "jar", "tar", "tgz", "gz", "mp4", "webm", "ogg", "m4a", "gif", "rs", "ts", "tsx",
    "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "rb",
    "php", "swift", "scala", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "graphql", "proto",
    "css", "scss", "less", "vue", "svelte", "astro", "lua", "r", "jl", "dart", "ex", "exs", "erl",
    "hs", "ml", "mli", "clj", "fs", "zig", "nim", "v", "sol", "tf", "hcl", "nix", "dockerfile",
    "makefile", "cmake", "ini", "cfg", "conf", "env", "log", "tex", "bib", "rst", "adoc", "org",
];

/// Canonical MIME allowlist corresponding to `artifact_intake` + safe preview formats.
pub const ALLOWED_NOTEBOOK_MIME_PREFIXES: &[&str] = &[
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "text/html",
    "text/xml",
    "text/x-",
    "application/json",
    "application/x-ipynb+json",
    "application/xml",
    "application/pdf",
    "application/rtf",
    "application/zip",
    "application/java-archive",
    "application/x-tar",
    "application/gzip",
    "application/epub+zip",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/octet-stream",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/mp4",
    "video/mp4",
    "video/webm",
];

/// Security headers attached to every [`crate::preview::PreviewPayload`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewSecurityHeaders {
    /// Always `"nosniff"`.
    pub x_content_type_options: String,
    /// `"inline"` for safe passive payloads, or forced `"attachment; filename=\"...\""` for HTML/SVG/binary.
    pub content_disposition: String,
    /// `true` whenever inline browser execution is forbidden (HTML, SVG, XHTML, raw binary).
    pub force_attachment: bool,
    /// Strict sandbox CSP applied to preview responses.
    pub content_security_policy: String,
}

impl PreviewSecurityHeaders {
    /// Build strict security headers for a preview response, unconditionally forcing
    /// `Content-Disposition: attachment` for HTML, XHTML, SVG, and untrusted binary payloads.
    #[must_use]
    pub fn for_format(safe_filename: &str, force_attachment: bool) -> Self {
        let escaped_name = safe_filename
            .replace(['\\', '"', '\r', '\n'], "_")
            .trim()
            .to_string();
        let display_name = if escaped_name.is_empty() {
            "preview.bin".to_string()
        } else {
            escaped_name
        };
        let content_disposition = if force_attachment {
            format!("attachment; filename=\"{display_name}\"")
        } else {
            format!("inline; filename=\"{display_name}\"")
        };
        let content_security_policy = if force_attachment {
            "default-src 'none'; sandbox".to_string()
        } else {
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'".to_string()
        };
        Self {
            x_content_type_options: "nosniff".to_string(),
            content_disposition,
            force_attachment,
            content_security_policy,
        }
    }
}

/// Lifecycle state of a manual visible-browser handoff ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisibleHandoffStatus {
    PendingUserAction,
    CompletedByUser,
    Cancelled,
}

/// Auditable manual visible-browser handoff ticket (`MANUAL_VISIBLE_BROWSER_ONLY`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisibleHandoffTicket {
    pub ticket_id: String,
    /// Always `"MANUAL_VISIBLE_BROWSER_ONLY"`.
    pub execution_mode: String,
    /// Always `false` — automated solving or credential scraping is strictly forbidden.
    pub auto_solve_permitted: bool,
    /// Always `true` — indicates an interactive human gate was encountered.
    pub challenge_required: bool,
    /// Redacted origin/URL safe for UI display (never carries cookies, userinfo, or signed query tokens).
    pub sanitized_target: String,
    pub reason: String,
    pub status: VisibleHandoffStatus,
    pub created_at_ms: i64,
    pub resolved_at_ms: Option<i64>,
}

/// Manages manual visible-browser handoffs (`MANUAL_VISIBLE_BROWSER_ONLY`) with zero credential scraping.
#[derive(Debug, Default)]
pub struct VisibleHandoffManager {
    tickets: Mutex<BTreeMap<String, VisibleHandoffTicket>>,
}

impl VisibleHandoffManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a sanitized visible-browser handoff ticket requiring interactive user action.
    #[must_use]
    pub fn create_ticket(&self, raw_target: &str, reason: &str) -> VisibleHandoffTicket {
        let sanitized_target = sanitize_target_for_handoff(raw_target);
        let safe_reason = SecretRedactor::redact(reason);
        let ticket = VisibleHandoffTicket {
            ticket_id: format!("handoff_{}", Uuid::new_v4().simple()),
            execution_mode: MANUAL_VISIBLE_BROWSER_ONLY.to_string(),
            auto_solve_permitted: false,
            challenge_required: true,
            sanitized_target,
            reason: safe_reason,
            status: VisibleHandoffStatus::PendingUserAction,
            created_at_ms: now_epoch_ms(),
            resolved_at_ms: None,
        };
        self.tickets
            .lock()
            .insert(ticket.ticket_id.clone(), ticket.clone());
        ticket
    }

    /// Mark an existing ticket completed by the user in a visible browser window.
    pub fn mark_completed(&self, ticket_id: &str) -> Result<VisibleHandoffTicket, NotebookError> {
        let mut guard = self.tickets.lock();
        let ticket = guard.get_mut(ticket_id).ok_or_else(|| NotebookError::NotFound {
            entity: "handoff_ticket",
            id: ticket_id.to_string(),
        })?;
        ticket.status = VisibleHandoffStatus::CompletedByUser;
        ticket.resolved_at_ms = Some(now_epoch_ms());
        Ok(ticket.clone())
    }

    /// Cancel an existing pending handoff ticket.
    pub fn cancel(&self, ticket_id: &str) -> Result<VisibleHandoffTicket, NotebookError> {
        let mut guard = self.tickets.lock();
        let ticket = guard.get_mut(ticket_id).ok_or_else(|| NotebookError::NotFound {
            entity: "handoff_ticket",
            id: ticket_id.to_string(),
        })?;
        ticket.status = VisibleHandoffStatus::Cancelled;
        ticket.resolved_at_ms = Some(now_epoch_ms());
        Ok(ticket.clone())
    }

    /// Fetch a ticket by ID.
    #[must_use]
    pub fn get(&self, ticket_id: &str) -> Option<VisibleHandoffTicket> {
        self.tickets.lock().get(ticket_id).cloned()
    }

    /// List all pending tickets awaiting interactive human completion.
    #[must_use]
    pub fn list_pending(&self) -> Vec<VisibleHandoffTicket> {
        self.tickets
            .lock()
            .values()
            .filter(|t| t.status == VisibleHandoffStatus::PendingUserAction)
            .cloned()
            .collect()
    }
}

fn sanitize_target_for_handoff(raw_target: &str) -> String {
    let policy = UrlInspectionPolicy {
        strict_tls: false,
        allow_loopback_http: true,
        allow_private_endpoints: true,
        allow_non_loopback: true,
        redact_signed_params: true,
        allow_socks_schemes: false,
    };
    if let Ok(info) = sanitize_and_inspect_url(raw_target, &policy) {
        return info.origin;
    }
    SecretRedactor::redact(raw_target)
}

/// Circuit state for the `429 AUTH_CHALLENGE_REQUIRED` fail-closed zero-retry breaker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthCircuitState {
    Closed,
    Tripped,
}

/// Snapshot of the `AuthChallengeCircuitBreaker` for status/telemetry endpoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthCircuitSnapshot {
    pub state: AuthCircuitState,
    pub retries_attempted: u64,
    pub trip_count: u64,
    pub last_reason: Option<String>,
    pub active_ticket_id: Option<String>,
    pub tripped_at_ms: Option<i64>,
}

#[derive(Debug)]
struct AuthCircuitInner {
    state: AuthCircuitState,
    trip_count: u64,
    last_reason: Option<String>,
    active_ticket: Option<VisibleHandoffTicket>,
    tripped_at_ms: Option<i64>,
}

/// Zero-retry fail-closed circuit breaker for upstream `429 AUTH_CHALLENGE_REQUIRED`,
/// `google.com/sorry`, CAPTCHA, and sign-in gates.
#[derive(Debug)]
pub struct AuthChallengeCircuitBreaker {
    inner: Mutex<AuthCircuitInner>,
    /// Tracks automatic retries performed on challenge gates (strictly invariant `== 0`).
    retries_attempted: AtomicU64,
}

impl Default for AuthChallengeCircuitBreaker {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthChallengeCircuitBreaker {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AuthCircuitInner {
                state: AuthCircuitState::Closed,
                trip_count: 0,
                last_reason: None,
                active_ticket: None,
                tripped_at_ms: None,
            }),
            retries_attempted: AtomicU64::new(0),
        }
    }

    /// Check whether an outbound request is permitted. If tripped, fails closed immediately
    /// with `429 AUTH_CHALLENGE_REQUIRED` without issuing any network call or retry.
    pub fn check_allowed(&self) -> Result<(), NotebookError> {
        let guard = self.inner.lock();
        if guard.state == AuthCircuitState::Tripped {
            let ticket = guard.active_ticket.clone().unwrap_or_else(|| VisibleHandoffTicket {
                ticket_id: "handoff_unknown".to_string(),
                execution_mode: MANUAL_VISIBLE_BROWSER_ONLY.to_string(),
                auto_solve_permitted: false,
                challenge_required: true,
                sanitized_target: "https://share.gemini.google".to_string(),
                reason: "Circuit breaker tripped on prior authentication/CAPTCHA challenge"
                    .to_string(),
                status: VisibleHandoffStatus::PendingUserAction,
                created_at_ms: now_epoch_ms(),
                resolved_at_ms: None,
            });
            return Err(NotebookError::AuthChallengeRequired {
                status: AUTH_CHALLENGE_HTTP_STATUS,
                code: AUTH_CHALLENGE_CODE,
                detail: guard
                    .last_reason
                    .clone()
                    .unwrap_or_else(|| "Circuit breaker tripped; manual visible-browser handoff required".to_string()),
                handoff: Box::new(ticket),
            });
        }
        Ok(())
    }

    /// Trip the circuit breaker immediately on an auth/CAPTCHA/429 challenge (zero retries)
    /// and register a [`VisibleHandoffTicket`] (`MANUAL_VISIBLE_BROWSER_ONLY`).
    pub fn trip(
        &self,
        handoff_manager: &VisibleHandoffManager,
        target: &str,
        reason: &str,
    ) -> NotebookError {
        let ticket = handoff_manager.create_ticket(target, reason);
        let safe_reason = SecretRedactor::redact(reason);
        {
            let mut guard = self.inner.lock();
            guard.state = AuthCircuitState::Tripped;
            guard.trip_count = guard.trip_count.saturating_add(1);
            guard.last_reason = Some(safe_reason.clone());
            guard.active_ticket = Some(ticket.clone());
            guard.tripped_at_ms = Some(now_epoch_ms());
        }
        NotebookError::AuthChallengeRequired {
            status: AUTH_CHALLENGE_HTTP_STATUS,
            code: AUTH_CHALLENGE_CODE,
            detail: safe_reason,
            handoff: Box::new(ticket),
        }
    }

    /// Reset the circuit breaker ONLY after the active [`VisibleHandoffTicket`] has been
    /// explicitly marked completed by the user.
    pub fn reset_after_handoff(
        &self,
        handoff_manager: &VisibleHandoffManager,
        ticket_id: &str,
    ) -> Result<AuthCircuitSnapshot, NotebookError> {
        let ticket = handoff_manager.get(ticket_id).ok_or_else(|| NotebookError::NotFound {
            entity: "handoff_ticket",
            id: ticket_id.to_string(),
        })?;
        if ticket.status != VisibleHandoffStatus::CompletedByUser {
            return Err(NotebookError::PolicyBlocked {
                code: "HANDOFF_NOT_COMPLETED",
                reason: format!(
                    "handoff ticket '{ticket_id}' must be completed by the user before resetting the circuit breaker"
                ),
            });
        }
        let mut guard = self.inner.lock();
        if let Some(active) = &guard.active_ticket {
            if active.ticket_id != ticket_id {
                return Err(NotebookError::InvalidInput(format!(
                    "ticket '{ticket_id}' does not match active tripped ticket '{}'",
                    active.ticket_id
                )));
            }
        }
        guard.state = AuthCircuitState::Closed;
        guard.active_ticket = None;
        guard.last_reason = None;
        guard.tripped_at_ms = None;
        Ok(AuthCircuitSnapshot {
            state: guard.state.clone(),
            retries_attempted: self.retries_attempted.load(Ordering::Relaxed),
            trip_count: guard.trip_count,
            last_reason: None,
            active_ticket_id: None,
            tripped_at_ms: None,
        })
    }

    /// Return current breaker telemetry snapshot.
    #[must_use]
    pub fn snapshot(&self) -> AuthCircuitSnapshot {
        let guard = self.inner.lock();
        AuthCircuitSnapshot {
            state: guard.state.clone(),
            retries_attempted: self.retries_attempted.load(Ordering::Relaxed),
            trip_count: guard.trip_count,
            last_reason: guard.last_reason.clone(),
            active_ticket_id: guard.active_ticket.as_ref().map(|t| t.ticket_id.clone()),
            tripped_at_ms: guard.tripped_at_ms,
        }
    }
}

/// Validate XML payload size (`<= 128 MiB`) and reject XXE (`<!DOCTYPE`, `<!ENTITY`) declarations.
pub fn validate_xml_safety(bytes: &[u8], context: &str) -> Result<(), NotebookError> {
    validate_xml_safety_with_limit(bytes, MAX_XML_BYTES, context)
}

/// Validate XML payload size against an explicit byte limit (`<= MAX_XML_BYTES`) and reject XXE declarations.
pub fn validate_xml_safety_with_limit(
    bytes: &[u8],
    max_bytes: usize,
    context: &str,
) -> Result<(), NotebookError> {
    let effective_limit = max_bytes.min(MAX_XML_BYTES);
    if bytes.len() > effective_limit {
        return Err(NotebookError::SecurityRejected {
            code: "XML_SIZE_LIMIT_EXCEEDED",
            reason: format!(
                "XML payload '{context}' is {} bytes, exceeding limit ({effective_limit} bytes; max 128 MiB)",
                bytes.len()
            ),
        });
    }

    // Decode UTF-8 lossily and also inspect stripped NUL bytes to catch UTF-16 obfuscated DOCTYPE/ENTITY.
    let direct_upper = String::from_utf8_lossy(bytes).to_ascii_uppercase();
    if contains_xxe_marker(&direct_upper) {
        return Err(NotebookError::SecurityRejected {
            code: "XXE_REJECTED",
            reason: format!(
                "XML payload '{context}' contains forbidden <!DOCTYPE or <!ENTITY declaration"
            ),
        });
    }

    if bytes.contains(&0) {
        let ascii_filtered: String = bytes
            .iter()
            .copied()
            .filter(|b| *b != 0)
            .map(|b| (b as char).to_ascii_uppercase())
            .collect();
        if contains_xxe_marker(&ascii_filtered) {
            return Err(NotebookError::SecurityRejected {
                code: "XXE_REJECTED",
                reason: format!(
                    "XML payload '{context}' contains UTF-16/NUL-padded <!DOCTYPE or <!ENTITY declaration"
                ),
            });
        }
    }

    Ok(())
}

fn contains_xxe_marker(upper: &str) -> bool {
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return true;
    }
    // Also catch whitespace between `<!` and `DOCTYPE`/`ENTITY` (e.g. `<!  ENTITY`).
    let mut rest = upper;
    while let Some(idx) = rest.find("<!") {
        let after = rest[idx + 2..].trim_start();
        if after.starts_with("DOCTYPE") || after.starts_with("ENTITY") {
            return true;
        }
        rest = &rest[idx + 2..];
    }
    false
}

/// Enforce archive recursion depth (`<= 5`), entry count (`<= 1000`), total decompressed size,
/// and expansion ratio (`<= 100x`).
pub fn validate_archive_limits(
    entry_count: usize,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    depth: usize,
    context: &str,
) -> Result<(), NotebookError> {
    if depth > MAX_ARCHIVE_DEPTH {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_DEPTH_EXCEEDED",
            reason: format!(
                "archive '{context}' nesting depth {depth} exceeds maximum {MAX_ARCHIVE_DEPTH}"
            ),
        });
    }
    if entry_count > MAX_ARCHIVE_ENTRIES {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
            reason: format!(
                "archive '{context}' entry count {entry_count} exceeds maximum {MAX_ARCHIVE_ENTRIES}"
            ),
        });
    }
    if uncompressed_bytes > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_UNCOMPRESSED_CAP_EXCEEDED",
            reason: format!(
                "archive '{context}' uncompressed size {uncompressed_bytes} exceeds 128 MiB cap"
            ),
        });
    }
    let effective_compressed = compressed_bytes.max(1) as f64;
    let ratio = (uncompressed_bytes as f64) / effective_compressed;
    if uncompressed_bytes > 0 && ratio > MAX_EXPANSION_RATIO {
        return Err(NotebookError::SecurityRejected {
            code: "ZIP_BOMB_RATIO_EXCEEDED",
            reason: format!(
                "archive '{context}' expansion ratio {ratio:.2}x exceeds maximum {MAX_EXPANSION_RATIO:.0}x"
            ),
        });
    }
    Ok(())
}

/// Reject zip-slip traversal paths (`..`, absolute paths, Windows drive letters, control chars).
pub fn validate_archive_entry_path(entry_name: &str) -> Result<String, NotebookError> {
    if entry_name.is_empty()
        || entry_name.bytes().any(|b| b <= 0x1F || b == 0x7F)
        || entry_name.starts_with('/')
        || entry_name.starts_with('\\')
    {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_PATH_TRAVERSAL",
            reason: format!("unsafe archive entry path '{entry_name}'"),
        });
    }
    let normalized = entry_name.replace('\\', "/");
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_PATH_TRAVERSAL",
            reason: format!("drive-qualified archive entry path '{entry_name}' rejected"),
        });
    }
    for segment in normalized.split('/') {
        if segment == ".." {
            return Err(NotebookError::SecurityRejected {
                code: "ARCHIVE_PATH_TRAVERSAL",
                reason: format!("parent traversal in archive entry '{entry_name}' rejected"),
            });
        }
    }
    Ok(normalized)
}

/// Validate filename & MIME against `artifact_intake` allowlist rules.
///
/// When `strict_artifact_intake_only == true`, only the 15 canonical `artifact_intake`
/// extensions are permitted; otherwise extended safe document/code/preview extensions are also
/// allowed while dangerous executable/script-bundle types (`exe`, `dll`, `msi`, `scr`, `lnk`,
/// `vbs`, `hta`, `com`, `pif`, `reg`) are always rejected.
pub fn validate_filename_and_mime(
    raw_filename: &str,
    mime_type: Option<&str>,
    strict_artifact_intake_only: bool,
) -> Result<(String, String), NotebookError> {
    let safe_name = sanitize_download_filename(raw_filename)?;
    let ext = extract_extension_lower(&safe_name);

    const BLOCKED_EXECUTABLE_EXTS: &[&str] = &[
        "exe", "dll", "sys", "msi", "msp", "scr", "com", "pif", "lnk", "vbs", "vbe", "hta", "reg",
        "cpl", "ocx", "drv", "inf", "apk", "dmg", "pkg", "deb", "rpm",
    ];
    if BLOCKED_EXECUTABLE_EXTS.contains(&ext.as_str()) {
        return Err(NotebookError::SecurityRejected {
            code: "DISALLOWED_EXTENSION",
            reason: format!("executable/installer extension '.{ext}' is strictly blocked"),
        });
    }

    if strict_artifact_intake_only {
        if !ARTIFACT_INTAKE_ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(NotebookError::SecurityRejected {
                code: "DISALLOWED_NOTEBOOK_EXTENSION",
                reason: format!(
                    "extension '.{ext}' is outside the canonical artifact_intake allowlist"
                ),
            });
        }
    } else if !ext.is_empty()
        && !ARTIFACT_INTAKE_ALLOWED_EXTENSIONS.contains(&ext.as_str())
        && !EXTENDED_NOTEBOOK_EXTENSIONS.contains(&ext.as_str())
    {
        return Err(NotebookError::SecurityRejected {
            code: "DISALLOWED_MIME_OR_EXTENSION",
            reason: format!("extension '.{ext}' is not allowlisted for notebook ingestion"),
        });
    }

    let resolved_mime = match mime_type.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            let base = m
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let allowed = ALLOWED_NOTEBOOK_MIME_PREFIXES
                .iter()
                .any(|prefix| base == *prefix || (prefix.ends_with('-') && base.starts_with(prefix)));
            if !allowed {
                return Err(NotebookError::SecurityRejected {
                    code: "DISALLOWED_MIME_TYPE",
                    reason: format!("MIME type '{base}' is not on the notebook allowlist"),
                });
            }
            base
        }
        None => infer_mime_from_extension(&ext).to_string(),
    };

    Ok((safe_name, resolved_mime))
}

/// Extract lowercase file extension (or special extensionless filename like `dockerfile`/`makefile`).
#[must_use]
pub fn extract_extension_lower(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let low = base.to_ascii_lowercase();
    if low == "dockerfile" || low == "makefile" || low == "cmakelists.txt" {
        return if low == "cmakelists.txt" {
            "cmake".to_string()
        } else {
            low
        };
    }
    if low.ends_with(".tar.gz") {
        return "tgz".to_string();
    }
    base.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Infer canonical MIME type from lowercase file extension.
#[must_use]
pub fn infer_mime_from_extension(ext: &str) -> &'static str {
    match ext {
        "md" | "mdx" | "markdown" => "text/markdown",
        "txt" | "log" | "rst" | "adoc" | "org" | "tex" | "bib" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" | "htm" | "xhtml" => "text/html",
        "svg" => "image/svg+xml",
        "xml" => "application/xml",
        "json" => "application/json",
        "ipynb" => "application/x-ipynb+json",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub" => "application/epub+zip",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        "zip" => "application/zip",
        "jar" => "application/java-archive",
        "tar" => "application/x-tar",
        "tgz" | "gz" => "application/gzip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "text/plain",
    }
}

/// Returns `true` when the given extension or MIME type represents active web markup (HTML/SVG)
/// that MUST be served with forced `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.
#[must_use]
pub fn requires_forced_attachment(ext: &str, mime_type: &str) -> bool {
    let m = mime_type.to_ascii_lowercase();
    matches!(ext, "html" | "htm" | "xhtml" | "svg")
        || m.starts_with("text/html")
        || m.starts_with("application/xhtml")
        || m.starts_with("image/svg")
}
