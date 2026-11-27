#![deny(unsafe_code)]

//! Safe core primitives for Omnia: hashing, Base64/hex, CSPRNG UUIDs,
//! RFC 8259 JSON helpers, UTF-8/UTF-16 utilities, bilingual span-protected
//! normalization, Win32 Credential Manager, and secret redaction.

pub mod credentials;
mod encoding;
mod error;
mod json;
pub mod prompt_norm;
mod redactor;
pub mod utf16;
mod utf8;

pub use credentials::{
    mask_secret_hint, normalize_credential_target, CredentialStore, MaskedCredential,
    RedactedSecret, OMNIA_CREDENTIAL_PREFIX,
};
pub use encoding::{
    base64_decode, base64_encode, hex_decode, hex_encode, sha256_bytes, sha256_hex, uuid_v4,
    uuid_v4_simple,
};
pub use error::CoreError;
pub use json::{canonical_json, compact_json, parse_json, pretty_json, try_parse_json};
pub use prompt_norm::{
    detect_unaccented_vietnamese_collision, encapsulate_data_plane_record,
    extract_protected_spans, fold_vietnamese_ascii, has_vietnamese_diacritics,
    restore_protected_spans, restore_vietnamese_contextual, verify_translation_invariants,
    AmbiguousTokenNote, AppliedNormalizationNote, DataPlaneRecord, ProtectedSpan,
    ProtectedSpanExtraction, ProtectedSpanKind, TranslationInvariantReport,
    UnaccentedVietnameseDetection, VietnameseRestorationResult, DATA_PLANE_SCHEMA_MODE,
};
pub use redactor::{PrivacyMask, SecretRedactor};
pub use utf16::{
    lsp_utf16_to_utf8_line_col, utf16_code_unit_len, utf16_nul_to_utf8, utf16_to_utf8,
    utf16_to_utf8_lossy, utf16_unit_to_utf8_byte_offset, utf8_byte_offset_to_utf16_unit,
    utf8_line_col_to_lsp_utf16, utf8_to_utf16, utf8_to_utf16_nul,
};
pub use utf8::{
    is_valid_utf8, now_epoch_ms, sanitize_utf8_lossy, truncate_utf8_bytes,
    truncate_utf8_codepoints, truncate_utf8_word_safe, utf8_codepoint_count,
    utf8_has_control_chars,
};
