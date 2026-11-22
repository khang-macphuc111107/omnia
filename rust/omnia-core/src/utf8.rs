use std::time::{SystemTime, UNIX_EPOCH};

/// Return current wall-clock time as signed milliseconds since the Unix epoch.
#[must_use]
pub fn now_epoch_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(before) => {
            let ms = i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX);
            -ms
        }
    }
}

/// Return `true` when `bytes` is strictly valid UTF-8.
#[must_use]
pub fn is_valid_utf8(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok()
}

/// Decode arbitrary bytes into UTF-8 by replacing ill-formed byte sequences with `U+FFFD`.
#[must_use]
pub fn sanitize_utf8_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Count Unicode scalar values (`char`s) in `s`.
#[must_use]
pub fn utf8_codepoint_count(s: &str) -> usize {
    s.chars().count()
}

/// Return `true` when `s` contains disallowed ASCII C0 control characters (`< 0x20` or `0x7F`),
/// excluding ordinary whitespace if desired — wait: mirrors native title/model validation where
/// all control bytes `< 0x20` or `== 0x7F` are rejected unless whitespace is handled separately.
#[must_use]
pub fn utf8_has_control_chars(s: &str) -> bool {
    s.bytes().any(|b| b < 0x20 || b == 0x7F)
}

/// Truncate `s` cleanly to at most `max_chars` Unicode scalar values without splitting UTF-8 codepoints.
#[must_use]
pub fn truncate_utf8_codepoints(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    match s.char_indices().nth(max_chars) {
        Some((end, _)) => s[..end].to_owned(),
        None => s.to_owned(),
    }
}

/// Truncate `s` to at most `max_chars` codepoints, avoiding breaking mid-word when whitespace
/// exists inside the retained prefix.
#[must_use]
pub fn truncate_utf8_word_safe(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let Some((cut_byte, next_ch)) = s.char_indices().nth(max_chars) else {
        return s.to_owned();
    };

    let prefix = &s[..cut_byte];
    if next_ch.is_whitespace() {
        return prefix.trim_end_matches(char::is_whitespace).to_owned();
    }

    if let Some((ws_byte, _)) = prefix
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_whitespace())
    {
        let trimmed = prefix[..ws_byte].trim_end_matches(char::is_whitespace);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }

    prefix.to_owned()
}

/// Truncate `s` to at most `max_bytes` UTF-8 bytes without splitting multi-byte codepoints,
/// appending `suffix` when truncation occurs and budget permits.
#[must_use]
pub fn truncate_utf8_bytes(s: &str, max_bytes: usize, suffix: &str) -> String {
    if s.len() <= max_bytes {
        return s.to_owned();
    }
    if max_bytes == 0 {
        return String::new();
    }
    if suffix.len() >= max_bytes {
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        return s[..end].to_owned();
    }

    let content_budget = max_bytes - suffix.len();
    let mut end = content_budget;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + suffix.len());
    out.push_str(&s[..end]);
    out.push_str(suffix);
    out
}
