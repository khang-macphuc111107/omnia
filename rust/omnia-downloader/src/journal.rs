//! `.part.meta` v2 interval resume sidecars and binary `OMNF` + CRC32 resume journals
//! with strict pre-allocation bounds checks.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use omnia_connector_gateway::artifact_intake::{classify_http_validator, HttpValidatorStrength};
use serde::{Deserialize, Serialize};

use crate::chunker::{normalize_completed_intervals, record_completed_interval, total_interval_bytes};
use crate::types::{current_epoch_ms, validate_safe_local_path, DownloaderError, DRM_SUPPORTED};

/// Sidecar metadata schema version (`.part.meta` v2).
pub const PART_META_VERSION: u32 = 2;

/// Binary resume journal magic bytes (`"OMNF"`).
pub const OMNF_MAGIC: [u8; 4] = *b"OMNF";

/// Current binary `OMNF` journal format version.
pub const OMNF_VERSION: u16 = 1;

/// Fixed `OMNF` frame header length: magic(4) + version(2) + record_type(2) + payload_len(4).
pub const OMNF_HEADER_BYTES: usize = 12;

/// Fixed `OMNF` frame trailer length: CRC32(4).
pub const OMNF_CRC_BYTES: usize = 4;

/// Hard pre-allocation cap per single `OMNF` frame payload (1 MiB).
pub const MAX_OMNF_FRAME_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Hard pre-allocation cap on total records replayed from one `OMNF` journal file.
pub const MAX_OMNF_JOURNAL_RECORDS: usize = 65_536;

/// `.part.meta` v2 interval-based resume sidecar.
///
/// Stores canonical `completed_ranges: Vec<(u64, u64)>` instead of fixed stream slots so
/// changing concurrency (e.g., 8 -> 32 or 128 -> 2 streams) across pause/resume never loses progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartMetaV2 {
    pub version: u32,
    pub job_id: String,
    pub sanitized_url: String,
    pub destination_filename: String,
    pub total_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub validator_strength: HttpValidatorStrength,
    pub completed_ranges: Vec<(u64, u64)>,
    pub drm_supported: bool,
    pub updated_at_ms: u64,
}

impl PartMetaV2 {
    /// Creates a new v2 sidecar metadata record.
    #[must_use]
    pub fn new(
        job_id: impl Into<String>,
        sanitized_url: impl Into<String>,
        destination_filename: impl Into<String>,
        total_size: u64,
        etag: Option<String>,
        last_modified: Option<String>,
    ) -> Self {
        let validator_strength =
            classify_http_validator(etag.as_deref(), last_modified.as_deref());
        Self {
            version: PART_META_VERSION,
            job_id: job_id.into(),
            sanitized_url: sanitized_url.into(),
            destination_filename: destination_filename.into(),
            total_size,
            etag,
            last_modified,
            validator_strength,
            completed_ranges: Vec::new(),
            drm_supported: DRM_SUPPORTED,
            updated_at_ms: current_epoch_ms(),
        }
    }

    /// Records a completed inclusive byte interval `[start, end]` and coalesces adjacent ranges.
    pub fn add_completed_range(&mut self, start: u64, end: u64) {
        record_completed_interval(&mut self.completed_ranges, start, end, self.total_size);
        self.updated_at_ms = current_epoch_ms();
    }

    /// Total unique bytes completed across all recorded intervals.
    #[must_use]
    pub fn completed_bytes(&self) -> u64 {
        total_interval_bytes(&self.completed_ranges)
    }

    /// Returns the strong `If-Range` HTTP header value if eligible for safe resume.
    ///
    /// RFC 9110 §13.1.5 forbids weak ETags (`W/"..."`) in `If-Range`.
    #[must_use]
    pub fn if_range_validator(&self) -> Option<&str> {
        match self.validator_strength {
            HttpValidatorStrength::StrongEtag => self.etag.as_deref(),
            HttpValidatorStrength::LastModifiedOnly => self.last_modified.as_deref(),
            HttpValidatorStrength::WeakEtag | HttpValidatorStrength::None => None,
        }
    }

    /// Checks whether this sidecar can safely resume against freshly probed server headers.
    #[must_use]
    pub fn is_compatible_for_resume(
        &self,
        sanitized_url: &str,
        total_size: u64,
        probe_etag: Option<&str>,
        probe_last_modified: Option<&str>,
    ) -> bool {
        if self.version != PART_META_VERSION
            || self.sanitized_url != sanitized_url
            || self.total_size != total_size
            || total_size == 0
        {
            return false;
        }
        let probe_strength = classify_http_validator(probe_etag, probe_last_modified);
        match (self.validator_strength, probe_strength) {
            (HttpValidatorStrength::StrongEtag, HttpValidatorStrength::StrongEtag) => {
                self.etag.as_deref() == probe_etag
            }
            (HttpValidatorStrength::LastModifiedOnly, HttpValidatorStrength::LastModifiedOnly) => {
                self.last_modified.as_deref() == probe_last_modified
            }
            // Weak ETags and missing validators MUST force a fresh download to prevent silent corruption.
            _ => false,
        }
    }

    /// Atomically writes `.part.meta` via temp-file + rename.
    pub fn save_atomic(&self, path: &Path) -> Result<(), DownloaderError> {
        let safe_path = validate_safe_local_path(path, None)?;
        if let Some(parent) = safe_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp_name = format!(
            "{}.tmp",
            safe_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("part.meta")
        );
        let tmp_path = safe_path.with_file_name(tmp_name);
        let payload = serde_json::to_vec_pretty(self)?;
        fs::write(&tmp_path, payload)?;
        if safe_path.exists() {
            let _ = fs::remove_file(&safe_path);
        }
        fs::rename(&tmp_path, &safe_path)?;
        Ok(())
    }

    /// Loads and normalizes a `.part.meta` v2 sidecar from disk.
    pub fn load(path: &Path) -> Result<Self, DownloaderError> {
        let safe_path = validate_safe_local_path(path, None)?;
        let bytes = fs::read(&safe_path)?;
        let mut meta: Self = serde_json::from_slice(&bytes)?;
        if meta.version != PART_META_VERSION {
            return Err(DownloaderError::CorruptJournal {
                detail: format!("unsupported .part.meta version {}", meta.version),
            });
        }
        meta.completed_ranges =
            normalize_completed_intervals(&meta.completed_ranges, meta.total_size);
        meta.validator_strength =
            classify_http_validator(meta.etag.as_deref(), meta.last_modified.as_deref());
        meta.drm_supported = DRM_SUPPORTED;
        Ok(meta)
    }
}

/// Computes canonical `.part.meta` sidecar path for a `.part` path.
#[must_use]
pub fn part_meta_path_for(part_path: &Path) -> PathBuf {
    let mut os = part_path.as_os_str().to_os_string();
    os.push(".meta");
    PathBuf::from(os)
}

/// Computes canonical binary `OMNF` journal path for a `.part` path.
#[must_use]
pub fn omnf_journal_path_for(part_path: &Path) -> PathBuf {
    let mut os = part_path.as_os_str().to_os_string();
    os.push(".omnf");
    PathBuf::from(os)
}

/// Record types persisted inside binary `OMNF` + CRC32 resume journal frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OmnfRecord {
    JobInit {
        job_id: String,
        sanitized_url: String,
        total_size: u64,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    RangeCompleted {
        start: u64,
        end: u64,
    },
    TruncateFallback {
        reason: String,
    },
    ChecksumVerified {
        sha256_hex: String,
        crc32c_b64: String,
    },
    JobFinished {
        total_bytes: u64,
    },
}

impl OmnfRecord {
    #[must_use]
    const fn type_code(&self) -> u16 {
        match self {
            Self::JobInit { .. } => 1,
            Self::RangeCompleted { .. } => 2,
            Self::TruncateFallback { .. } => 3,
            Self::ChecksumVerified { .. } => 4,
            Self::JobFinished { .. } => 5,
        }
    }
}

/// Replayed state reconstructed from a sequence of verified `OMNF` frames.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OmnfReplayState {
    pub job_id: Option<String>,
    pub sanitized_url: Option<String>,
    pub total_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub completed_ranges: Vec<(u64, u64)>,
    pub fallback_truncated: bool,
    pub sha256_hex: Option<String>,
    pub crc32c_b64: Option<String>,
    pub finished: bool,
    pub records_replayed: usize,
}

/// Binary `OMNF` + CRC32 (`crc32fast`) append-only resume journal with strict pre-alloc bounds.
pub struct OmnfJournal;

impl OmnfJournal {
    /// Encodes a single [`OmnfRecord`] into an `OMNF` binary frame with trailing IEEE CRC32.
    pub fn encode_frame(record: &OmnfRecord) -> Result<Vec<u8>, DownloaderError> {
        let payload = serde_json::to_vec(record)?;
        if payload.len() > MAX_OMNF_FRAME_PAYLOAD_BYTES {
            return Err(DownloaderError::CorruptJournal {
                detail: format!(
                    "OMNF payload length {} exceeds cap {}",
                    payload.len(),
                    MAX_OMNF_FRAME_PAYLOAD_BYTES
                ),
            });
        }
        let payload_len = u32::try_from(payload.len()).map_err(|_| {
            DownloaderError::CorruptJournal {
                detail: "OMNF payload length overflowed u32".into(),
            }
        })?;

        let total_len = OMNF_HEADER_BYTES + payload.len() + OMNF_CRC_BYTES;
        let mut frame = Vec::with_capacity(total_len);
        frame.extend_from_slice(&OMNF_MAGIC);
        frame.extend_from_slice(&OMNF_VERSION.to_le_bytes());
        frame.extend_from_slice(&record.type_code().to_le_bytes());
        frame.extend_from_slice(&payload_len.to_le_bytes());
        frame.extend_from_slice(&payload);

        let crc = crc32fast::hash(&frame);
        frame.extend_from_slice(&crc.to_le_bytes());
        Ok(frame)
    }

    /// Decodes a stream of `OMNF` binary frames from `bytes`, verifying magic, version,
    /// strict pre-allocation length bounds, remaining buffer bounds, and CRC32 on every frame.
    pub fn decode_frames(bytes: &[u8]) -> Result<Vec<OmnfRecord>, DownloaderError> {
        let mut cursor = 0usize;
        let mut records = Vec::new();

        while cursor < bytes.len() {
            if records.len() >= MAX_OMNF_JOURNAL_RECORDS {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "OMNF record count exceeds cap {MAX_OMNF_JOURNAL_RECORDS}"
                    ),
                });
            }
            let remaining = bytes.len() - cursor;
            if remaining < OMNF_HEADER_BYTES + OMNF_CRC_BYTES {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "truncated OMNF frame header at offset {cursor} ({remaining} bytes left)"
                    ),
                });
            }

            let hdr = &bytes[cursor..cursor + OMNF_HEADER_BYTES];
            if hdr[0..4] != OMNF_MAGIC {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!("invalid OMNF magic at offset {cursor}"),
                });
            }
            let version = u16::from_le_bytes([hdr[4], hdr[5]]);
            if version != OMNF_VERSION {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!("unsupported OMNF version {version} at offset {cursor}"),
                });
            }
            let declared_type = u16::from_le_bytes([hdr[6], hdr[7]]);
            let payload_len = u32::from_le_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]) as usize;

            // Strict pre-allocation bounds check BEFORE slicing or allocating!
            if payload_len > MAX_OMNF_FRAME_PAYLOAD_BYTES {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "OMNF frame payload_len={payload_len} exceeds pre-alloc cap {MAX_OMNF_FRAME_PAYLOAD_BYTES}"
                    ),
                });
            }
            let frame_len = OMNF_HEADER_BYTES
                .checked_add(payload_len)
                .and_then(|v| v.checked_add(OMNF_CRC_BYTES))
                .ok_or_else(|| DownloaderError::CorruptJournal {
                    detail: "OMNF frame length integer overflow".into(),
                })?;
            if frame_len > remaining {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "OMNF frame claims {frame_len} bytes at offset {cursor}, only {remaining} bytes available"
                    ),
                });
            }

            let body_end = cursor + OMNF_HEADER_BYTES + payload_len;
            let expected_crc = u32::from_le_bytes([
                bytes[body_end],
                bytes[body_end + 1],
                bytes[body_end + 2],
                bytes[body_end + 3],
            ]);
            let actual_crc = crc32fast::hash(&bytes[cursor..body_end]);
            if actual_crc != expected_crc {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "OMNF CRC32 mismatch at offset {cursor}: expected 0x{expected_crc:08x}, got 0x{actual_crc:08x}"
                    ),
                });
            }

            let payload_slice = &bytes[cursor + OMNF_HEADER_BYTES..body_end];
            let record: OmnfRecord = serde_json::from_slice(payload_slice).map_err(|err| {
                DownloaderError::CorruptJournal {
                    detail: format!("OMNF payload JSON decode error at offset {cursor}: {err}"),
                }
            })?;
            if record.type_code() != declared_type {
                return Err(DownloaderError::CorruptJournal {
                    detail: format!(
                        "OMNF record type mismatch at offset {cursor}: header={declared_type}, payload={}",
                        record.type_code()
                    ),
                });
            }

            records.push(record);
            cursor += frame_len;
        }

        Ok(records)
    }

    /// Appends one `OMNF` frame atomically to `path`.
    pub fn append_record(path: &Path, record: &OmnfRecord) -> Result<(), DownloaderError> {
        let safe_path = validate_safe_local_path(path, None)?;
        if let Some(parent) = safe_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let frame = Self::encode_frame(record)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&safe_path)?;
        file.write_all(&frame)?;
        Ok(())
    }

    /// Reads and replays an `OMNF` journal file into [`OmnfReplayState`].
    pub fn replay_file(path: &Path) -> Result<OmnfReplayState, DownloaderError> {
        let safe_path = validate_safe_local_path(path, None)?;
        let meta = fs::metadata(&safe_path)?;
        let max_file_bytes = (MAX_OMNF_FRAME_PAYLOAD_BYTES as u64) * 16;
        if meta.len() > max_file_bytes {
            return Err(DownloaderError::CorruptJournal {
                detail: format!(
                    "OMNF journal file size {} exceeds safety cap {}",
                    meta.len(),
                    max_file_bytes
                ),
            });
        }
        let mut file = File::open(&safe_path)?;
        let mut buf = Vec::with_capacity(meta.len() as usize);
        file.read_to_end(&mut buf)?;
        let records = Self::decode_frames(&buf)?;
        Ok(Self::fold_records(&records))
    }

    /// Folds decoded `OMNF` records into a replay state snapshot.
    #[must_use]
    pub fn fold_records(records: &[OmnfRecord]) -> OmnfReplayState {
        let mut state = OmnfReplayState::default();
        for rec in records {
            state.records_replayed += 1;
            match rec {
                OmnfRecord::JobInit {
                    job_id,
                    sanitized_url,
                    total_size,
                    etag,
                    last_modified,
                } => {
                    state.job_id = Some(job_id.clone());
                    state.sanitized_url = Some(sanitized_url.clone());
                    state.total_size = *total_size;
                    state.etag = etag.clone();
                    state.last_modified = last_modified.clone();
                }
                OmnfRecord::RangeCompleted { start, end } => {
                    if state.total_size > 0 {
                        record_completed_interval(
                            &mut state.completed_ranges,
                            *start,
                            *end,
                            state.total_size,
                        );
                    } else {
                        state.completed_ranges.push((*start, *end));
                    }
                }
                OmnfRecord::TruncateFallback { .. } => {
                    state.completed_ranges.clear();
                    state.fallback_truncated = true;
                }
                OmnfRecord::ChecksumVerified {
                    sha256_hex,
                    crc32c_b64,
                } => {
                    state.sha256_hex = Some(sha256_hex.clone());
                    state.crc32c_b64 = Some(crc32c_b64.clone());
                }
                OmnfRecord::JobFinished { .. } => {
                    state.finished = true;
                }
            }
        }
        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_meta_v2_enforces_strong_if_range_and_rejects_weak_etag() {
        let mut meta = PartMetaV2::new(
            "job-1",
            "https://cdn.example.org/file.bin",
            "file.bin",
            10_000,
            Some("\"strong-etag-1\"".into()),
            Some("Wed, 21 Oct 2015 07:28:00 GMT".into()),
        );
        meta.add_completed_range(0, 999);
        meta.add_completed_range(1_000, 2_499);
        meta.add_completed_range(5_000, 5_999);
        assert_eq!(meta.completed_ranges, vec![(0, 2_499), (5_000, 5_999)]);
        assert_eq!(meta.completed_bytes(), 3_500);
        assert_eq!(meta.if_range_validator(), Some("\"strong-etag-1\""));
        assert!(meta.is_compatible_for_resume(
            "https://cdn.example.org/file.bin",
            10_000,
            Some("\"strong-etag-1\""),
            None
        ));
        assert!(!meta.is_compatible_for_resume(
            "https://cdn.example.org/file.bin",
            10_000,
            Some("\"different-etag\""),
            None
        ));

        let weak = PartMetaV2::new(
            "job-weak",
            "https://cdn.example.org/file.bin",
            "file.bin",
            10_000,
            Some("W/\"weak-etag\"".into()),
            None,
        );
        assert_eq!(weak.if_range_validator(), None);
        assert!(!weak.is_compatible_for_resume(
            "https://cdn.example.org/file.bin",
            10_000,
            Some("W/\"weak-etag\""),
            None
        ));
    }

    #[test]
    fn omnf_binary_crc32_roundtrip_and_bounds_protection() {
        let recs = vec![
            OmnfRecord::JobInit {
                job_id: "j-42".into(),
                sanitized_url: "https://example.org/data.bin".into(),
                total_size: 4096,
                etag: Some("\"v1\"".into()),
                last_modified: None,
            },
            OmnfRecord::RangeCompleted {
                start: 0,
                end: 2047,
            },
            OmnfRecord::RangeCompleted {
                start: 2048,
                end: 4095,
            },
            OmnfRecord::JobFinished { total_bytes: 4096 },
        ];
        let mut blob = Vec::new();
        for r in &recs {
            blob.extend_from_slice(&OmnfJournal::encode_frame(r).unwrap());
        }

        let decoded = OmnfJournal::decode_frames(&blob).unwrap();
        assert_eq!(decoded, recs);
        let replayed = OmnfJournal::fold_records(&decoded);
        assert_eq!(replayed.completed_ranges, vec![(0, 4095)]);
        assert!(replayed.finished);

        // Bit-flip corruption must fail CRC32 check.
        let mut corrupted = blob.clone();
        corrupted[15] ^= 0xFF;
        assert!(matches!(
            OmnfJournal::decode_frames(&corrupted),
            Err(DownloaderError::CorruptJournal { .. })
        ));

        // Malicious header claiming 0xFFFF_FFFF payload bytes must fail pre-alloc bounds immediately.
        let mut bomb = Vec::new();
        bomb.extend_from_slice(&OMNF_MAGIC);
        bomb.extend_from_slice(&OMNF_VERSION.to_le_bytes());
        bomb.extend_from_slice(&1u16.to_le_bytes());
        bomb.extend_from_slice(&u32::MAX.to_le_bytes());
        bomb.extend_from_slice(&[0u8; 8]);
        assert!(matches!(
            OmnfJournal::decode_frames(&bomb),
            Err(DownloaderError::CorruptJournal { .. })
        ));
    }
}
