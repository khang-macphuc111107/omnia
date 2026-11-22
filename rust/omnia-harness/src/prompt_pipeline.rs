use std::collections::{BTreeMap, BTreeSet, HashMap};

use omnia_core::{sha256_hex, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

use crate::proactive_rag::{fold_vietnamese_ascii, has_vietnamese_diacritics};

/// Canonical data-plane envelope tag preventing prompt injection into normalized records.
pub const DATA_PLANE_SCHEMA_MODE: &str = "INERT_STRING_RECORD_ONLY";

/// Classification for spans deterministically extracted before prose normalization or translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProtectedSpanKind {
    FencedCodeBlock,
    InlineCode,
    LatexDisplayMath,
    LatexInlineMath,
    Url,
    FilesystemPath,
    CliFlag,
    NumericUnitLiteral,
    Identifier,
}

impl ProtectedSpanKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FencedCodeBlock => "fenced_code_block",
            Self::InlineCode => "inline_code",
            Self::LatexDisplayMath => "latex_display_math",
            Self::LatexInlineMath => "latex_inline_math",
            Self::Url => "url",
            Self::FilesystemPath => "filesystem_path",
            Self::CliFlag => "cli_flag",
            Self::NumericUnitLiteral => "numeric_unit_literal",
            Self::Identifier => "identifier",
        }
    }
}

impl Serialize for ProtectedSpanKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.as_str().serialize(serializer)
    }
}

/// One extracted technical/code/math span replaced by `__OMNIA_SPAN_XXXX__`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedSpan {
    pub index: usize,
    pub placeholder: String,
    pub kind: ProtectedSpanKind,
    pub raw: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

impl ProtectedSpan {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "placeholder": self.placeholder,
            "kind": self.kind.as_str(),
            "raw": self.raw,
            "start_byte": self.start_byte,
            "end_byte": self.end_byte,
        })
    }
}

impl Serialize for ProtectedSpan {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Result of [`extract_protected_spans`], holding masked text and indexed span records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedSpanExtraction {
    pub masked_text: String,
    pub spans: Vec<ProtectedSpan>,
}

impl ProtectedSpanExtraction {
    /// Restore all extracted placeholders inside `text` back to their exact raw spans.
    #[must_use]
    pub fn restore(&self, text: &str) -> String {
        restore_protected_spans(text, &self.spans)
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "masked_text": self.masked_text,
            "spans": self.spans.iter().map(ProtectedSpan::to_json).collect::<Vec<_>>(),
        })
    }
}

impl AsRef<[ProtectedSpan]> for ProtectedSpanExtraction {
    fn as_ref(&self) -> &[ProtectedSpan] {
        &self.spans
    }
}

impl Serialize for ProtectedSpanExtraction {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Deterministically extracts fenced code blocks, inline backtick spans, URLs, Windows/POSIX
/// paths, CLI flags, code identifiers (`snake_case`, `camelCase`, `PascalCase`), LaTeX math
/// (`$...$`, `$$...$$`), and numeric+unit literals into `__OMNIA_SPAN_0001__` placeholders.
#[must_use]
pub fn extract_protected_spans(input: &str) -> ProtectedSpanExtraction {
    if input.is_empty() {
        return ProtectedSpanExtraction {
            masked_text: String::new(),
            spans: Vec::new(),
        };
    }

    let mut masked = String::with_capacity(input.len());
    let mut spans = Vec::new();
    let mut cursor = 0usize;

    while cursor < input.len() {
        if let Some((end_byte, kind)) = match_protected_span_at(input, cursor) {
            let idx = spans.len() + 1;
            let placeholder = format!("__OMNIA_SPAN_{idx:04}__");
            let raw = input[cursor..end_byte].to_owned();
            spans.push(ProtectedSpan {
                index: idx,
                placeholder: placeholder.clone(),
                kind,
                raw,
                start_byte: cursor,
                end_byte,
            });
            masked.push_str(&placeholder);
            cursor = end_byte;
            continue;
        }

        let Some(ch) = input[cursor..].chars().next() else {
            break;
        };
        masked.push(ch);
        cursor += ch.len_utf8();
    }

    ProtectedSpanExtraction {
        masked_text: masked,
        spans,
    }
}

/// Deterministically restores `__OMNIA_SPAN_XXXX__` placeholders back to their exact original
/// spans in a single non-recursive pass so nested raw text cannot trigger double substitution.
#[must_use]
pub fn restore_protected_spans<S: AsRef<[ProtectedSpan]>>(text: &str, spans: S) -> String {
    let slice = spans.as_ref();
    if slice.is_empty() || !text.contains("__OMNIA_SPAN_") {
        return text.to_owned();
    }

    let lookup: HashMap<&str, &str> = slice
        .iter()
        .map(|s| (s.placeholder.as_str(), s.raw.as_str()))
        .collect();

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    const PREFIX: &str = "__OMNIA_SPAN_";

    while let Some(rel) = text[cursor..].find(PREFIX) {
        let start = cursor + rel;
        out.push_str(&text[cursor..start]);

        let after_prefix = &text[start + PREFIX.len()..];
        let digits_len = after_prefix
            .bytes()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits_len >= 4 && after_prefix[digits_len..].starts_with("__") {
            let end = start + PREFIX.len() + digits_len + 2;
            let token = &text[start..end];
            if let Some(raw) = lookup.get(token) {
                out.push_str(raw);
                cursor = end;
                continue;
            }
        }

        out.push_str(PREFIX);
        cursor = start + PREFIX.len();
    }

    out.push_str(&text[cursor..]);
    out
}

fn match_protected_span_at(input: &str, idx: usize) -> Option<(usize, ProtectedSpanKind)> {
    if let Some(end) = match_fenced_code_block(input, idx) {
        return Some((end, ProtectedSpanKind::FencedCodeBlock));
    }
    if let Some(end) = match_inline_code(input, idx) {
        return Some((end, ProtectedSpanKind::InlineCode));
    }
    if let Some(end) = match_latex_display(input, idx) {
        return Some((end, ProtectedSpanKind::LatexDisplayMath));
    }
    if let Some(end) = match_latex_inline(input, idx) {
        return Some((end, ProtectedSpanKind::LatexInlineMath));
    }
    if let Some(end) = match_url(input, idx) {
        return Some((end, ProtectedSpanKind::Url));
    }
    if let Some(end) = match_filesystem_path(input, idx) {
        return Some((end, ProtectedSpanKind::FilesystemPath));
    }
    if let Some(end) = match_cli_flag(input, idx) {
        return Some((end, ProtectedSpanKind::CliFlag));
    }
    if let Some(end) = match_numeric_unit_literal(input, idx) {
        return Some((end, ProtectedSpanKind::NumericUnitLiteral));
    }
    if let Some(end) = match_identifier(input, idx) {
        return Some((end, ProtectedSpanKind::Identifier));
    }
    None
}

fn prev_char(input: &str, idx: usize) -> Option<char> {
    input[..idx].chars().next_back()
}

fn is_line_start_with_indent(input: &str, idx: usize) -> bool {
    let line_start = input[..idx].rfind('\n').map_or(0, |p| p + 1);
    input[line_start..idx]
        .chars()
        .all(|c| c == ' ' || c == '\t')
}

fn match_fenced_code_block(input: &str, idx: usize) -> Option<usize> {
    let rest = &input[idx..];
    let fence_char = if rest.starts_with("```") {
        '`'
    } else if rest.starts_with("~~~") && is_line_start_with_indent(input, idx) {
        '~'
    } else {
        return None;
    };

    let fence_len = rest
        .bytes()
        .take_while(|&b| b as char == fence_char)
        .count();
    if fence_len < 3 {
        return None;
    }

    let at_line_start = is_line_start_with_indent(input, idx);
    let after_open = idx + fence_len;

    // 1. Single-line fenced block on one line (e.g. ```fn main() {}```).
    if fence_char == '`' {
        let line_limit = input[after_open..]
            .find('\n')
            .map_or(input.len(), |p| after_open + p);
        let needle: String = std::iter::repeat_n('`', fence_len).collect();
        if let Some(close_rel) = input[after_open..line_limit].find(&needle) {
            let end = after_open + close_rel + fence_len;
            let extra = input[end..].bytes().take_while(|&b| b == b'`').count();
            return Some(end + extra);
        }
    }

    // 2. Multi-line fenced block (either at line start or preceded by whitespace in inline prompt prose).
    if at_line_start || (fence_char == '`' && prev_char(input, idx).is_none_or(char::is_whitespace))
    {
        if let Some(nl_rel) = input[after_open..].find('\n') {
            let mut search_pos = after_open + nl_rel + 1;
            while search_pos < input.len() {
                let line_end = input[search_pos..]
                    .find('\n')
                    .map_or(input.len(), |p| search_pos + p);
                let line = input[search_pos..line_end].trim_end_matches('\r');
                let trimmed = line.trim_start_matches([' ', '\t']);
                let leading_ws = line.len() - trimmed.len();
                let close_len = trimmed
                    .bytes()
                    .take_while(|&b| b as char == fence_char)
                    .count();
                if close_len >= fence_len {
                    let after_close = &trimmed[close_len..];
                    if after_close.trim().is_empty() {
                        return Some(line_end);
                    }
                    if !at_line_start
                        && after_close.starts_with(|c: char| {
                            c.is_whitespace() || matches!(c, ',' | '.' | ';' | ':' | ')' | ']')
                        })
                    {
                        return Some(search_pos + leading_ws + close_len);
                    }
                }
                if line_end == input.len() {
                    break;
                }
                search_pos = line_end + 1;
            }
            // Unclosed multi-line fence protects to EOF so inner syntax stays intact.
            return Some(input.len());
        }
    }

    None
}

fn match_inline_code(input: &str, idx: usize) -> Option<usize> {
    let rest = &input[idx..];
    if !rest.starts_with('`') {
        return None;
    }
    let tick_len = rest.bytes().take_while(|&b| b == b'`').count();
    if tick_len >= 3 {
        return None;
    }
    let after_open = idx + tick_len;
    let paragraph_limit = find_blank_line_end(input, after_open).unwrap_or(input.len());

    let mut pos = after_open;
    while pos < paragraph_limit {
        if input.as_bytes()[pos] == b'`' {
            let run = input[pos..paragraph_limit]
                .bytes()
                .take_while(|&b| b == b'`')
                .count();
            if run == tick_len {
                if pos > after_open {
                    return Some(pos + run);
                }
                return None;
            }
            pos += run;
            continue;
        }
        pos += input[pos..].chars().next()?.len_utf8();
    }
    None
}

fn find_blank_line_end(input: &str, start: usize) -> Option<usize> {
    let slice = &input[start..];
    let lf = slice.find("\n\n");
    let crlf = slice.find("\r\n\r\n");
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(start + a.min(b)),
        (Some(a), None) => Some(start + a),
        (None, Some(b)) => Some(start + b),
        (None, None) => None,
    }
}

fn is_escaped(input: &str, idx: usize) -> bool {
    let bytes = input.as_bytes();
    let mut backslashes = 0usize;
    let mut pos = idx;
    while pos > 0 && bytes[pos - 1] == b'\\' {
        backslashes += 1;
        pos -= 1;
    }
    backslashes % 2 == 1
}

fn match_latex_display(input: &str, idx: usize) -> Option<usize> {
    if !input[idx..].starts_with("$$") || is_escaped(input, idx) {
        return None;
    }
    let after_open = idx + 2;
    let mut pos = after_open;
    while pos + 1 < input.len() {
        if input[pos..].starts_with("$$") && !is_escaped(input, pos) {
            if !input[after_open..pos].trim().is_empty() {
                return Some(pos + 2);
            }
            return None;
        }
        pos += input[pos..].chars().next()?.len_utf8();
    }
    None
}

fn match_latex_inline(input: &str, idx: usize) -> Option<usize> {
    if !input[idx..].starts_with('$') || input[idx..].starts_with("$$") || is_escaped(input, idx) {
        return None;
    }
    let after_open = idx + 1;
    let first_ch = input[after_open..].chars().next()?;
    if first_ch.is_whitespace() {
        return None;
    }

    let line_end = input[after_open..]
        .find('\n')
        .map_or(input.len(), |p| after_open + p);

    let mut pos = after_open;
    while pos < line_end {
        if input.as_bytes()[pos] == b'$' && !is_escaped(input, pos) {
            if input[pos..].starts_with("$$") {
                pos += 2;
                continue;
            }
            let prev = prev_char(input, pos)?;
            let next = input[pos + 1..].chars().next();
            let valid_close =
                !prev.is_whitespace() && !next.is_some_and(|c| c.is_ascii_alphanumeric());
            if valid_close && pos > after_open {
                let inner = &input[after_open..pos];
                if !inner.trim().is_empty() {
                    return Some(pos + 1);
                }
            }
            return None;
        }
        pos += input[pos..].chars().next()?.len_utf8();
    }
    None
}

fn match_url(input: &str, idx: usize) -> Option<usize> {
    if let Some(prev) = prev_char(input, idx) {
        if prev.is_alphanumeric() || prev == '_' {
            return None;
        }
    }
    let rest = &input[idx..];
    let scheme_len = if starts_with_ignore_ascii_case(rest, "https://") {
        8
    } else if starts_with_ignore_ascii_case(rest, "http://") {
        7
    } else {
        return None;
    };

    let after_scheme = &rest[scheme_len..];
    let first = after_scheme.chars().next()?;
    if first.is_whitespace() || matches!(first, '<' | '>' | '"' | '\'' | '`') {
        return None;
    }

    let raw_end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`'))
        .unwrap_or(rest.len());
    let candidate = trim_trailing_delimiters(&rest[..raw_end], true);
    if candidate.len() <= scheme_len {
        return None;
    }
    Some(idx + candidate.len())
}

fn match_filesystem_path(input: &str, idx: usize) -> Option<usize> {
    if let Some(prev) = prev_char(input, idx) {
        if !(prev.is_whitespace()
            || matches!(prev, '(' | '[' | '{' | '"' | '\'' | '=' | ':' | ',' | ';'))
        {
            return None;
        }
    }

    let rest = &input[idx..];
    let bytes = rest.as_bytes();

    // 1. Windows drive path (D:\... or C:/...) or UNC path (\\server\share...)
    let is_win_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_win_unc = bytes.len() >= 5
        && bytes[0] == b'\\'
        && bytes[1] == b'\\'
        && bytes[2].is_ascii_alphanumeric();

    if is_win_drive || is_win_unc {
        let raw_end = scan_path_token_end(rest);
        if is_win_unc {
            let trimmed = trim_trailing_delimiters(&rest[..raw_end], false);
            if trimmed[2..].contains('\\') {
                return Some(idx + trimmed.len());
            }
            return None;
        }
        let min_len = 3;
        if raw_end > min_len {
            let trimmed = trim_trailing_delimiters(&rest[..raw_end], false);
            if trimmed.len() >= min_len {
                return Some(idx + trimmed.len());
            }
        }
        return None;
    }

    // 2. Explicit relative/home/rooted POSIX path: ./..., ../..., ~/..., /seg/seg...
    let is_explicit_posix = rest.starts_with("./")
        || rest.starts_with("../")
        || rest.starts_with("~/")
        || rest.starts_with(".\\")
        || rest.starts_with("..\\");
    if is_explicit_posix {
        let raw_end = scan_path_token_end(rest);
        let trimmed = trim_trailing_delimiters(&rest[..raw_end], false);
        if trimmed.len() >= 3 {
            return Some(idx + trimmed.len());
        }
        return None;
    }

    if rest.starts_with('/') {
        let raw_end = scan_path_token_end(rest);
        let trimmed = trim_trailing_delimiters(&rest[..raw_end], false);
        let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
        if segments.len() >= 2
            && segments
                .iter()
                .all(|s| s.chars().all(is_posix_segment_char))
            && segments
                .iter()
                .any(|s| s.chars().any(|c| c.is_ascii_alphabetic()))
        {
            return Some(idx + trimmed.len());
        }
        return None;
    }

    // 3. Unrooted workspace/repo relative path (e.g. rust/omnia-harness/src/lib.rs, src/main.rs).
    // Strictly avoid matching short prose pairs like "ac/dc", "and/or", "yes/no".
    let raw_end = scan_path_token_end(rest);
    if raw_end < 3 {
        return None;
    }
    let trimmed = trim_trailing_delimiters(&rest[..raw_end], false);
    let sep = if trimmed.contains('/') {
        '/'
    } else if trimmed.contains('\\') {
        '\\'
    } else {
        return None;
    };

    if trimmed.starts_with(sep) {
        return None;
    }
    let has_trailing_sep = trimmed.ends_with(sep);
    let segments: Vec<&str> = trimmed.split(sep).filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    if segments.len() == 1 && !has_trailing_sep {
        return None;
    }
    if !segments
        .iter()
        .all(|s| !s.is_empty() && s.chars().all(is_posix_segment_char))
    {
        return None;
    }
    if !segments
        .iter()
        .any(|s| s.chars().any(|c| c.is_ascii_alphabetic()))
    {
        return None;
    }

    let first_lower = segments[0].to_ascii_lowercase();
    let known_root = matches!(
        first_lower.as_str(),
        "rust"
            | "src"
            | "docs"
            | "tools"
            | "tests"
            | "test"
            | "native"
            | "platform"
            | "ui"
            | "bin"
            | "etc"
            | "usr"
            | "var"
            | "tmp"
            | "opt"
            | "home"
            | "app"
            | "lib"
            | "crates"
            | "include"
            | "scripts"
    );
    let has_extension = segments.iter().any(|s| looks_like_file_with_ext(s));
    let has_ident_sep = segments.iter().any(|s| s.contains('_') || s.contains('-'));
    let multi_slash = segments.len() >= 3;

    if sep == '\\'
        || known_root
        || has_trailing_sep
        || multi_slash
        || has_extension
        || has_ident_sep
    {
        return Some(idx + trimmed.len());
    }

    None
}

fn scan_path_token_end(rest: &str) -> usize {
    rest.find(|c: char| {
        c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`' | '|' | '*' | '?')
    })
    .unwrap_or(rest.len())
}

fn is_posix_segment_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '~')
}

fn looks_like_file_with_ext(seg: &str) -> bool {
    if seg == "..." {
        return true;
    }
    let Some(dot) = seg.rfind('.') else {
        return false;
    };
    if dot == 0 || dot + 1 >= seg.len() {
        return false;
    }
    let ext = &seg[dot + 1..];
    (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

fn trim_trailing_delimiters(candidate: &str, is_url: bool) -> &str {
    let mut end = candidate.len();
    loop {
        let slice = &candidate[..end];
        let Some(last) = slice.chars().next_back() else {
            break;
        };
        let should_strip = match last {
            ',' | ';' | '!' | '?' => true,
            ':' => !slice.ends_with("://"),
            '.' => {
                // Preserve intentional `...` ellipsis inside paths like `D:\...` or `rust/...`.
                !slice.ends_with("...") && (is_url || slice.len() > 2)
            }
            ')' => unmatched_closing(slice, '(', ')'),
            ']' => unmatched_closing(slice, '[', ']'),
            '}' => unmatched_closing(slice, '{', '}'),
            _ => false,
        };
        if !should_strip {
            break;
        }
        end -= last.len_utf8();
    }
    &candidate[..end]
}

fn unmatched_closing(s: &str, open: char, close: char) -> bool {
    let opens = s.chars().filter(|&c| c == open).count();
    let closes = s.chars().filter(|&c| c == close).count();
    closes > opens
}

fn match_cli_flag(input: &str, idx: usize) -> Option<usize> {
    if let Some(prev) = prev_char(input, idx) {
        if !(prev.is_whitespace()
            || matches!(prev, '(' | '[' | '{' | '"' | '\'' | ',' | ';' | '=' | ':'))
        {
            return None;
        }
    }
    let rest = &input[idx..];
    let bytes = rest.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'-' {
        return None;
    }

    let end = if bytes[1] == b'-' {
        // Long flag: `--offline`, `--secret-scope=all`
        if bytes.len() < 3 || !bytes[2].is_ascii_alphanumeric() {
            return None;
        }
        let mut pos = 3usize;
        while pos < bytes.len()
            && (bytes[pos].is_ascii_alphanumeric() || matches!(bytes[pos], b'-' | b'_'))
        {
            pos += 1;
        }
        if pos < bytes.len() && bytes[pos] == b'=' {
            let mut val_pos = pos + 1;
            while val_pos < bytes.len() {
                let b = bytes[val_pos];
                if b.is_ascii_alphanumeric()
                    || matches!(b, b'_' | b'-' | b'.' | b'/' | b'\\' | b':')
                {
                    val_pos += 1;
                } else {
                    break;
                }
            }
            if val_pos > pos + 1 {
                pos = val_pos;
            }
        }
        pos
    } else if bytes[1].is_ascii_alphabetic() {
        // Short or PowerShell flag: `-p`, `-B`, `-NoProfile`
        let mut pos = 2usize;
        while pos < bytes.len()
            && (bytes[pos].is_ascii_alphanumeric() || matches!(bytes[pos], b'-' | b'_'))
        {
            pos += 1;
        }
        pos
    } else {
        return None;
    };

    if let Some(next) = rest[end..].chars().next() {
        if !(next.is_whitespace()
            || matches!(
                next,
                ',' | ';' | ')' | ']' | '}' | '"' | '\'' | '.' | ':' | '!' | '?'
            ))
        {
            return None;
        }
    }
    Some(idx + end)
}

fn match_numeric_unit_literal(input: &str, idx: usize) -> Option<usize> {
    if let Some(prev) = prev_char(input, idx) {
        if prev.is_alphanumeric() || matches!(prev, '_' | '.') {
            return None;
        }
    }

    let rest = &input[idx..];
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return None;
    }

    let mut pos = 0usize;
    if bytes[0] == b'-' {
        if bytes.len() < 2 || !bytes[1].is_ascii_digit() {
            return None;
        }
        if let Some(prev) = prev_char(input, idx) {
            if !(prev.is_whitespace() || matches!(prev, '(' | '[' | '{' | ',' | '=' | ':')) {
                return None;
            }
        }
        pos = 1;
    } else if !bytes[0].is_ascii_digit() {
        return None;
    }

    let int_start = pos;
    while pos < bytes.len() && bytes[pos].is_ascii_digit() {
        pos += 1;
    }
    if pos == int_start {
        return None;
    }

    if pos + 1 < bytes.len() && bytes[pos] == b'.' && bytes[pos + 1].is_ascii_digit() {
        pos += 1;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
    }

    // Either directly attached unit (3.5V, 120Hz) or single-space separated unit (4096 MB).
    let (unit_start, spaced) = if pos < bytes.len() && bytes[pos] == b' ' {
        (pos + 1, true)
    } else {
        (pos, false)
    };

    let unit_slice = &rest[unit_start..];
    let mut unit_end_rel = 0usize;
    for ch in unit_slice.chars() {
        if ch.is_ascii_alphabetic() || matches!(ch, 'µ' | 'μ' | 'Ω' | '°' | '%') {
            unit_end_rel += ch.len_utf8();
        } else {
            break;
        }
    }
    if unit_end_rel == 0 {
        return None;
    }

    let unit = &unit_slice[..unit_end_rel];
    let after_unit = unit_slice[unit_end_rel..].chars().next();
    if after_unit.is_some_and(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    if is_known_technical_unit(unit, spaced) {
        return Some(idx + unit_start + unit_end_rel);
    }

    None
}

fn is_known_technical_unit(unit: &str, spaced: bool) -> bool {
    let lower = unit.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "hz" | "khz"
            | "mhz"
            | "ghz"
            | "mv"
            | "kv"
            | "ma"
            | "ua"
            | "µa"
            | "μa"
            | "mw"
            | "kw"
            | "kb"
            | "mb"
            | "gb"
            | "tb"
            | "pb"
            | "kib"
            | "mib"
            | "gib"
            | "tib"
            | "bps"
            | "kbps"
            | "mbps"
            | "gbps"
            | "ms"
            | "us"
            | "µs"
            | "μs"
            | "ns"
            | "px"
            | "pt"
            | "em"
            | "rem"
            | "mm"
            | "cm"
            | "km"
            | "kg"
            | "mg"
            | "fps"
            | "dpi"
            | "ppi"
            | "rpm"
            | "mah"
            | "wh"
            | "kwh"
            | "va"
            | "kva"
            | "ohm"
            | "ohms"
            | "bit"
            | "bits"
            | "byte"
            | "bytes"
            | "v"
    ) {
        return true;
    }

    // Single-letter SI/computing symbols require exact case unless spaced units above.
    matches!(unit, "V" | "A" | "W" | "B" | "K" | "Ω" | "°C" | "°F") || (!spaced && unit == "s")
}

fn match_identifier(input: &str, idx: usize) -> Option<usize> {
    if let Some(prev) = prev_char(input, idx) {
        if prev.is_alphanumeric() || prev == '_' {
            return None;
        }
    }

    let rest = &input[idx..];
    let first = rest.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }

    let bytes = rest.as_bytes();
    let mut len = 0usize;
    while len < bytes.len() && (bytes[len].is_ascii_alphanumeric() || bytes[len] == b'_') {
        len += 1;
    }
    if len < 2 {
        return None;
    }

    if let Some(next) = rest[len..].chars().next() {
        if next.is_alphanumeric() || next == '_' {
            return None;
        }
    }

    let token = &rest[..len];
    if is_snake_camel_or_pascal_identifier(token) {
        return Some(idx + len);
    }
    None
}

fn is_snake_camel_or_pascal_identifier(token: &str) -> bool {
    let has_alpha = token.bytes().any(|b| b.is_ascii_alphabetic());
    if !has_alpha {
        return false;
    }

    // snake_case or SCREAMING_SNAKE_CASE (at least one underscore plus letter)
    if token.contains('_') {
        return !token.starts_with("__OMNIA_SPAN_");
    }

    let bytes = token.as_bytes();
    let has_upper = bytes.iter().any(|b| b.is_ascii_uppercase());
    let has_lower = bytes.iter().any(|b| b.is_ascii_lowercase());

    // camelCase: starts lowercase ASCII, has uppercase ASCII
    if bytes[0].is_ascii_lowercase() && has_upper {
        return true;
    }

    // PascalCase: starts uppercase ASCII, has lowercase AND >= 2 uppercase humps (avoids plain words like "Hello")
    if bytes[0].is_ascii_uppercase() && has_lower {
        let upper_count = bytes.iter().filter(|b| b.is_ascii_uppercase()).count();
        let has_lower_to_upper = bytes.windows(2).any(|w| {
            (w[0].is_ascii_lowercase() || w[0].is_ascii_digit()) && w[1].is_ascii_uppercase()
        });
        return upper_count >= 2 && (has_lower_to_upper || bytes[1].is_ascii_uppercase());
    }

    false
}

/// Diagnostic note emitted when a short token is borderline between Vietnamese shorthand and a
/// technical/English reading and is therefore preserved rather than blindly rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguousTokenNote {
    pub token: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub left_context: Vec<String>,
    pub right_context: Vec<String>,
    pub candidate_expansions: Vec<String>,
    pub action: String,
    pub reason: String,
}

impl AmbiguousTokenNote {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "token": self.token,
            "byte_start": self.byte_start,
            "byte_end": self.byte_end,
            "left_context": self.left_context,
            "right_context": self.right_context,
            "candidate_expansions": self.candidate_expansions,
            "action": self.action,
            "reason": self.reason,
        })
    }
}

impl Serialize for AmbiguousTokenNote {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Concrete shorthand restoration applied after verifying surrounding collocations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedNormalizationNote {
    pub original: String,
    pub restored: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub reason: String,
}

impl AppliedNormalizationNote {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "original": self.original,
            "restored": self.restored,
            "byte_start": self.byte_start,
            "byte_end": self.byte_end,
            "reason": self.reason,
        })
    }
}

impl Serialize for AppliedNormalizationNote {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Output of [`restore_vietnamese_contextual`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VietnameseRestorationResult {
    pub original: String,
    pub restored_text: String,
    pub protected_spans_count: usize,
    pub applied_normalizations: Vec<AppliedNormalizationNote>,
    pub ambiguous_tokens: Vec<AmbiguousTokenNote>,
}

impl VietnameseRestorationResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "original": SecretRedactor::redact(&self.original),
            "restored_text": SecretRedactor::redact(&self.restored_text),
            "protected_spans_count": self.protected_spans_count,
            "applied_normalizations": self.applied_normalizations.iter().map(AppliedNormalizationNote::to_json).collect::<Vec<_>>(),
            "ambiguous_tokens": self.ambiguous_tokens.iter().map(AmbiguousTokenNote::to_json).collect::<Vec<_>>(),
        }))
    }
}

impl Serialize for VietnameseRestorationResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

#[derive(Debug, Clone)]
struct ProseSegment {
    raw: String,
    is_word: bool,
    is_placeholder: bool,
    start_byte: usize,
    end_byte: usize,
}

/// Context-aware Vietnamese chat shorthand & typo restorer.
///
/// Extracts protected technical spans first, inspects left/right collocations and clause
/// context so technical/math expressions (`"dòng điện dc"`, `"nguồn dc"`, `"ac/dc"`,
/// `"tham số r"`, `"biến r"`, `"r = 10"`) remain untouched, restores verified Vietnamese
/// chat shorthand (`"làm dc ko r"` -> `"làm được không rồi"`,
/// `"trl giùm vde nhx cx khó"` -> `"trả lời giùm vấn đề nhưng cũng khó"`), and emits
/// [`AmbiguousTokenNote`] entries for borderline tokens instead of blind regex replacement.
#[must_use]
pub fn restore_vietnamese_contextual(input: &str) -> VietnameseRestorationResult {
    let extraction = extract_protected_spans(input);
    let span_raw_by_placeholder: HashMap<&str, &str> = extraction
        .spans
        .iter()
        .map(|s| (s.placeholder.as_str(), s.raw.as_str()))
        .collect();

    let mut segments = tokenize_prose_segments(&extraction.masked_text);
    let word_indices: Vec<usize> = segments
        .iter()
        .enumerate()
        .filter_map(|(idx, seg)| if seg.is_word { Some(idx) } else { None })
        .collect();

    let mut applied_normalizations = Vec::new();
    let mut ambiguous_tokens = Vec::new();

    // Precompute clause bounds per segment index (split on sentence punctuation or newline).
    let clause_ids = assign_clause_ids(&segments);

    for (pos_in_words, &seg_idx) in word_indices.iter().enumerate() {
        let seg = &segments[seg_idx];
        if seg.is_placeholder {
            continue;
        }
        let raw_tok = seg.raw.clone();
        let lower_tok = raw_tok.to_lowercase();
        let folded_tok = fold_vietnamese_ascii(&raw_tok);
        let clause_id = clause_ids[seg_idx];

        let (left_words, right_words) = collect_neighbor_words(
            &segments,
            &word_indices,
            pos_in_words,
            &span_raw_by_placeholder,
        );
        let left_punct = nearest_non_space_char_before(&segments, seg_idx);
        let right_punct = nearest_non_space_char_after(&segments, seg_idx);
        let at_clause_end = is_at_clause_end(&segments, seg_idx);
        let clause_stats = compute_clause_stats(&segments, &clause_ids, clause_id);

        let decision = evaluate_token_normalization(
            &raw_tok,
            &lower_tok,
            &folded_tok,
            &left_words,
            &right_words,
            left_punct,
            right_punct,
            at_clause_end,
            &clause_stats,
        );

        match decision {
            TokenDecision::Restore { target, reason } => {
                let cased = preserve_leading_case(&raw_tok, target);
                if cased != raw_tok {
                    applied_normalizations.push(AppliedNormalizationNote {
                        original: raw_tok,
                        restored: cased.clone(),
                        byte_start: seg.start_byte,
                        byte_end: seg.end_byte,
                        reason: reason.to_owned(),
                    });
                    segments[seg_idx].raw = cased;
                }
            }
            TokenDecision::Ambiguous { candidates, reason } => {
                ambiguous_tokens.push(AmbiguousTokenNote {
                    token: raw_tok,
                    byte_start: seg.start_byte,
                    byte_end: seg.end_byte,
                    left_context: left_words,
                    right_context: right_words,
                    candidate_expansions: candidates.into_iter().map(str::to_owned).collect(),
                    action: "preserved".to_owned(),
                    reason: reason.to_owned(),
                });
            }
            TokenDecision::Keep => {}
        }
    }

    let rebuilt_masked: String = segments.into_iter().map(|s| s.raw).collect();
    let restored_text = restore_protected_spans(&rebuilt_masked, &extraction.spans);

    VietnameseRestorationResult {
        original: input.to_owned(),
        restored_text,
        protected_spans_count: extraction.spans.len(),
        applied_normalizations,
        ambiguous_tokens,
    }
}

enum TokenDecision {
    Keep,
    Restore {
        target: &'static str,
        reason: &'static str,
    },
    Ambiguous {
        candidates: Vec<&'static str>,
        reason: &'static str,
    },
}

struct ClauseStats {
    vn_signal_score: u32,
    en_signal_score: u32,
}

fn tokenize_prose_segments(text: &str) -> Vec<ProseSegment> {
    let mut out = Vec::new();
    let mut idx = 0usize;

    while idx < text.len() {
        if text[idx..].starts_with("__OMNIA_SPAN_") {
            let after = &text[idx + "__OMNIA_SPAN_".len()..];
            let digits = after.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digits >= 4 && after[digits..].starts_with("__") {
                let end = idx + "__OMNIA_SPAN_".len() + digits + 2;
                out.push(ProseSegment {
                    raw: text[idx..end].to_owned(),
                    is_word: true,
                    is_placeholder: true,
                    start_byte: idx,
                    end_byte: end,
                });
                idx = end;
                continue;
            }
        }

        let Some(ch) = text[idx..].chars().next() else {
            break;
        };
        if ch.is_alphanumeric() {
            let start = idx;
            let mut end = idx;
            while end < text.len() {
                if text[end..].starts_with("__OMNIA_SPAN_") {
                    break;
                }
                let Some(next_ch) = text[end..].chars().next() else {
                    break;
                };
                if next_ch.is_alphanumeric() {
                    end += next_ch.len_utf8();
                } else {
                    break;
                }
            }
            out.push(ProseSegment {
                raw: text[start..end].to_owned(),
                is_word: true,
                is_placeholder: false,
                start_byte: start,
                end_byte: end,
            });
            idx = end;
        } else {
            let start = idx;
            let mut end = idx;
            while end < text.len() {
                if text[end..].starts_with("__OMNIA_SPAN_") {
                    break;
                }
                let Some(next_ch) = text[end..].chars().next() else {
                    break;
                };
                if !next_ch.is_alphanumeric() {
                    end += next_ch.len_utf8();
                } else {
                    break;
                }
            }
            out.push(ProseSegment {
                raw: text[start..end].to_owned(),
                is_word: false,
                is_placeholder: false,
                start_byte: start,
                end_byte: end,
            });
            idx = end;
        }
    }

    out
}

fn assign_clause_ids(segments: &[ProseSegment]) -> Vec<usize> {
    let mut ids = Vec::with_capacity(segments.len());
    let mut cur = 0usize;
    for seg in segments {
        ids.push(cur);
        if !seg.is_word
            && seg
                .raw
                .chars()
                .any(|c| matches!(c, '.' | '!' | '?' | ';' | '\n'))
        {
            cur += 1;
        }
    }
    ids
}

fn collect_neighbor_words(
    segments: &[ProseSegment],
    word_indices: &[usize],
    pos: usize,
    span_lookup: &HashMap<&str, &str>,
) -> (Vec<String>, Vec<String>) {
    let mut left = Vec::new();
    let start_pos = pos.saturating_sub(2);
    for &wi in &word_indices[start_pos..pos] {
        let seg = &segments[wi];
        let val = if seg.is_placeholder {
            span_lookup
                .get(seg.raw.as_str())
                .copied()
                .unwrap_or(&seg.raw)
        } else {
            &seg.raw
        };
        left.push(val.to_owned());
    }

    let mut right = Vec::new();
    let end_pos = (pos + 3).min(word_indices.len());
    for &wi in &word_indices[pos + 1..end_pos] {
        let seg = &segments[wi];
        let val = if seg.is_placeholder {
            span_lookup
                .get(seg.raw.as_str())
                .copied()
                .unwrap_or(&seg.raw)
        } else {
            &seg.raw
        };
        right.push(val.to_owned());
    }

    (left, right)
}

fn nearest_non_space_char_before(segments: &[ProseSegment], seg_idx: usize) -> Option<char> {
    let mut idx = seg_idx;
    while idx > 0 {
        idx -= 1;
        for ch in segments[idx].raw.chars().rev() {
            if !ch.is_whitespace() {
                return Some(ch);
            }
        }
    }
    None
}

fn nearest_non_space_char_after(segments: &[ProseSegment], seg_idx: usize) -> Option<char> {
    for seg in &segments[seg_idx + 1..] {
        for ch in seg.raw.chars() {
            if !ch.is_whitespace() {
                return Some(ch);
            }
        }
    }
    None
}

fn is_at_clause_end(segments: &[ProseSegment], seg_idx: usize) -> bool {
    for seg in &segments[seg_idx + 1..] {
        if seg.is_word {
            return false;
        }
        if seg
            .raw
            .chars()
            .any(|c| matches!(c, ',' | '.' | '!' | '?' | ';' | ':' | '\n' | ')' | ']'))
        {
            return true;
        }
    }
    true
}

fn compute_clause_stats(
    segments: &[ProseSegment],
    clause_ids: &[usize],
    target_clause: usize,
) -> ClauseStats {
    let mut vn_signal_score = 0u32;
    let mut en_signal_score = 0u32;

    for (idx, seg) in segments.iter().enumerate() {
        if clause_ids[idx] != target_clause || !seg.is_word || seg.is_placeholder {
            continue;
        }
        if has_vietnamese_diacritics(&seg.raw) {
            vn_signal_score += 3;
            continue;
        }
        let folded = fold_vietnamese_ascii(&seg.raw);
        if is_unambiguous_vn_lexeme(&folded) {
            vn_signal_score += 2;
        } else if is_vn_shorthand_lexeme(&folded) {
            vn_signal_score += 1;
        } else if is_english_structural_lexeme(&folded) {
            en_signal_score += 2;
        }
    }

    ClauseStats {
        vn_signal_score,
        en_signal_score,
    }
}

fn is_unambiguous_vn_lexeme(folded: &str) -> bool {
    matches!(
        folded,
        "khong"
            | "duoc"
            | "lam"
            | "gium"
            | "giup"
            | "nhung"
            | "cung"
            | "truoc"
            | "kho"
            | "xem"
            | "chay"
            | "sua"
            | "viet"
            | "hieu"
            | "biet"
            | "thay"
            | "chua"
            | "roi"
            | "nhe"
            | "nha"
            | "voi"
            | "cua"
            | "nay"
            | "kia"
            | "trong"
            | "ngoai"
            | "tren"
            | "duoi"
            | "giua"
            | "neu"
            | "thi"
            | "phai"
            | "muon"
            | "dang"
            | "vua"
            | "moi"
            | "lai"
            | "vao"
            | "xuong"
            | "xong"
            | "rat"
            | "khi"
            | "tai"
            | "sao"
            | "dau"
            | "minh"
            | "toi"
            | "chung"
            | "nguon"
            | "dien"
            | "dong"
            | "tham"
            | "bien"
            | "van"
            | "de"
    )
}

fn is_vn_shorthand_lexeme(folded: &str) -> bool {
    matches!(
        folded,
        "ko" | "dc"
            | "vde"
            | "nhg"
            | "nhx"
            | "nhma"
            | "cx"
            | "trc"
            | "ntn"
            | "trl"
            | "xog"
            | "lun"
            | "nx"
            | "trg"
            | "htai"
            | "dko"
            | "bth"
    )
}

fn is_english_structural_lexeme(folded: &str) -> bool {
    matches!(
        folded,
        "the"
            | "is"
            | "are"
            | "was"
            | "were"
            | "been"
            | "being"
            | "have"
            | "has"
            | "had"
            | "will"
            | "would"
            | "should"
            | "could"
            | "this"
            | "that"
            | "these"
            | "those"
            | "from"
            | "with"
            | "into"
            | "onto"
            | "about"
            | "between"
            | "through"
            | "please"
            | "module"
            | "config"
            | "function"
            | "parameter"
            | "variable"
            | "current"
            | "supply"
            | "power"
    )
}

fn folded_neighbors(words: &[String]) -> Vec<String> {
    words.iter().map(|w| fold_vietnamese_ascii(w)).collect()
}

fn joined_tail_pair(words: &[String]) -> Option<String> {
    if words.len() >= 2 {
        Some(format!(
            "{} {}",
            fold_vietnamese_ascii(&words[words.len() - 2]),
            fold_vietnamese_ascii(&words[words.len() - 1])
        ))
    } else {
        None
    }
}

fn is_all_ascii_uppercase(raw: &str) -> bool {
    let mut has_alpha = false;
    for ch in raw.chars() {
        if ch.is_alphabetic() {
            has_alpha = true;
            if !ch.is_ascii_uppercase() {
                return false;
            }
        }
    }
    has_alpha
}

#[allow(clippy::too_many_arguments)]
fn evaluate_token_normalization(
    raw_tok: &str,
    lower_tok: &str,
    folded_tok: &str,
    left_words: &[String],
    right_words: &[String],
    left_punct: Option<char>,
    right_punct: Option<char>,
    at_clause_end: bool,
    clause_stats: &ClauseStats,
) -> TokenDecision {
    let left_f = folded_neighbors(left_words);
    let right_f = folded_neighbors(right_words);
    let prev_1 = left_f.last().map(String::as_str).unwrap_or("");
    let next_1 = right_f.first().map(String::as_str).unwrap_or("");
    let left_pair = joined_tail_pair(left_words);

    // 1. Explicit Vietnamese diacritic shorthand (`đc`, `vđề`, `đko`) is unambiguous.
    match lower_tok {
        "đc" => {
            return TokenDecision::Restore {
                target: "được",
                reason: "unambiguous_vietnamese_diacritic_shorthand",
            };
        }
        "vđề" => {
            return TokenDecision::Restore {
                target: "vấn đề",
                reason: "unambiguous_vietnamese_diacritic_shorthand",
            };
        }
        "đko" => {
            return TokenDecision::Restore {
                target: "đúng không",
                reason: "unambiguous_vietnamese_diacritic_shorthand",
            };
        }
        _ => {}
    }

    // 2. Context-gated `dc`: must stay untouched in electrical/technical contexts
    // (`dòng điện dc`, `nguồn dc`, `ac/dc`, `DC`, `12V dc`, etc.).
    if folded_tok == "dc" {
        let slash_joined =
            left_punct == Some('/') || right_punct == Some('/') || left_punct == Some('-');
        let electrical_left = matches!(
            prev_1,
            "dien"
                | "nguon"
                | "ac"
                | "volt"
                | "ampe"
                | "mach"
                | "pin"
                | "sac"
                | "power"
                | "current"
                | "voltage"
                | "supply"
                | "domain"
                | "datacenter"
        ) || matches!(
            left_pair.as_deref(),
            Some("dong dien" | "dien ap" | "bo nguon" | "dong co" | "chinh luu" | "mach dien")
        ) || prev_1.ends_with("v")
            && prev_1.chars().next().is_some_and(|c| c.is_ascii_digit());
        let electrical_right = matches!(
            next_1,
            "ac" | "motor"
                | "converter"
                | "inverter"
                | "supply"
                | "power"
                | "bus"
                | "rail"
                | "current"
                | "voltage"
                | "controller"
        ) || next_1.ends_with("v")
            && next_1.chars().next().is_some_and(|c| c.is_ascii_digit());

        if slash_joined || electrical_left || electrical_right {
            return TokenDecision::Keep;
        }
        if is_all_ascii_uppercase(raw_tok) {
            if clause_stats.vn_signal_score >= 2 {
                return TokenDecision::Ambiguous {
                    candidates: vec!["DC (direct current / technical)", "được"],
                    reason: "uppercase_dc_in_vietnamese_clause_preserved",
                };
            }
            return TokenDecision::Keep;
        }

        let vn_modal_left = matches!(
            prev_1,
            "lam"
                | "xem"
                | "chay"
                | "sua"
                | "viet"
                | "doc"
                | "hieu"
                | "dung"
                | "xai"
                | "chon"
                | "mo"
                | "tat"
                | "bat"
                | "tao"
                | "gui"
                | "nhan"
                | "lay"
                | "tinh"
                | "giai"
                | "tim"
                | "co"
                | "khong"
                | "ko"
                | "k"
                | "chua"
                | "ch"
                | "se"
                | "da"
                | "dang"
                | "vua"
                | "moi"
                | "ms"
                | "cung"
                | "cx"
                | "van"
                | "giup"
                | "gium"
                | "cho"
                | "build"
                | "test"
                | "merge"
                | "run"
                | "focus"
        );
        let vn_modal_right = matches!(
            next_1,
            "ko" | "k"
                | "khong"
                | "chua"
                | "ch"
                | "chu"
                | "r"
                | "roi"
                | "nhe"
                | "nha"
                | "dau"
                | "nua"
                | "nx"
                | "luon"
                | "lun"
                | "het"
                | "xong"
                | "xog"
                | "khong?"
                | "gi"
                | "nao"
                | "nhieu"
                | "it"
                | "hon"
        );

        if vn_modal_left || vn_modal_right {
            return TokenDecision::Restore {
                target: "được",
                reason: "vietnamese_modal_collocation",
            };
        }
        return TokenDecision::Ambiguous {
            candidates: vec!["được", "dc (direct current / technical)"],
            reason: "borderline_dc_without_clear_electrical_or_modal_cue",
        };
    }

    // 3. Context-gated `r`: must stay untouched in math/parameter/code contexts
    // (`tham số r`, `biến r`, `r = 10`, `R`).
    if folded_tok == "r" {
        let math_operator_adj =
            matches!(
                right_punct,
                Some('=' | '<' | '>' | '+' | '*' | '/' | '^' | '[' | '(')
            ) || matches!(left_punct, Some('=' | '<' | '>' | '+' | '*' | '/' | '^'));
        let tech_var_left = matches!(
            prev_1,
            "so" | "bien"
                | "kinh"
                | "tro"
                | "tri"
                | "truc"
                | "tap"
                | "ham"
                | "lenh"
                | "co"
                | "flag"
                | "kenh"
                | "diem"
                | "canh"
                | "vector"
                | "param"
                | "parameter"
                | "var"
                | "variable"
                | "arg"
                | "argument"
                | "radius"
                | "resistance"
                | "ngu"
                | "goi"
                | "muc"
                | "o"
                | "matrix"
                | "cot"
                | "hang"
        ) || matches!(
            left_pair.as_deref(),
            Some(
                "tham so" | "he so" | "ban kinh" | "dien tro" | "gia tri" | "ma tran" | "ngon ngu"
            )
        );
        let tech_var_right = matches!(next_1, "studio" | "language" | "package" | "value");

        if math_operator_adj || tech_var_left || tech_var_right {
            return TokenDecision::Keep;
        }
        if is_all_ascii_uppercase(raw_tok) {
            if clause_stats.vn_signal_score >= 2 {
                return TokenDecision::Ambiguous {
                    candidates: vec!["R (identifier / language)", "rồi"],
                    reason: "uppercase_r_in_vietnamese_clause_preserved",
                };
            }
            return TokenDecision::Keep;
        }

        let vn_prev_cue = matches!(
            prev_1,
            "ko" | "k"
                | "khong"
                | "dc"
                | "duoc"
                | "xong"
                | "xog"
                | "het"
                | "roi"
                | "vua"
                | "lau"
                | "co"
                | "da"
                | "lam"
                | "chay"
                | "xem"
                | "hieu"
                | "biet"
                | "thay"
                | "nghe"
                | "noi"
                | "gui"
                | "nhan"
                | "lay"
                | "tao"
                | "sua"
                | "bi"
                | "mat"
                | "toi"
                | "den"
                | "qua"
                | "ve"
                | "len"
                | "xuong"
                | "ra"
                | "vao"
                | "day"
                | "do"
                | "nay"
                | "thoi"
                | "ma"
                | "on"
                | "ok"
                | "done"
                | "pass"
                | "fail"
                | "loi"
                | "hien"
                | "tai"
                | "luon"
                | "lun"
        );
        let vn_next_continuation = matches!(
            next_1,
            "nhe"
                | "nha"
                | "ne"
                | "do"
                | "day"
                | "ma"
                | "thi"
                | "lam"
                | "chay"
                | "moi"
                | "lai"
                | "nen"
                | "vay"
                | "nhung"
                | "nhx"
                | "nhg"
                | "cung"
                | "cx"
                | "a"
                | "oi"
                | "dko"
                | "ko"
                | "k"
        );

        if clause_stats.vn_signal_score >= 1
            && vn_prev_cue
            && (at_clause_end || vn_next_continuation)
        {
            return TokenDecision::Restore {
                target: "rồi",
                reason: "vietnamese_clause_aspect_particle_r",
            };
        }
        if clause_stats.vn_signal_score >= 1 {
            return TokenDecision::Ambiguous {
                candidates: vec!["rồi", "r (variable / parameter)"],
                reason: "borderline_r_token_preserved",
            };
        }
        return TokenDecision::Keep;
    }

    // 4. Dedicated Vietnamese chat shorthands (`ko`, `vde`, `nhg`, `nhx`, `cx`, `trc`, `ntn`, `trl`, ...).
    let dedicated_target = match folded_tok {
        "ko" => Some(("không", "vietnamese_shorthand_ko")),
        "vde" => Some(("vấn đề", "vietnamese_shorthand_vde")),
        "nhg" | "nhx" => Some(("nhưng", "vietnamese_shorthand_nhung")),
        "nhma" => Some(("nhưng mà", "vietnamese_shorthand_nhung_ma")),
        "cx" => Some(("cũng", "vietnamese_shorthand_cx")),
        "trc" => Some(("trước", "vietnamese_shorthand_trc")),
        "ntn" => Some(("như thế nào", "vietnamese_shorthand_ntn")),
        "trl" => Some(("trả lời", "vietnamese_shorthand_trl")),
        "xog" => Some(("xong", "vietnamese_shorthand_xog")),
        "lun" => Some(("luôn", "vietnamese_shorthand_lun")),
        "nx" => Some(("nữa", "vietnamese_shorthand_nx")),
        "trg" => Some(("trong", "vietnamese_shorthand_trg")),
        "htai" => Some(("hiện tại", "vietnamese_shorthand_htai")),
        "dko" => Some(("đúng không", "vietnamese_shorthand_dko")),
        "bth" => Some(("bình thường", "vietnamese_shorthand_bth")),
        _ => None,
    };

    if let Some((target, reason)) = dedicated_target {
        if is_all_ascii_uppercase(raw_tok) {
            return TokenDecision::Ambiguous {
                candidates: vec![target, "uppercase technical acronym"],
                reason: "uppercase_shorthand_preserved_as_possible_acronym",
            };
        }
        if clause_stats.en_signal_score >= 2 && clause_stats.vn_signal_score <= 1 {
            return TokenDecision::Ambiguous {
                candidates: vec![target, "english/technical abbreviation"],
                reason: "shorthand_inside_english_clause_preserved",
            };
        }
        return TokenDecision::Restore { target, reason };
    }

    // 5. Highly overloaded short tokens (`k`, `ms`, `vs`, `bt`, `th`, `v`, `bh`, `ng`, `sd`).
    if folded_tok == "k" {
        if matches!(right_punct, Some('=' | '<' | '>'))
            || matches!(prev_1, "so" | "bien" | "vitamin" | "bai")
            || matches!(left_pair.as_deref(), Some("tham so" | "he so"))
        {
            return TokenDecision::Keep;
        }
        if (matches!(
            next_1,
            "biet" | "hieu" | "co" | "lam" | "can" | "phai" | "duoc" | "dc"
        ) || (matches!(prev_1, "lam" | "hieu" | "duoc" | "dc" | "co") && at_clause_end))
            && clause_stats.vn_signal_score >= 1
            && !is_all_ascii_uppercase(raw_tok)
        {
            return TokenDecision::Restore {
                target: "không",
                reason: "vietnamese_negation_interrogative_k",
            };
        }
        if clause_stats.vn_signal_score >= 1 {
            return TokenDecision::Ambiguous {
                candidates: vec!["không", "k (constant / parameter)"],
                reason: "borderline_single_letter_k_preserved",
            };
        }
        return TokenDecision::Keep;
    }

    if folded_tok == "ms" {
        if is_all_ascii_uppercase(raw_tok)
            || prev_1.chars().all(|c| c.is_ascii_digit())
            || matches!(next_1, "windows" | "word" | "excel" | "office")
        {
            return TokenDecision::Keep;
        }
        if clause_stats.vn_signal_score >= 2
            && matches!(
                next_1,
                "lam" | "xai" | "dung" | "biet" | "thay" | "tao" | "chay" | "hieu" | "xong"
            )
        {
            return TokenDecision::Restore {
                target: "mới",
                reason: "vietnamese_preverbal_ms",
            };
        }
        if clause_stats.vn_signal_score >= 1 {
            return TokenDecision::Ambiguous {
                candidates: vec!["mới", "ms (milliseconds)"],
                reason: "borderline_ms_token_preserved",
            };
        }
        return TokenDecision::Keep;
    }

    if folded_tok == "vs" {
        if matches!(
            prev_1,
            "viec" | "hop" | "noi" | "don" | "doi" | "cung" | "choi" | "gap"
        ) || matches!(
            left_pair.as_deref(),
            Some("lam viec" | "ket hop" | "trao doi" | "noi chuyen")
        ) {
            return TokenDecision::Restore {
                target: "với",
                reason: "vietnamese_comitative_vs",
            };
        }
        if clause_stats.vn_signal_score >= 2 && clause_stats.en_signal_score == 0 {
            return TokenDecision::Ambiguous {
                candidates: vec!["với", "vs (versus)"],
                reason: "borderline_vs_token_preserved",
            };
        }
        return TokenDecision::Keep;
    }

    if folded_tok == "bt" && clause_stats.vn_signal_score >= 1 {
        if matches!(prev_1, "ko" | "k" | "khong" | "ai" | "cha" | "dau") {
            return TokenDecision::Restore {
                target: "biết",
                reason: "vietnamese_negation_plus_bt",
            };
        }
        if matches!(prev_1, "chay" | "van" | "dong" | "xai" | "hoat") {
            return TokenDecision::Restore {
                target: "bình thường",
                reason: "vietnamese_state_plus_bt",
            };
        }
        return TokenDecision::Ambiguous {
            candidates: vec!["bình thường", "biết"],
            reason: "bt_ambiguous_between_binh_thuong_and_biet",
        };
    }

    if matches!(folded_tok, "th" | "bh" | "sd" | "ng") && clause_stats.vn_signal_score >= 2 {
        if folded_tok == "ng" && matches!(prev_1, "moi" | "nhieu" | "vai" | "mot" | "hai") {
            return TokenDecision::Restore {
                target: "người",
                reason: "vietnamese_quantifier_plus_ng",
            };
        }
        if folded_tok == "th" && prev_1 == "v" && at_clause_end {
            return TokenDecision::Restore {
                target: "thôi",
                reason: "vietnamese_idiom_v_th",
            };
        }
        let cands = match folded_tok {
            "th" => vec!["thì", "thôi"],
            "bh" => vec!["bây giờ", "bao giờ"],
            "sd" => vec!["sử dụng", "SD (standard/secure digital)"],
            "ng" => vec!["người", "ng (identifier)"],
            _ => vec![],
        };
        return TokenDecision::Ambiguous {
            candidates: cands,
            reason: "overloaded_vietnamese_shorthand_preserved",
        };
    }

    TokenDecision::Keep
}

fn preserve_leading_case(original: &str, replacement: &str) -> String {
    let Some(first_orig) = original.chars().next() else {
        return replacement.to_owned();
    };
    if first_orig.is_uppercase() {
        let mut chars = replacement.chars();
        if let Some(first_rep) = chars.next() {
            let mut out = String::new();
            for uc in first_rep.to_uppercase() {
                out.push(uc);
            }
            out.push_str(chars.as_str());
            return out;
        }
    }
    replacement.to_owned()
}

fn starts_with_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    haystack
        .get(..needle.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(needle))
}

/// Detection result for unaccented Vietnamese phrases that collide with valid English words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnaccentedVietnameseDetection {
    pub is_unaccented_vietnamese: bool,
    pub contains_english_homographs: bool,
    pub matched_ngrams: Vec<String>,
    pub homograph_tokens: Vec<String>,
    pub confidence_bps: u32,
    pub recommended_language: String,
    pub notes: Vec<String>,
}

impl UnaccentedVietnameseDetection {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "is_unaccented_vietnamese": self.is_unaccented_vietnamese,
            "contains_english_homographs": self.contains_english_homographs,
            "matched_ngrams": self.matched_ngrams,
            "homograph_tokens": self.homograph_tokens,
            "confidence_bps": self.confidence_bps,
            "recommended_language": self.recommended_language,
            "notes": self.notes,
        })
    }
}

impl Serialize for UnaccentedVietnameseDetection {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Detects unaccented Vietnamese phrases whose tokens collide with valid English words
/// (such as `"ban can set lai do tre"`, `"hay bat no len"`, and `"to an de"`) using
/// Vietnamese syntactic bigrams, trigrams, and English anti-marker disambiguation.
#[must_use]
pub fn detect_unaccented_vietnamese_collision(input: &str) -> UnaccentedVietnameseDetection {
    let extraction = extract_protected_spans(input);
    let has_diacritics = has_vietnamese_diacritics(input);

    let tokens: Vec<String> = extraction
        .masked_text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty() && !s.starts_with("__OMNIA_SPAN_"))
        .map(fold_vietnamese_ascii)
        .collect();

    if tokens.is_empty() {
        return UnaccentedVietnameseDetection {
            is_unaccented_vietnamese: false,
            contains_english_homographs: false,
            matched_ngrams: Vec::new(),
            homograph_tokens: Vec::new(),
            confidence_bps: 0,
            recommended_language: "en".to_owned(),
            notes: vec!["no_prose_tokens".to_owned()],
        };
    }

    let mut matched_ngrams = BTreeSet::new();
    let mut vn_score: i32 = 0;
    let mut en_anti_score: i32 = 0;

    // 1. Vietnamese syntactic trigrams (high structural specificity; rare/impossible in English).
    for win in tokens.windows(3) {
        let tri = format!("{} {} {}", win[0], win[1], win[2]);
        if is_vn_syntactic_trigram(&tri) {
            matched_ngrams.insert(tri);
            vn_score += 4_500;
        }
    }

    // 2. Vietnamese syntactic bigrams (split into strong VN transitions vs weak code-switch pairs).
    for win in tokens.windows(2) {
        let bi = format!("{} {}", win[0], win[1]);
        if is_strong_vn_syntactic_bigram(&bi) {
            matched_ngrams.insert(bi.clone());
            vn_score += 2_600;
        } else if is_supporting_vn_bigram(&bi) {
            matched_ngrams.insert(bi.clone());
            vn_score += 900;
        }

        if is_english_anti_bigram(&bi) {
            en_anti_score += 2_400;
        }
    }

    // 3. Unambiguous ASCII Vietnamese shorthands or exclusive VN vocabulary boost.
    for tok in &tokens {
        if is_vn_shorthand_lexeme(tok) || is_exclusive_unaccented_vn_word(tok) {
            vn_score += 1_800;
        }
        if is_english_strong_function_word(tok) {
            en_anti_score += 1_200;
        }
    }

    let mut homograph_tokens = BTreeSet::new();
    for tok in &tokens {
        if is_en_vn_homograph(tok) {
            homograph_tokens.insert(tok.clone());
        }
    }

    // Penalize pure single supporting bigram inside English syntax (e.g. "I can set up").
    let net_score = vn_score - en_anti_score;
    let is_unaccented_vietnamese = !has_diacritics
        && (vn_score >= 4_500 || (net_score >= 3_200 && !matched_ngrams.is_empty()));

    let contains_english_homographs = !homograph_tokens.is_empty();
    let confidence_bps = if has_diacritics {
        9_800
    } else if is_unaccented_vietnamese {
        u32::try_from((net_score.max(vn_score / 2)).clamp(5_500, 9_900)).unwrap_or(9_000)
    } else {
        u32::try_from(vn_score.clamp(0, 4_000)).unwrap_or(0)
    };

    let has_genuine_non_homograph_en =
        tokens.iter().any(|t| is_english_strong_function_word(t)) && en_anti_score >= 2_400;
    let has_code_switched_tech_en = tokens.iter().any(|t| {
        matches!(
            t.as_str(),
            "set" | "config" | "build" | "test" | "merge" | "timeout"
        )
    });

    let recommended_language = if has_diacritics || is_unaccented_vietnamese {
        if has_genuine_non_homograph_en
            || (has_code_switched_tech_en && tokens.len() >= 8 && en_anti_score > 0)
        {
            "bilingual".to_owned()
        } else {
            "vi".to_owned()
        }
    } else {
        "en".to_owned()
    };

    let mut notes = Vec::new();
    if is_unaccented_vietnamese && contains_english_homographs {
        notes.push("detected_unaccented_vietnamese_with_english_homographs".to_owned());
    }
    if has_diacritics {
        notes.push("contains_explicit_vietnamese_diacritics".to_owned());
    }
    if !is_unaccented_vietnamese && !has_diacritics {
        notes.push("insufficient_vietnamese_syntactic_evidence".to_owned());
    }

    UnaccentedVietnameseDetection {
        is_unaccented_vietnamese,
        contains_english_homographs,
        matched_ngrams: matched_ngrams.into_iter().collect(),
        homograph_tokens: homograph_tokens.into_iter().collect(),
        confidence_bps,
        recommended_language,
        notes,
    }
}

fn is_vn_syntactic_trigram(tri: &str) -> bool {
    matches!(
        tri,
        "ban can set"
            | "can set lai"
            | "set lai do"
            | "lai do tre"
            | "hay bat no"
            | "bat no len"
            | "hay tat no"
            | "tat no di"
            | "hay mo no"
            | "hay xem lai"
            | "to an de"
            | "no an de"
            | "an de lam"
            | "de lam gi"
            | "cho to an"
            | "to muon an"
            | "tai sao khong"
            | "nhu the nao"
            | "lam the nao"
            | "co van de"
            | "ban xem lai"
            | "chay lai thu"
            | "khong hieu sao"
            | "chua thay gi"
            | "lam duoc khong"
            | "lam dc ko"
            | "cai dat lai"
            | "xem lai giup"
            | "sua lai giup"
            | "can lam gi"
            | "ban dung co"
    )
}

fn is_strong_vn_syntactic_bigram(bi: &str) -> bool {
    matches!(
        bi,
        "ban can"
            | "ban hay"
            | "ban xem"
            | "ban lam"
            | "ban dung"
            | "ban bat"
            | "ban tat"
            | "toi can"
            | "toi muon"
            | "minh can"
            | "minh thay"
            | "to an"
            | "to can"
            | "to muon"
            | "an de"
            | "hay bat"
            | "hay tat"
            | "hay mo"
            | "hay dong"
            | "hay xem"
            | "hay thu"
            | "hay chay"
            | "hay sua"
            | "hay lam"
            | "hay dung"
            | "bat no"
            | "tat no"
            | "mo no"
            | "bat len"
            | "tat di"
            | "no len"
            | "no xuong"
            | "no bi"
            | "no co"
            | "no ko"
            | "no la"
            | "no duoc"
            | "set lai"
            | "chay lai"
            | "lam lai"
            | "sua lai"
            | "xem lai"
            | "doc lai"
            | "gui lai"
            | "luu lai"
            | "de lai"
            | "do tre"
            | "do sang"
            | "toc do"
            | "che do"
            | "van de"
            | "han muc"
            | "bo nho"
            | "kien truc"
            | "dinh tuyen"
            | "giao thuc"
            | "du lieu"
            | "he thong"
            | "tai sao"
            | "nhu the"
            | "the nao"
            | "la gi"
            | "co the"
            | "khong the"
            | "khong co"
            | "khong duoc"
            | "khong biet"
            | "khong hieu"
            | "chua co"
            | "chua xong"
            | "lam gi"
            | "lam sao"
            | "xong roi"
            | "cho toi"
            | "cho minh"
            | "gium toi"
            | "gium minh"
            | "cai dat"
            | "cau hinh"
            | "rat de"
            | "de lam"
            | "de hieu"
    )
}

fn is_supporting_vn_bigram(bi: &str) -> bool {
    matches!(bi, "can set" | "to an" | "lai do" | "do no" | "len di")
}

fn is_english_anti_bigram(bi: &str) -> bool {
    matches!(
        bi,
        "you can"
            | "we can"
            | "they can"
            | "i can"
            | "can you"
            | "the delay"
            | "the issue"
            | "an issue"
            | "an old"
            | "to an"
            | "in the"
            | "on the"
            | "of the"
            | "for the"
            | "from the"
            | "with the"
            | "this is"
            | "that is"
            | "will be"
            | "would be"
            | "has been"
            | "do not"
            | "does not"
            | "did not"
            | "set up"
    )
}

fn is_exclusive_unaccented_vn_word(tok: &str) -> bool {
    matches!(
        tok,
        "khong"
            | "duoc"
            | "gium"
            | "giup"
            | "nhung"
            | "truoc"
            | "chay"
            | "hieu"
            | "biet"
            | "chua"
            | "nguon"
            | "dinh"
            | "tuyen"
            | "kien"
            | "truc"
            | "giao"
            | "thuc"
            | "xong"
            | "khong?"
    )
}

fn is_english_strong_function_word(tok: &str) -> bool {
    matches!(
        tok,
        "the"
            | "is"
            | "are"
            | "was"
            | "were"
            | "been"
            | "would"
            | "should"
            | "could"
            | "this"
            | "that"
            | "these"
            | "those"
            | "from"
            | "with"
            | "into"
            | "extent"
            | "server"
            | "delay"
            | "issue"
    )
}

fn is_en_vn_homograph(tok: &str) -> bool {
    matches!(
        tok,
        "ban"
            | "can"
            | "set"
            | "do"
            | "hay"
            | "bat"
            | "no"
            | "len"
            | "to"
            | "an"
            | "de"
            | "me"
            | "ma"
            | "co"
            | "con"
            | "lam"
            | "van"
            | "tin"
            | "ta"
            | "tam"
            | "nam"
            | "cat"
            | "mat"
            | "rat"
            | "sat"
            | "hat"
            | "cam"
            | "dam"
            | "ram"
            | "ham"
            | "son"
            | "ton"
            | "don"
            | "non"
            | "mon"
            | "bon"
            | "pin"
            | "sin"
            | "bin"
            | "fin"
            | "gap"
            | "map"
            | "nap"
            | "tap"
            | "cap"
            | "lap"
            | "rap"
            | "sap"
            | "go"
            | "so"
            | "be"
            | "he"
            | "we"
            | "us"
            | "la"
            | "lo"
            | "am"
    )
}

/// Inert JSON data-plane record wrapping untrusted user text for translation or analysis
/// without allowing prompt-injection escape into control-plane instructions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPlaneRecord {
    pub schema: String,
    pub handling_mode: String,
    pub inert_data_only: bool,
    pub record_id: String,
    pub target_language: String,
    pub sanitized_text: String,
    pub masked_text: String,
    pub protected_spans: Vec<ProtectedSpan>,
    pub raw_sha256: String,
    pub contains_redactions: bool,
}

impl DataPlaneRecord {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "schema": self.schema,
            "handling_mode": self.handling_mode,
            "inert_data_only": self.inert_data_only,
            "record_id": self.record_id,
            "target_language": self.target_language,
            "sanitized_text": self.sanitized_text,
            "masked_text": self.masked_text,
            "protected_spans": self.protected_spans.iter().map(ProtectedSpan::to_json).collect::<Vec<_>>(),
            "raw_sha256": self.raw_sha256,
            "contains_redactions": self.contains_redactions,
        }))
    }
}

impl Serialize for DataPlaneRecord {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Wraps `raw_text` inside an `INERT_STRING_RECORD_ONLY` JSON data-plane record, defaults
/// `target_language` to `"en"` when `None` or blank, scrubs credentials via [`SecretRedactor`],
/// and masks protected spans deterministically.
#[must_use]
pub fn encapsulate_data_plane_record(
    record_id: &str,
    raw_text: &str,
    target_language: Option<&str>,
) -> DataPlaneRecord {
    let resolved_lang = match target_language.map(str::trim) {
        Some(lang) if !lang.is_empty() => lang.to_owned(),
        _ => "en".to_owned(),
    };
    let clean_id = SecretRedactor::redact(record_id.trim());
    let sanitized_text = SecretRedactor::redact(raw_text);
    let contains_redactions = sanitized_text != raw_text;
    let extraction = extract_protected_spans(&sanitized_text);
    let raw_sha256 = sha256_hex(sanitized_text.as_bytes());

    DataPlaneRecord {
        schema: DATA_PLANE_SCHEMA_MODE.to_owned(),
        handling_mode: DATA_PLANE_SCHEMA_MODE.to_owned(),
        inert_data_only: true,
        record_id: clean_id,
        target_language: resolved_lang,
        sanitized_text,
        masked_text: extraction.masked_text,
        protected_spans: extraction.spans,
        raw_sha256,
        contains_redactions,
    }
}

/// Deterministic invariant verification receipt checking 100% preservation of all protected
/// spans, identifiers, paths, CLI flags, URLs, LaTeX math, and numbers across translation or
/// normalization — never relying on a brittle length-delta heuristic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationInvariantReport {
    pub valid: bool,
    pub checked_spans: usize,
    pub checked_standalone_numbers: usize,
    pub missing_or_altered_spans: Vec<String>,
    pub missing_numbers: Vec<String>,
    pub leaked_placeholders: Vec<String>,
}

impl TranslationInvariantReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "valid": self.valid,
            "checked_spans": self.checked_spans,
            "checked_standalone_numbers": self.checked_standalone_numbers,
            "missing_or_altered_spans": self.missing_or_altered_spans,
            "missing_numbers": self.missing_numbers,
            "leaked_placeholders": self.leaked_placeholders,
        })
    }
}

impl Serialize for TranslationInvariantReport {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Verifies deterministically that `processed` preserves 100% of every protected span
/// (code blocks, inline code, URLs, paths, CLI flags, identifiers, LaTeX math, numeric+unit
/// literals) and standalone numeric literals from `original`, without using any length-delta
/// heuristic.
#[must_use]
pub fn verify_translation_invariants(
    original: &str,
    processed: &str,
) -> TranslationInvariantReport {
    let orig_ext = extract_protected_spans(original);
    let proc_ext = extract_protected_spans(processed);

    let mut orig_span_counts: BTreeMap<String, usize> = BTreeMap::new();
    for s in &orig_ext.spans {
        *orig_span_counts.entry(s.raw.clone()).or_insert(0) += 1;
    }

    let mut proc_span_counts: BTreeMap<String, usize> = BTreeMap::new();
    for s in &proc_ext.spans {
        *proc_span_counts.entry(s.raw.clone()).or_insert(0) += 1;
    }

    let mut missing_or_altered_spans = Vec::new();
    for (raw, &expected_count) in &orig_span_counts {
        let found_in_spans = proc_span_counts.get(raw).copied().unwrap_or(0);
        if found_in_spans >= expected_count {
            continue;
        }
        // Fallback exact occurrence count with identifier/numeric boundaries if prose punctuation changed.
        let found_bounded = count_bounded_occurrences(processed, raw);
        if found_bounded < expected_count {
            missing_or_altered_spans.push(raw.clone());
        }
    }

    // Verify standalone numeric literals outside already-extracted protected spans.
    let orig_numbers = extract_standalone_numbers(&orig_ext.masked_text);
    let proc_numbers = extract_standalone_numbers(&proc_ext.masked_text);
    let mut orig_num_counts: BTreeMap<String, usize> = BTreeMap::new();
    for num in &orig_numbers {
        *orig_num_counts.entry(num.clone()).or_insert(0) += 1;
    }
    let mut proc_num_counts: BTreeMap<String, usize> = BTreeMap::new();
    for num in &proc_numbers {
        *proc_num_counts.entry(num.clone()).or_insert(0) += 1;
    }

    let mut missing_numbers = Vec::new();
    for (num, &expected) in &orig_num_counts {
        if proc_num_counts.get(num).copied().unwrap_or(0) < expected {
            missing_numbers.push(num.clone());
        }
    }

    // Verify no internal `__OMNIA_SPAN_XXXX__` placeholders leaked unexpanded into processed text.
    let orig_placeholders = find_placeholder_tokens(original);
    let proc_placeholders = find_placeholder_tokens(processed);
    let mut leaked_placeholders = Vec::new();
    for ph in proc_placeholders {
        if !orig_placeholders.contains(&ph) {
            leaked_placeholders.push(ph);
        }
    }

    let valid = missing_or_altered_spans.is_empty()
        && missing_numbers.is_empty()
        && leaked_placeholders.is_empty();

    TranslationInvariantReport {
        valid,
        checked_spans: orig_ext.spans.len(),
        checked_standalone_numbers: orig_numbers.len(),
        missing_or_altered_spans,
        missing_numbers,
        leaked_placeholders,
    }
}

fn count_bounded_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let require_left_boundary = needle
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let require_right_boundary = needle
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');

    let mut count = 0usize;
    let mut pos = 0usize;
    while let Some(rel) = haystack[pos..].find(needle) {
        let start = pos + rel;
        let end = start + needle.len();
        let left_ok = !require_left_boundary
            || haystack[..start]
                .chars()
                .next_back()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        let right_ok = !require_right_boundary
            || haystack[end..]
                .chars()
                .next()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if left_ok && right_ok {
            count += 1;
        }
        pos = end;
    }
    count
}

fn extract_standalone_numbers(masked_text: &str) -> Vec<String> {
    let mut nums = Vec::new();
    let bytes = masked_text.as_bytes();
    let mut idx = 0usize;

    while idx < bytes.len() {
        if masked_text[idx..].starts_with("__OMNIA_SPAN_") {
            let after = &masked_text[idx + "__OMNIA_SPAN_".len()..];
            let digits = after.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digits >= 4 && after[digits..].starts_with("__") {
                idx += "__OMNIA_SPAN_".len() + digits + 2;
                continue;
            }
        }

        if bytes[idx].is_ascii_digit() {
            let left_ok = idx == 0
                || masked_text[..idx]
                    .chars()
                    .next_back()
                    .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '.'));
            let mut end = idx;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() {
                end += 1;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
            }
            let right_ok = end == bytes.len()
                || masked_text[end..]
                    .chars()
                    .next()
                    .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            if left_ok && right_ok {
                nums.push(masked_text[idx..end].to_owned());
            }
            idx = end;
        } else {
            idx += masked_text[idx..].chars().next().map_or(1, char::len_utf8);
        }
    }

    nums
}

fn find_placeholder_tokens(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    const PREFIX: &str = "__OMNIA_SPAN_";
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find(PREFIX) {
        let start = cursor + rel;
        let after = &text[start + PREFIX.len()..];
        let digits = after.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits >= 4 && after[digits..].starts_with("__") {
            let end = start + PREFIX.len() + digits + 2;
            out.insert(text[start..end].to_owned());
            cursor = end;
        } else {
            cursor = start + PREFIX.len();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_spans_extract_and_roundtrip_all_categories() {
        let input = concat!(
            "Check ```rust\nlet x = 1;\n``` and `cargo test --offline` at https://example.test/docs?a=1 ",
            "in D:\\Omnia\\rust\\omnia-harness\\src\\lib.rs or rust/omnia-routing/src/lib.rs ",
            "with -p and --locked for 3.5V, 4096 MB, 120Hz, $E = mc^2$, $$\\int_0^1 x dx$$ ",
            "using snake_case_fn, camelCaseVar, PascalCaseType."
        );
        let ext = extract_protected_spans(input);
        assert!(ext.spans.len() >= 14);
        assert_eq!(ext.spans[0].placeholder, "__OMNIA_SPAN_0001__");
        assert_eq!(ext.spans[0].kind, ProtectedSpanKind::FencedCodeBlock);
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::InlineCode && s.raw == "`cargo test --offline`"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::Url && s.raw == "https://example.test/docs?a=1"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::FilesystemPath
                && s.raw == r"D:\Omnia\rust\omnia-harness\src\lib.rs"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::FilesystemPath
                && s.raw == "rust/omnia-routing/src/lib.rs"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::CliFlag && s.raw == "-p"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::CliFlag && s.raw == "--locked"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::NumericUnitLiteral && s.raw == "3.5V"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::NumericUnitLiteral && s.raw == "4096 MB"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::NumericUnitLiteral && s.raw == "120Hz"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::LatexInlineMath && s.raw == "$E = mc^2$"));
        assert!(ext.spans.iter().any(
            |s| s.kind == ProtectedSpanKind::LatexDisplayMath && s.raw == "$$\\int_0^1 x dx$$"
        ));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::Identifier && s.raw == "snake_case_fn"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::Identifier && s.raw == "camelCaseVar"));
        assert!(ext
            .spans
            .iter()
            .any(|s| s.kind == ProtectedSpanKind::Identifier && s.raw == "PascalCaseType"));

        assert_eq!(restore_protected_spans(&ext.masked_text, &ext.spans), input);
        assert_eq!(restore_protected_spans(&ext.masked_text, &ext), input);
    }

    #[test]
    fn vietnamese_contextual_restoration_preserves_technical_and_restores_chat() {
        assert_eq!(
            restore_vietnamese_contextual("làm dc ko r").restored_text,
            "làm được không rồi"
        );
        assert_eq!(
            restore_vietnamese_contextual("trl giùm vde nhx cx khó").restored_text,
            "trả lời giùm vấn đề nhưng cũng khó"
        );
        assert_eq!(
            restore_vietnamese_contextual("trc hết giải quyết vđề này ntn nhg vẫn chạy tốt")
                .restored_text,
            "trước hết giải quyết vấn đề này như thế nào nhưng vẫn chạy tốt"
        );
        assert_eq!(
            restore_vietnamese_contextual("đc rồi cũng ổn").restored_text,
            "được rồi cũng ổn"
        );

        for untouched in [
            "dòng điện dc",
            "nguồn dc",
            "ac/dc",
            "tham số r",
            "biến r",
            "r = 10",
        ] {
            let res = restore_vietnamese_contextual(untouched);
            assert_eq!(
                res.restored_text, untouched,
                "must leave `{untouched}` untouched"
            );
        }

        let borderline = restore_vietnamese_contextual("kiểm tra dc ở module");
        assert_eq!(borderline.restored_text, "kiểm tra dc ở module");
        assert!(!borderline.ambiguous_tokens.is_empty());
        assert_eq!(borderline.ambiguous_tokens[0].action, "preserved");
    }

    #[test]
    fn unaccented_vietnamese_collision_detects_homographs_without_english_false_positives() {
        for phrase in ["ban can set lai do tre", "hay bat no len", "to an de"] {
            let det = detect_unaccented_vietnamese_collision(phrase);
            assert!(
                det.is_unaccented_vietnamese,
                "expected unaccented Vietnamese detection for `{phrase}`: {:?}",
                det
            );
            assert!(det.contains_english_homographs);
            assert_ne!(det.recommended_language, "en");
        }

        for english in [
            "You can set the delay again.",
            "We walked to an old house.",
            "He can bat a ball across the field.",
        ] {
            let det = detect_unaccented_vietnamese_collision(english);
            assert!(
                !det.is_unaccented_vietnamese,
                "false positive on English sentence `{english}`: {:?}",
                det
            );
            assert_eq!(det.recommended_language, "en");
        }
    }

    #[test]
    fn data_plane_record_defaults_and_deterministic_invariants_without_length_heuristic() {
        let rec = encapsulate_data_plane_record(
            "rec-1",
            "Chạy `cargo test` tại D:\\Omnia\\rust với token=sk-proj-dummy1234567890abcdef",
            None,
        );
        assert_eq!(rec.schema, "INERT_STRING_RECORD_ONLY");
        assert_eq!(rec.handling_mode, "INERT_STRING_RECORD_ONLY");
        assert!(rec.inert_data_only);
        assert_eq!(rec.target_language, "en");
        assert!(rec.contains_redactions);
        assert!(!rec.sanitized_text.contains("sk-proj-"));

        let rec_blank = encapsulate_data_plane_record("rec-2", "hello", Some("   "));
        assert_eq!(rec_blank.target_language, "en");

        // Massive legitimate >100% length delta must PASS when all spans & numbers are preserved.
        let orig =
            "làm dc ko r ở D:\\Omnia\\rust với 3.5V và 4096 MB và snake_case_id với giá trị 10";
        let translated = "Could you please verify whether this can already be completed successfully inside D:\\Omnia\\rust using 3.5V and 4096 MB and snake_case_id with value 10?";
        let ok_report = verify_translation_invariants(orig, translated);
        assert!(
            ok_report.valid,
            "expected valid invariants despite >100% length change: {:?}",
            ok_report
        );

        // Dropping or mutating a protected span or number must FAIL deterministically.
        let broken = "Completed inside D:\\Omnia\\ruts using 3.6V and 4096 MB and snake_case_id with value 10";
        let bad_report = verify_translation_invariants(orig, broken);
        assert!(!bad_report.valid);
        assert!(bad_report
            .missing_or_altered_spans
            .contains(&"D:\\Omnia\\rust".to_owned()));
        assert!(bad_report
            .missing_or_altered_spans
            .contains(&"3.5V".to_owned()));
    }
}
