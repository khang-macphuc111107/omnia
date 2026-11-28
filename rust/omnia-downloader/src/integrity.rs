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

/// Pure-Rust RFC 1321 MD5 streaming hasher (`#![forbid(unsafe_code)]`, zero external deps).
#[derive(Debug, Clone)]
pub struct Md5Hasher {
    state: [u32; 4],
    count: u64,
    buffer: [u8; 64],
}

impl Default for Md5Hasher {
    fn default() -> Self {
        Self::new()
    }
}

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
    0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
    0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
    0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
    0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
    0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391,
];

impl Md5Hasher {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            count: 0,
            buffer: [0u8; 64],
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        let mut idx = (self.count as usize) & 0x3f;
        self.count = self.count.saturating_add(data.len() as u64);
        let mut pos = 0usize;
        if idx > 0 {
            let need = 64 - idx;
            if data.len() < need {
                self.buffer[idx..idx + data.len()].copy_from_slice(data);
                return;
            }
            self.buffer[idx..64].copy_from_slice(&data[..need]);
            let block = self.buffer;
            self.transform(&block);
            pos = need;
            idx = 0;
        }
        let _ = idx;
        while pos + 64 <= data.len() {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[pos..pos + 64]);
            self.transform(&block);
            pos += 64;
        }
        if pos < data.len() {
            let rem = data.len() - pos;
            self.buffer[..rem].copy_from_slice(&data[pos..]);
        }
    }

    fn transform(&mut self, block: &[u8; 64]) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            let j = i * 4;
            *word = u32::from_le_bytes([block[j], block[j + 1], block[j + 2], block[j + 3]]);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];

        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(f)
                .wrapping_add(MD5_K[i])
                .wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(MD5_S[i]));
            a = temp;
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }

    #[must_use]
    pub fn finalize(mut self) -> [u8; 16] {
        let bit_len = self.count.wrapping_mul(8);
        let idx = (self.count as usize) & 0x3f;
        let pad_len = if idx < 56 { 56 - idx } else { 120 - idx };
        let mut pad = vec![0u8; pad_len];
        pad[0] = 0x80;
        self.update(&pad);
        self.update(&bit_len.to_le_bytes());

        let mut out = [0u8; 16];
        for (i, w) in self.state.iter().enumerate() {
            out[i * 4..(i + 1) * 4].copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    #[must_use]
    pub fn finalize_hex(self) -> String {
        hex_encode(&self.finalize())
    }

    #[must_use]
    pub fn finalize_base64(self) -> String {
        base64_encode(&self.finalize())
    }
}

/// Computes RFC 1321 MD5 digest of an in-memory slice.
#[must_use]
pub fn md5_bytes(data: &[u8]) -> [u8; 16] {
    let mut h = Md5Hasher::new();
    h.update(data);
    h.finalize()
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
    #[serde(default)]
    pub md5_hex: String,
    #[serde(default)]
    pub md5_b64: String,
    #[serde(default)]
    pub md5_verified: bool,
}

/// Computes SHA-256, CRC32C, and MD5 in a single streaming pass over `path` (64 KiB buffer).
pub fn hash_file_streaming_full(path: &Path) -> Result<IntegrityReport, DownloaderError> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(STREAM_BUF_BYTES, file);
    let mut buf = vec![0u8; STREAM_BUF_BYTES];
    let mut sha = Sha256::new();
    let mut crc = Crc32cHasher::new();
    let mut md5 = Md5Hasher::new();
    let mut total_bytes = 0u64;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        crc.update(&buf[..n]);
        md5.update(&buf[..n]);
        total_bytes = total_bytes.saturating_add(n as u64);
    }

    let sha_hex = hex_encode(&sha.finalize());
    let crc_u32 = crc.finalize();
    let crc_b64 = base64_encode(&crc_u32.to_be_bytes());
    let md5_raw = md5.finalize();
    let md5_hex = hex_encode(&md5_raw);
    let md5_b64 = base64_encode(&md5_raw);

    Ok(IntegrityReport {
        total_bytes,
        sha256_hex: sha_hex,
        crc32c_u32: crc_u32,
        crc32c_b64: crc_b64,
        sha256_verified: false,
        crc32c_verified: false,
        md5_hex,
        md5_b64,
        md5_verified: false,
    })
}

/// Computes both SHA-256 and CRC32C in a single streaming pass over `path` (64 KiB buffer).
pub fn hash_file_streaming(path: &Path) -> Result<(u64, String, u32, String), DownloaderError> {
    let rep = hash_file_streaming_full(path)?;
    Ok((rep.total_bytes, rep.sha256_hex, rep.crc32c_u32, rep.crc32c_b64))
}

/// Streams a file on disk once and verifies optional expected SHA-256 and/or `X-Goog-Hash` CRC32C.
pub fn verify_file_integrity(
    path: &Path,
    expected_sha256: Option<&str>,
    expected_crc32c_b64: Option<&str>,
) -> Result<IntegrityReport, DownloaderError> {
    verify_file_integrity_with_md5(path, expected_sha256, expected_crc32c_b64, None)
}

/// Streams a file on disk once and verifies optional expected SHA-256, `X-Goog-Hash` CRC32C,
/// and/or expected MD5 (32-hex OR 24-char Base64, optional `md5:` prefix).
pub fn verify_file_integrity_with_md5(
    path: &Path,
    expected_sha256: Option<&str>,
    expected_crc32c_b64: Option<&str>,
    expected_md5: Option<&str>,
) -> Result<IntegrityReport, DownloaderError> {
    let mut rep = hash_file_streaming_full(path)?;

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
        if rep.sha256_hex != exp {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "SHA-256",
                expected: exp,
                actual: rep.sha256_hex,
            });
        }
        rep.sha256_verified = true;
    }

    if let Some(exp_b64) = expected_crc32c_b64.map(str::trim).filter(|s| !s.is_empty()) {
        let expected_u32 = decode_crc32c_base64(exp_b64)?;
        if rep.crc32c_u32 != expected_u32 {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "CRC32C",
                expected: exp_b64.to_string(),
                actual: rep.crc32c_b64,
            });
        }
        rep.crc32c_verified = true;
    }

    if let Some(exp_md5_raw) = expected_md5.map(str::trim).filter(|s| !s.is_empty()) {
        let clean = exp_md5_raw
            .strip_prefix("md5:")
            .or_else(|| exp_md5_raw.strip_prefix("MD5:"))
            .unwrap_or(exp_md5_raw)
            .trim();
        let expected_hex = if clean.len() == 32 && clean.bytes().all(|b| b.is_ascii_hexdigit()) {
            clean.to_ascii_lowercase()
        } else {
            let decoded = base64_decode(clean).map_err(|err| {
                DownloaderError::InvalidInput(format!("invalid expected MD5 `{exp_md5_raw}`: {err}"))
            })?;
            if decoded.len() != 16 {
                return Err(DownloaderError::InvalidInput(format!(
                    "expected MD5 must be 32 hex chars or 16-byte base64, got `{exp_md5_raw}`"
                )));
            }
            hex_encode(&decoded)
        };
        if rep.md5_hex != expected_hex {
            return Err(DownloaderError::IntegrityMismatch {
                algorithm: "MD5",
                expected: expected_hex,
                actual: rep.md5_hex,
            });
        }
        rep.md5_verified = true;
    }

    Ok(rep)
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

    #[test]
    fn md5_matches_rfc1321_vectors_and_verifies_hex_and_base64() {
        let mut h = Md5Hasher::new();
        h.update(b"");
        assert_eq!(h.finalize_hex(), "d41d8cd98f00b204e9800998ecf8427e");
        let mut h2 = Md5Hasher::new();
        h2.update(b"abc");
        assert_eq!(h2.finalize_hex(), "900150983cd24fb0d6963f7d28e17f72");
        let mut h3 = Md5Hasher::new();
        h3.update(b"message ");
        h3.update(b"digest");
        assert_eq!(h3.finalize_hex(), "f96b697d7cb7938d525a2f31aaf161d0");

        let path = std::env::temp_dir().join(format!(
            "omnia-dl-md5-test-{}.bin",
            omnia_core::uuid_v4_simple()
        ));
        std::fs::write(&path, b"abc").unwrap();
        let rep = verify_file_integrity_with_md5(
            &path,
            None,
            None,
            Some("900150983CD24FB0D6963F7D28E17F72"),
        )
        .unwrap();
        assert!(rep.md5_verified);
        assert_eq!(rep.md5_hex, "900150983cd24fb0d6963f7d28e17f72");
        let rep_b64 = verify_file_integrity_with_md5(&path, None, None, Some(&rep.md5_b64)).unwrap();
        assert!(rep_b64.md5_verified);

        let err = verify_file_integrity_with_md5(
            &path,
            None,
            None,
            Some("00000000000000000000000000000000"),
        )
        .unwrap_err();
        assert!(matches!(
            err,
            DownloaderError::IntegrityMismatch {
                algorithm: "MD5",
                ..
            }
        ));
        let _ = std::fs::remove_file(&path);
    }
}
