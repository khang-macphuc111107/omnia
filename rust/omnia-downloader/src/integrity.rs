//! Streaming SHA-256 and CRC32C (`X-Goog-Hash`) integrity verification.
//!
//! Reads files in fixed 64 KiB chunks so multi-gigabyte downloads never buffer in RAM.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use omnia_core::{base64_decode, base64_encode, hex_encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::DownloaderError;

/// Streaming read buffer size (64 KiB) for file digest verification.
const STREAM_BUF_BYTES: usize = 64 * 1024;

/// Reflected Castagnoli polynomial (`0x82F63B78`) for CRC32C (`X-Goog-Hash`).
const CRC32C_POLY_REFLECTED: u32 = 0x82F6_3B78;

/// Precomputed 256-entry lookup table for CRC32C (Castagnoli).
const fn build_crc32c_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ CRC32C_POLY_REFLECTED;
            } else {
                crc >>= 1;
            }
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

const CRC32C_TABLE: [u32; 256] = build_crc32c_table();

/// Pure-Rust streaming CRC32C (Castagnoli) hasher compatible with Google Cloud / Drive `X-Goog-Hash`.
#[derive(Debug, Clone)]
pub struct Crc32cHasher {
    state: u32,
}

impl Default for Crc32cHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Crc32cHasher {
    #[must_use]
    pub const fn new() -> Self {
        Self { state: !0u32 }
    }

    pub fn update(&mut self, data: &[u8]) {
        let mut crc = self.state;
        for &byte in data {
            let idx = ((crc ^ u32::from(byte)) & 0xFF) as usize;
            crc = (crc >> 8) ^ CRC32C_TABLE[idx];
        }
        self.state = crc;
    }

    #[must_use]
    pub const fn finalize(self) -> u32 {
        !self.state
    }

    /// Finalizes and returns the standard Google `X-Goog-Hash` Base64-encoded big-endian CRC32C.
    #[must_use]
    pub fn finalize_base64(self) -> String {
        base64_encode(&self.finalize().to_be_bytes())
    }
}

/// Computes CRC32C (Castagnoli) of an in-memory slice.
#[must_use]
pub fn crc32c_bytes(data: &[u8]) -> u32 {
    let mut hasher = Crc32cHasher::new();
    hasher.update(data);
    hasher.finalize()
}

/// Computes Google `X-Goog-Hash` Base64-encoded big-endian CRC32C of `data`.
#[must_use]
pub fn crc32c_base64(data: &[u8]) -> String {
    base64_encode(&crc32c_bytes(data).to_be_bytes())
}

/// Parsed fields from one or more HTTP `X-Goog-Hash` response headers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleHashHeader {
    pub crc32c_b64: Option<String>,
    pub md5_b64: Option<String>,
}

/// Parses HTTP `X-Goog-Hash` header values (e.g., `"crc32c=4waSgw==, md5=..."`).
#[must_use]
pub fn parse_x_goog_hash<'a>(values: impl IntoIterator<Item = &'a str>) -> GoogleHashHeader {
    let mut out = GoogleHashHeader::default();
    for raw in values {
        for part in raw.split(',') {
            let trimmed = part.trim();
            if let Some((key, val)) = trimmed.split_once('=') {
                let key_low = key.trim().to_ascii_lowercase();
                let val_clean = val.trim();
                if val_clean.is_empty() {
                    continue;
                }
                match key_low.as_str() {
                    "crc32c" => out.crc32c_b64 = Some(val_clean.to_string()),
                    "md5" => out.md5_b64 = Some(val_clean.to_string()),
                    _ => {}
                }
            }
        }
    }
    out
}

/// Decodes a Base64-encoded big-endian `X-Goog-Hash` CRC32C string into a `u32`.
pub fn decode_crc32c_base64(b64: &str) -> Result<u32, DownloaderError> {
    let decoded = base64_decode(b64.trim()).map_err(|err| {
        DownloaderError::InvalidInput(format!("invalid CRC32C base64 `{b64}`: {err}"))
    })?;
    if decoded.len() != 4 {
        return Err(DownloaderError::InvalidInput(format!(
            "CRC32C base64 must decode to 4 bytes, got {}",
            decoded.len()
        )));
    }
    Ok(u32::from_be_bytes([
        decoded[0], decoded[1], decoded[2], decoded[3],
    ]))
}

/// Streaming digest summary computed over a file on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityReport {
    pub total_bytes: u64,
    pub sha256_hex: String,
    pub crc32c_u32: u32,
    pub crc32c_b64: String,
    pub sha256_verified: bool,
    pub crc32c_verified: bool,
}

/// Computes both SHA-256 and CRC32C in a single streaming pass over `path` (64 KiB buffer).
pub fn hash_file_streaming(path: &Path) -> Result<(u64, String, u32, String), DownloaderError> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(STREAM_BUF_BYTES, file);
    let mut buf = vec![0u8; STREAM_BUF_BYTES];
    let mut sha = Sha256::new();
    let mut crc = Crc32cHasher::new();
    let mut total_bytes = 0u64;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        crc.update(&buf[..n]);
        total_bytes = total_bytes.saturating_add(n as u64);
    }

    let sha_hex = hex_encode(&sha.finalize());
    let crc_u32 = crc.finalize();
    let crc_b64 = base64_encode(&crc_u32.to_be_bytes());
    Ok((total_bytes, sha_hex, crc_u32, crc_b64))
}

/// Streams a file on disk once and verifies optional expected SHA-256 and/or `X-Goog-Hash` CRC32C.
pub fn verify_file_integrity(
    path: &Path,
    expected_sha256: Option<&str>,
    expected_crc32c_b64: Option<&str>,
) -> Result<IntegrityReport, DownloaderError> {
    let (total_bytes, actual_sha256, actual_crc32c_u32, actual_crc32c_b64) =
        hash_file_streaming(path)?;

    let mut sha256_verified = false;
    if let Some(exp_raw) = expected_sha256.map(str::trim).filter(|s| !s.is_empty()) {
        let exp = exp_raw
            .strip_prefix("sha256:")
            .or_else(|| exp_raw.strip_prefix("SHA256:"))
            .unwrap_or(exp_raw)
            .to_ascii_lowercase();
        if exp.len() != 64 || !exp.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(DownloaderError::InvalidInput(format!(
                "expected SHA-256 must be 64 hex characters, got `{exp_raw}`"
            )));
        }
        if actual_sha256 != exp {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "SHA-256",
                expected: exp,
                actual: actual_sha256,
            });
        }
        sha256_verified = true;
    }

    let mut crc32c_verified = false;
    if let Some(exp_b64) = expected_crc32c_b64.map(str::trim).filter(|s| !s.is_empty()) {
        let expected_u32 = decode_crc32c_base64(exp_b64)?;
        if actual_crc32c_u32 != expected_u32 {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "CRC32C",
                expected: exp_b64.to_string(),
                actual: actual_crc32c_b64,
            });
        }
        crc32c_verified = true;
    }

    Ok(IntegrityReport {
        total_bytes,
        sha256_hex: actual_sha256,
        crc32c_u32: actual_crc32c_u32,
        crc32c_b64: actual_crc32c_b64,
        sha256_verified,
        crc32c_verified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32c_matches_rfc3720_castagnoli_check_vector() {
        // Standard RFC 3720 / iSCSI Castagnoli check value for "123456789" is 0xE3069283.
        let crc = crc32c_bytes(b"123456789");
        assert_eq!(crc, 0xE306_9283);

        // Incremental updates match single-shot calculation.
        let mut h = Crc32cHasher::new();
        h.update(b"1234");
        h.update(b"56789");
        assert_eq!(h.finalize(), 0xE306_9283);

        // X-Goog-Hash Base64 round-trip.
        let b64 = crc32c_base64(b"123456789");
        assert_eq!(decode_crc32c_base64(&b64).unwrap(), 0xE306_9283);
    }

    #[test]
    fn parses_x_goog_hash_multi_value_headers() {
        let parsed = parse_x_goog_hash([
            "crc32c=4waSgw==, md5=1B2M2Y8AsgTpgAmY7PhCfg==",
        ]);
        assert_eq!(parsed.crc32c_b64.as_deref(), Some("4waSgw=="));
        assert_eq!(
            parsed.md5_b64.as_deref(),
            Some("1B2M2Y8AsgTpgAmY7PhCfg==")
        );
    }
}
