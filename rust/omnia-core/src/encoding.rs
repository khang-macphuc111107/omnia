use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use sha2::{Digest as _, Sha256};

use crate::error::CoreError;

const LOWER_HEX: &[u8; 16] = b"0123456789abcdef";

/// Compute the raw 32-byte SHA-256 digest of `bytes`.
#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Compute the lowercase 64-character hexadecimal SHA-256 digest of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256_bytes(bytes);
    hex_encode(&digest)
}

/// Encode `bytes` as lowercase hexadecimal.
#[must_use]
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(LOWER_HEX[(b >> 4) as usize] as char);
        out.push(LOWER_HEX[(b & 0x0F) as usize] as char);
    }
    out
}

/// Decode an even-length hexadecimal string (upper or lower case) into bytes.
pub fn hex_decode(s: &str) -> Result<Vec<u8>, CoreError> {
    let raw = s.as_bytes();
    if !raw.len().is_multiple_of(2) {
        return Err(CoreError::InvalidHex(format!(
            "hex input must have even length, got {}",
            raw.len()
        )));
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    let (chunks, _) = raw.as_chunks::<2>();
    for (idx, chunk) in chunks.iter().enumerate() {
        let hi = decode_nibble(chunk[0]).ok_or_else(|| {
            CoreError::InvalidHex(format!("invalid hex digit at byte {}", idx * 2))
        })?;
        let lo = decode_nibble(chunk[1]).ok_or_else(|| {
            CoreError::InvalidHex(format!("invalid hex digit at byte {}", idx * 2 + 1))
        })?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn decode_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Encode `bytes` using standard Base64 with `=` padding.
#[must_use]
pub fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decode a standard Base64 string.
pub fn base64_decode(s: &str) -> Result<Vec<u8>, CoreError> {
    STANDARD
        .decode(s.as_bytes())
        .map_err(|err| CoreError::InvalidBase64(err.to_string()))
}

/// Generate a random RFC 4122 version-4 UUID in canonical lowercase hyphenated form
/// (`8-4-4-4-12`) using OS CSPRNG entropy (`getrandom`).
pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG getrandom failed");
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    let hex = hex_encode(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Generate a 32-character lowercase unhyphenated UUID v4 string.
pub fn uuid_v4_simple() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG getrandom failed");
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    hex_encode(&bytes)
}
