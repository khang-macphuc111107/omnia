//! Canonical artifact intake manifest normalizers for Gemini Notebook bundles and
//! Google Drive Downloader manifests, enforcing SHA-256 verification, duplicate
//! detection, archive/filename/range safety, and mandatory stripping/redaction of
//! `access_bearing_url`, signed URLs, cookies, and personal identifiers (PII).

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::{
    detect_json_secrets, find_unsafe_prototype_key, has_bidi_controls, has_control_chars,
    impl_str_enum_serde, is_access_bearing_url_key, is_pii_key_name, is_private_disk_path_key,
    is_sensitive_key_name, normalize_sha256_hex, redact_emails, redact_json_value,
    redact_private_disk_paths, redact_secrets_in_text, sanitize_and_inspect_url,
    sanitize_url_origin, sha256_hex, strip_bidi_controls, UrlInspectionPolicy, REDACTED_EMAIL,
    REDACTED_SECRET, REDACTED_URL, REDACTED_USER_PROFILE,
};

const MAX_ARCHIVE_ENTRIES: usize = 1_000;
const MAX_EXPANSION_RATIO: f64 = 100.0;
const ALLOWED_NOTEBOOK_EXTENSIONS: &[&str] = &[
    "md", "txt", "json", "csv", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "webp", "wav",
    "mp3", "html",
];
const WIN_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Errors emitted by canonical artifact intake normalizers.
#[derive(Debug, Error)]
pub enum ArtifactIntakeError {
    #[error("unsafe prototype key at '{0}'")]
    UnsafePrototypeKey(String),
    #[error("invalid intake manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid memory namespace '{0}'")]
    InvalidNamespace(String),
    #[error("ERR_CHECKSUM_MISMATCH for '{artifact_id}': expected {expected}, actual {actual}")]
    ChecksumMismatch {
        artifact_id: String,
        expected: String,
        actual: String,
    },
    #[error(
        "ERR_DUPLICATE_ID_HASH_CONFLICT for '{artifact_id}': {first_sha256} != {second_sha256}"
    )]
    DuplicateIdHashConflict {
        artifact_id: String,
        first_sha256: String,
        second_sha256: String,
    },
    #[error("security policy rejected artifact '{artifact_id}': {reason}")]
    SecurityRejected { artifact_id: String, reason: String },
    #[error("DRM or anti-bot/CAPTCHA gate cannot be bypassed for '{artifact_id}': {reason}")]
    PolicyBlocked { artifact_id: String, reason: String },
    #[error("invalid byte-range coverage for '{artifact_id}': {detail}")]
    InvalidByteRanges { artifact_id: String, detail: String },
}

/// Supported intake connector source families.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IntakeSourceKind {
    GeminiNotebook,
    GoogleDriveDownloader,
}

impl IntakeSourceKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GeminiNotebook => "gemini_notebook",
            Self::GoogleDriveDownloader => "google_drive_downloader",
        }
    }
}

impl FromStr for IntakeSourceKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "gemini_notebook" | "notebook" | "notebooklm" => Ok(Self::GeminiNotebook),
            "google_drive_downloader" | "gdrive" | "google_drive" => {
                Ok(Self::GoogleDriveDownloader)
            }
            other => Err(format!("unknown intake source kind '{other}'")),
        }
    }
}

impl_str_enum_serde!(IntakeSourceKind);

/// Execution mode constraint for Google Drive / visible-browser downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DownloadExecutionMode {
    ManualVisibleBrowserOnly,
    LocalStagedManifest,
    ApiExport,
}

impl DownloadExecutionMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManualVisibleBrowserOnly => "MANUAL_VISIBLE_BROWSER_ONLY",
            Self::LocalStagedManifest => "LOCAL_STAGED_MANIFEST",
            Self::ApiExport => "API_EXPORT",
        }
    }
}

impl FromStr for DownloadExecutionMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_uppercase().replace('-', "_").as_str() {
            "MANUAL_VISIBLE_BROWSER_ONLY" | "MANUAL" | "VISIBLE_BROWSER" => {
                Ok(Self::ManualVisibleBrowserOnly)
            }
            "LOCAL_STAGED_MANIFEST" | "LOCAL" => Ok(Self::LocalStagedManifest),
            "API_EXPORT" | "API" => Ok(Self::ApiExport),
            other => Err(format!("unknown execution mode '{other}'")),
        }
    }
}

impl_str_enum_serde!(DownloadExecutionMode);

/// Strength classification for HTTP cache/resume validators (`ETag` / `Last-Modified`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HttpValidatorStrength {
    StrongEtag,
    WeakEtag,
    LastModifiedOnly,
    None,
}

impl HttpValidatorStrength {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StrongEtag => "strong_etag",
            Self::WeakEtag => "weak_etag",
            Self::LastModifiedOnly => "last_modified_only",
            Self::None => "none",
        }
    }
}

impl FromStr for HttpValidatorStrength {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "strong_etag" => Ok(Self::StrongEtag),
            "weak_etag" => Ok(Self::WeakEtag),
            "last_modified_only" => Ok(Self::LastModifiedOnly),
            "none" => Ok(Self::None),
            other => Err(format!("unknown validator strength '{other}'")),
        }
    }
}

impl_str_enum_serde!(HttpValidatorStrength);

/// Contiguous byte-range slice descriptor (`[start, end_inclusive]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRangeSegment {
    pub start: u64,
    pub end_inclusive: u64,
}

impl Serialize for ByteRangeSegment {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "start": self.start,
            "end_inclusive": self.end_inclusive,
        })
        .serialize(serializer)
    }
}

/// Normalized, secret-free canonical artifact record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalIntakeArtifact {
    pub artifact_id: String,
    pub source_kind: IntakeSourceKind,
    pub title: String,
    pub safe_filename: String,
    pub relative_path: Option<String>,
    pub sha256: String,
    pub checksum_verified: bool,
    pub is_duplicate: bool,
    pub duplicate_of: Option<String>,
    pub byte_size: Option<u64>,
    pub mime_type: Option<String>,
    pub sanitized_source_origin: Option<String>,
    pub sanitized_source_url: Option<String>,
    pub preserved_signed_params: Vec<String>,
    pub validator_strength: HttpValidatorStrength,
    pub metadata: Map<String, Value>,
    pub redacted_fields: Vec<String>,
}

impl Serialize for CanonicalIntakeArtifact {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "artifact_id": self.artifact_id,
            "source_kind": self.source_kind,
            "title": self.title,
            "safe_filename": self.safe_filename,
            "relative_path": self.relative_path,
            "sha256": self.sha256,
            "checksum_verified": self.checksum_verified,
            "is_duplicate": self.is_duplicate,
            "duplicate_of": self.duplicate_of,
            "byte_size": self.byte_size,
            "mime_type": self.mime_type,
            "sanitized_source_origin": self.sanitized_source_origin,
            "sanitized_source_url": self.sanitized_source_url,
            "preserved_signed_params": self.preserved_signed_params,
            "validator_strength": self.validator_strength,
            "metadata": self.metadata,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Cross-artifact SHA-256 duplicate group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateGroup {
    pub sha256: String,
    pub primary_artifact_id: String,
    pub duplicate_artifact_ids: Vec<String>,
}

impl Serialize for DuplicateGroup {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "sha256": self.sha256,
            "primary_artifact_id": self.primary_artifact_id,
            "duplicate_artifact_ids": self.duplicate_artifact_ids,
        })
        .serialize(serializer)
    }
}

/// Canonical, secret-free normalized intake manifest across Notebook/Drive downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalIntakeManifest {
    pub manifest_id: String,
    pub source_kind: IntakeSourceKind,
    pub memory_namespace: Option<String>,
    pub execution_mode: Option<DownloadExecutionMode>,
    pub ws_origin: Option<String>,
    pub artifacts: Vec<CanonicalIntakeArtifact>,
    pub duplicate_groups: Vec<DuplicateGroup>,
    pub stripped_access_urls: Vec<String>,
    pub redacted_fields: Vec<String>,
}

impl Serialize for CanonicalIntakeManifest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut val = json!({
            "manifest_id": self.manifest_id,
            "source_kind": self.source_kind,
            "memory_namespace": self.memory_namespace,
            "execution_mode": self.execution_mode,
            "ws_origin": self.ws_origin,
            "artifacts": self.artifacts,
            "duplicate_groups": self.duplicate_groups,
            "stripped_access_urls": self.stripped_access_urls,
            "redacted_fields": self.redacted_fields,
        });
        if !detect_json_secrets(&val).is_empty() {
            let (cleaned, _) = redact_json_value(&val);
            val = cleaned;
        }
        val.serialize(serializer)
    }
}

/// Validates memory namespace grammar: `^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`.
#[must_use]
pub fn is_valid_memory_namespace(namespace: &str) -> bool {
    let bytes = namespace.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    let last = bytes[bytes.len() - 1];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit())
        || !(last.is_ascii_lowercase() || last.is_ascii_digit())
    {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

/// Classifies HTTP cache/resume validator strength.
#[must_use]
pub fn classify_http_validator(
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> HttpValidatorStrength {
    if let Some(tag) = etag.map(str::trim).filter(|s| !s.is_empty()) {
        if tag.starts_with("W/") || tag.starts_with("w/") {
            return HttpValidatorStrength::WeakEtag;
        }
        return HttpValidatorStrength::StrongEtag;
    }
    if last_modified
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        return HttpValidatorStrength::LastModifiedOnly;
    }
    HttpValidatorStrength::None
}

/// Sanitizes an untrusted download filename for safe Win32/POSIX disk creation.
pub fn sanitize_download_filename(raw_name: &str) -> Result<String, ArtifactIntakeError> {
    let (no_bidi, _) = strip_bidi_controls(raw_name);
    let trimmed = no_bidi.trim();
    if trimmed.is_empty() || has_control_chars(trimmed) {
        return Err(ArtifactIntakeError::InvalidManifest(
            "filename is empty or contains control characters".into(),
        ));
    }
    // Strip any path directories first.
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', ' ']);
    if base.is_empty() || base == "." || base == ".." {
        return Err(ArtifactIntakeError::InvalidManifest(
            "filename resolves to empty or traversal segment".into(),
        ));
    }

    let mut sanitized = String::with_capacity(base.len());
    for ch in base.chars() {
        match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => sanitized.push('_'),
            c if c.is_control() => {}
            c => sanitized.push(c),
        }
    }
    let sanitized = sanitized.trim_matches(['.', ' ']).to_string();
    if sanitized.is_empty() {
        return Err(ArtifactIntakeError::InvalidManifest(
            "filename empty after character sanitization".into(),
        ));
    }
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if WIN_RESERVED_NAMES.contains(&stem.as_str()) {
        Ok(format!("_{sanitized}"))
    } else {
        Ok(sanitized)
    }
}

/// Verifies contiguous, non-overlapping coverage of `[0, expected_size)` for multi-part downloads.
pub fn validate_contiguous_byte_ranges(
    artifact_id: &str,
    expected_size: u64,
    ranges: &[ByteRangeSegment],
) -> Result<(), ArtifactIntakeError> {
    if expected_size == 0 {
        if ranges.is_empty()
            || (ranges.len() == 1 && ranges[0].start == 0 && ranges[0].end_inclusive == 0)
        {
            return Ok(());
        }
        return Err(ArtifactIntakeError::InvalidByteRanges {
            artifact_id: artifact_id.to_string(),
            detail: "non-empty range provided for zero-byte expected artifact".into(),
        });
    }
    if ranges.is_empty() {
        return Err(ArtifactIntakeError::InvalidByteRanges {
            artifact_id: artifact_id.to_string(),
            detail: "no byte ranges provided for non-empty artifact".into(),
        });
    }

    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|r| (r.start, r.end_inclusive));

    let mut cursor: u64 = 0;
    for seg in sorted {
        if seg.end_inclusive < seg.start {
            return Err(ArtifactIntakeError::InvalidByteRanges {
                artifact_id: artifact_id.to_string(),
                detail: format!("inverted byte range {}-{}", seg.start, seg.end_inclusive),
            });
        }
        if seg.start < cursor {
            return Err(ArtifactIntakeError::InvalidByteRanges {
                artifact_id: artifact_id.to_string(),
                detail: format!(
                    "overlapping byte range starting at {} < {cursor}",
                    seg.start
                ),
            });
        }
        if seg.start > cursor {
            return Err(ArtifactIntakeError::InvalidByteRanges {
                artifact_id: artifact_id.to_string(),
                detail: format!(
                    "gap before byte range starting at {} (expected {cursor})",
                    seg.start
                ),
            });
        }
        cursor = seg.end_inclusive.saturating_add(1);
    }

    if cursor != expected_size {
        return Err(ArtifactIntakeError::InvalidByteRanges {
            artifact_id: artifact_id.to_string(),
            detail: format!("coverage ended at {cursor} bytes, expected {expected_size}"),
        });
    }
    Ok(())
}

/// Normalizes and validates either a Gemini Notebook or Google Drive Downloader intake manifest.
pub fn normalize_canonical_artifact_intake(
    raw: &Value,
) -> Result<CanonicalIntakeManifest, ArtifactIntakeError> {
    if let Some(proto) = find_unsafe_prototype_key(raw, "$") {
        return Err(ArtifactIntakeError::UnsafePrototypeKey(proto));
    }
    let obj = raw.as_object().ok_or_else(|| {
        ArtifactIntakeError::InvalidManifest("intake manifest must be a JSON object".into())
    })?;

    let source_raw = obj
        .get("source_kind")
        .or_else(|| obj.get("sourceKind"))
        .or_else(|| obj.get("connector"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ArtifactIntakeError::InvalidManifest("missing required 'source_kind'".into())
        })?;
    let source_kind =
        IntakeSourceKind::from_str(source_raw).map_err(ArtifactIntakeError::InvalidManifest)?;

    let manifest_id = obj
        .get("manifest_id")
        .or_else(|| obj.get("bundle_id"))
        .or_else(|| obj.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ArtifactIntakeError::InvalidManifest("missing required 'manifest_id'".into())
        })?
        .to_string();

    let memory_namespace = match obj
        .get("memory_namespace")
        .or_else(|| obj.get("namespace"))
        .and_then(Value::as_str)
    {
        Some(ns) => {
            if !is_valid_memory_namespace(ns) {
                return Err(ArtifactIntakeError::InvalidNamespace(ns.to_string()));
            }
            Some(ns.to_string())
        }
        None => None,
    };

    let execution_mode = match obj
        .get("execution_mode")
        .or_else(|| obj.get("executionMode"))
        .and_then(Value::as_str)
    {
        Some(m) => {
            Some(DownloadExecutionMode::from_str(m).map_err(ArtifactIntakeError::InvalidManifest)?)
        }
        None => None,
    };

    let ws_origin = match obj
        .get("ws_origin")
        .or_else(|| obj.get("wsOrigin"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(orig) => Some(validate_ws_origin(orig)?),
        None => None,
    };

    let mut stripped_access_urls = BTreeSet::new();
    let mut manifest_redactions = BTreeSet::new();
    strip_manifest_access_urls(
        obj,
        "$",
        &mut stripped_access_urls,
        &mut manifest_redactions,
    );

    if let Some(entries_count) = obj.get("archive_entry_count").and_then(Value::as_u64) {
        if entries_count as usize > MAX_ARCHIVE_ENTRIES {
            return Err(ArtifactIntakeError::SecurityRejected {
                artifact_id: manifest_id,
                reason: format!(
                    "archive entry count {entries_count} exceeds limit {MAX_ARCHIVE_ENTRIES}"
                ),
            });
        }
    }
    if let (Some(comp), Some(uncomp)) = (
        obj.get("archive_compressed_bytes").and_then(Value::as_f64),
        obj.get("archive_uncompressed_bytes")
            .and_then(Value::as_f64),
    ) {
        if comp > 0.0 && (uncomp / comp) > MAX_EXPANSION_RATIO {
            return Err(ArtifactIntakeError::SecurityRejected {
                artifact_id: manifest_id,
                reason: "archive expansion ratio exceeds safety limit (zip-bomb guard)".into(),
            });
        }
    }

    let raw_items = obj
        .get("artifacts")
        .or_else(|| obj.get("sources"))
        .or_else(|| obj.get("items"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ArtifactIntakeError::InvalidManifest(
                "'artifacts' (or 'sources'/'items') array required".into(),
            )
        })?;

    let mut artifacts = Vec::with_capacity(raw_items.len());
    let mut seen_ids_to_hash: BTreeMap<String, String> = BTreeMap::new();
    let mut hash_to_primary: BTreeMap<String, String> = BTreeMap::new();
    let mut hash_to_dups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut citation_fingerprints: BTreeMap<String, String> = BTreeMap::new();

    for (idx, item_val) in raw_items.iter().enumerate() {
        let item_obj = item_val.as_object().ok_or_else(|| {
            ArtifactIntakeError::InvalidManifest(format!("artifacts[{idx}] must be an object"))
        })?;

        let artifact_id = item_obj
            .get("artifact_id")
            .or_else(|| item_obj.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ArtifactIntakeError::InvalidManifest(format!(
                    "artifacts[{idx}] missing required 'artifact_id'"
                ))
            })?
            .to_string();

        // Reject DRM and CAPTCHA / anti-bot gates unconditionally.
        if flag_true(item_obj, "has_drm") || flag_true(item_obj, "drm_protected") {
            return Err(ArtifactIntakeError::PolicyBlocked {
                artifact_id,
                reason: "DRM-protected media is strictly rejected".into(),
            });
        }
        if flag_true(item_obj, "requires_captcha")
            || flag_true(item_obj, "anti_bot_challenge")
            || flag_true(item_obj, "captcha_required")
        {
            return Err(ArtifactIntakeError::PolicyBlocked {
                artifact_id,
                reason:
                    "CAPTCHA or anti-bot gate requires interactive user completion; never bypass"
                        .into(),
            });
        }
        if flag_true(item_obj, "is_symlink") || flag_true(item_obj, "symlink") {
            return Err(ArtifactIntakeError::SecurityRejected {
                artifact_id,
                reason: "symlinks are rejected in archive/intake bundles".into(),
            });
        }
        if flag_true(item_obj, "is_encrypted") || flag_true(item_obj, "pdf_encrypted") {
            return Err(ArtifactIntakeError::SecurityRejected {
                artifact_id,
                reason: "encrypted PDF or encrypted payload cannot be ingested unverified".into(),
            });
        }
        if let Some(preview) = item_obj.get("content_preview").and_then(Value::as_str) {
            let upper = preview.to_ascii_uppercase();
            if upper.contains("<!ENTITY") || upper.contains("<!DOCTYPE") {
                return Err(ArtifactIntakeError::SecurityRejected {
                    artifact_id,
                    reason: "XXE DOCTYPE/ENTITY declaration detected in content".into(),
                });
            }
        }
        if source_kind == IntakeSourceKind::GoogleDriveDownloader
            && flag_true(item_obj, "requires_authenticated_session")
            && execution_mode != Some(DownloadExecutionMode::ManualVisibleBrowserOnly)
        {
            return Err(ArtifactIntakeError::PolicyBlocked {
                artifact_id,
                reason: "authenticated Drive session artifacts require MANUAL_VISIBLE_BROWSER_ONLY"
                    .into(),
            });
        }

        // Citation conflict check for Notebook bundles.
        if let Some(citations) = item_obj.get("citations").and_then(Value::as_array) {
            for cit in citations {
                if let (Some(cid), Some(fingerprint_val)) = (
                    cit.get("citation_id").and_then(Value::as_str),
                    cit.get("source_sha256").or_else(|| cit.get("span")),
                ) {
                    let fp = fingerprint_val.to_string();
                    if let Some(existing) = citation_fingerprints.get(cid) {
                        if existing != &fp {
                            return Err(ArtifactIntakeError::SecurityRejected {
                                artifact_id: artifact_id.clone(),
                                reason: format!("ambiguous/conflicting citation '{cid}'"),
                            });
                        }
                    } else {
                        citation_fingerprints.insert(cid.to_string(), fp);
                    }
                }
            }
        }

        let mut item_redactions = BTreeSet::new();
        strip_manifest_access_urls(
            item_obj,
            &format!("artifacts[{idx}]"),
            &mut stripped_access_urls,
            &mut item_redactions,
        );

        let raw_title = item_obj
            .get("title")
            .or_else(|| item_obj.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&artifact_id);
        let title = clean_human_text(raw_title, "title", &mut item_redactions);

        let raw_filename = item_obj
            .get("filename")
            .or_else(|| item_obj.get("file_name"))
            .or_else(|| item_obj.get("relative_path"))
            .and_then(Value::as_str)
            .unwrap_or(&artifact_id);
        let safe_filename = sanitize_download_filename(raw_filename)?;

        let relative_path = match item_obj.get("relative_path").and_then(Value::as_str) {
            Some(rel) => Some(validate_intake_relative_path(&artifact_id, rel)?),
            None => None,
        };

        if source_kind == IntakeSourceKind::GeminiNotebook {
            validate_notebook_extension(&artifact_id, &safe_filename)?;
        }

        let (sha256, checksum_verified) = resolve_and_verify_sha256(&artifact_id, item_obj)?;

        // Check identical ID conflicting hashes (`ERR_DUPLICATE_ID_HASH_CONFLICT`).
        if let Some(prev_hash) = seen_ids_to_hash.get(&artifact_id) {
            if prev_hash != &sha256 {
                return Err(ArtifactIntakeError::DuplicateIdHashConflict {
                    artifact_id,
                    first_sha256: prev_hash.clone(),
                    second_sha256: sha256,
                });
            }
        } else {
            seen_ids_to_hash.insert(artifact_id.clone(), sha256.clone());
        }

        // Cross-artifact SHA-256 duplicate tracking.
        let (is_duplicate, duplicate_of) = if let Some(primary_id) = hash_to_primary.get(&sha256) {
            hash_to_dups
                .entry(sha256.clone())
                .or_default()
                .push(artifact_id.clone());
            (true, Some(primary_id.clone()))
        } else {
            hash_to_primary.insert(sha256.clone(), artifact_id.clone());
            (false, None)
        };

        let byte_size = item_obj
            .get("byte_size")
            .or_else(|| item_obj.get("size_bytes"))
            .and_then(Value::as_u64);

        // Optional byte-range validation if segments are present.
        if let Some(range_arr) = item_obj.get("byte_ranges").and_then(Value::as_array) {
            let expected = byte_size.ok_or_else(|| ArtifactIntakeError::InvalidByteRanges {
                artifact_id: artifact_id.clone(),
                detail: "byte_ranges supplied without byte_size".into(),
            })?;
            let mut segs = Vec::with_capacity(range_arr.len());
            for r in range_arr {
                let s = r.get("start").and_then(Value::as_u64).ok_or_else(|| {
                    ArtifactIntakeError::InvalidByteRanges {
                        artifact_id: artifact_id.clone(),
                        detail: "range missing start".into(),
                    }
                })?;
                let e = r
                    .get("end_inclusive")
                    .or_else(|| r.get("end"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| ArtifactIntakeError::InvalidByteRanges {
                        artifact_id: artifact_id.clone(),
                        detail: "range missing end_inclusive".into(),
                    })?;
                segs.push(ByteRangeSegment {
                    start: s,
                    end_inclusive: e,
                });
            }
            validate_contiguous_byte_ranges(&artifact_id, expected, &segs)?;
        }

        let mime_type = item_obj
            .get("mime_type")
            .or_else(|| item_obj.get("content_type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // Inspect & sanitize public provenance URL (never allowing SSRF, remote HTTP, or raw secret leaks).
        let (sanitized_source_origin, sanitized_source_url, preserved_signed_params) =
            if let Some(src_url) = item_obj
                .get("source_url")
                .or_else(|| item_obj.get("canonical_url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let url_policy = UrlInspectionPolicy {
                    strict_tls: true,
                    allow_loopback_http: true,
                    allow_private_endpoints: false,
                    allow_non_loopback: true,
                    redact_signed_params: true,
                    allow_socks_schemes: false,
                };
                match sanitize_and_inspect_url(src_url, &url_policy) {
                    Ok(info) => {
                        if !info.is_safe() {
                            let reason = if info.is_metadata {
                                "source_url targets cloud metadata endpoint"
                            } else if info.private_disallowed {
                                "source_url targets disallowed private/link-local endpoint"
                            } else if info.non_tls_remote {
                                "remote source_url must use HTTPS (strict TLS)"
                            } else if info.non_loopback_disallowed {
                                "non-loopback source_url disallowed by policy"
                            } else if info.had_embedded_credentials {
                                "source_url must not embed credentials"
                            } else {
                                "source_url contains secret query credentials"
                            };
                            return Err(ArtifactIntakeError::SecurityRejected {
                                artifact_id: artifact_id.clone(),
                                reason: reason.to_string(),
                            });
                        }
                        let (orig, _) = sanitize_url_origin(&info.normalized_url);
                        if !info.preserved_signed_params.is_empty() {
                            item_redactions
                                .insert("source_url:signed_query_params_stripped".into());
                        }
                        let clean_url = if info.preserved_signed_params.is_empty() {
                            Some(info.normalized_url)
                        } else {
                            // Never retain a URL that originally held signed tokens.
                            stripped_access_urls.insert(format!("artifacts[{idx}].source_url"));
                            Some(REDACTED_URL.to_string())
                        };
                        (orig, clean_url, info.preserved_signed_params)
                    }
                    Err(err) => {
                        return Err(ArtifactIntakeError::SecurityRejected {
                            artifact_id: artifact_id.clone(),
                            reason: format!("invalid or unsafe source_url: {err}"),
                        });
                    }
                }
            } else {
                (None, None, Vec::new())
            };

        let validator_strength = classify_http_validator(
            item_obj.get("etag").and_then(Value::as_str),
            item_obj.get("last_modified").and_then(Value::as_str),
        );

        let metadata = build_sanitized_metadata(
            item_obj,
            &mut stripped_access_urls,
            &mut item_redactions,
            idx,
        );

        for rf in &item_redactions {
            manifest_redactions.insert(format!("artifacts[{idx}].{rf}"));
        }

        artifacts.push(CanonicalIntakeArtifact {
            artifact_id,
            source_kind,
            title,
            safe_filename,
            relative_path,
            sha256,
            checksum_verified,
            is_duplicate,
            duplicate_of,
            byte_size,
            mime_type,
            sanitized_source_origin,
            sanitized_source_url,
            preserved_signed_params,
            validator_strength,
            metadata,
            redacted_fields: item_redactions.into_iter().collect(),
        });
    }

    let duplicate_groups = hash_to_dups
        .into_iter()
        .map(|(sha, dups)| DuplicateGroup {
            primary_artifact_id: hash_to_primary.get(&sha).cloned().unwrap_or_default(),
            sha256: sha,
            duplicate_artifact_ids: dups,
        })
        .collect();

    Ok(CanonicalIntakeManifest {
        manifest_id,
        source_kind,
        memory_namespace,
        execution_mode,
        ws_origin,
        artifacts,
        duplicate_groups,
        stripped_access_urls: stripped_access_urls.into_iter().collect(),
        redacted_fields: manifest_redactions.into_iter().collect(),
    })
}

fn validate_ws_origin(orig: &str) -> Result<String, ArtifactIntakeError> {
    if orig == "*" || has_control_chars(orig) || has_bidi_controls(orig) {
        return Err(ArtifactIntakeError::SecurityRejected {
            artifact_id: "manifest".into(),
            reason: "wildcard or unsafe ws_origin rejected".into(),
        });
    }
    if orig.starts_with("chrome-extension://") || orig.starts_with("moz-extension://") {
        return Ok(orig.to_string());
    }
    let policy = UrlInspectionPolicy {
        strict_tls: true,
        allow_loopback_http: true,
        allow_private_endpoints: false,
        allow_non_loopback: false,
        redact_signed_params: true,
        allow_socks_schemes: false,
    };
    let info = sanitize_and_inspect_url(orig, &policy).map_err(|e| {
        ArtifactIntakeError::SecurityRejected {
            artifact_id: "manifest".into(),
            reason: format!("invalid ws_origin: {e}"),
        }
    })?;
    if !info.is_loopback || info.had_embedded_credentials {
        return Err(ArtifactIntakeError::SecurityRejected {
            artifact_id: "manifest".into(),
            reason: "ws_origin must be loopback or browser extension origin".into(),
        });
    }
    Ok(info.origin)
}

fn validate_intake_relative_path(
    artifact_id: &str,
    raw_rel: &str,
) -> Result<String, ArtifactIntakeError> {
    let trimmed = raw_rel.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || has_control_chars(trimmed)
        || has_bidi_controls(trimmed)
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
    {
        return Err(ArtifactIntakeError::SecurityRejected {
            artifact_id: artifact_id.to_string(),
            reason: format!("unsafe archive/relative path '{trimmed}'"),
        });
    }
    let mut parts = Vec::new();
    for seg in trimmed.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                return Err(ArtifactIntakeError::SecurityRejected {
                    artifact_id: artifact_id.to_string(),
                    reason: "zip-slip '..' traversal segment rejected".into(),
                });
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(ArtifactIntakeError::SecurityRejected {
            artifact_id: artifact_id.to_string(),
            reason: "relative_path resolves to empty path".into(),
        });
    }
    Ok(parts.join("/"))
}

fn validate_notebook_extension(
    artifact_id: &str,
    safe_filename: &str,
) -> Result<(), ArtifactIntakeError> {
    let Some((_, ext)) = safe_filename.rsplit_once('.') else {
        return Ok(());
    };
    let lower_ext = ext.to_ascii_lowercase();
    if !ALLOWED_NOTEBOOK_EXTENSIONS.contains(&lower_ext.as_str()) {
        return Err(ArtifactIntakeError::SecurityRejected {
            artifact_id: artifact_id.to_string(),
            reason: format!("disallowed notebook file extension '.{lower_ext}'"),
        });
    }
    Ok(())
}

fn resolve_and_verify_sha256(
    artifact_id: &str,
    obj: &Map<String, Value>,
) -> Result<(String, bool), ArtifactIntakeError> {
    let expected = obj
        .get("expected_sha256")
        .or_else(|| obj.get("sha256"))
        .and_then(Value::as_str)
        .map(|raw| {
            normalize_sha256_hex(raw).ok_or_else(|| {
                ArtifactIntakeError::InvalidManifest(format!(
                    "artifact '{artifact_id}' has malformed sha256 digest"
                ))
            })
        })
        .transpose()?;

    let computed_from_content = obj
        .get("content_utf8")
        .and_then(Value::as_str)
        .map(|s| sha256_hex(s.as_bytes()));

    let actual = obj
        .get("actual_sha256")
        .and_then(Value::as_str)
        .map(|raw| {
            normalize_sha256_hex(raw).ok_or_else(|| {
                ArtifactIntakeError::InvalidManifest(format!(
                    "artifact '{artifact_id}' has malformed actual_sha256 digest"
                ))
            })
        })
        .transpose()?
        .or(computed_from_content);

    match (expected, actual) {
        (Some(exp), Some(act)) => {
            if exp != act {
                return Err(ArtifactIntakeError::ChecksumMismatch {
                    artifact_id: artifact_id.to_string(),
                    expected: exp,
                    actual: act,
                });
            }
            Ok((exp, true))
        }
        (None, Some(act)) => Ok((act, true)),
        (Some(exp), None) => Ok((exp, false)),
        (None, None) => Err(ArtifactIntakeError::InvalidManifest(format!(
            "artifact '{artifact_id}' requires 'sha256', 'expected_sha256', or 'content_utf8'"
        ))),
    }
}

fn strip_manifest_access_urls(
    obj: &Map<String, Value>,
    path_prefix: &str,
    stripped_urls: &mut BTreeSet<String>,
    redactions: &mut BTreeSet<String>,
) {
    for (k, v) in obj {
        let p = format!("{path_prefix}.{k}");
        if is_access_bearing_url_key(k) {
            stripped_urls.insert(p.clone());
            redactions.insert(format!("{k}:access_bearing_url_stripped"));
        } else if is_pii_key_name(k) {
            redactions.insert(format!("{k}:pii_stripped"));
        } else if is_sensitive_key_name(k) {
            redactions.insert(format!("{k}:secret_stripped"));
        } else if is_private_disk_path_key(k) {
            redactions.insert(format!("{k}:disk_path_redacted"));
        }
        if let Some(nested) = v.as_object() {
            strip_manifest_access_urls(nested, &p, stripped_urls, redactions);
        }
    }
}

fn build_sanitized_metadata(
    item_obj: &Map<String, Value>,
    stripped_urls: &mut BTreeSet<String>,
    redactions: &mut BTreeSet<String>,
    idx: usize,
) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(raw_meta) = item_obj.get("metadata").and_then(Value::as_object) else {
        return out;
    };
    for (k, v) in raw_meta {
        let full_path = format!("artifacts[{idx}].metadata.{k}");
        if is_access_bearing_url_key(k) {
            stripped_urls.insert(full_path);
            redactions.insert(format!("metadata.{k}:stripped"));
            out.insert(k.clone(), Value::String(REDACTED_URL.to_string()));
            continue;
        }
        if is_pii_key_name(k) {
            redactions.insert(format!("metadata.{k}:pii"));
            out.insert(k.clone(), Value::String(REDACTED_EMAIL.to_string()));
            continue;
        }
        if is_sensitive_key_name(k) {
            redactions.insert(format!("metadata.{k}:secret"));
            out.insert(k.clone(), Value::String(REDACTED_SECRET.to_string()));
            continue;
        }
        if is_private_disk_path_key(k) {
            redactions.insert(format!("metadata.{k}:disk_path"));
            out.insert(k.clone(), Value::String(REDACTED_USER_PROFILE.to_string()));
            continue;
        }
        let (cleaned_val, paths) = redact_json_value(v);
        for p in paths {
            redactions.insert(format!("metadata.{k}.{p}"));
        }
        out.insert(k.clone(), cleaned_val);
    }
    out
}

fn clean_human_text(raw: &str, field: &str, redactions: &mut BTreeSet<String>) -> String {
    let (no_bidi, bidi_changed) = strip_bidi_controls(raw);
    if bidi_changed {
        redactions.insert(format!("{field}:bidi_stripped"));
    }
    let (no_secrets, kinds) = redact_secrets_in_text(&no_bidi);
    for k in kinds {
        redactions.insert(format!("{field}:{k}"));
    }
    let (no_emails, email_changed) = redact_emails(&no_secrets);
    if email_changed {
        redactions.insert(format!("{field}:email_redacted"));
    }
    let (no_paths, path_changed) = redact_private_disk_paths(&no_emails);
    if path_changed {
        redactions.insert(format!("{field}:disk_path_redacted"));
    }
    no_paths.trim().to_string()
}

fn flag_true(obj: &Map<String, Value>, key: &str) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_access_bearing_urls_signed_params_cookies_and_pii_and_detects_duplicates() {
        let payload_a = "hello deterministic artifact";
        let hash_a = sha256_hex(payload_a.as_bytes());

        let raw = json!({
            "manifest_id": "intake-1",
            "source_kind": "google_drive_downloader",
            "memory_namespace": "study_docs-2026",
            "execution_mode": "MANUAL_VISIBLE_BROWSER_ONLY",
            "ws_origin": "http://127.0.0.1:9222",
            "artifacts": [
                {
                    "artifact_id": "art-1",
                    "title": "Lecture 1 by alice@university.edu",
                    "filename": "CON.pdf",
                    "content_utf8": payload_a,
                    "expected_sha256": hash_a,
                    "byte_size": 26,
                    "byte_ranges": [{"start": 0, "end_inclusive": 25}],
                    "access_bearing_url": "https://drive.google.com/uc?id=123&Signature=secret99",
                    "source_url": "https://cdn.example.com/file.pdf?X-Amz-Signature=deadbeef&GoogleAccessId=svc@g",
                    "etag": "\"abc123\"",
                    "metadata": {
                        "cookie": "SID=secret_cookie; HSID=secret_hsid",
                        "owner_email": "alice@university.edu",
                        "local_download_dir": "C:\\Users\\Alice\\Downloads"
                    }
                },
                {
                    "artifact_id": "art-2",
                    "title": "Duplicate copy",
                    "filename": "copy.pdf",
                    "sha256": hash_a
                }
            ]
        });

        let manifest = normalize_canonical_artifact_intake(&raw).expect("valid canonical intake");
        assert_eq!(manifest.artifacts.len(), 2);
        assert_eq!(manifest.artifacts[0].safe_filename, "_CON.pdf");
        assert!(manifest.artifacts[0].checksum_verified);
        assert!(!manifest.artifacts[0].is_duplicate);
        assert!(manifest.artifacts[1].is_duplicate);
        assert_eq!(manifest.artifacts[1].duplicate_of.as_deref(), Some("art-1"));
        assert_eq!(manifest.duplicate_groups.len(), 1);
        assert_eq!(
            manifest.duplicate_groups[0].duplicate_artifact_ids,
            vec!["art-2"]
        );

        let emitted = serde_json::to_value(&manifest).expect("serialize manifest");
        let serialized_text = emitted.to_string();
        assert!(!serialized_text.contains("secret99"));
        assert!(!serialized_text.contains("deadbeef"));
        assert!(!serialized_text.contains("SID=secret_cookie"));
        assert!(!serialized_text.contains("alice@university.edu"));
        assert!(!serialized_text.contains("C:\\Users\\Alice"));
        assert!(detect_json_secrets(&emitted).is_empty());
        assert!(manifest
            .stripped_access_urls
            .contains(&"artifacts[0].access_bearing_url".to_string()));
    }

    #[test]
    fn rejects_checksum_mismatch_drm_captcha_zip_slip_and_id_hash_conflict() {
        let bad_hash = json!({
            "manifest_id": "bad-hash",
            "source_kind": "gemini_notebook",
            "artifacts": [{
                "artifact_id": "a1",
                "filename": "notes.md",
                "content_utf8": "actual content",
                "expected_sha256": "0".repeat(64)
            }]
        });
        assert!(matches!(
            normalize_canonical_artifact_intake(&bad_hash),
            Err(ArtifactIntakeError::ChecksumMismatch { .. })
        ));

        let drm = json!({
            "manifest_id": "drm",
            "source_kind": "google_drive_downloader",
            "artifacts": [{
                "artifact_id": "a1",
                "filename": "video.mp4",
                "sha256": "a".repeat(64),
                "has_drm": true
            }]
        });
        assert!(matches!(
            normalize_canonical_artifact_intake(&drm),
            Err(ArtifactIntakeError::PolicyBlocked { .. })
        ));

        let zip_slip = json!({
            "manifest_id": "zip",
            "source_kind": "gemini_notebook",
            "artifacts": [{
                "artifact_id": "a1",
                "filename": "ok.md",
                "relative_path": "../../evil.md",
                "sha256": "b".repeat(64)
            }]
        });
        assert!(matches!(
            normalize_canonical_artifact_intake(&zip_slip),
            Err(ArtifactIntakeError::SecurityRejected { .. })
        ));

        let conflict = json!({
            "manifest_id": "conflict",
            "source_kind": "gemini_notebook",
            "artifacts": [
                {"artifact_id": "same-id", "filename": "a.md", "sha256": "a".repeat(64)},
                {"artifact_id": "same-id", "filename": "a.md", "sha256": "b".repeat(64)}
            ]
        });
        assert!(matches!(
            normalize_canonical_artifact_intake(&conflict),
            Err(ArtifactIntakeError::DuplicateIdHashConflict { .. })
        ));
    }

    #[test]
    fn rejects_metadata_private_and_remote_non_tls_source_urls_while_allowing_loopback_http() {
        let digest = sha256_hex(b"ok");
        for unsafe_url in [
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5/internal/spec.md",
            "http://example.com/public.md",
        ] {
            let manifest = json!({
                "manifest_id": "ssrf-check",
                "source_kind": "gemini_notebook",
                "artifacts": [{
                    "artifact_id": "a1",
                    "filename": "doc.md",
                    "sha256": digest,
                    "source_url": unsafe_url
                }]
            });
            assert!(
                matches!(
                    normalize_canonical_artifact_intake(&manifest),
                    Err(ArtifactIntakeError::SecurityRejected { .. })
                ),
                "expected SecurityRejected for {unsafe_url}"
            );
        }

        let loopback = json!({
            "manifest_id": "loopback-ok",
            "source_kind": "gemini_notebook",
            "artifacts": [{
                "artifact_id": "a1",
                "filename": "doc.md",
                "sha256": digest,
                "source_url": "http://127.0.0.1:4096/docs/doc.md?utm_source=test"
            }]
        });
        let normalized =
            normalize_canonical_artifact_intake(&loopback).expect("loopback http allowed");
        assert_eq!(
            normalized.artifacts[0].sanitized_source_origin.as_deref(),
            Some("http://127.0.0.1:4096")
        );
        assert_eq!(
            normalized.artifacts[0].sanitized_source_url.as_deref(),
            Some("http://127.0.0.1:4096/docs/doc.md")
        );
    }
}
