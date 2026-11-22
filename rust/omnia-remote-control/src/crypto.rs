//! Pure-Rust cryptographic primitives for `omnia-remote-control`.
//!
//! Implements RFC 2104 HMAC-SHA256 over [`sha2::Sha256`], constant-time MAC
//! verification, domain-separated session key derivation, lowercase hex
//! encoding/decoding, and Base64 helpers without external HMAC/hex crates.

use std::fmt;
use std::hint::black_box;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// SHA-256 block size in bytes (RFC 2104 / FIPS 180-4).
const SHA256_BLOCK_BYTES: usize = 64;
/// SHA-256 output digest length in bytes.
pub const SHA256_DIGEST_BYTES: usize = 32;

/// Errors returned by cryptographic helpers.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// Hex string length was odd or did not match expected fixed byte width.
    #[error("invalid hex length: expected {expected} hex characters, got {actual}")]
    InvalidHexLength { expected: usize, actual: usize },
    /// Hex string contained a non-hexadecimal character.
    #[error("invalid hex character at byte index {index}")]
    InvalidHexChar { index: usize },
    /// Base64 payload could not be decoded.
    #[error("invalid base64 payload: {0}")]
    InvalidBase64(String),
    /// Constant-time MAC verification failed.
    #[error("HMAC-SHA256 verification failed")]
    MacMismatch,
    /// Key derivation input was invalid (for example empty secret or metadata).
    #[error("invalid key derivation input: {0}")]
    InvalidKeyMaterial(&'static str),
}

/// Wrapper for a 32-byte symmetric session MAC key whose `Debug` output is redacted.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKey([u8; SHA256_DIGEST_BYTES]);

impl SessionKey {
    /// Wraps a raw 32-byte symmetric session key.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; SHA256_DIGEST_BYTES]) -> Self {
        Self(bytes)
    }

    /// Returns the raw key bytes for cryptographic operations.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SHA256_DIGEST_BYTES] {
        &self.0
    }

    /// Returns the SHA-256 lowercase hex digest of the key (`shared_secret_digest`).
    #[must_use]
    pub fn digest_hex(&self) -> String {
        sha256_hex(&self.0)
    }
}

impl fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionKey(<redacted>)")
    }
}

impl Drop for SessionKey {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            black_box(std::mem::replace(byte, 0));
        }
    }
}

/// Computes SHA-256 digest of `data`.
#[must_use]
pub fn sha256(data: &[u8]) -> [u8; SHA256_DIGEST_BYTES] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; SHA256_DIGEST_BYTES];
    out.copy_from_slice(&digest);
    out
}

/// Computes lowercase hex-encoded SHA-256 digest of `data`.
#[must_use]
pub fn sha256_hex(data: &[u8]) -> String {
    encode_hex(&sha256(data))
}

/// Computes RFC 2104 HMAC-SHA256 over `data` using `key`.
#[must_use]
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; SHA256_DIGEST_BYTES] {
    let mut k0 = [0u8; SHA256_BLOCK_BYTES];
    if key.len() > SHA256_BLOCK_BYTES {
        let hashed = sha256(key);
        k0[..SHA256_DIGEST_BYTES].copy_from_slice(&hashed);
    } else {
        k0[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0u8; SHA256_BLOCK_BYTES];
    let mut opad = [0u8; SHA256_BLOCK_BYTES];
    for i in 0..SHA256_BLOCK_BYTES {
        ipad[i] = k0[i] ^ 0x36;
        opad[i] = k0[i] ^ 0x5c;
    }

    let mut inner_hasher = Sha256::new();
    inner_hasher.update(ipad);
    inner_hasher.update(data);
    let inner_digest = inner_hasher.finalize();

    let mut outer_hasher = Sha256::new();
    outer_hasher.update(opad);
    outer_hasher.update(inner_digest);
    let outer_digest = outer_hasher.finalize();

    let mut out = [0u8; SHA256_DIGEST_BYTES];
    out.copy_from_slice(&outer_digest);

    for byte in k0.iter_mut().chain(ipad.iter_mut()).chain(opad.iter_mut()) {
        black_box(std::mem::replace(byte, 0));
    }

    out
}

/// Computes RFC 2104 HMAC-SHA256 and encodes it as lowercase 64-character hex.
#[must_use]
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    encode_hex(&hmac_sha256(key, data))
}

/// Constant-time equality comparison for fixed 32-byte digests.
#[must_use]
pub fn constant_time_eq_32(a: &[u8; SHA256_DIGEST_BYTES], b: &[u8; SHA256_DIGEST_BYTES]) -> bool {
    let mut diff: u8 = 0;
    for i in 0..SHA256_DIGEST_BYTES {
        diff |= black_box(a[i] ^ b[i]);
    }
    black_box(diff) == 0
}

/// Constant-time equality comparison for arbitrary byte slices.
#[must_use]
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= black_box(x ^ y);
    }
    black_box(diff) == 0
}

/// Verifies a hex-encoded HMAC-SHA256 tag in constant time.
pub fn verify_hmac_sha256_hex(key: &[u8], data: &[u8], mac_hex: &str) -> Result<(), CryptoError> {
    let provided = decode_hex_32(mac_hex)?;
    let expected = hmac_sha256(key, data);
    if constant_time_eq_32(&expected, &provided) {
        Ok(())
    } else {
        Err(CryptoError::MacMismatch)
    }
}

/// Derives a domain-separated 32-byte session MAC key from a pairing secret and handshake inputs.
pub fn derive_session_key(
    pairing_secret: &[u8],
    session_id: &str,
    initiator_id: &str,
    approver_id: &str,
    offer_nonce: &str,
    approval_nonce: &str,
) -> Result<SessionKey, CryptoError> {
    if pairing_secret.is_empty() {
        return Err(CryptoError::InvalidKeyMaterial(
            "pairing secret must not be empty",
        ));
    }
    if session_id.is_empty()
        || initiator_id.is_empty()
        || approver_id.is_empty()
        || offer_nonce.is_empty()
        || approval_nonce.is_empty()
    {
        return Err(CryptoError::InvalidKeyMaterial(
            "session and handshake identifiers must not be empty",
        ));
    }

    let mut transcript = Vec::with_capacity(128);
    transcript.extend_from_slice(b"omnia-remote-control:v1:session-key");
    push_len_prefixed(&mut transcript, session_id.as_bytes());
    push_len_prefixed(&mut transcript, initiator_id.as_bytes());
    push_len_prefixed(&mut transcript, approver_id.as_bytes());
    push_len_prefixed(&mut transcript, offer_nonce.as_bytes());
    push_len_prefixed(&mut transcript, approval_nonce.as_bytes());

    Ok(SessionKey::from_bytes(hmac_sha256(
        pairing_secret,
        &transcript,
    )))
}

/// Appends `u32` big-endian length followed by raw bytes for unambiguous framing.
pub(crate) fn push_len_prefixed(buf: &mut Vec<u8>, field: &[u8]) {
    let len = u32::try_from(field.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(field);
}

/// Encodes `bytes` as lowercase hexadecimal.
#[must_use]
pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Decodes a 64-character hexadecimal string into a 32-byte array.
pub fn decode_hex_32(hex_str: &str) -> Result<[u8; SHA256_DIGEST_BYTES], CryptoError> {
    let bytes = hex_str.as_bytes();
    if bytes.len() != SHA256_DIGEST_BYTES * 2 {
        return Err(CryptoError::InvalidHexLength {
            expected: SHA256_DIGEST_BYTES * 2,
            actual: bytes.len(),
        });
    }
    let mut out = [0u8; SHA256_DIGEST_BYTES];
    for (idx, chunk) in bytes.as_chunks::<2>().0.iter().enumerate() {
        let hi = decode_nibble(chunk[0]).ok_or(CryptoError::InvalidHexChar { index: idx * 2 })?;
        let lo =
            decode_nibble(chunk[1]).ok_or(CryptoError::InvalidHexChar { index: idx * 2 + 1 })?;
        out[idx] = (hi << 4) | lo;
    }
    Ok(out)
}

const fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Encodes `bytes` as standard Base64.
#[must_use]
pub fn encode_base64(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

/// Decodes standard Base64 text into bytes.
pub fn decode_base64(input: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64_STANDARD
        .decode(input.as_bytes())
        .map_err(|err| CryptoError::InvalidBase64(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4231_test_case_1_20_byte_key() {
        let key = [0x0bu8; 20];
        let data = b"Hi There";
        let mac = hmac_sha256_hex(&key, data);
        assert_eq!(
            mac,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn rfc4231_test_case_2_jefe() {
        let key = b"Jefe";
        let data = b"what do ya want for nothing?";
        let mac = hmac_sha256_hex(key, data);
        assert_eq!(
            mac,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn rfc4231_test_cases_3_and_4() {
        // Test Case 3
        let key3 = [0xaau8; 20];
        let data3 = [0xddu8; 50];
        assert_eq!(
            hmac_sha256_hex(&key3, &data3),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        );

        // Test Case 4
        let key4: [u8; 25] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
        ];
        let data4 = [0xcdu8; 50];
        assert_eq!(
            hmac_sha256_hex(&key4, &data4),
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
        );
    }

    #[test]
    fn rfc4231_test_cases_6_and_7_over_block_size_key() {
        let key = [0xaau8; 131];
        let data6 = b"Test Using Larger Than Block-Size Key - Hash Key First";
        assert_eq!(
            hmac_sha256_hex(&key, data6),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );

        let data7 = b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.";
        assert_eq!(
            hmac_sha256_hex(&key, data7),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
        );
    }

    #[test]
    fn constant_time_mac_verification_and_tamper_rejection() {
        let key = b"omnia-pairing-secret-2026";
        let payload = b"session-1|seq-42|mouse-move";
        let tag = hmac_sha256_hex(key, payload);
        assert!(verify_hmac_sha256_hex(key, payload, &tag).is_ok());

        let mut tampered_bytes = decode_hex_32(&tag).expect("valid mac hex");
        tampered_bytes[31] ^= 0x01;
        let tampered_hex = encode_hex(&tampered_bytes);
        assert_eq!(
            verify_hmac_sha256_hex(key, payload, &tampered_hex),
            Err(CryptoError::MacMismatch)
        );
        assert_eq!(
            verify_hmac_sha256_hex(key, b"session-1|seq-43|mouse-move", &tag),
            Err(CryptoError::MacMismatch)
        );
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"omnia", b"omnia"));
    }

    #[test]
    fn hex_and_base64_round_trip_and_invalid_hex_rejection() {
        let raw = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11];
        let b64 = encode_base64(&raw);
        assert_eq!(decode_base64(&b64).expect("base64 decodes"), raw);
        assert!(matches!(
            decode_base64("not!valid!base64"),
            Err(CryptoError::InvalidBase64(_))
        ));
        assert!(matches!(
            decode_hex_32("deadbeef"),
            Err(CryptoError::InvalidHexLength {
                expected: 64,
                actual: 8
            })
        ));
        let bad_hex = format!("{}zz", "0".repeat(62));
        assert_eq!(
            decode_hex_32(&bad_hex),
            Err(CryptoError::InvalidHexChar { index: 62 })
        );
    }
}
