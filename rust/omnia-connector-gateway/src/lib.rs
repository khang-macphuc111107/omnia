//! `omnia-connector-gateway` — Typed connector gateway contracts for Omnia.
//!
//! Modules:
//! 1. [`opencode_compat`]: OpenCode SSE event & permission prompt normalizer,
//!    `/v1/responses` tool-namespace preservation/restoration, strict URL & relative path
//!    validation, and truthful unconfigured/unavailable reporting.
//! 2. [`codex_patched`]: CodexPatched session/rollout JSONL parser, goal ledger validator
//!    enforcing `token_budget: Option<u64>` remains `None` unless explicitly opted in by the user,
//!    zero-drop `ADDITIVE_INTAKE` queue ordering, `TurnSteer` CAS validator, and secret redaction.
//! 3. [`proxy_router`]: Deterministic failover scheduler and 4-state health / circuit-breaker
//!    model (`healthy`, `cooldown`, `tripped`, `unavailable`) aligned with `D:\htmustc-proxy`
//!    semantics, emitting secret-free routing receipts.
//! 4. [`artifact_intake`]: Gemini Notebook & Google Drive Downloader canonical intake manifest
//!    normalizer with SHA-256 verification, cross-artifact duplicate detection, and mandatory
//!    stripping/redaction of `access_bearing_url`, signed URLs, cookies, and personal identifiers.
//! 5. [`gemini_share`]: Public Gemini share URL gatekeeper, Google WIZ `batchexecute` (`ujx1Bf` /
//!    `otAQ7b`) frame decoder, paginated transcript normalizer, completeness verification, and
//!    strict secret/cookie/signed-URL/PII redaction.

#![forbid(unsafe_code)]

pub mod artifact_intake;
pub mod codex_patched;
pub mod gemini_share;
pub mod htmustc_wire;
pub mod opencode_compat;
pub mod proxy_router;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr};
use url::Url;

/// Canonical secret placeholder emitted after redaction.
pub const REDACTED_SECRET: &str = "[REDACTED_SECRET]";
/// Canonical PEM private key placeholder emitted after redaction.
pub const REDACTED_PEM_KEY: &str = "[REDACTED_PEM_KEY]";
/// Canonical fallback placeholder when a full URL carried secrets and had no safe origin.
pub const REDACTED_URL: &str = "[REDACTED_URL]";
/// Canonical PII email placeholder emitted after redaction.
pub const REDACTED_EMAIL: &str = "[REDACTED_EMAIL]";
/// Canonical Windows user profile path placeholder emitted after redaction.
pub const REDACTED_USER_PROFILE: &str = "[REDACTED_USER_PROFILE]";
/// Canonical POSIX home path placeholder emitted after redaction.
pub const REDACTED_USER_HOME: &str = "[REDACTED_USER_HOME]";
/// Omnia connector redaction policy tag.
pub const OMNIA_REDACTION_POLICY: &str = "strict_no_secrets_no_prompts_no_raw_urls_v1";

/// Maximum HTTP header block size accepted by the AdGuard-tolerant parser (64 KiB).
pub const MAX_ADGUARD_HTTP_HEADER_BYTES: usize = 64 * 1024;

/// Non-secret credential metadata keys permitted in sanitized connector receipts.
pub(crate) const PUBLIC_CREDENTIAL_KEYS: &[&str] = &[
    "auth_mode",
    "account_tier",
    "plan_type",
    "region",
    "project_id",
    "provider",
    "provider_id",
    "scopes",
    "enabled",
    "label",
    "workspace_id",
    "account_id",
    "tier",
    "model_family",
];

/// Non-secret token accounting / quota quantity keys that must never trigger false-positive secret hits.
pub(crate) const NON_SECRET_TOKEN_COUNT_KEYS: &[&str] = &[
    "token_budget",
    "tokenbudget",
    "token_count",
    "tokencount",
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "reasoning_tokens",
    "total_tokens",
    "max_output_tokens",
    "context_limit_tokens",
    "input_limit_tokens",
    "tokens_used",
    "remaining_tokens",
    "emergency_reserve_tokens",
    "max_stale_tokens",
    "reserved_tokens",
    "estimated_input_tokens",
    "estimated_output_tokens",
];

/// Keys associated with sensitive credential material.
pub(crate) const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "id_token",
    "auth_token",
    "authtoken",
    "experimental_bearer_token",
    "bearer",
    "authorization",
    "proxy-authorization",
    "proxy_authorization",
    "client_secret",
    "secret",
    "password",
    "passwd",
    "pwd",
    "private_key",
    "cookie",
    "cookies",
    "set-cookie",
    "set_cookie",
    "cookie_header",
    "session_key",
    "session_token",
    "management_key",
    "admin_key",
    "x-api-key",
    "x-goog-api-key",
    "cf_clearance",
];

/// Prototype-pollution keys forbidden anywhere in untrusted JSON payloads.
pub(crate) const UNSAFE_PROTOTYPE_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];

/// Signed URL query parameter names whose names are preserved for audit while values are redacted.
pub(crate) const SIGNED_URL_PRESERVED_PARAMS: &[&str] = &[
    "x-amz-algorithm",
    "x-amz-date",
    "x-amz-expires",
    "x-amz-signedheaders",
    "x-amz-signature",
    "x-amz-security-token",
    "x-amz-credential",
    "x-goog-algorithm",
    "x-goog-date",
    "x-goog-expires",
    "x-goog-signedheaders",
    "x-goog-signature",
    "x-goog-credential",
    "sig",
    "sv",
    "se",
    "sp",
    "sr",
    "st",
    "expires",
    "signature",
    "key-pair-id",
    "policy",
];

/// Secret-bearing URL query parameters that must always be redacted.
pub(crate) const SECRET_QUERY_PARAMS: &[&str] = &[
    "x-amz-signature",
    "x-amz-security-token",
    "x-amz-credential",
    "x-goog-signature",
    "x-goog-credential",
    "x-goog-api-key",
    "sig",
    "signature",
    "token",
    "access_token",
    "api_key",
    "apikey",
    "key",
    "client_secret",
    "auth",
    "authorization",
    "secret",
    "password",
    "passwd",
];

/// Marketing / tracking query parameters stripped unconditionally from sanitized URLs.
pub(crate) const TRACKING_QUERY_PARAMS: &[&str] = &[
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "fbclid",
    "gclid",
    "dclid",
    "yclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "_ga",
    "_gl",
    "spm",
];

const METADATA_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];

/// Shared macro implementing `Display` and `Serialize`/`Deserialize` via `as_str` + `FromStr`.
macro_rules! impl_str_enum_serde {
    ($ty:ty) => {
        impl std::fmt::Display for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(deserializer)?;
                raw.parse::<Self>().map_err(serde::de::Error::custom)
            }
        }
    };
}
pub(crate) use impl_str_enum_serde;

/// Computes lowercase 64-character hexadecimal SHA-256 digest of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Validates and normalizes an optional `sha256:`-prefixed 64-character hex digest.
#[must_use]
pub fn normalize_sha256_hex(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    if without_prefix.len() == 64 && without_prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(without_prefix.to_ascii_lowercase())
    } else {
        None
    }
}

/// Returns `true` when `value` contains any ASCII control character (`<= 0x1F` or `0x7F`).
#[must_use]
pub fn has_control_chars(value: &str) -> bool {
    value.bytes().any(|b| b <= 0x1F || b == 0x7F)
}

/// Returns `true` when `value` contains Unicode bidirectional override characters.
#[must_use]
pub fn has_bidi_controls(value: &str) -> bool {
    value.chars().any(|c| {
        matches!(
            c,
            '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
    })
}

/// Strips Unicode bidirectional override characters from `value`.
#[must_use]
pub fn strip_bidi_controls(value: &str) -> (String, bool) {
    if !has_bidi_controls(value) {
        return (value.to_string(), false);
    }
    let cleaned = value
        .chars()
        .filter(|c| {
            !matches!(
                *c,
                '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
            )
        })
        .collect();
    (cleaned, true)
}

fn is_valid_env_ident(s: &str) -> bool {
    let mut bytes = s.bytes();
    match bytes.next() {
        Some(b) if b.is_ascii_alphabetic() || b == b'_' => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Extracts a symbolic environment variable reference (`env:VAR`, `${VAR}`, `$VAR`, `{env:VAR}`).
#[must_use]
pub fn extract_env_reference(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("env:") {
        return is_valid_env_ident(rest).then(|| format!("env:{rest}"));
    }
    if let Some(inner) = trimmed.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        return is_valid_env_ident(inner).then(|| format!("env:{inner}"));
    }
    if let Some(rest) = trimmed.strip_prefix('$') {
        return is_valid_env_ident(rest).then(|| format!("env:{rest}"));
    }
    if let Some(inner) = trimmed.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        let inner = inner.trim();
        if let Some(after_env) = inner.strip_prefix("env") {
            let after_env = after_env.trim_start();
            if let Some(var) = after_env.strip_prefix(':') {
                let var = var.trim();
                if is_valid_env_ident(var) {
                    return Some(format!("env:{var}"));
                }
            }
        }
    }
    None
}

/// Returns `true` when `value` is blank, a symbolic env ref, or an already-redacted placeholder.
#[must_use]
pub fn is_safe_placeholder(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || extract_env_reference(trimmed).is_some() {
        return true;
    }
    if trimmed.starts_with("[REDACTED") && trimmed.ends_with(']') {
        return trimmed[1..trimmed.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    }
    let low = trimmed.to_ascii_lowercase();
    if low == "<redacted>" || low == "<secret>" || (low.starts_with("<env:") && low.ends_with('>'))
    {
        return true;
    }
    if let Some(rest) = low.strip_prefix("***redacted***") {
        if rest.is_empty() {
            return true;
        }
        if let Some(suffix) = rest.strip_prefix(':') {
            return (1..=8).contains(&suffix.len())
                && suffix.bytes().all(|b| b.is_ascii_alphanumeric());
        }
    }
    false
}

/// Returns `true` when `key` identifies sensitive credential/secret material (excluding public metadata and numeric token counters).
#[must_use]
pub fn is_sensitive_key_name(key: &str) -> bool {
    let low = key.trim().to_ascii_lowercase();
    if low.is_empty()
        || PUBLIC_CREDENTIAL_KEYS.contains(&low.as_str())
        || NON_SECRET_TOKEN_COUNT_KEYS.contains(&low.as_str())
    {
        return false;
    }
    if low == "token"
        || low.ends_with("_token")
        || low.ends_with("-token")
        || low == "sig"
        || low == "signature"
        || low.ends_with("_signature")
        || low.ends_with("-signature")
    {
        return true;
    }
    SENSITIVE_KEY_TOKENS.iter().any(|tok| low.contains(tok))
}

/// Returns `true` when `key` identifies an email/PII or private user-identity field.
#[must_use]
pub fn is_pii_key_name(key: &str) -> bool {
    let low = key.trim().to_ascii_lowercase();
    matches!(
        low.as_str(),
        "email"
            | "user_email"
            | "account_email"
            | "owner_email"
            | "author_email"
            | "owner_name"
            | "account_name"
            | "user_id"
            | "userid"
            | "gaia_id"
            | "gaiaid"
            | "phone"
            | "phone_number"
            | "ip_address"
            | "client_ip"
    )
}

/// Returns `true` when `key` is a private local disk path field that must be stripped.
#[must_use]
pub fn is_private_disk_path_key(key: &str) -> bool {
    let low = key.trim().to_ascii_lowercase();
    matches!(
        low.as_str(),
        "localpath"
            | "diskpath"
            | "fullpath"
            | "originalpath"
            | "local_path"
            | "disk_path"
            | "full_path"
            | "original_path"
            | "user_profile_path"
            | "temp_path"
    )
}

/// Returns `true` when `key` is an access-bearing / signed URL field that must be stripped.
#[must_use]
pub fn is_access_bearing_url_key(key: &str) -> bool {
    let low = key.trim().to_ascii_lowercase();
    matches!(
        low.as_str(),
        "access_bearing_url"
            | "accessbearingurl"
            | "presigned_url"
            | "presignedurl"
            | "signed_url"
            | "signedurl"
            | "download_url_with_token"
            | "authenticated_url"
    )
}

/// Scans an arbitrary `serde_json::Value` tree for prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
#[must_use]
pub fn find_unsafe_prototype_key(value: &Value, path: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let next_path = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                if UNSAFE_PROTOTYPE_KEYS.contains(&k.as_str()) {
                    return Some(next_path);
                }
                if let Some(found) = find_unsafe_prototype_key(v, &next_path) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => {
            for (idx, item) in items.iter().enumerate() {
                let next_path = format!("{path}[{idx}]");
                if let Some(found) = find_unsafe_prototype_key(item, &next_path) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn is_word_boundary_before(bytes: &[u8], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    let b = bytes[idx - 1];
    !(b.is_ascii_alphanumeric() || b == b'_')
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
}

fn is_key_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}

fn redact_pem_blocks(input: &str, hits: &mut BTreeSet<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("-----BEGIN ") {
        let after_begin = &rest[start..];
        if let Some(hdr_end) = after_begin.find("PRIVATE KEY-----") {
            let search_from = hdr_end + "PRIVATE KEY-----".len();
            if let Some(end_rel) = after_begin[search_from..].find("-----END ") {
                let after_end = &after_begin[search_from + end_rel..];
                if let Some(footer_end) = after_end.find("PRIVATE KEY-----") {
                    out.push_str(&rest[..start]);
                    out.push_str(REDACTED_PEM_KEY);
                    hits.insert("PEM_PRIVATE_KEY".to_string());
                    rest = &after_end[footer_end + "PRIVATE KEY-----".len()..];
                    continue;
                }
            }
        }
        out.push_str(&rest[..start + "-----BEGIN ".len()]);
        rest = &rest[start + "-----BEGIN ".len()..];
    }
    out.push_str(rest);
    out
}

fn redact_bearer_tokens(input: &str, hits: &mut BTreeSet<String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 6 <= bytes.len()
            && bytes[i..i + 6].eq_ignore_ascii_case(b"bearer")
            && is_word_boundary_before(bytes, i)
        {
            let mut j = i + 6;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j > i + 6 {
                let tok_start = j;
                while j < bytes.len() && is_token_char(bytes[j]) {
                    j += 1;
                }
                let tok = &input[tok_start..j];
                if tok.len() >= 8 && !is_safe_placeholder(tok) {
                    out.push_str(&input[i..tok_start]);
                    out.push_str(REDACTED_SECRET);
                    hits.insert("BEARER_TOKEN".to_string());
                    i = j;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn match_provider_prefix_len(slice: &[u8]) -> Option<(usize, usize)> {
    // Returns (prefix_len, min_total_len)
    const RULES: &[(&[u8], usize)] = &[
        (b"github_pat_", 27),
        (b"ghp_", 20),
        (b"gho_", 20),
        (b"ghs_", 20),
        (b"ghu_", 20),
        (b"ghr_", 20),
        (b"sk-ant-", 19),
        (b"sk-proj-", 20),
        (b"sk-", 15),
        (b"AIza", 24),
        (b"AKIA", 20),
        (b"xoxb-", 15),
        (b"xoxp-", 15),
        (b"xoxa-", 15),
        (b"hf_", 19),
        (b"glpat-", 22),
    ];
    for (prefix, min_len) in RULES {
        if slice.starts_with(prefix) {
            return Some((prefix.len(), *min_len));
        }
    }
    None
}

fn redact_provider_prefixes(input: &str, hits: &mut BTreeSet<String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if is_word_boundary_before(bytes, i) {
            if let Some((prefix_len, min_len)) = match_provider_prefix_len(&bytes[i..]) {
                let mut j = i + prefix_len;
                while j < bytes.len() && is_key_token_char(bytes[j]) {
                    j += 1;
                }
                if j - i >= min_len && (j == bytes.len() || !bytes[j].is_ascii_alphanumeric()) {
                    out.push_str(REDACTED_SECRET);
                    hits.insert("PROVIDER_TOKEN_PREFIX".to_string());
                    i = j;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_kv_and_cookie_secrets(input: &str, hits: &mut BTreeSet<String>) -> String {
    const KV_KEYS: &[&str] = &[
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "password",
        "passwd",
        "cf_clearance",
        "session_token",
        "management_key",
        "admin_key",
    ];
    const COOKIE_KEYS: &[&str] = &[
        "__secure-1psidts",
        "__secure-3psidts",
        "__secure-1psidcc",
        "__secure-3psidcc",
        "__secure-1psid",
        "__secure-3psid",
        "sapisid",
        "apisid",
        "ssid",
        "hsid",
        "sidcc",
        "nid",
        "cf_clearance",
    ];

    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    'outer: while i < bytes.len() {
        if is_word_boundary_before(bytes, i) {
            // Check cookie pairs first (`NAME=VALUE`)
            for cookie_name in COOKIE_KEYS {
                let klen = cookie_name.len();
                if i + klen < bytes.len()
                    && bytes[i..i + klen].eq_ignore_ascii_case(cookie_name.as_bytes())
                    && bytes[i + klen] == b'='
                {
                    let val_start = i + klen + 1;
                    let mut val_end = val_start;
                    while val_end < bytes.len()
                        && !bytes[val_end].is_ascii_whitespace()
                        && !matches!(bytes[val_end], b';' | b'"' | b'\'' | b'&' | b',' | b'}')
                    {
                        val_end += 1;
                    }
                    let val = &input[val_start..val_end];
                    if val.len() >= 6 && !is_safe_placeholder(val) {
                        out.push_str(&input[i..val_start]);
                        out.push_str(REDACTED_SECRET);
                        hits.insert(format!("COOKIE_SECRET:{}", &input[i..i + klen]));
                        i = val_end;
                        continue 'outer;
                    }
                }
            }

            // Check KV pairs (`api_key=...`, `password: "..."`, etc.)
            for kv_name in KV_KEYS {
                let klen = kv_name.len();
                if i + klen < bytes.len()
                    && bytes[i..i + klen].eq_ignore_ascii_case(kv_name.as_bytes())
                {
                    let mut sep_idx = i + klen;
                    while sep_idx < bytes.len() && bytes[sep_idx].is_ascii_whitespace() {
                        sep_idx += 1;
                    }
                    if sep_idx < bytes.len() && (bytes[sep_idx] == b':' || bytes[sep_idx] == b'=') {
                        sep_idx += 1;
                        while sep_idx < bytes.len() && bytes[sep_idx].is_ascii_whitespace() {
                            sep_idx += 1;
                        }
                        if sep_idx < bytes.len() {
                            let quote = if bytes[sep_idx] == b'"' || bytes[sep_idx] == b'\'' {
                                Some(bytes[sep_idx])
                            } else {
                                None
                            };
                            let val_start = if quote.is_some() {
                                sep_idx + 1
                            } else {
                                sep_idx
                            };
                            let mut val_end = val_start;
                            while val_end < bytes.len() {
                                let b = bytes[val_end];
                                if let Some(q) = quote {
                                    if b == q {
                                        break;
                                    }
                                } else if b.is_ascii_whitespace()
                                    || matches!(b, b'"' | b'\'' | b'&' | b',' | b';' | b'}' | b')')
                                {
                                    break;
                                }
                                val_end += 1;
                            }
                            let val = &input[val_start..val_end];
                            if val.len() >= 4
                                && !is_safe_placeholder(val)
                                && (quote.is_none()
                                    || (val_end < bytes.len() && Some(bytes[val_end]) == quote))
                            {
                                out.push_str(&input[i..val_start]);
                                out.push_str(REDACTED_SECRET);
                                hits.insert(format!("KV_SECRET:{kv_name}"));
                                i = val_end;
                                continue 'outer;
                            }
                        }
                    }
                }
            }
        }
        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// Redacts PEM private keys, Bearer tokens, provider key prefixes, cookies, and KV secrets.
#[must_use]
pub fn redact_secrets_in_text(input: &str) -> (String, Vec<String>) {
    if input.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut hits = BTreeSet::new();
    let step1 = redact_pem_blocks(input, &mut hits);
    let step2 = redact_bearer_tokens(&step1, &mut hits);
    let step3 = redact_provider_prefixes(&step2, &mut hits);
    let step4 = redact_kv_and_cookie_secrets(&step3, &mut hits);
    (step4, hits.into_iter().collect())
}

/// Redacts host-specific user profile/home path substrings (`C:\Users\...`, `/home/...`, `/Users/...`).
#[must_use]
pub fn redact_private_disk_paths(input: &str) -> (String, bool) {
    if input.is_empty() {
        return (String::new(), false);
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut changed = false;

    while i < bytes.len() {
        // Windows profile: `[A-Za-z]:\Users\<user>` or `[A-Za-z]:/Users/<user>`
        if i + 9 < bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
            && bytes[i + 3..i + 8].eq_ignore_ascii_case(b"users")
            && (bytes[i + 8] == b'\\' || bytes[i + 8] == b'/')
        {
            let mut end = i + 9;
            while end < bytes.len()
                && !bytes[end].is_ascii_whitespace()
                && !matches!(bytes[end], b'\\' | b'/' | b'"' | b'\'' | b',' | b';' | b')')
            {
                end += 1;
            }
            if end > i + 9 {
                out.push_str(REDACTED_USER_PROFILE);
                changed = true;
                i = end;
                continue;
            }
        }
        // POSIX home: `/home/<user>` or `/Users/<user>`
        if bytes[i] == b'/' && is_word_boundary_before(bytes, i) {
            let rest = &bytes[i + 1..];
            let prefix_len = if rest.len() > 5 && rest[..5].eq_ignore_ascii_case(b"home/") {
                Some(6)
            } else if rest.len() > 6 && rest[..6].eq_ignore_ascii_case(b"users/") {
                Some(7)
            } else {
                None
            };
            if let Some(plen) = prefix_len {
                let mut end = i + plen;
                while end < bytes.len()
                    && !bytes[end].is_ascii_whitespace()
                    && !matches!(bytes[end], b'/' | b'\\' | b'"' | b'\'' | b',' | b';' | b')')
                {
                    end += 1;
                }
                if end > i + plen {
                    out.push('/');
                    out.push_str(REDACTED_USER_HOME);
                    changed = true;
                    i = end;
                    continue;
                }
            }
        }

        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    (out, changed)
}

fn is_email_local_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')
}

/// Redacts inline email addresses (`user@domain.tld`) from text while leaving URLs without userinfo intact.
#[must_use]
pub fn redact_emails(input: &str) -> (String, bool) {
    if !input.contains('@') {
        return (input.to_string(), false);
    }
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut changed = false;

    while i < bytes.len() {
        if is_word_boundary_before(bytes, i) && is_email_local_char(bytes[i]) {
            let mut j = i;
            while j < bytes.len() && is_email_local_char(bytes[j]) {
                j += 1;
            }
            if j > i && j + 3 < bytes.len() && bytes[j] == b'@' {
                let dom_start = j + 1;
                let mut k = dom_start;
                while k < bytes.len() && is_email_domain_char(bytes[k]) {
                    k += 1;
                }
                let domain = &input[dom_start..k];
                if let Some((_, tld)) = domain.rsplit_once('.') {
                    if tld.len() >= 2
                        && tld.bytes().all(|b| b.is_ascii_alphabetic())
                        && !domain.starts_with('.')
                        && !domain.ends_with('.')
                        && (k == bytes.len() || !bytes[k].is_ascii_alphanumeric())
                    {
                        // Avoid mangling `https://user:pass@host` (that belongs to URL userinfo)
                        let prefix_slice = &input[..i];
                        if !prefix_slice.ends_with("://") && !prefix_slice.ends_with(':') {
                            out.push_str(REDACTED_EMAIL);
                            changed = true;
                            i = k;
                            continue;
                        }
                    }
                }
            }
        }
        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    (out, changed)
}

/// Options controlling URL inspection and credential/tracking sanitization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UrlInspectionPolicy {
    /// Reject remote non-TLS schemes (`http`, `socks5`) unless loopback.
    pub strict_tls: bool,
    /// Permit plain `http://` when host is strictly loopback (`127.0.0.0/8`, `localhost`, `::1`).
    pub allow_loopback_http: bool,
    /// Permit private RFC1918/ULA endpoints (always forbids cloud metadata IPs).
    pub allow_private_endpoints: bool,
    /// Permit non-loopback hosts at all (used by loopback-default connectors like OpenCode).
    pub allow_non_loopback: bool,
    /// Redact signed URL parameter values (`X-Amz-Signature`, `X-Goog-Signature`, `sig`, etc.).
    pub redact_signed_params: bool,
    /// Permitted schemes (`http`, `https`, `socks5`, `socks5h`).
    pub allow_socks_schemes: bool,
}

impl Default for UrlInspectionPolicy {
    fn default() -> Self {
        Self {
            strict_tls: true,
            allow_loopback_http: true,
            allow_private_endpoints: false,
            allow_non_loopback: true,
            redact_signed_params: true,
            allow_socks_schemes: true,
        }
    }
}

/// Detailed result of URL parsing, SSRF checks, and credential/tracking sanitization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedUrlInfo {
    pub normalized_url: String,
    pub origin: String,
    pub scheme: String,
    pub host: String,
    pub connect_host: String,
    pub port: u16,
    pub is_loopback: bool,
    pub is_private: bool,
    pub is_metadata: bool,
    pub had_embedded_credentials: bool,
    pub had_query_secrets: bool,
    pub non_tls_remote: bool,
    pub non_loopback_disallowed: bool,
    pub private_disallowed: bool,
    pub stripped_tracking_params: Vec<String>,
    pub preserved_signed_params: Vec<String>,
}

impl SanitizedUrlInfo {
    /// Returns `true` when no security policy violation was detected on this URL.
    #[must_use]
    pub fn is_safe(&self) -> bool {
        !self.had_embedded_credentials
            && !self.had_query_secrets
            && !self.is_metadata
            && !self.non_tls_remote
            && !self.non_loopback_disallowed
            && !self.private_disallowed
    }
}

/// Errors emitted when a URL fails structural syntax, scheme, or control-character checks.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlSanitizeError {
    #[error("URL cannot be empty")]
    Empty,
    #[error("URL contains forbidden ASCII control characters")]
    ControlChars,
    #[error("malformed URL: {0}")]
    Malformed(String),
    #[error("disallowed URL scheme `{0}`")]
    UnsafeScheme(String),
    #[error("URL is missing a hostname")]
    MissingHost,
    #[error("URL has an invalid or zero port")]
    InvalidPort,
}

fn is_metadata_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip == Ipv4Addr::new(169, 254, 169, 254)
        || ip == Ipv4Addr::new(100, 100, 100, 200)
        || (octets[0] == 169 && octets[1] == 254)
}

fn classify_ip(ip: IpAddr) -> (bool, bool, bool) {
    // Returns (is_loopback, is_private_or_reserved, is_metadata)
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            let cgnat = octets[0] == 100 && (64..=127).contains(&octets[1]);
            let metadata = is_metadata_ipv4(v4);
            let priv_flag = v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || cgnat;
            (v4.is_loopback(), priv_flag, metadata)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return classify_ip(IpAddr::V4(mapped));
            }
            let seg0 = v6.segments()[0];
            let is_link_local = (seg0 & 0xffc0) == 0xfe80;
            let is_ula = (seg0 & 0xfe00) == 0xfc00;
            let priv_flag = v6.is_unspecified() || is_link_local || is_ula;
            (v6.is_loopback(), priv_flag, is_link_local)
        }
    }
}

/// Validates and sanitizes `raw_url` against SSRF, scheme, userinfo, and query-secret rules.
pub fn sanitize_and_inspect_url(
    raw_url: &str,
    policy: &UrlInspectionPolicy,
) -> Result<SanitizedUrlInfo, UrlSanitizeError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(UrlSanitizeError::Empty);
    }
    if has_control_chars(trimmed) {
        return Err(UrlSanitizeError::ControlChars);
    }

    let parsed = Url::parse(trimmed).map_err(|e| UrlSanitizeError::Malformed(e.to_string()))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    let scheme_ok = matches!(scheme.as_str(), "https" | "http")
        || (policy.allow_socks_schemes && matches!(scheme.as_str(), "socks5" | "socks5h"));
    if !scheme_ok {
        return Err(UrlSanitizeError::UnsafeScheme(scheme));
    }

    let host_raw = parsed.host_str().ok_or(UrlSanitizeError::MissingHost)?;
    let host_lower = host_raw.trim_end_matches('.').to_ascii_lowercase();
    if host_lower.is_empty() {
        return Err(UrlSanitizeError::MissingHost);
    }
    if parsed.port() == Some(0) {
        return Err(UrlSanitizeError::InvalidPort);
    }
    let port = parsed
        .port()
        .or(match scheme.as_str() {
            "https" => Some(443),
            "http" => Some(80),
            "socks5" | "socks5h" => Some(1080),
            _ => None,
        })
        .ok_or(UrlSanitizeError::InvalidPort)?;

    let connect_host = match parsed.host() {
        Some(url::Host::Ipv6(ip)) => ip.to_string(),
        _ => host_lower.clone(),
    };
    let host_netloc = if connect_host.contains(':') && !host_lower.starts_with('[') {
        format!("[{connect_host}]")
    } else {
        host_lower.clone()
    };

    let mut is_loopback =
        host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1";
    let mut is_private = false;
    let mut is_metadata = METADATA_HOSTS.contains(&host_lower.as_str());

    if let Some(url_host) = parsed.host() {
        match url_host {
            url::Host::Ipv4(v4) => {
                let (lb, pv, md) = classify_ip(IpAddr::V4(v4));
                is_loopback = lb;
                is_private = pv;
                is_metadata = is_metadata || md;
            }
            url::Host::Ipv6(v6) => {
                let (lb, pv, md) = classify_ip(IpAddr::V6(v6));
                is_loopback = lb;
                is_private = pv;
                is_metadata = is_metadata || md;
            }
            url::Host::Domain(_) => {
                if let Ok(ip) = connect_host.parse::<IpAddr>() {
                    let (lb, pv, md) = classify_ip(ip);
                    is_loopback = lb;
                    is_private = pv;
                    is_metadata = is_metadata || md;
                }
            }
        }
    }

    let had_embedded_credentials = !parsed.username().is_empty() || parsed.password().is_some();
    let non_loopback_disallowed = !is_loopback && !policy.allow_non_loopback;
    let private_disallowed = is_private && !is_loopback && !policy.allow_private_endpoints;
    let non_tls_remote = matches!(scheme.as_str(), "http" | "socks5")
        && !(is_loopback && policy.allow_loopback_http)
        && policy.strict_tls;

    let mut stripped_tracking_params = Vec::new();
    let mut preserved_signed_params = Vec::new();
    let mut clean_pairs: Vec<(String, String)> = Vec::new();
    let mut had_query_secrets = false;

    for (qk, qv) in parsed.query_pairs() {
        let qk_str = qk.into_owned();
        let qv_str = qv.into_owned();
        let qk_low = qk_str.to_ascii_lowercase();

        if TRACKING_QUERY_PARAMS.contains(&qk_low.as_str()) {
            stripped_tracking_params.push(qk_str);
            continue;
        }
        if SIGNED_URL_PRESERVED_PARAMS.contains(&qk_low.as_str()) {
            preserved_signed_params.push(qk_str.clone());
        }

        let is_secret_param = SECRET_QUERY_PARAMS.contains(&qk_low.as_str())
            || qk_low.contains("secret")
            || qk_low.contains("password")
            || qk_low.contains("token");

        if is_secret_param && !is_safe_placeholder(&qv_str) {
            if !SIGNED_URL_PRESERVED_PARAMS.contains(&qk_low.as_str()) {
                had_query_secrets = true;
                clean_pairs.push((qk_str, REDACTED_SECRET.to_string()));
                continue;
            }
            if policy.redact_signed_params {
                clean_pairs.push((qk_str, REDACTED_SECRET.to_string()));
                continue;
            }
        }

        let (_, text_hits) = redact_secrets_in_text(&qv_str);
        if !text_hits.is_empty() {
            had_query_secrets = true;
            clean_pairs.push((qk_str, REDACTED_SECRET.to_string()));
            continue;
        }

        clean_pairs.push((qk_str, qv_str));
    }

    let mut rebuilt = Url::parse(&format!("{scheme}://{host_netloc}:{port}/"))
        .map_err(|e| UrlSanitizeError::Malformed(e.to_string()))?;
    let path = if parsed.path().is_empty() {
        "/"
    } else {
        parsed.path()
    };
    rebuilt.set_path(path);
    if !clean_pairs.is_empty() {
        let mut qp = rebuilt.query_pairs_mut();
        for (k, v) in &clean_pairs {
            qp.append_pair(k, v);
        }
    }

    let explicit_default_port = parsed.port().is_some();
    let origin = if explicit_default_port
        || !matches!((scheme.as_str(), port), ("http", 80) | ("https", 443))
    {
        format!("{scheme}://{host_netloc}:{port}")
    } else {
        format!("{scheme}://{host_netloc}")
    };

    Ok(SanitizedUrlInfo {
        normalized_url: rebuilt.as_str().to_string(),
        origin,
        scheme,
        host: host_netloc,
        connect_host,
        port,
        is_loopback,
        is_private,
        is_metadata,
        had_embedded_credentials,
        had_query_secrets,
        non_tls_remote,
        non_loopback_disallowed,
        private_disallowed,
        stripped_tracking_params,
        preserved_signed_params,
    })
}

/// Strips credentials, query, and fragment from a URL, returning `(origin_only_url, had_sensitive_parts)`.
#[must_use]
pub fn sanitize_url_origin(raw_url: &str) -> (Option<String>, bool) {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || !trimmed.contains("://") {
        return (None, false);
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return (None, true);
    };
    let had_sensitive = !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query_pairs().any(|(k, _)| {
            let low = k.to_ascii_lowercase();
            SECRET_QUERY_PARAMS.contains(&low.as_str())
                || low.contains("secret")
                || low.contains("password")
                || low.contains("token")
        });
    let Some(host_str) = parsed.host_str() else {
        return (None, had_sensitive);
    };
    let host_formatted = if host_str.contains(':') && !host_str.starts_with('[') {
        format!("[{host_str}]")
    } else {
        host_str.to_string()
    };
    let port_part = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    (
        Some(format!(
            "{}://{}{}",
            parsed.scheme().to_ascii_lowercase(),
            host_formatted,
            port_part
        )),
        had_sensitive,
    )
}

/// Recursively redacts inline secrets and secret-bearing URLs in a JSON value without leaking credentials.
pub fn redact_json_value(value: &Value) -> (Value, Vec<String>) {
    let mut hits = BTreeSet::new();
    let redacted = redact_json_inner(value, &mut hits);
    (redacted, hits.into_iter().collect())
}

fn redact_json_inner(value: &Value, hits: &mut BTreeSet<String>) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if is_pii_key_name(k) {
                    hits.insert(format!("PII_FIELD:{}", k.to_ascii_lowercase()));
                    continue;
                }
                if is_private_disk_path_key(k) {
                    hits.insert(format!("PRIVATE_PATH:{}", k.to_ascii_lowercase()));
                    continue;
                }
                if is_access_bearing_url_key(k) {
                    hits.insert(format!("ACCESS_BEARING_URL:{}", k.to_ascii_lowercase()));
                    continue;
                }
                if is_sensitive_key_name(k) {
                    match v {
                        Value::String(s) => {
                            let trimmed = s.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if let Some(env_ref) = extract_env_reference(trimmed) {
                                out.insert(k.clone(), Value::String(env_ref));
                            } else if is_safe_placeholder(trimmed) {
                                out.insert(k.clone(), Value::String(REDACTED_SECRET.to_string()));
                            } else {
                                hits.insert(format!("SECRET_KEY:{}", k.to_ascii_lowercase()));
                                out.insert(k.clone(), Value::String(REDACTED_SECRET.to_string()));
                            }
                        }
                        Value::Object(_) => {
                            out.insert(k.clone(), redact_json_inner(v, hits));
                        }
                        Value::Null => {}
                        _ => {
                            hits.insert(format!("SECRET_KEY:{}", k.to_ascii_lowercase()));
                            out.insert(k.clone(), Value::String(REDACTED_SECRET.to_string()));
                        }
                    }
                } else {
                    out.insert(k.clone(), redact_json_inner(v, hits));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|i| redact_json_inner(i, hits)).collect())
        }
        Value::String(s) => {
            if extract_env_reference(s).is_some() || is_safe_placeholder(s) {
                return Value::String(s.clone());
            }
            let (mut red, text_hits) = redact_secrets_in_text(s);
            for h in text_hits {
                hits.insert(h);
            }
            if red.contains("://") {
                let (origin, had_sensitive) = sanitize_url_origin(&red);
                if had_sensitive {
                    hits.insert("URL_CREDENTIALS_OR_SECRET_QUERY".to_string());
                    red = origin.unwrap_or_else(|| REDACTED_URL.to_string());
                }
            }
            Value::String(red)
        }
        _ => value.clone(),
    }
}

/// Scans a JSON value for any non-placeholder inline secret material without mutating it.
#[must_use]
pub fn detect_json_secrets(value: &Value) -> Vec<String> {
    let (_, hits) = redact_json_value(value);
    hits
}

/// Parsed HTTP/1.x request head resilient to Windows AdGuard loopback quirks
/// (double spaces like `GET  /path HTTP/1.1` and ~5.4 KB injected `Cookie:` headers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHttpHead {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Map<String, Value>,
    pub stripped_sensitive_headers: Vec<String>,
    pub total_header_bytes: usize,
}

/// Errors emitted while parsing an HTTP request head block.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HttpHeadParseError {
    #[error("HTTP header block exceeds {MAX_ADGUARD_HTTP_HEADER_BYTES} byte limit")]
    HeadersTooLarge,
    #[error("HTTP request headers must be valid UTF-8")]
    InvalidUtf8,
    #[error("HTTP request line is malformed: {0}")]
    MalformedRequestLine(&'static str),
    #[error("HTTP header line is malformed: {0}")]
    MalformedHeader(&'static str),
}

/// Parses an HTTP/1.x head block while tolerating AdGuard double-whitespace request lines
/// (`GET  /path HTTP/1.1`) and stripping/draining injected `Cookie` / `Authorization` headers.
pub fn parse_adguard_tolerant_http_head(raw: &[u8]) -> Result<ParsedHttpHead, HttpHeadParseError> {
    let head_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| pos + 4)
        .unwrap_or(raw.len());
    if head_end > MAX_ADGUARD_HTTP_HEADER_BYTES {
        return Err(HttpHeadParseError::HeadersTooLarge);
    }
    let head_slice = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| &raw[..pos])
        .unwrap_or(raw);
    let text = std::str::from_utf8(head_slice).map_err(|_| HttpHeadParseError::InvalidUtf8)?;
    let mut lines = text.split("\r\n");
    let req_line = lines
        .next()
        .ok_or(HttpHeadParseError::MalformedRequestLine(
            "missing request line",
        ))?;

    // `split_whitespace` intentionally handles AdGuard's `GET  /path HTTP/1.1` double-space rewrite.
    let mut parts = req_line.split_whitespace();
    let method = parts
        .next()
        .ok_or(HttpHeadParseError::MalformedRequestLine("missing method"))?;
    let target = parts
        .next()
        .ok_or(HttpHeadParseError::MalformedRequestLine("missing target"))?;
    let version = parts
        .next()
        .ok_or(HttpHeadParseError::MalformedRequestLine(
            "missing HTTP version",
        ))?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(HttpHeadParseError::MalformedRequestLine(
            "unsupported version or trailing tokens",
        ));
    }
    if !target.starts_with('/') || has_control_chars(target) {
        return Err(HttpHeadParseError::MalformedRequestLine(
            "invalid request target",
        ));
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    let mut headers = Map::new();
    let mut stripped_sensitive_headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or(HttpHeadParseError::MalformedHeader("missing colon"))?;
        let low = name.trim().to_ascii_lowercase();
        if low.is_empty() {
            return Err(HttpHeadParseError::MalformedHeader("empty header name"));
        }
        let val_trimmed = value.trim();
        if matches!(
            low.as_str(),
            "cookie" | "set-cookie" | "authorization" | "proxy-authorization" | "x-api-key"
        ) || is_sensitive_key_name(&low)
        {
            stripped_sensitive_headers.push(low);
            continue;
        }
        headers.insert(low, Value::String(val_trimmed.to_string()));
    }

    Ok(ParsedHttpHead {
        method: method.to_string(),
        path: path.to_string(),
        query: query.to_string(),
        headers,
        stripped_sensitive_headers,
        total_header_bytes: head_end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_redaction_catches_tokens_cookies_pems_and_keeps_token_counts() {
        let sk = format!("{}-{}", "sk", "test_secret_123456789");
        let aiza = format!("{}{}", "AI", "zaDummyKey123456789012345");
        let pem_begin = format!("-----BEGIN {}-----", "RSA PRIVATE KEY");
        let pem_end = format!("-----END {}-----", "RSA PRIVATE KEY");
        let payload = json!({
            "api_key": sk,
            "env_ref": "${OPENAI_API_KEY}",
            "token_budget": 10000,
            "input_tokens": 500,
            "headers": {
                "Authorization": "Bearer opaque_secret_token_987654",
                "Cookie": "__Secure-1PSID=verysecretcookievalue12345; SIDCC=anothersidccsecret"
            },
            "pem": format!("{pem_begin}\nMIIEowIBAAKCAQEA\n{pem_end}"),
            "note": format!("leak {aiza} in text")
        });
        let (redacted, hits) = redact_json_value(&payload);
        let serialized = serde_json::to_string(&redacted).expect("json");
        assert!(!serialized.contains("test_secret_123456789"));
        assert!(!serialized.contains("opaque_secret_token"));
        assert!(!serialized.contains("verysecretcookievalue"));
        assert!(!serialized.contains("MIIEowIBAAKCAQEA"));
        assert!(!serialized.contains("DummyKey123456"));
        assert_eq!(redacted["env_ref"], "${OPENAI_API_KEY}");
        assert_eq!(redacted["token_budget"], 10000);
        assert_eq!(redacted["input_tokens"], 500);
        assert!(hits.iter().any(|h| h.contains("SECRET_KEY:api_key")));
    }

    #[test]
    fn adguard_tolerant_http_parser_handles_double_space_and_5kb_cookies() {
        let huge_cookie = "session=".to_string() + &"a".repeat(5500);
        let raw = format!(
            "GET  /api/events?foo=1 HTTP/1.1\r\nHost: 127.0.0.1:4096\r\nCookie: {huge_cookie}\r\nAuthorization: Bearer topsecret12345\r\nAccept: text/event-stream\r\n\r\n"
        );
        let parsed = parse_adguard_tolerant_http_head(raw.as_bytes()).expect("adguard head parses");
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.path, "/api/events");
        assert_eq!(parsed.query, "foo=1");
        assert_eq!(
            parsed.headers.get("accept").and_then(Value::as_str),
            Some("text/event-stream")
        );
        assert!(parsed
            .stripped_sensitive_headers
            .contains(&"cookie".to_string()));
        assert!(parsed
            .stripped_sensitive_headers
            .contains(&"authorization".to_string()));
        let serialized = serde_json::to_string(&parsed.headers).expect("headers json");
        assert!(!serialized.contains("aaaaa"));
        assert!(!serialized.contains("topsecret12345"));
    }
}
