#![forbid(unsafe_code)]

//! Safe core primitives for Omnia: hashing, Base64/hex, CSPRNG UUIDs,
//! RFC 8259 JSON helpers, UTF-8 utilities, and zero-unsafe secret redaction.

mod encoding;
mod error;
mod json;
mod redactor;
mod utf8;

pub use encoding::{
    base64_decode, base64_encode, hex_decode, hex_encode, sha256_bytes, sha256_hex, uuid_v4,
    uuid_v4_simple,
};
pub use error::CoreError;
pub use json::{canonical_json, compact_json, parse_json, pretty_json, try_parse_json};
pub use redactor::SecretRedactor;
pub use utf8::{
    is_valid_utf8, now_epoch_ms, sanitize_utf8_lossy, truncate_utf8_bytes,
    truncate_utf8_codepoints, truncate_utf8_word_safe, utf8_codepoint_count,
    utf8_has_control_chars,
};
