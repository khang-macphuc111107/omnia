use crate::CoreError;

/// Encodes a UTF-8 string into UTF-16 code units without a trailing NUL.
#[must_use]
pub fn utf8_to_utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Encodes a UTF-8 string into NUL-terminated UTF-16 code units (for Win32 `*W` APIs).
#[must_use]
pub fn utf8_to_utf16_nul(text: &str) -> Vec<u16> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    units
}

/// Strictly decodes UTF-16 code units into a UTF-8 `String`, rejecting unpaired surrogates.
pub fn utf16_to_utf8(units: &[u16]) -> Result<String, CoreError> {
    String::from_utf16(units)
        .map_err(|err| CoreError::InvalidUtf16(format!("unpaired UTF-16 surrogate: {err}")))
}

/// Decodes a NUL-terminated UTF-16 slice (stopping at the first `0`) strictly into UTF-8.
pub fn utf16_nul_to_utf8(units: &[u16]) -> Result<String, CoreError> {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    utf16_to_utf8(&units[..end])
}

/// Lossily decodes UTF-16 code units, replacing unpaired surrogates with U+FFFD.
#[must_use]
pub fn utf16_to_utf8_lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Returns the exact number of UTF-16 code units needed to represent `text`.
#[must_use]
pub fn utf16_code_unit_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Converts a UTF-8 byte offset within `text` into the corresponding UTF-16 code-unit offset
/// (clamped to `text.len()` and rounded back to the enclosing char boundary if mid-codepoint).
#[must_use]
pub fn utf8_byte_offset_to_utf16_unit(text: &str, byte_offset: usize) -> usize {
    let target = byte_offset.min(text.len());
    let mut utf16_units = 0usize;
    for (idx, ch) in text.char_indices() {
        if idx >= target {
            break;
        }
        if idx + ch.len_utf8() > target {
            break;
        }
        utf16_units += ch.len_utf16();
    }
    utf16_units
}

/// Converts a UTF-16 code-unit offset within `text` into a valid UTF-8 byte offset
/// (never splitting a surrogate pair or multi-byte UTF-8 sequence).
#[must_use]
pub fn utf16_unit_to_utf8_byte_offset(text: &str, utf16_offset: usize) -> usize {
    let mut seen_units = 0usize;
    for (idx, ch) in text.char_indices() {
        let next_units = seen_units + ch.len_utf16();
        if next_units > utf16_offset {
            return idx;
        }
        seen_units = next_units;
    }
    text.len()
}

/// Converts a 0-based `(line, byte_col)` position in `text` into a 0-based LSP UTF-16
/// `(line, utf16_col)` tuple.
#[must_use]
pub fn utf8_line_col_to_lsp_utf16(text: &str, line: usize, byte_col: usize) -> (u32, u32) {
    let Some(line_str) = text.split('\n').nth(line) else {
        return (u32::try_from(line).unwrap_or(u32::MAX), 0);
    };
    let line_clean = line_str.strip_suffix('\r').unwrap_or(line_str);
    let col_units = utf8_byte_offset_to_utf16_unit(line_clean, byte_col);
    (
        u32::try_from(line).unwrap_or(u32::MAX),
        u32::try_from(col_units).unwrap_or(u32::MAX),
    )
}

/// Converts a 0-based LSP UTF-16 `(line, utf16_col)` position in `text` back to a 0-based
/// `(line, utf8_byte_col)` tuple.
#[must_use]
pub fn lsp_utf16_to_utf8_line_col(text: &str, line: u32, utf16_col: u32) -> (usize, usize) {
    let line_idx = line as usize;
    let Some(line_str) = text.split('\n').nth(line_idx) else {
        return (line_idx, 0);
    };
    let line_clean = line_str.strip_suffix('\r').unwrap_or(line_str);
    let byte_col = utf16_unit_to_utf8_byte_offset(line_clean, utf16_col as usize);
    (line_idx, byte_col)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_roundtrip_surrogates_and_lsp_offsets() {
        let sample = "Xin chào 👋 Omnia\nlet x = 1;";
        let u16s = utf8_to_utf16(sample);
        assert_eq!(utf16_to_utf8(&u16s).expect("valid utf16"), sample);

        // Unpaired high surrogate fails strictly.
        assert!(utf16_to_utf8(&[0xD83D]).is_err());

        // `👋` is 4 UTF-8 bytes and 2 UTF-16 code units starting at byte 10 / UTF-16 unit 9.
        let byte_after_emoji = "Xin chào 👋".len();
        let u16_pos = utf8_byte_offset_to_utf16_unit(sample, byte_after_emoji);
        assert_eq!(u16_pos, 11);
        assert_eq!(utf16_unit_to_utf8_byte_offset(sample, u16_pos), byte_after_emoji);

        let (lsp_line, lsp_col) = utf8_line_col_to_lsp_utf16(sample, 0, byte_after_emoji);
        assert_eq!((lsp_line, lsp_col), (0, 11));
        assert_eq!(lsp_utf16_to_utf8_line_col(sample, 0, 11), (0, byte_after_emoji));
    }
}
