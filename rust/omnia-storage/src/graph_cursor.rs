use omnia_core::{hex_decode, hex_encode, sha256_bytes, uuid_v4};
use serde::{Deserialize, Serialize};

use crate::error::StoreError;

/// Prefix identifying signed Omnia keyset graph pagination cursors.
pub const GRAPH_CURSOR_PREFIX: &str = "srgr1";

/// Minimum HMAC key length enforced for graph cursor signing/verification.
pub const MIN_GRAPH_CURSOR_SECRET_BYTES: usize = 16;

/// Opaque payload carried inside an HMAC-SHA256 signed [`GRAPH_CURSOR_PREFIX`] cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphKeysetCursor {
    pub version: u8,
    pub scope: String,
    pub watermark_seq: i64,
    pub tie_breaker_id: String,
    pub direction: String,
    pub issued_at_ms: i64,
}

impl GraphKeysetCursor {
    #[must_use]
    pub fn new(
        scope: impl Into<String>,
        watermark_seq: i64,
        tie_breaker_id: impl Into<String>,
        direction: impl Into<String>,
        issued_at_ms: i64,
    ) -> Self {
        Self {
            version: 1,
            scope: scope.into(),
            watermark_seq,
            tie_breaker_id: tie_breaker_id.into(),
            direction: direction.into(),
            issued_at_ms,
        }
    }
}

/// Self-contained RFC 2104 HMAC-SHA256 keyset graph cursor codec (`srgr1.<hex-json>.<hex-hmac-sha256>`).
#[derive(Debug, Clone)]
pub struct GraphCursorCodec {
    secret: Vec<u8>,
}

impl GraphCursorCodec {
    /// Construct a cursor codec from a high-entropy HMAC secret (`>= 16` bytes).
    pub fn new(secret: impl Into<Vec<u8>>) -> Result<Self, StoreError> {
        let key = secret.into();
        if key.len() < MIN_GRAPH_CURSOR_SECRET_BYTES {
            return Err(StoreError::invalid_input(format!(
                "Graph cursor secret must be at least {MIN_GRAPH_CURSOR_SECRET_BYTES} bytes."
            )));
        }
        Ok(Self { secret: key })
    }

    /// Generate a fresh 32-byte random signing key using CSPRNG-backed UUID entropy.
    #[must_use]
    pub fn generate_secret() -> [u8; 32] {
        new_graph_cursor_secret()
    }

    /// Encode and sign a keyset cursor token (`srgr1.<hex-json>.<hex-hmac-sha256>`).
    pub fn encode(&self, cursor: &GraphKeysetCursor) -> Result<String, StoreError> {
        encode_graph_cursor(&self.secret, cursor)
    }

    /// Verify HMAC-SHA256 signature in constant time and decode a cursor bound to `expected_scope`.
    pub fn decode(&self, expected_scope: &str, token: &str) -> Result<GraphKeysetCursor, StoreError> {
        decode_graph_cursor(&self.secret, expected_scope, token)
    }
}

/// Generate a fresh 32-byte CSPRNG-backed HMAC signing secret.
#[must_use]
pub fn new_graph_cursor_secret() -> [u8; 32] {
    let entropy = format!("{}:{}:srgr1", uuid_v4(), uuid_v4());
    sha256_bytes(entropy.as_bytes())
}

/// Compute RFC 2104 HMAC-SHA256 over `message` using pure-Rust `omnia_core::sha256_bytes`.
#[must_use]
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized_key = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let digest = sha256_bytes(key);
        normalized_key[..32].copy_from_slice(&digest);
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }

    let mut inner_buf = Vec::with_capacity(BLOCK_SIZE + message.len());
    for byte in normalized_key {
        inner_buf.push(byte ^ 0x36);
    }
    inner_buf.extend_from_slice(message);
    let inner_hash = sha256_bytes(&inner_buf);

    let mut outer_buf = [0u8; BLOCK_SIZE + 32];
    for (idx, byte) in normalized_key.iter().enumerate() {
        outer_buf[idx] = byte ^ 0x5c;
    }
    outer_buf[BLOCK_SIZE..].copy_from_slice(&inner_hash);
    sha256_bytes(&outer_buf)
}

/// Encode and HMAC-sign a graph keyset cursor (`srgr1.<hex-json>.<hex-hmac-sha256>`).
pub fn encode_graph_cursor(secret: &[u8], cursor: &GraphKeysetCursor) -> Result<String, StoreError> {
    if secret.len() < MIN_GRAPH_CURSOR_SECRET_BYTES {
        return Err(StoreError::invalid_input(format!(
            "Graph cursor secret must be at least {MIN_GRAPH_CURSOR_SECRET_BYTES} bytes."
        )));
    }
    if cursor.version != 1 {
        return Err(StoreError::invalid_input(format!(
            "Unsupported graph cursor version {}.",
            cursor.version
        )));
    }
    if cursor.scope.trim().is_empty() {
        return Err(StoreError::invalid_input("Graph cursor scope must not be empty."));
    }
    if !matches!(cursor.direction.as_str(), "forward" | "backward") {
        return Err(StoreError::invalid_input(format!(
            "Unsupported graph cursor direction '{}'.",
            cursor.direction
        )));
    }

    let payload_bytes = serde_json::to_vec(cursor).map_err(|e| {
        StoreError::invalid_input(format!("Failed serializing graph cursor JSON: {e}"))
    })?;
    let payload_hex = hex_encode(&payload_bytes);
    let signed_input = format!("{GRAPH_CURSOR_PREFIX}.{payload_hex}");
    let mac = hmac_sha256(secret, signed_input.as_bytes());
    Ok(format!("{signed_input}.{}", hex_encode(&mac)))
}

/// Verify and decode an HMAC-signed graph keyset cursor (`srgr1.<hex-json>.<hex-hmac-sha256>`).
pub fn decode_graph_cursor(
    secret: &[u8],
    expected_scope: &str,
    token: &str,
) -> Result<GraphKeysetCursor, StoreError> {
    if secret.len() < MIN_GRAPH_CURSOR_SECRET_BYTES {
        return Err(StoreError::invalid_input(format!(
            "Graph cursor secret must be at least {MIN_GRAPH_CURSOR_SECRET_BYTES} bytes."
        )));
    }
    if expected_scope.trim().is_empty() {
        return Err(StoreError::invalid_input("Expected graph cursor scope must not be empty."));
    }

    let trimmed = token.trim();
    let mut parts = trimmed.split('.');
    let prefix = parts
        .next()
        .ok_or_else(|| StoreError::invalid_input("Malformed graph cursor: missing prefix."))?;
    let payload_hex = parts
        .next()
        .ok_or_else(|| StoreError::invalid_input("Malformed graph cursor: missing payload."))?;
    let sig_hex = parts
        .next()
        .ok_or_else(|| StoreError::invalid_input("Malformed graph cursor: missing signature."))?;
    if parts.next().is_some() {
        return Err(StoreError::invalid_input(
            "Malformed graph cursor: unexpected extra segments.",
        ));
    }
    if prefix != GRAPH_CURSOR_PREFIX {
        return Err(StoreError::invalid_input(format!(
            "Invalid graph cursor prefix '{prefix}'."
        )));
    }

    let sig_bytes = hex_decode(sig_hex)
        .map_err(|e| StoreError::invalid_input(format!("Invalid cursor signature hex: {e}")))?;
    if sig_bytes.len() != 32 {
        return Err(StoreError::invalid_input(
            "Invalid graph cursor signature length.",
        ));
    }

    let signed_input = format!("{GRAPH_CURSOR_PREFIX}.{payload_hex}");
    let expected_mac = hmac_sha256(secret, signed_input.as_bytes());
    if !constant_time_eq(&sig_bytes, &expected_mac) {
        return Err(StoreError::invalid_input(
            "Graph cursor HMAC verification failed.",
        ));
    }

    let payload_bytes = hex_decode(payload_hex)
        .map_err(|e| StoreError::invalid_input(format!("Invalid cursor payload hex: {e}")))?;
    let cursor: GraphKeysetCursor = serde_json::from_slice(&payload_bytes).map_err(|e| {
        StoreError::invalid_input(format!("Malformed graph cursor JSON payload: {e}"))
    })?;
    if cursor.version != 1 {
        return Err(StoreError::invalid_input(format!(
            "Unsupported graph cursor version {}.",
            cursor.version
        )));
    }
    if cursor.scope != expected_scope {
        return Err(StoreError::invalid_input(format!(
            "Graph cursor scope mismatch: expected '{expected_scope}', got '{}'.",
            cursor.scope
        )));
    }
    if !matches!(cursor.direction.as_str(), "forward" | "backward") {
        return Err(StoreError::invalid_input(format!(
            "Unsupported graph cursor direction '{}'.",
            cursor.direction
        )));
    }
    Ok(cursor)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc4231_vectors() {
        // RFC 4231 Test Case 1
        let key1 = [0x0bu8; 20];
        let data1 = b"Hi There";
        assert_eq!(
            hex_encode(&hmac_sha256(&key1, data1)),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );

        // RFC 4231 Test Case 2
        let key2 = b"Jefe";
        let data2 = b"what do ya want for nothing?";
        assert_eq!(
            hex_encode(&hmac_sha256(key2, data2)),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );

        // Block-size (>64 bytes) key normalization check (RFC 4231 Test Case 6)
        let key6 = [0xaau8; 131];
        let data6 = b"Test Using Larger Than Block-Size Key - Hash Key First";
        assert_eq!(
            hex_encode(&hmac_sha256(&key6, data6)),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn srgr1_graph_cursor_roundtrip_and_tamper_rejection() {
        let secret = new_graph_cursor_secret();
        let codec = GraphCursorCodec::new(secret.to_vec()).expect("codec");
        let cursor = GraphKeysetCursor::new("peer_messages", 42, "msg_42", "forward", 1_700_000_000_000);
        let token = codec.encode(&cursor).expect("encode");
        assert!(token.starts_with("srgr1."));
        assert_eq!(token.split('.').count(), 3);

        let decoded = codec.decode("peer_messages", &token).expect("decode");
        assert_eq!(decoded, cursor);

        // Wrong scope must fail
        let wrong_scope = codec
            .decode("workspace_nodes", &token)
            .expect_err("scope mismatch");
        assert!(wrong_scope.to_string().contains("scope mismatch"));

        // Wrong key must fail
        let other = GraphCursorCodec::new(new_graph_cursor_secret().to_vec()).expect("other");
        assert!(other.decode("peer_messages", &token).is_err());

        // Single-char tamper in payload or signature must fail
        let mut tampered = token.clone().into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'0' { b'1' } else { b'0' };
        let tampered_str = String::from_utf8(tampered).unwrap();
        assert!(codec.decode("peer_messages", &tampered_str).is_err());

        // Legacy prefix or trailing garbage must fail
        assert!(codec
            .decode("peer_messages", &format!("srgr0.{}", &token[6..]))
            .is_err());
        assert!(codec
            .decode("peer_messages", &format!("{token}.extra"))
            .is_err());
    }

    #[test]
    fn stores_enforce_trusted_schema_off_and_secure_delete_on() {
        let harness = crate::HarnessStore::open_in_memory().expect("harness store");
        let mut s_trusted = harness
            .connection()
            .prepare("PRAGMA trusted_schema;")
            .expect("trusted_schema");
        assert_eq!(
            s_trusted.step().expect("step"),
            omnia_winsqlite::StepStatus::Row
        );
        assert_eq!(s_trusted.column_int64(0).expect("val"), 0);

        let mut s_secure = harness
            .connection()
            .prepare("PRAGMA secure_delete;")
            .expect("secure_delete");
        assert_eq!(
            s_secure.step().expect("step"),
            omnia_winsqlite::StepStatus::Row
        );
        assert_eq!(s_secure.column_int64(0).expect("val"), 1);

        // Verify SessionStore and RecallStore open cleanly with security PRAGMAs enforced.
        let _sess = crate::SessionStore::open_in_memory().expect("session store");
        let _recall = crate::RecallStore::open_in_memory().expect("recall store");
        let _repo = crate::ProviderProfileRepository::open_in_memory().expect("profile repo");
    }
}
