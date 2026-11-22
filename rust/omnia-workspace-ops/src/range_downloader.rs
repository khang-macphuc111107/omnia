//! 1–128 stream chunked HTTP(S) byte-range planner, pure-Rust SSRF/URL guard, external
//! staging-directory containment check, dynamic work-stealing splitter, and SHA-256 assembly verifier.

use crate::path_guard::{
    ensure_outside_workspace, is_reparse_point_metadata, resolve_workspace_root,
    strip_verbatim_drive_prefix,
};
use crate::{io_err, WorkspaceOpsError};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Minimum concurrent range streams allowed by [`plan_range_download`].
pub const MIN_RANGE_STREAMS: usize = 1;
/// Maximum concurrent range streams allowed by [`plan_range_download`].
pub const MAX_RANGE_STREAMS: usize = 128;

/// Policy governing pure-Rust URL validation for range download planning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct RangeUrlPolicy {
    /// Must remain `false` in production; `true` allows loopback hosts (`127.0.0.0/8`, `::1`,
    /// `localhost`) solely for local loopback test harnesses. Private RFC-1918, link-local,
    /// ULA, and cloud metadata addresses remain unconditionally blocked.
    pub allow_loopback_for_testing: bool,
}

/// Errors returned by chunked range download planning, URL/staging guards, work-stealing, and
/// SHA-256 assembly verification.
#[derive(Debug, Error)]
pub enum RangeDownloadError {
    /// `requested_streams` fell outside `1..=128`.
    #[error("requested_streams={requested} out of allowed 1..=128 range")]
    InvalidStreamCount { requested: usize },

    /// `min_chunk_bytes` was zero.
    #[error("min_chunk_bytes must be >= 1, got {min_chunk_bytes}")]
    InvalidMinChunkBytes { min_chunk_bytes: u64 },

    /// `content_length_bytes` was zero; HTTP byte ranges require non-empty content.
    #[error("content_length_bytes must be >= 1")]
    ZeroContentLength,

    /// URL was empty, non-HTTP(S), malformed, or contained control/whitespace characters.
    #[error("invalid download URL: {detail}")]
    InvalidUrl { detail: String },

    /// URL contained embedded `user:pass@` or `user@` authority credentials.
    #[error("embedded credentials in download URL are forbidden")]
    EmbeddedCredentialsForbidden,

    /// URL resolved to a loopback, private, link-local, ULA, or cloud metadata host/IP.
    #[error("forbidden download target host `{host}` ({reason})")]
    ForbiddenNetworkHost { host: String, reason: &'static str },

    /// Staging directory resolved inside or equal to `workspace_root`.
    #[error("staging directory `{staging_dir}` must lie strictly outside workspace root `{workspace_root}`")]
    StagingDirInsideWorkspace {
        workspace_root: String,
        staging_dir: String,
    },

    /// Underlying path containment or filesystem metadata check error.
    #[error(transparent)]
    WorkspacePath(#[from] WorkspaceOpsError),

    /// Target segment identifier was not found in the active segment list.
    #[error("segment_id={segment_id} not found")]
    SegmentNotFound { segment_id: usize },

    /// Reported `bytes_done` exceeded the segment length.
    #[error("segment_id={segment_id} progress bytes_done={bytes_done} exceeds segment_len={segment_len}")]
    InvalidProgress {
        segment_id: usize,
        bytes_done: u64,
        segment_len: u64,
    },

    /// `min_split_bytes` was zero.
    #[error("min_split_bytes must be >= 1, got {min_split_bytes}")]
    InvalidSplitThreshold { min_split_bytes: u64 },

    /// Segment's remaining uncompleted tail is too small to split into two `>= min_split_bytes` parts.
    #[error(
        "segment_id={segment_id} cannot split remaining {remaining_bytes} bytes with min_split_bytes={min_split_bytes}"
    )]
    SegmentNotSplittable {
        segment_id: usize,
        remaining_bytes: u64,
        min_split_bytes: u64,
    },

    /// No segments or zero total bytes were supplied for assembly.
    #[error("cannot assemble and verify empty chunk payload")]
    EmptyChunks,

    /// `expected_sha256_hex` was not a 64-character hexadecimal string.
    #[error("expected_sha256_hex must be a 64-character hex SHA-256 digest")]
    InvalidSha256Hex,

    /// Computed SHA-256 of concatenated chunks did not match `expected_sha256_hex`.
    #[error("assembled chunk SHA-256 mismatch: expected `{expected}`, got `{actual}`")]
    Sha256Mismatch { expected: String, actual: String },

    /// Segment list count did not match planned segments during keyed assembly.
    #[error("segment count mismatch: expected {expected}, got {actual}")]
    SegmentCountMismatch { expected: usize, actual: usize },

    /// Assembled segment byte slice length disagreed with planned `[start_byte, end_byte]`.
    #[error("segment_id={segment_id} length mismatch: expected {expected} bytes, got {actual}")]
    SegmentLengthMismatch {
        segment_id: usize,
        expected: u64,
        actual: usize,
    },
}

/// Validated and secret-scrubbed HTTP(S) download URL descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedDownloadUrl {
    /// Normalized URL with secret query parameter values replaced by `[REDACTED]`.
    pub sanitized_url: String,
    /// Lowercase scheme (`"http"` or `"https"`).
    pub scheme: String,
    /// Normalized host string (IPv6 literals retain `[...]`).
    pub host: String,
    /// Effective TCP port (`80`, `443`, or explicit nonzero port).
    pub port: u16,
    /// True when the host is loopback (`127.0.0.0/8`, `::1`, or `localhost`).
    pub is_loopback: bool,
    /// True when loopback was admitted solely via explicit test opt-in.
    pub loopback_opted_in: bool,
    /// Names of query parameters whose values were scrubbed in `sanitized_url`.
    pub scrubbed_query_keys: Vec<String>,
}

/// Inclusive HTTP byte-range segment (`Range: bytes=<start_byte>-<end_byte>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRangeSegment {
    /// Unique segment identifier within the download plan (new stolen chunks increment sequentially).
    pub segment_id: usize,
    /// Inclusive starting byte offset (`0`-based).
    pub start_byte: u64,
    /// Inclusive ending byte offset (`start_byte <= end_byte`).
    pub end_byte: u64,
}

impl ByteRangeSegment {
    /// Number of bytes covered by this inclusive range (`end_byte - start_byte + 1`).
    pub const fn len(&self) -> u64 {
        self.end_byte - self.start_byte + 1
    }

    /// Always `false` for valid inclusive `[start_byte, end_byte]` segments.
    pub const fn is_empty(&self) -> bool {
        false
    }

    /// Formats the RFC 9110 `Range` header value (`bytes=<start>-<end>`).
    pub fn http_range_header(&self) -> String {
        format!("bytes={}-{}", self.start_byte, self.end_byte)
    }
}

impl Serialize for ByteRangeSegment {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "segment_id": self.segment_id,
            "start_byte": self.start_byte,
            "end_byte": self.end_byte,
            "byte_len": self.len(),
            "range_header": self.http_range_header(),
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ByteRangeSegment {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val.as_object().ok_or_else(|| {
            serde::de::Error::custom("ByteRangeSegment must be a JSON object")
        })?;
        let segment_id = obj
            .get("segment_id")
            .and_then(Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| serde::de::Error::custom("missing usize segment_id"))?;
        let start_byte = obj
            .get("start_byte")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u64 start_byte"))?;
        let end_byte = obj
            .get("end_byte")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u64 end_byte"))?;
        if end_byte < start_byte {
            return Err(serde::de::Error::custom("end_byte must be >= start_byte"));
        }
        Ok(Self {
            segment_id,
            start_byte,
            end_byte,
        })
    }
}

/// Complete validated plan for a multi-stream HTTP byte-range download staged outside `workspace_root`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RangeDownloadPlan {
    /// Secret-scrubbed download URL safe to persist in receipts.
    pub sanitized_url: String,
    /// Query parameter names scrubbed from `sanitized_url`.
    pub scrubbed_query_keys: Vec<String>,
    /// Normalized staging directory verified strictly outside `workspace_root`.
    pub staging_dir: PathBuf,
    /// Canonicalized workspace root checked against `staging_dir`.
    pub workspace_root: PathBuf,
    /// Total resource size in bytes.
    pub content_length_bytes: u64,
    /// Caller-requested stream count (`1..=128`).
    pub requested_streams: usize,
    /// Actual segment count after honoring `min_chunk_bytes` and `content_length_bytes`.
    pub planned_streams: usize,
    /// Minimum chunk size constraint used during partitioning.
    pub min_chunk_bytes: u64,
    /// True when loopback URL testing opt-in was active.
    pub loopback_opted_in: bool,
    /// Ordered contiguous non-overlapping inclusive byte ranges covering `0..content_length_bytes`.
    pub segments: Vec<ByteRangeSegment>,
}

impl RangeDownloadPlan {
    /// Serializes this plan into a secret-free [`serde_json::Value`] receipt.
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for RangeDownloadPlan {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "sanitized_url": self.sanitized_url,
            "scrubbed_query_keys": self.scrubbed_query_keys,
            "staging_dir": self.staging_dir.display().to_string(),
            "workspace_root": self.workspace_root.display().to_string(),
            "content_length_bytes": self.content_length_bytes,
            "requested_streams": self.requested_streams,
            "planned_streams": self.planned_streams,
            "min_chunk_bytes": self.min_chunk_bytes,
            "loopback_opted_in": self.loopback_opted_in,
            "segments": self.segments,
        })
        .serialize(serializer)
    }
}

/// Verified concatenated download payload produced by [`assemble_and_verify_chunks`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedChunkAssembly {
    /// Concatenated ordered payload bytes.
    pub bytes: Vec<u8>,
    /// Total concatenated byte length.
    pub total_bytes: usize,
    /// Verified lowercase 64-character SHA-256 hex digest.
    pub sha256_hex: String,
    /// Number of segments concatenated.
    pub segment_count: usize,
}

impl VerifiedChunkAssembly {
    /// Consumes the assembly and returns the verified byte buffer.
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Validates an HTTP(S) download URL under strict default SSRF protections
/// (`allow_loopback_for_testing == false`).
pub fn validate_download_url(raw_url: &str) -> Result<ValidatedDownloadUrl, RangeDownloadError> {
    validate_download_url_with_policy(raw_url, RangeUrlPolicy::default())
}

/// Validates an HTTP(S) download URL in pure Rust, rejecting embedded credentials, non-HTTP(S)
/// schemes, private/link-local/ULA/metadata hosts, and scrubbing secret query parameters.
pub fn validate_download_url_with_policy(
    raw_url: &str,
    policy: RangeUrlPolicy,
) -> Result<ValidatedDownloadUrl, RangeDownloadError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "URL cannot be empty".to_string(),
        });
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "URL contains control or whitespace characters".to_string(),
        });
    }

    let (scheme_raw, after_scheme) =
        trimmed
            .split_once("://")
            .ok_or_else(|| RangeDownloadError::InvalidUrl {
                detail: "URL must include `http://` or `https://` scheme".to_string(),
            })?;
    let scheme = scheme_raw.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(RangeDownloadError::InvalidUrl {
            detail: format!("unsupported URL scheme `{scheme}`; only http/https allowed"),
        });
    }

    // Strip any fragment first so it does not leak into authority/query parsing.
    let without_fragment = after_scheme
        .split_once('#')
        .map_or(after_scheme, |(before, _)| before);

    let auth_end = without_fragment
        .find(['/', '?'])
        .unwrap_or(without_fragment.len());
    let authority = &without_fragment[..auth_end];
    let rest = &without_fragment[auth_end..];

    if authority.is_empty() {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "URL authority/host is empty".to_string(),
        });
    }
    if authority.contains('@') {
        return Err(RangeDownloadError::EmbeddedCredentialsForbidden);
    }
    if authority.contains('\\') {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "backslash in URL authority is forbidden".to_string(),
        });
    }

    let (host_normalized, port_explicit) = parse_authority(authority)?;
    let port = port_explicit.unwrap_or(if scheme == "https" { 443 } else { 80 });
    let is_loopback = verify_host_safety(&host_normalized, policy)?;

    let (path_part, query_part) = match rest.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (rest, None),
    };
    let normalized_path = if path_part.is_empty() { "/" } else { path_part };

    let mut scrubbed_query_keys = Vec::new();
    let sanitized_query = query_part.map(|q| scrub_query_string(q, &mut scrubbed_query_keys));

    let port_suffix = match port_explicit {
        Some(p) => format!(":{p}"),
        None => String::new(),
    };
    let sanitized_url = match sanitized_query {
        Some(q) if !q.is_empty() => format!("{scheme}://{host_normalized}{port_suffix}{normalized_path}?{q}"),
        _ => format!("{scheme}://{host_normalized}{port_suffix}{normalized_path}"),
    };

    Ok(ValidatedDownloadUrl {
        sanitized_url,
        scheme,
        host: host_normalized,
        port,
        is_loopback,
        loopback_opted_in: is_loopback && policy.allow_loopback_for_testing,
        scrubbed_query_keys,
    })
}

/// Plans 1–128 contiguous inclusive HTTP byte-range segments under default SSRF policy and
/// enforces `staging_dir` strictly outside `workspace_root`.
pub fn plan_range_download(
    url: &str,
    content_length_bytes: u64,
    requested_streams: usize,
    min_chunk_bytes: u64,
    staging_dir: impl AsRef<Path>,
    workspace_root: impl AsRef<Path>,
) -> Result<RangeDownloadPlan, RangeDownloadError> {
    plan_range_download_with_policy(
        url,
        content_length_bytes,
        requested_streams,
        min_chunk_bytes,
        staging_dir,
        workspace_root,
        RangeUrlPolicy::default(),
    )
}

/// Plans 1–128 contiguous inclusive HTTP byte-range segments with an explicit [`RangeUrlPolicy`].
pub fn plan_range_download_with_policy(
    url: &str,
    content_length_bytes: u64,
    requested_streams: usize,
    min_chunk_bytes: u64,
    staging_dir: impl AsRef<Path>,
    workspace_root: impl AsRef<Path>,
    policy: RangeUrlPolicy,
) -> Result<RangeDownloadPlan, RangeDownloadError> {
    if !(MIN_RANGE_STREAMS..=MAX_RANGE_STREAMS).contains(&requested_streams) {
        return Err(RangeDownloadError::InvalidStreamCount {
            requested: requested_streams,
        });
    }
    if min_chunk_bytes == 0 {
        return Err(RangeDownloadError::InvalidMinChunkBytes { min_chunk_bytes });
    }
    if content_length_bytes == 0 {
        return Err(RangeDownloadError::ZeroContentLength);
    }

    let validated_url = validate_download_url_with_policy(url, policy)?;
    let canonical_root = resolve_workspace_root(workspace_root)?;
    let validated_staging = validate_external_staging_dir(&canonical_root, staging_dir.as_ref())?;

    let max_chunks_by_min = (content_length_bytes / min_chunk_bytes).max(1);
    let max_chunks_by_len = content_length_bytes;
    let planned_streams_u64 = (requested_streams as u64)
        .min(max_chunks_by_min)
        .min(max_chunks_by_len)
        .max(1);
    let planned_streams = planned_streams_u64 as usize;

    let base_len = content_length_bytes / planned_streams_u64;
    let remainder = content_length_bytes % planned_streams_u64;

    let mut segments = Vec::with_capacity(planned_streams);
    let mut cursor = 0u64;
    for idx in 0..planned_streams {
        let extra = u64::from((idx as u64) < remainder);
        let seg_len = base_len + extra;
        let start_byte = cursor;
        let end_byte = cursor + seg_len - 1;
        segments.push(ByteRangeSegment {
            segment_id: idx,
            start_byte,
            end_byte,
        });
        cursor = end_byte + 1;
    }
    debug_assert_eq!(cursor, content_length_bytes);

    Ok(RangeDownloadPlan {
        sanitized_url: validated_url.sanitized_url,
        scrubbed_query_keys: validated_url.scrubbed_query_keys,
        staging_dir: validated_staging,
        workspace_root: canonical_root,
        content_length_bytes,
        requested_streams,
        planned_streams,
        min_chunk_bytes,
        loopback_opted_in: validated_url.loopback_opted_in,
        segments,
    })
}

/// Dynamic work-stealing helper: splits the uncompleted tail of `active_id` in half so an idle
/// stream can download the second half concurrently without overlaps or gaps.
pub fn split_largest_active_segment(
    segments: &mut Vec<ByteRangeSegment>,
    active_id: usize,
    bytes_done: u64,
    min_split_bytes: u64,
) -> Result<ByteRangeSegment, RangeDownloadError> {
    if min_split_bytes == 0 {
        return Err(RangeDownloadError::InvalidSplitThreshold { min_split_bytes });
    }
    let pos = segments
        .iter()
        .position(|s| s.segment_id == active_id)
        .ok_or(RangeDownloadError::SegmentNotFound {
            segment_id: active_id,
        })?;
    let active = segments[pos];
    let seg_len = active.len();
    if bytes_done > seg_len {
        return Err(RangeDownloadError::InvalidProgress {
            segment_id: active_id,
            bytes_done,
            segment_len: seg_len,
        });
    }

    let remaining = seg_len - bytes_done;
    let min_required = min_split_bytes.saturating_mul(2).max(2);
    if remaining < min_required {
        return Err(RangeDownloadError::SegmentNotSplittable {
            segment_id: active_id,
            remaining_bytes: remaining,
            min_split_bytes,
        });
    }

    let remaining_start = active.start_byte + bytes_done;
    let first_half_remaining = remaining / 2;
    let active_new_end = remaining_start + first_half_remaining - 1;
    let stolen_start = active_new_end + 1;
    let stolen_end = active.end_byte;

    let next_id = segments
        .iter()
        .map(|s| s.segment_id)
        .max()
        .map_or(0, |m| m + 1);

    segments[pos].end_byte = active_new_end;
    let stolen = ByteRangeSegment {
        segment_id: next_id,
        start_byte: stolen_start,
        end_byte: stolen_end,
    };
    segments.insert(pos + 1, stolen);
    Ok(stolen)
}

/// Selects the active segment `(segment_id, bytes_done)` with the largest remaining uncompleted
/// tail that can still be split under `min_split_bytes`.
pub fn pick_largest_stealable_segment(
    segments: &[ByteRangeSegment],
    active_progress: &[(usize, u64)],
    min_split_bytes: u64,
) -> Option<(usize, u64)> {
    if min_split_bytes == 0 {
        return None;
    }
    let min_required = min_split_bytes.saturating_mul(2).max(2);
    let mut best: Option<(usize, u64, u64)> = None;
    for &(seg_id, bytes_done) in active_progress {
        if let Some(seg) = segments.iter().find(|s| s.segment_id == seg_id) {
            if bytes_done <= seg.len() {
                let remaining = seg.len() - bytes_done;
                if remaining >= min_required
                    && best.is_none_or(|(_, _, best_rem)| remaining > best_rem)
                {
                    best = Some((seg_id, bytes_done, remaining));
                }
            }
        }
    }
    best.map(|(id, done, _)| (id, done))
}

/// Concatenates ordered verified chunk slices and validates their SHA-256 digest via `sha2::Sha256`.
pub fn assemble_and_verify_chunks<B: AsRef<[u8]>>(
    segments_bytes: &[B],
    expected_sha256_hex: &str,
) -> Result<VerifiedChunkAssembly, RangeDownloadError> {
    let expected = normalize_sha256_hex(expected_sha256_hex)?;
    if segments_bytes.is_empty() {
        return Err(RangeDownloadError::EmptyChunks);
    }

    let total_bytes: usize = segments_bytes.iter().map(|s| s.as_ref().len()).sum();
    if total_bytes == 0 {
        return Err(RangeDownloadError::EmptyChunks);
    }

    let mut bytes = Vec::with_capacity(total_bytes);
    let mut hasher = Sha256::new();
    for seg in segments_bytes {
        let slice = seg.as_ref();
        bytes.extend_from_slice(slice);
        hasher.update(slice);
    }

    let actual = digest_to_hex(&hasher.finalize());
    if actual != expected {
        return Err(RangeDownloadError::Sha256Mismatch { expected, actual });
    }

    Ok(VerifiedChunkAssembly {
        bytes,
        total_bytes,
        sha256_hex: actual,
        segment_count: segments_bytes.len(),
    })
}

/// Validates and reorders `(segment_id, chunk_bytes)` pairs against `segments` in byte-offset
/// order, checks every segment's exact byte length, concatenates, and verifies SHA-256.
pub fn assemble_plan_chunks_and_verify<B: AsRef<[u8]>>(
    segments: &[ByteRangeSegment],
    segment_chunks: &[(usize, B)],
    expected_sha256_hex: &str,
) -> Result<VerifiedChunkAssembly, RangeDownloadError> {
    if segments.is_empty() || segment_chunks.is_empty() {
        return Err(RangeDownloadError::EmptyChunks);
    }
    if segments.len() != segment_chunks.len() {
        return Err(RangeDownloadError::SegmentCountMismatch {
            expected: segments.len(),
            actual: segment_chunks.len(),
        });
    }

    let mut ordered_segments: Vec<ByteRangeSegment> = segments.to_vec();
    ordered_segments.sort_by_key(|s| s.start_byte);

    let mut ordered_slices: Vec<&[u8]> = Vec::with_capacity(ordered_segments.len());
    for seg in &ordered_segments {
        let found = segment_chunks
            .iter()
            .find(|(id, _)| *id == seg.segment_id)
            .ok_or(RangeDownloadError::SegmentNotFound {
                segment_id: seg.segment_id,
            })?;
        let slice = found.1.as_ref();
        if (slice.len() as u64) != seg.len() {
            return Err(RangeDownloadError::SegmentLengthMismatch {
                segment_id: seg.segment_id,
                expected: seg.len(),
                actual: slice.len(),
            });
        }
        ordered_slices.push(slice);
    }

    assemble_and_verify_chunks(&ordered_slices, expected_sha256_hex)
}

fn validate_external_staging_dir(
    canonical_root: &Path,
    staging_dir: &Path,
) -> Result<PathBuf, RangeDownloadError> {
    let raw = staging_dir.to_string_lossy();
    if raw.is_empty() {
        return Err(WorkspaceOpsError::EmptyPath.into());
    }
    if raw.starts_with(r"\\?\UNC\")
        || raw.starts_with(r"//?/UNC/")
        || raw.starts_with(r"\\") && !raw.starts_with(r"\\?\")
        || raw.starts_with("//") && !raw.starts_with("//?/")
    {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.into_owned(),
            reason: "unc_network_prefix",
        }
        .into());
    }

    let clean = strip_verbatim_drive_prefix(staging_dir);
    if let Ok(meta) = fs::symlink_metadata(&clean) {
        if is_reparse_point_metadata(&meta) {
            return Err(WorkspaceOpsError::ReparsePointDetected {
                path: clean.display().to_string(),
            }
            .into());
        }
        if !meta.is_dir() {
            return Err(WorkspaceOpsError::NotADirectory {
                path: clean.display().to_string(),
            }
            .into());
        }
    }

    // Check existing ancestors for reparse points before containment comparison.
    let mut probe = clean.clone();
    while !probe.as_os_str().is_empty() {
        match fs::symlink_metadata(&probe) {
            Ok(meta) => {
                if is_reparse_point_metadata(&meta) {
                    return Err(WorkspaceOpsError::ReparsePointDetected {
                        path: probe.display().to_string(),
                    }
                    .into());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !probe.pop() {
                    break;
                }
            }
            Err(e) => return Err(io_err("symlink_metadata", &probe, e).into()),
        }
    }

    match ensure_outside_workspace(canonical_root, staging_dir) {
        Ok(outside) => Ok(outside),
        Err(WorkspaceOpsError::RollbackDirInsideWorkspace { root, rollback_dir }) => {
            Err(RangeDownloadError::StagingDirInsideWorkspace {
                workspace_root: root,
                staging_dir: rollback_dir,
            })
        }
        Err(other) => Err(other.into()),
    }
}

fn parse_authority(authority: &str) -> Result<(String, Option<u16>), RangeDownloadError> {
    if let Some(after_open) = authority.strip_prefix('[') {
        let Some((ipv6_inner, suffix)) = after_open.split_once(']') else {
            return Err(RangeDownloadError::InvalidUrl {
                detail: "unclosed IPv6 literal bracket".to_string(),
            });
        };
        if ipv6_inner.contains('%') {
            return Err(RangeDownloadError::InvalidUrl {
                detail: "IPv6 zone identifiers are forbidden in download URLs".to_string(),
            });
        }
        let parsed_v6: Ipv6Addr =
            ipv6_inner
                .parse()
                .map_err(|_| RangeDownloadError::InvalidUrl {
                    detail: format!("invalid IPv6 host literal `[{ipv6_inner}]`"),
                })?;
        let port = if suffix.is_empty() {
            None
        } else if let Some(port_str) = suffix.strip_prefix(':') {
            Some(parse_nonzero_port(port_str)?)
        } else {
            return Err(RangeDownloadError::InvalidUrl {
                detail: "unexpected trailing characters after IPv6 host".to_string(),
            });
        };
        return Ok((format!("[{parsed_v6}]"), port));
    }

    let (host_raw, port) = match authority.split_once(':') {
        Some((h, port_str)) => {
            if port_str.contains(':') {
                return Err(RangeDownloadError::InvalidUrl {
                    detail: "unbracketed multi-colon host/port in URL authority".to_string(),
                });
            }
            (h, Some(parse_nonzero_port(port_str)?))
        }
        None => (authority, None),
    };

    let host_clean = host_raw.trim_end_matches('.').to_ascii_lowercase();
    if host_clean.is_empty() {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "URL host cannot be empty".to_string(),
        });
    }
    if host_clean.contains('%')
        || !host_clean
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(RangeDownloadError::InvalidUrl {
            detail: format!("invalid characters in URL host `{host_clean}`"),
        });
    }

    Ok((host_clean, port))
}

fn parse_nonzero_port(port_str: &str) -> Result<u16, RangeDownloadError> {
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return Err(RangeDownloadError::InvalidUrl {
            detail: format!("invalid TCP port `{port_str}`"),
        });
    }
    let port = port_str
        .parse::<u16>()
        .map_err(|_| RangeDownloadError::InvalidUrl {
            detail: format!("TCP port `{port_str}` out of 1..=65535"),
        })?;
    if port == 0 {
        return Err(RangeDownloadError::InvalidUrl {
            detail: "TCP port 0 is invalid".to_string(),
        });
    }
    Ok(port)
}

fn verify_host_safety(host: &str, policy: RangeUrlPolicy) -> Result<bool, RangeDownloadError> {
    if host.starts_with('[') && host.ends_with(']') {
        let inner = &host[1..host.len() - 1];
        let ip: Ipv6Addr = inner.parse().map_err(|_| RangeDownloadError::InvalidUrl {
            detail: format!("invalid IPv6 host `{host}`"),
        })?;
        return check_ipv6_safety(host, ip, policy);
    }

    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return check_ipv4_safety(host, ip, policy);
    }

    if is_obfuscated_numeric_ip_host(host) {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: host.to_string(),
            reason: "obfuscated_numeric_ip_host",
        });
    }

    if host == "localhost" || host.ends_with(".localhost") {
        if policy.allow_loopback_for_testing {
            return Ok(true);
        }
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: host.to_string(),
            reason: "loopback_localhost",
        });
    }

    if host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host == "metadata"
        || host == "metadata.goog"
        || host == "instance-data"
    {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: host.to_string(),
            reason: "cloud_metadata_host",
        });
    }

    Ok(false)
}

fn check_ipv4_safety(
    display_host: &str,
    ip: Ipv4Addr,
    policy: RangeUrlPolicy,
) -> Result<bool, RangeDownloadError> {
    let oct = ip.octets();
    if oct[0] == 127 {
        if policy.allow_loopback_for_testing {
            return Ok(true);
        }
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "loopback_127_0_0_0_8",
        });
    }
    if oct[0] == 0 {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "unspecified_0_0_0_0_8",
        });
    }
    if oct[0] == 10
        || (oct[0] == 172 && (16..=31).contains(&oct[1]))
        || (oct[0] == 192 && oct[1] == 168)
    {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "private_rfc1918",
        });
    }
    if oct[0] == 169 && oct[1] == 254 {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "link_local_or_imds_169_254_0_0_16",
        });
    }
    if ip.is_multicast() || ip.is_broadcast() {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "multicast_or_broadcast_ipv4",
        });
    }
    Ok(false)
}

fn check_ipv6_safety(
    display_host: &str,
    ip: Ipv6Addr,
    policy: RangeUrlPolicy,
) -> Result<bool, RangeDownloadError> {
    if let Some(mapped_v4) = ip.to_ipv4_mapped() {
        return check_ipv4_safety(display_host, mapped_v4, policy);
    }
    if let Some(compat_v4) = ip.to_ipv4() {
        // `::` and `::1` also return Some(0.0.0.0) / Some(0.0.0.1) via to_ipv4(), so guard those explicitly.
        if !ip.is_unspecified() && !ip.is_loopback() {
            return check_ipv4_safety(display_host, compat_v4, policy);
        }
    }

    if ip.is_loopback() {
        if policy.allow_loopback_for_testing {
            return Ok(true);
        }
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "loopback_ipv6_::1",
        });
    }
    if ip.is_unspecified() {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "unspecified_ipv6",
        });
    }
    let segs = ip.segments();
    // fc00::/7 Unique Local IPv6 Unicast
    if (segs[0] & 0xfe00) == 0xfc00 {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "ula_fc00_7",
        });
    }
    // fe80::/10 Link-Local IPv6 Unicast
    if (segs[0] & 0xffc0) == 0xfe80 {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "link_local_fe80_10",
        });
    }
    if ip.is_multicast() {
        return Err(RangeDownloadError::ForbiddenNetworkHost {
            host: display_host.to_string(),
            reason: "multicast_ipv6",
        });
    }
    Ok(false)
}

fn is_obfuscated_numeric_ip_host(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.is_empty() || labels.len() > 4 {
        return false;
    }
    labels.iter().all(|label| {
        if label.is_empty() {
            return false;
        }
        if let Some(hex) = label.strip_prefix("0x") {
            !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())
        } else {
            label.bytes().all(|b| b.is_ascii_digit())
        }
    })
}

fn scrub_query_string(raw_query: &str, scrubbed_keys: &mut Vec<String>) -> String {
    if raw_query.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for pair in raw_query.split('&') {
        if let Some((key, _val)) = pair.split_once('=') {
            if is_secret_query_key(key) {
                scrubbed_keys.push(key.to_string());
                parts.push(format!("{key}=[REDACTED]"));
            } else {
                parts.push(pair.to_string());
            }
        } else {
            parts.push(pair.to_string());
        }
    }
    parts.join("&")
}

fn is_secret_query_key(raw_key: &str) -> bool {
    let lower = raw_key.to_ascii_lowercase();
    let exact = [
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "oauth_token",
        "auth",
        "authorization",
        "key",
        "api_key",
        "apikey",
        "secret",
        "client_secret",
        "private_key",
        "password",
        "passwd",
        "pwd",
        "signature",
        "sig",
        "x-amz-signature",
        "x-amz-credential",
        "x-amz-security-token",
        "x-goog-signature",
        "x-goog-credential",
        "sas",
        "se",
        "sp",
        "sr",
        "sv",
        "session",
        "session_id",
        "sid",
        "cookie",
        "jwt",
        "bearer",
        "credential",
    ];
    if exact.contains(&lower.as_str()) {
        return true;
    }
    lower.ends_with("_token")
        || lower.ends_with("_key")
        || lower.ends_with("_secret")
        || lower.ends_with("_signature")
        || lower.ends_with("_sig")
        || lower.ends_with("_password")
        || lower.starts_with("x-amz-")
        || lower.starts_with("x-goog-")
}

fn normalize_sha256_hex(raw: &str) -> Result<String, RangeDownloadError> {
    let trimmed = raw.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(RangeDownloadError::InvalidSha256Hex);
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn digest_to_hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SANDBOX_SEQ: AtomicU64 = AtomicU64::new(1);

    struct RangeSandbox {
        base: PathBuf,
        workspace: PathBuf,
        outside_staging: PathBuf,
    }

    impl RangeSandbox {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let seq = SANDBOX_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "omnia-range-dl-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            let workspace = base.join("workspace");
            let outside_staging = base.join("external-staging");
            fs::create_dir_all(&workspace).expect("create workspace");
            Self {
                base,
                workspace,
                outside_staging,
            }
        }
    }

    impl Drop for RangeSandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn planner_validates_1_to_128_streams_and_produces_contiguous_non_overlapping_ranges() {
        let sb = RangeSandbox::new("ranges");

        // Stream counts 0 and 129 must return InvalidStreamCount.
        assert!(matches!(
            plan_range_download(
                "https://cdn.example.org/bundle.bin",
                10_000,
                0,
                64,
                &sb.outside_staging,
                &sb.workspace
            ),
            Err(RangeDownloadError::InvalidStreamCount { requested: 0 })
        ));
        assert!(matches!(
            plan_range_download(
                "https://cdn.example.org/bundle.bin",
                10_000,
                129,
                64,
                &sb.outside_staging,
                &sb.workspace
            ),
            Err(RangeDownloadError::InvalidStreamCount { requested: 129 })
        ));

        // 128 streams over 131_075 bytes with min_chunk_bytes=1024 -> 128 contiguous segments.
        let plan_128 = plan_range_download(
            "https://cdn.example.org/archive.tar.zst?v=2&token=dummy_token_value&sig=synthetic_sig",
            131_075,
            128,
            1024,
            &sb.outside_staging,
            &sb.workspace,
        )
        .expect("128-stream plan");
        assert_eq!(plan_128.planned_streams, 128);
        assert_eq!(plan_128.segments.len(), 128);
        assert_eq!(plan_128.segments[0].start_byte, 0);
        assert_eq!(plan_128.segments.last().unwrap().end_byte, 131_074);
        assert!(!plan_128.sanitized_url.contains("dummy_token_value"));
        assert!(!plan_128.sanitized_url.contains("synthetic_sig"));
        assert!(plan_128.sanitized_url.contains("v=2"));
        assert!(plan_128.sanitized_url.contains("token=[REDACTED]"));
        assert!(plan_128.sanitized_url.contains("sig=[REDACTED]"));

        // Verify zero gaps, zero overlaps, and min_chunk_bytes honored across all 128 chunks.
        let mut expected_next = 0u64;
        for seg in &plan_128.segments {
            assert_eq!(seg.start_byte, expected_next);
            assert!(seg.len() >= 1024);
            expected_next = seg.end_byte + 1;
        }
        assert_eq!(expected_next, 131_075);

        // When content_length limits min_chunk_bytes, planned_streams scales down cleanly.
        let small_plan = plan_range_download(
            "https://downloads.example.test/file.bin",
            1_000,
            16,
            256,
            &sb.outside_staging,
            &sb.workspace,
        )
        .expect("bounded chunk count");
        assert_eq!(small_plan.planned_streams, 3);
        assert_eq!(small_plan.segments[0].len(), 334);
        assert_eq!(small_plan.segments[1].len(), 333);
        assert_eq!(small_plan.segments[2].len(), 333);
    }

    #[test]
    fn url_guard_blocks_credentials_private_metadata_and_loopback_without_opt_in() {
        let sb = RangeSandbox::new("url-guard");

        for bad_url in [
            "",
            "ftp://example.com/file.bin",
            "file:///C:/secret.txt",
            "https://dummy_user:dummy_pass@example.com/file.bin",
            "http://127.0.0.1:8080/file.bin",
            "http://localhost/file.bin",
            "http://[::1]:8080/file.bin",
            "http://10.0.0.5/internal.bin",
            "http://172.16.42.1/internal.bin",
            "http://192.168.1.10/internal.bin",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::ffff:169.254.169.254]/latest/",
            "http://[::ffff:127.0.0.1]/local.bin",
            "http://[fc00::1]/ula.bin",
            "http://[fe80::1]/link.bin",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://2130706433/int.bin",
            "http://0x7f000001/hex.bin",
        ] {
            let err = plan_range_download(
                bad_url,
                4096,
                4,
                512,
                &sb.outside_staging,
                &sb.workspace,
            )
            .expect_err(&format!("must reject {bad_url}"));
            assert!(
                matches!(
                    err,
                    RangeDownloadError::InvalidUrl { .. }
                        | RangeDownloadError::EmbeddedCredentialsForbidden
                        | RangeDownloadError::ForbiddenNetworkHost { .. }
                ),
                "unexpected error for {bad_url}: {err:?}"
            );
        }

        // Loopback opt-in admits 127.0.0.1 / [::1] / localhost for tests, while still blocking IMDS/RFC1918!
        let loopback_plan = plan_range_download_with_policy(
            "http://127.0.0.1:9000/test-fixture.bin",
            4096,
            4,
            512,
            &sb.outside_staging,
            &sb.workspace,
            RangeUrlPolicy {
                allow_loopback_for_testing: true,
            },
        )
        .expect("loopback test opt-in allowed");
        assert!(loopback_plan.loopback_opted_in);

        let still_blocked = plan_range_download_with_policy(
            "http://169.254.169.254/latest/meta-data/",
            4096,
            4,
            512,
            &sb.outside_staging,
            &sb.workspace,
            RangeUrlPolicy {
                allow_loopback_for_testing: true,
            },
        )
        .unwrap_err();
        assert!(matches!(
            still_blocked,
            RangeDownloadError::ForbiddenNetworkHost { .. }
        ));
    }

    #[test]
    fn staging_dir_must_be_strictly_outside_workspace_root() {
        let sb = RangeSandbox::new("staging");
        let inside_err = plan_range_download(
            "https://example.org/payload.bin",
            4096,
            4,
            512,
            sb.workspace.join("downloads"),
            &sb.workspace,
        )
        .expect_err("staging inside workspace must fail");
        assert!(matches!(
            inside_err,
            RangeDownloadError::StagingDirInsideWorkspace { .. }
        ));

        let same_root_err = plan_range_download(
            "https://example.org/payload.bin",
            4096,
            4,
            512,
            &sb.workspace,
            &sb.workspace,
        )
        .expect_err("staging equal to workspace root must fail");
        assert!(matches!(
            same_root_err,
            RangeDownloadError::StagingDirInsideWorkspace { .. }
        ));
    }

    #[test]
    fn work_stealing_split_and_sha256_assembly_verify_end_to_end() {
        let sb = RangeSandbox::new("steal-verify");
        let payload: Vec<u8> = (0..1024u32).map(|i| ((i * 37 + 13) % 251) as u8).collect();
        let expected_sha = digest_to_hex(&Sha256::digest(&payload));

        let mut plan = plan_range_download(
            "https://example.com/fixture.bin?api_key=dummy_api_key_123",
            payload.len() as u64,
            2,
            128,
            &sb.outside_staging,
            &sb.workspace,
        )
        .expect("initial 2-stream plan");
        assert_eq!(plan.segments.len(), 2); // [0..511], [512..1023]

        // Stream 0 has completed 112 bytes (400 remaining); steal half -> [0..311], stolen [312..511].
        let stolen = split_largest_active_segment(&mut plan.segments, 0, 112, 100)
            .expect("split remaining tail");
        assert_eq!(stolen.segment_id, 2);
        assert_eq!(stolen.start_byte, 312);
        assert_eq!(stolen.end_byte, 511);
        assert_eq!(plan.segments.len(), 3);
        assert_eq!(plan.segments[0].start_byte, 0);
        assert_eq!(plan.segments[0].end_byte, 311);
        assert_eq!(plan.segments[1], stolen);
        assert_eq!(plan.segments[2].start_byte, 512);
        assert_eq!(plan.segments[2].end_byte, 1023);

        // Cannot split if remaining tail < 2 * min_split_bytes.
        let too_small = split_largest_active_segment(&mut plan.segments, 2, 150, 50).unwrap_err();
        assert!(matches!(
            too_small,
            RangeDownloadError::SegmentNotSplittable { .. }
        ));

        // Assemble out-of-order chunks via plan verifier -> verifies exact bytes and SHA-256.
        let c0 = payload[0..=311].to_vec();
        let c2 = payload[312..=511].to_vec();
        let c1 = payload[512..=1023].to_vec();

        let verified = assemble_plan_chunks_and_verify(
            &plan.segments,
            &[(1, c1.clone()), (0, c0.clone()), (2, c2.clone())],
            &expected_sha.to_ascii_uppercase(),
        )
        .expect("assembled sha256 matches");
        assert_eq!(verified.total_bytes, payload.len());
        assert_eq!(verified.sha256_hex, expected_sha);
        assert_eq!(verified.bytes, payload);

        // Direct ordered slice assembly + tampered byte mismatch detection.
        let ordered_ok = assemble_and_verify_chunks(&[&c0, &c2, &c1], &expected_sha).unwrap();
        assert_eq!(ordered_ok.segment_count, 3);

        let mut tampered = c2;
        tampered[0] ^= 0xFF;
        let mismatch = assemble_and_verify_chunks(&[&c0, &tampered, &c1], &expected_sha).unwrap_err();
        assert!(matches!(mismatch, RangeDownloadError::Sha256Mismatch { .. }));
    }
}
