//! Content-Addressable Blob Store (`sha256:<hex>`), anti-bomb bounded wire codecs,
//! and verifiable `CaptureBundle` manifests for OmniDrive Pro v5.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use omnia_core::{base64_decode, base64_encode, hex_encode};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::privacy::PrivacyShield;
use crate::types::{current_epoch_ms, validate_safe_local_path, DownloaderError};

/// Default per-blob inflation/wire ceiling (16 MiB).
pub const DEFAULT_MAX_INFLATE_BYTES: usize = 16 * 1024 * 1024;
/// Hard safety ceiling on JSON depth when opening untrusted wire payloads.
pub const MAX_WIRE_JSON_DEPTH: usize = 64;
/// Default in-memory CAS entry cap before FIFO eviction.
pub const DEFAULT_MAX_CAS_ENTRIES: usize = 512;

/// Content-addressed blob metadata using `sha256:<hex>` digests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CasBlobMeta {
    pub digest: String,
    pub sha256_hex: String,
    pub byte_len: usize,
    pub media_type: String,
    pub stored_at_ms: u64,
}

/// Thread-safe SHA-256 Content-Addressable Blob Store with optional external disk backing.
#[derive(Debug)]
pub struct ContentAddressableBlobStore {
    root_dir: Option<PathBuf>,
    max_blob_bytes: usize,
    max_entries: usize,
    blobs: Mutex<CasInner>,
}

#[derive(Debug, Default)]
struct CasInner {
    data: HashMap<String, (CasBlobMeta, Vec<u8>)>,
    order: VecDeque<String>,
}

impl ContentAddressableBlobStore {
    /// Creates an in-memory CAS blob store with bounded memory caps.
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            root_dir: None,
            max_blob_bytes: DEFAULT_MAX_INFLATE_BYTES,
            max_entries: DEFAULT_MAX_CAS_ENTRIES,
            blobs: Mutex::new(CasInner::default()),
        }
    }

    /// Creates a disk-backed CAS blob store strictly outside `workspace_root`.
    pub fn open_dir(
        root_dir: &Path,
        workspace_root: Option<&Path>,
    ) -> Result<Self, DownloaderError> {
        let safe_root = validate_safe_local_path(root_dir, workspace_root)?;
        fs::create_dir_all(safe_root.join("objects"))?;
        Ok(Self {
            root_dir: Some(safe_root),
            max_blob_bytes: DEFAULT_MAX_INFLATE_BYTES,
            max_entries: DEFAULT_MAX_CAS_ENTRIES,
            blobs: Mutex::new(CasInner::default()),
        })
    }

    /// Computes canonical `sha256:<hex>` digest for `bytes`.
    #[must_use]
    pub fn digest_for_bytes(bytes: &[u8]) -> (String, String) {
        let hash = Sha256::digest(bytes);
        let hex = hex_encode(&hash);
        (format!("sha256:{hex}"), hex)
    }

    /// Stores `bytes` content-addressably and returns `(CasBlobMeta, deduplicated)`.
    pub fn put(
        &self,
        bytes: &[u8],
        media_type: &str,
    ) -> Result<(CasBlobMeta, bool), DownloaderError> {
        if bytes.len() > self.max_blob_bytes {
            return Err(DownloaderError::InvalidInput(format!(
                "CAS blob size {} exceeds maximum {} bytes",
                bytes.len(),
                self.max_blob_bytes
            )));
        }

        let (digest, sha256_hex) = Self::digest_for_bytes(bytes);
        let meta = CasBlobMeta {
            digest: digest.clone(),
            sha256_hex: sha256_hex.clone(),
            byte_len: bytes.len(),
            media_type: media_type.trim().to_string(),
            stored_at_ms: current_epoch_ms(),
        };

        if let Some(root) = &self.root_dir {
            let obj_path = root.join("objects").join(&sha256_hex);
            if !obj_path.exists() {
                let tmp = root.join("objects").join(format!("{sha256_hex}.tmp"));
                fs::write(&tmp, bytes)?;
                fs::rename(&tmp, &obj_path)?;
            }
        }

        let mut guard = self.blobs.lock();
        if let Some((existing_meta, _)) = guard.data.get(&digest) {
            return Ok((existing_meta.clone(), true));
        }

        if guard.data.len() >= self.max_entries {
            if let Some(oldest) = guard.order.pop_front() {
                guard.data.remove(&oldest);
            }
        }
        guard.order.push_back(digest.clone());
        guard.data.insert(digest, (meta.clone(), bytes.to_vec()));
        Ok((meta, false))
    }

    /// Fetches blob bytes by `sha256:<hex>` or raw 64-hex digest and verifies SHA-256 integrity.
    pub fn get(&self, digest_or_hex: &str) -> Result<Option<(CasBlobMeta, Vec<u8>)>, DownloaderError> {
        let normalized = normalize_digest_key(digest_or_hex)?;
        let hex = normalized
            .strip_prefix("sha256:")
            .unwrap_or(&normalized)
            .to_string();

        if let Some((meta, bytes)) = self.blobs.lock().data.get(&normalized) {
            let (_, actual_hex) = Self::digest_for_bytes(bytes);
            if actual_hex != hex {
                return Err(DownloaderError::IntegrityMismatch {
                    algorithm: "SHA-256",
                    expected: hex,
                    actual: actual_hex,
                });
            }
            return Ok(Some((meta.clone(), bytes.clone())));
        }

        if let Some(root) = &self.root_dir {
            let obj_path = root.join("objects").join(&hex);
            if obj_path.exists() {
                let bytes = fs::read(&obj_path)?;
                let (actual_digest, actual_hex) = Self::digest_for_bytes(&bytes);
                if actual_hex != hex {
                    return Err(DownloaderError::IntegrityMismatch {
                        algorithm: "SHA-256",
                        expected: hex,
                        actual: actual_hex,
                    });
                }
                let meta = CasBlobMeta {
                    digest: actual_digest,
                    sha256_hex: hex,
                    byte_len: bytes.len(),
                    media_type: "application/octet-stream".to_string(),
                    stored_at_ms: current_epoch_ms(),
                };
                return Ok(Some((meta, bytes)));
            }
        }

        Ok(None)
    }

    /// Checks whether `digest_or_hex` exists and passes integrity verification.
    pub fn has(&self, digest_or_hex: &str) -> Result<bool, DownloaderError> {
        Ok(self.get(digest_or_hex)?.is_some())
    }
}

fn normalize_digest_key(raw: &str) -> Result<String, DownloaderError> {
    let trimmed = raw.trim().to_ascii_lowercase();
    let hex = trimmed.strip_prefix("sha256:").unwrap_or(&trimmed);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(DownloaderError::InvalidInput(format!(
            "invalid CAS sha256 digest '{raw}'"
        )));
    }
    Ok(format!("sha256:{hex}"))
}

/// Supported wire codec envelopes with strict anti-bomb limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireCodecKind {
    Json,
    Base64Json,
    XorJson { key: Vec<u8>, inner_base64: bool },
}

/// Seals `value` under the configured [`WireCodecKind`] and `max_bytes` bound.
pub fn seal_wire_value(
    kind: &WireCodecKind,
    value: &Value,
    max_bytes: usize,
) -> Result<Vec<u8>, DownloaderError> {
    let limit = max_bytes.max(1);
    let json_bytes = serde_json::to_vec(value)?;
    if json_bytes.len() > limit {
        return Err(DownloaderError::InvalidInput(format!(
            "ERR_MAX_INFLATE_EXCEEDED: serialized payload {} > limit {}",
            json_bytes.len(),
            limit
        )));
    }
    match kind {
        WireCodecKind::Json => Ok(json_bytes),
        WireCodecKind::Base64Json => Ok(base64_encode(&json_bytes).into_bytes()),
        WireCodecKind::XorJson { key, inner_base64 } => {
            if key.is_empty() {
                return Err(DownloaderError::InvalidInput(
                    "ERR_EMPTY_XOR_KEY: XOR wire codec requires a non-empty key".into(),
                ));
            }
            let inner = if *inner_base64 {
                base64_encode(&json_bytes).into_bytes()
            } else {
                json_bytes
            };
            Ok(xor_mask(&inner, key))
        }
    }
}

/// Decodes and validates wire payload bytes with strict pre-decode length & nesting bounds.
pub fn open_wire_value(
    kind: &WireCodecKind,
    raw: &[u8],
    max_inflate_bytes: usize,
) -> Result<Value, DownloaderError> {
    let limit = max_inflate_bytes.max(1);
    let max_wire = limit.saturating_mul(2);
    if raw.len() > max_wire {
        return Err(DownloaderError::InvalidInput(format!(
            "ERR_MAX_INFLATE_EXCEEDED: wire payload {} > limit {}",
            raw.len(),
            max_wire
        )));
    }

    let decoded = match kind {
        WireCodecKind::Json => {
            if raw.len() > limit {
                return Err(DownloaderError::InvalidInput(format!(
                    "ERR_MAX_INFLATE_EXCEEDED: JSON payload {} > limit {}",
                    raw.len(),
                    limit
                )));
            }
            raw.to_vec()
        }
        WireCodecKind::Base64Json => decode_bounded_base64_json(raw, limit)?,
        WireCodecKind::XorJson { key, inner_base64 } => {
            if key.is_empty() {
                return Err(DownloaderError::InvalidInput(
                    "ERR_EMPTY_XOR_KEY: XOR wire codec requires a non-empty key".into(),
                ));
            }
            let unmasked = xor_mask(raw, key);
            if *inner_base64 {
                decode_bounded_base64_json(&unmasked, limit)?
            } else {
                if unmasked.len() > limit {
                    return Err(DownloaderError::InvalidInput(format!(
                        "ERR_MAX_INFLATE_EXCEEDED: XOR inner JSON {} > limit {}",
                        unmasked.len(),
                        limit
                    )));
                }
                unmasked
            }
        }
    };

    let val: Value = serde_json::from_slice(&decoded)?;
    enforce_json_depth(&val, MAX_WIRE_JSON_DEPTH)?;
    Ok(val)
}

fn decode_bounded_base64_json(raw: &[u8], limit: usize) -> Result<Vec<u8>, DownloaderError> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| DownloaderError::InvalidInput("ERR_INVALID_BASE64: non-UTF8 base64".into()))?
        .trim();
    let est = (text.len().saturating_mul(3)) / 4;
    if est > limit.saturating_add(4) {
        return Err(DownloaderError::InvalidInput(format!(
            "ERR_MAX_INFLATE_EXCEEDED: estimated base64 decode {} > limit {}",
            est, limit
        )));
    }
    let decoded = base64_decode(text).map_err(|e| {
        DownloaderError::InvalidInput(format!("ERR_INVALID_BASE64: malformed base64 ({e})"))
    })?;
    if decoded.len() > limit {
        return Err(DownloaderError::InvalidInput(format!(
            "ERR_MAX_INFLATE_EXCEEDED: decoded base64 {} > limit {}",
            decoded.len(),
            limit
        )));
    }
    Ok(decoded)
}

fn xor_mask(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

fn enforce_json_depth(val: &Value, remaining: usize) -> Result<(), DownloaderError> {
    if remaining == 0 {
        return Err(DownloaderError::InvalidInput(
            "ERR_JSON_DEPTH_EXCEEDED: wire payload nesting depth limit exceeded".into(),
        ));
    }
    match val {
        Value::Array(items) => {
            for item in items {
                enforce_json_depth(item, remaining - 1)?;
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                enforce_json_depth(v, remaining - 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Entry inside a verifiable [`CaptureBundle`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureBundleEntry {
    pub name: String,
    pub media_type: String,
    pub digest: String,
    pub byte_len: usize,
}

/// Secret-free CAS CaptureBundle manifest linking immutable SHA-256 content entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureBundle {
    pub schema_version: String,
    pub bundle_id: String,
    pub sanitized_source_url: String,
    pub created_at_ms: u64,
    pub total_bytes: usize,
    pub entries: Vec<CaptureBundleEntry>,
    pub metadata: Value,
    pub manifest_sha256: String,
}

impl CaptureBundle {
    /// Builds and seals a [`CaptureBundle`] in `store` from `(name, media_type, bytes)` parts.
    pub fn build_and_seal(
        store: &ContentAddressableBlobStore,
        bundle_id: String,
        source_url: &str,
        parts: &[(&str, &str, &[u8])],
        metadata: Value,
    ) -> Result<Self, DownloaderError> {
        let sanitized_source_url = PrivacyShield::sanitize_for_receipt(source_url);
        let created_at_ms = current_epoch_ms();
        let mut entries = Vec::with_capacity(parts.len());
        let mut total_bytes = 0usize;

        for (name, media_type, bytes) in parts {
            let (meta, _) = store.put(bytes, media_type)?;
            total_bytes = total_bytes.saturating_add(meta.byte_len);
            entries.push(CaptureBundleEntry {
                name: (*name).to_string(),
                media_type: meta.media_type,
                digest: meta.digest,
                byte_len: meta.byte_len,
            });
        }

        let canonical_for_hash = json!({
            "schema_version": "omnia.capture-bundle.v1",
            "bundle_id": bundle_id,
            "sanitized_source_url": sanitized_source_url,
            "created_at_ms": created_at_ms,
            "total_bytes": total_bytes,
            "entries": entries,
            "metadata": metadata,
        });
        let manifest_sha256 =
            hex_encode(&Sha256::digest(serde_json::to_vec(&canonical_for_hash)?));

        Ok(Self {
            schema_version: "omnia.capture-bundle.v1".to_string(),
            bundle_id,
            sanitized_source_url,
            created_at_ms,
            total_bytes,
            entries,
            metadata,
            manifest_sha256,
        })
    }

    /// Verifies manifest digest AND verifies every referenced CAS blob in `store`.
    pub fn verify_all(&self, store: &ContentAddressableBlobStore) -> Result<bool, DownloaderError> {
        let canonical_for_hash = json!({
            "schema_version": self.schema_version,
            "bundle_id": self.bundle_id,
            "sanitized_source_url": self.sanitized_source_url,
            "created_at_ms": self.created_at_ms,
            "total_bytes": self.total_bytes,
            "entries": self.entries,
            "metadata": self.metadata,
        });
        let actual_manifest =
            hex_encode(&Sha256::digest(serde_json::to_vec(&canonical_for_hash)?));
        if actual_manifest != self.manifest_sha256 {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "SHA-256",
                expected: self.manifest_sha256.clone(),
                actual: actual_manifest,
            });
        }
        for entry in &self.entries {
            if !store.has(&entry.digest)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_bundle_stores_dedups_and_verifies_integrity() {
        let cas = ContentAddressableBlobStore::in_memory();
        let (m1, d1) = cas.put(b"hello world", "text/plain").expect("put 1");
        let (m2, d2) = cas.put(b"hello world", "text/plain").expect("put 2");
        assert!(!d1);
        assert!(d2);
        assert_eq!(m1.digest, m2.digest);
        assert!(m1.digest.starts_with("sha256:"));

        let bundle = CaptureBundle::build_and_seal(
            &cas,
            "bundle-1".to_string(),
            "https://cdn.example.org/course/video?token=secret_tok_123",
            &[
                ("manifest.m3u8", "application/vnd.apple.mpegurl", b"#EXTM3U\n"),
                ("notes.txt", "text/plain", b"hello world"),
            ],
            json!({ "course": "CS101" }),
        )
        .expect("build bundle");
        assert!(!bundle.sanitized_source_url.contains("secret_tok_123"));
        assert!(bundle.verify_all(&cas).expect("verify bundle"));
    }

    #[test]
    fn wire_codecs_roundtrip_and_reject_anti_bomb_overflow() {
        let val = json!({ "status": "ok", "items": [1, 2, 3] });
        let xor_codec = WireCodecKind::XorJson {
            key: b"k-dummy".to_vec(),
            inner_base64: true,
        };
        let sealed = seal_wire_value(&xor_codec, &val, 4096).expect("seal");
        let opened = open_wire_value(&xor_codec, &sealed, 4096).expect("open");
        assert_eq!(opened, val);

        let bomb_err = open_wire_value(&WireCodecKind::Json, &vec![b' '; 2048], 512)
            .expect_err("must reject over-limit wire payload");
        assert!(bomb_err.to_string().contains("ERR_MAX_INFLATE_EXCEEDED"));
    }
}
