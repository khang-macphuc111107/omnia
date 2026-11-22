use serde_json::{Map, Value};

/// Deterministic zero-unsafe secret redactor for log lines, run journals, and JSON payloads.
pub struct SecretRedactor;

const REDACTED: &str = "[REDACTED]";
const REDACTED_PRIVATE_KEY: &str = "[REDACTED_PRIVATE_KEY]";

const TOKEN_PREFIXES: &[&str] = &[
    "sk-proj-",
    "sk-svcacct-",
    "sk-admin-",
    "sk-live-",
    "sk-test-",
    "sk-ant-",
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxr-",
    "AIza",
    "AKIA",
    "ASIA",
    "npm_",
    "pypi-",
    "hf_",
    "whsec_",
    "rk_live_",
    "rk_test_",
    "sk_live_",
    "sk_test_",
];

const QUERY_PARAM_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "x-api-key",
    "x_api_key",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "auth_token",
    "token",
    "secret",
    "password",
    "passwd",
    "signature",
    "sig",
];

const TEXT_HEADER_KEYS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "cookie",
    "set-cookie",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "password",
    "passwd",
    "passphrase",
];

impl SecretRedactor {
    /// Redact API keys, Bearer/Basic auth headers, URL credentials, cookies,
    /// query-string secrets, JWTs, and PEM private keys while leaving normal text
    /// and token-count telemetry untouched.
    #[must_use]
    pub fn redact(input: &str) -> String {
        if input.is_empty() {
            return String::new();
        }
        let step1 = redact_pem_blocks(input);
        let step2 = redact_url_userinfo(&step1);
        let step3 = redact_query_params(&step2);
        let step4 = redact_header_lines(&step3);
        let step5 = redact_bearer_tokens(&step4);
        let step6 = redact_jwt_tokens(&step5);
        redact_prefixed_tokens(&step6)
    }

    /// Return `true` when `redact(input)` changes the input string.
    #[must_use]
    pub fn contains_secret(input: &str) -> bool {
        Self::redact(input) != input
    }

    /// Recursively redact secret keys and secret-bearing string values in JSON while
    /// strictly preserving benign token-count keys (`token_budget`, `input_tokens`,
    /// `output_tokens`, `max_output_tokens`, etc.).
    #[must_use]
    pub fn redact_json(val: &Value) -> Value {
        redact_json_value(val, false)
    }
}

fn redact_json_value(val: &Value, parent_key_is_secret: bool) -> Value {
    match val {
        Value::Null => Value::Null,
        Value::Bool(b) => {
            if parent_key_is_secret {
                Value::String(REDACTED.to_owned())
            } else {
                Value::Bool(*b)
            }
        }
        Value::Number(n) => {
            if parent_key_is_secret {
                Value::String(REDACTED.to_owned())
            } else {
                Value::Number(n.clone())
            }
        }
        Value::String(s) => {
            if parent_key_is_secret {
                if s.is_empty() {
                    Value::String(String::new())
                } else {
                    Value::String(REDACTED.to_owned())
                }
            } else {
                Value::String(SecretRedactor::redact(s))
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_json_value(item, parent_key_is_secret))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (k, v) in map {
                if is_benign_token_count_key(k) {
                    out.insert(k.clone(), redact_json_value(v, false));
                } else if is_sensitive_json_key(k) {
                    match v {
                        Value::Object(_) | Value::Array(_) => {
                            // Recurse into structured credential objects/arrays so keys remain visible
                            // while leaf scalars/strings are redacted.
                            out.insert(k.clone(), redact_json_value(v, true));
                        }
                        _ => {
                            out.insert(k.clone(), redact_json_value(v, true));
                        }
                    }
                } else {
                    out.insert(k.clone(), redact_json_value(v, false));
                }
            }
            Value::Object(out)
        }
    }
}

fn normalize_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for ch in key.chars() {
        if ch == '-' {
            out.push('_');
        } else {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

fn is_benign_token_count_key(key: &str) -> bool {
    let norm = normalize_key(key);
    let compact: String = norm.chars().filter(|&c| c != '_').collect();

    if matches!(
        norm.as_str(),
        "token_budget"
            | "token_limit"
            | "token_count"
            | "token_usage"
            | "tokens_used"
            | "max_tokens"
            | "max_input_tokens"
            | "max_output_tokens"
            | "input_tokens"
            | "output_tokens"
            | "prompt_tokens"
            | "completion_tokens"
            | "total_tokens"
            | "cached_tokens"
            | "cache_read_tokens"
            | "cache_creation_tokens"
            | "reasoning_tokens"
            | "reserved_tokens"
            | "remaining_tokens"
            | "reserve_tokens"
            | "available_tokens"
            | "context_tokens"
            | "tokens_per_second"
            | "cancellation_token"
            | "page_token"
            | "next_page_token"
            | "prev_page_token"
            | "cursor_token"
    ) {
        return true;
    }

    norm.ends_with("_tokens")
        || compact.ends_with("tokens")
        || norm.ends_with("_token_budget")
        || norm.ends_with("_token_limit")
        || norm.ends_with("_token_count")
        || norm.ends_with("_token_usage")
        || norm.starts_with("token_count_")
        || norm.starts_with("token_budget_")
}

fn is_sensitive_json_key(key: &str) -> bool {
    let norm = normalize_key(key);
    if matches!(
        norm.as_str(),
        "api_key"
            | "apikey"
            | "x_api_key"
            | "secret"
            | "secrets"
            | "client_secret"
            | "signing_secret"
            | "webhook_secret"
            | "private_key"
            | "privatekey"
            | "password"
            | "passwd"
            | "passphrase"
            | "credential"
            | "credentials"
            | "authorization"
            | "proxy_authorization"
            | "auth_header"
            | "cookie"
            | "cookies"
            | "set_cookie"
            | "session_cookie"
            | "bearer_token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "auth_token"
            | "api_token"
            | "token"
            | "secret_key"
            | "secretkey"
            | "encryption_key"
            | "master_key"
            | "pat"
    ) {
        return true;
    }

    norm.ends_with("_api_key")
        || norm.ends_with("_apikey")
        || norm.ends_with("_secret")
        || norm.ends_with("_secret_key")
        || norm.ends_with("_private_key")
        || norm.ends_with("_password")
        || norm.ends_with("_passphrase")
        || norm.ends_with("_access_token")
        || norm.ends_with("_refresh_token")
        || norm.ends_with("_auth_token")
        || norm.ends_with("_bearer_token")
}

fn redact_pem_blocks(input: &str) -> String {
    const BEGIN_PREFIX: &str = "-----BEGIN ";
    const PRIVATE_MARKER: &str = "PRIVATE KEY-----";
    const END_PREFIX: &str = "-----END ";

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel_begin) = input[cursor..].find(BEGIN_PREFIX) {
        let begin_idx = cursor + rel_begin;
        out.push_str(&input[cursor..begin_idx]);

        let Some(rel_line_end) = input[begin_idx..].find('\n') else {
            out.push_str(&input[begin_idx..]);
            return out;
        };
        let header_end = begin_idx + rel_line_end;
        let header = input[begin_idx..header_end].trim_end_matches('\r');
        if !header.ends_with(PRIVATE_MARKER) {
            out.push_str(&input[begin_idx..header_end]);
            cursor = header_end;
            continue;
        }

        if let Some(rel_end) = input[header_end..].find(END_PREFIX) {
            let end_line_start = header_end + rel_end;
            let end_block = match input[end_line_start..].find("-----") {
                Some(_) => {
                    let after_prefix = end_line_start + END_PREFIX.len();
                    match input[after_prefix..].find("-----") {
                        Some(rel_tail) => after_prefix + rel_tail + 5,
                        None => input.len(),
                    }
                }
                None => input.len(),
            };
            out.push_str(REDACTED_PRIVATE_KEY);
            cursor = end_block;
        } else {
            out.push_str(REDACTED_PRIVATE_KEY);
            return out;
        }
    }

    out.push_str(&input[cursor..]);
    out
}

fn redact_url_userinfo(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel_scheme) = input[cursor..].find("://") {
        let scheme_end = cursor + rel_scheme + 3;
        out.push_str(&input[cursor..scheme_end]);

        let rest = &input[scheme_end..];
        let authority_end = rest
            .find(['/', '?', '#', ' ', '\t', '\r', '\n', '"', '\''])
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if let Some(at_pos) = authority.rfind('@') {
            let userinfo = &authority[..at_pos];
            if userinfo.contains(':') {
                out.push_str(REDACTED);
                out.push('@');
                out.push_str(&authority[at_pos + 1..]);
                cursor = scheme_end + authority_end;
                continue;
            }
        }
        out.push_str(authority);
        cursor = scheme_end + authority_end;
    }

    out.push_str(&input[cursor..]);
    out
}

fn redact_query_params(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let bytes = input.as_bytes();

    while i < bytes.len() {
        let ch = bytes[i];
        if ch == b'?' || ch == b'&' || is_ident_boundary_before(bytes, i) {
            let start_key = if ch == b'?' || ch == b'&' {
                out.push(ch as char);
                i + 1
            } else {
                i
            };
            if let Some(eq_rel) = input[start_key..].find('=') {
                let eq_pos = start_key + eq_rel;
                let key = &input[start_key..eq_pos];
                if !key.is_empty()
                    && key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    && is_query_secret_key(key)
                {
                    let val_start = eq_pos + 1;
                    let val_len = scan_query_value_end(&input[val_start..]);
                    out.push_str(key);
                    out.push('=');
                    if val_len > 0 {
                        out.push_str(REDACTED);
                    }
                    i = val_start + val_len;
                    continue;
                }
            }
            if ch == b'?' || ch == b'&' {
                i += 1;
                continue;
            }
        }

        let Some(c) = input[i..].chars().next() else {
            break;
        };
        out.push(c);
        i += c.len_utf8();
    }

    out
}

fn is_ident_boundary_before(bytes: &[u8], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    let prev = bytes[idx - 1];
    !(prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'-')
}

fn is_query_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    QUERY_PARAM_KEYS.contains(&lower.as_str())
}

fn scan_query_value_end(rest: &str) -> usize {
    rest.find(|c: char| matches!(c, '&' | '#' | '"' | '\'' | ')' | ']' | '}') || c.is_whitespace())
        .unwrap_or(rest.len())
}

fn redact_header_lines(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (idx, line) in input.split_inclusive('\n').enumerate() {
        let _ = idx;
        let (body, nl) = if let Some(stripped) = line.strip_suffix('\n') {
            (stripped, "\n")
        } else {
            (line, "")
        };
        let (content, cr) = if let Some(stripped) = body.strip_suffix('\r') {
            (stripped, "\r")
        } else {
            (body, "")
        };

        if let Some(colon) = content.find(':') {
            let raw_name = content[..colon].trim();
            let lower_name = raw_name.to_ascii_lowercase();
            // Do not hijack JSON lines like `"api_key": "value"` in raw string inputs;
            // only apply line-header redaction to plain text headers such as Authorization or Cookie.
            let unquoted = raw_name.trim_matches('"');
            let lower_unquoted = unquoted.to_ascii_lowercase();
            let raw_val = content[colon + 1..].trim();
            if TEXT_HEADER_KEYS.contains(&lower_name.as_str())
                && !raw_val.is_empty()
                && raw_val != REDACTED
            {
                out.push_str(&content[..=colon]);
                out.push(' ');
                if let Some((scheme, _)) = split_auth_scheme(raw_val) {
                    out.push_str(scheme);
                    out.push(' ');
                    out.push_str(REDACTED);
                } else {
                    out.push_str(REDACTED);
                }
                out.push_str(cr);
                out.push_str(nl);
                continue;
            }
            if lower_name != lower_unquoted && is_sensitive_json_key(&lower_unquoted) {
                // Quoted `"secret": "value"` line
                let trimmed = raw_val.trim_end_matches(',');
                if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() > 2 {
                    let trailing_comma = if raw_val.ends_with(',') { "," } else { "" };
                    out.push_str(&content[..=colon]);
                    out.push_str(" \"");
                    out.push_str(REDACTED);
                    out.push('"');
                    out.push_str(trailing_comma);
                    out.push_str(cr);
                    out.push_str(nl);
                    continue;
                }
            }
        }

        out.push_str(line);
    }
    out
}

fn split_auth_scheme(val: &str) -> Option<(&str, &str)> {
    let space = val.find(char::is_whitespace)?;
    let scheme = &val[..space];
    let rest = val[space..].trim_start();
    if matches!(
        scheme.to_ascii_lowercase().as_str(),
        "bearer" | "basic" | "token"
    ) && !rest.is_empty()
    {
        Some((scheme, rest))
    } else {
        None
    }
}

fn redact_bearer_tokens(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let bytes = input.as_bytes();

    while i < bytes.len() {
        if is_ident_boundary_before(bytes, i)
            && starts_with_ignore_ascii_case(&input[i..], "bearer ")
        {
            let scheme = &input[i..i + 6];
            let after_space = &input[i + 7..];
            let ws_len = after_space.len() - after_space.trim_start_matches([' ', '\t']).len();
            let tok_start = i + 7 + ws_len;
            let tok_len = scan_token_chars(&input[tok_start..]);
            if tok_len >= 6 && &input[tok_start..tok_start + tok_len] != REDACTED {
                out.push_str(scheme);
                out.push(' ');
                out.push_str(REDACTED);
                i = tok_start + tok_len;
                continue;
            }
        }

        let Some(c) = input[i..].chars().next() else {
            break;
        };
        out.push(c);
        i += c.len_utf8();
    }

    out
}

fn redact_jwt_tokens(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let bytes = input.as_bytes();

    while i < bytes.len() {
        if is_ident_boundary_before(bytes, i) && input[i..].starts_with("eyJ") {
            let tok_len = input[i..].bytes().take_while(|&b| is_jwt_char(b)).count();
            let candidate = &input[i..i + tok_len];
            let mut parts = candidate.split('.');
            if let (Some(h), Some(p), Some(s), None) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            {
                if h.len() >= 8 && p.starts_with("eyJ") && p.len() >= 8 && s.len() >= 8 {
                    out.push_str(REDACTED);
                    i += tok_len;
                    continue;
                }
            }
        }

        let Some(c) = input[i..].chars().next() else {
            break;
        };
        out.push(c);
        i += c.len_utf8();
    }

    out
}

fn redact_prefixed_tokens(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let bytes = input.as_bytes();

    while i < bytes.len() {
        if is_ident_boundary_before(bytes, i) {
            if let Some(prefix) = TOKEN_PREFIXES.iter().find(|&&p| input[i..].starts_with(p)) {
                let tail = &input[i + prefix.len()..];
                let tail_len = scan_token_chars(tail);
                if tail_len >= 8 {
                    out.push_str(REDACTED);
                    i += prefix.len() + tail_len;
                    continue;
                }
            }
        }

        let Some(c) = input[i..].chars().next() else {
            break;
        };
        out.push(c);
        i += c.len_utf8();
    }

    out
}

fn starts_with_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    haystack
        .get(..needle.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(needle))
}

fn scan_token_chars(s: &str) -> usize {
    s.bytes()
        .take_while(|&b| {
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b'/' | b'=')
        })
        .count()
}

fn is_jwt_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}
