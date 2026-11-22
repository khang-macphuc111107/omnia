use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};

use omnia_core::{hex_decode, hex_encode, sha256_bytes, sha256_hex, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

/// Default streak ceiling before older consecutive failed compile/test iterations are compacted.
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: usize = 2;

const HMAC_SHA256_BLOCK_SIZE: usize = 64;
const EXECUTION_RECEIPT_SCHEMA: &str = "omnia.execution-receipt.v1";

/// Errors returned by Sovereign Harness anti-hallucination and integrity verifiers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContractError {
    #[error("invalid line range {start_line}..={end_line} for source with {total_lines} lines")]
    InvalidLineRange {
        start_line: usize,
        end_line: usize,
        total_lines: usize,
    },
    #[error("no hash anchors supplied for verification")]
    EmptyAnchors,
    #[error("malformed hash anchor `{0}` (expected `line_no:hash4|text` or `line_no:hash4`)")]
    MalformedAnchor(String),
    #[error("anchor line {line_no} out of bounds (source has {total_lines} lines)")]
    LineOutOfBounds { line_no: usize, total_lines: usize },
    #[error("hash anchor mismatch at line {line_no}: expected `{expected_hash4}`, actual `{actual_hash4}`")]
    HashAnchorMismatch {
        line_no: usize,
        expected_hash4: String,
        actual_hash4: String,
    },
    #[error("anchor text mismatch at line {line_no}")]
    AnchorTextMismatch { line_no: usize },
    #[error("invalid shadow git index path `{path}`: {reason}")]
    InvalidShadowGitIndex { path: String, reason: String },
    #[error("invalid digest format `{0}`")]
    InvalidDigest(String),
}

/// One hash-anchored source line reference (`line_no:hash4|text`) used to guard edits
/// against stale line numbers or silently drifted context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashAnchor {
    pub line_no: usize,
    pub hash4: String,
    pub expected_text: Option<String>,
    pub replacement_text: Option<String>,
}

impl HashAnchor {
    #[must_use]
    pub fn new(line_no: usize, hash4: impl Into<String>) -> Self {
        Self {
            line_no,
            hash4: hash4.into(),
            expected_text: None,
            replacement_text: None,
        }
    }

    #[must_use]
    pub fn with_text(
        line_no: usize,
        hash4: impl Into<String>,
        expected_text: impl Into<String>,
    ) -> Self {
        Self {
            line_no,
            hash4: hash4.into(),
            expected_text: Some(expected_text.into()),
            replacement_text: None,
        }
    }

    #[must_use]
    pub fn with_replacement(
        line_no: usize,
        hash4: impl Into<String>,
        replacement_text: impl Into<String>,
    ) -> Self {
        Self {
            line_no,
            hash4: hash4.into(),
            expected_text: None,
            replacement_text: Some(replacement_text.into()),
        }
    }

    /// Parse a single `line_no:hash4|text` (or `line_no:hash4`) anchor string.
    pub fn parse(raw: &str) -> Result<Self, ContractError> {
        let trimmed = raw.trim_end_matches('\r');
        let Some(colon) = trimmed.find(':') else {
            return Err(ContractError::MalformedAnchor(raw.to_owned()));
        };
        let line_no: usize = trimmed[..colon]
            .trim()
            .parse()
            .map_err(|_| ContractError::MalformedAnchor(raw.to_owned()))?;
        if line_no == 0 {
            return Err(ContractError::MalformedAnchor(raw.to_owned()));
        }
        let rest = &trimmed[colon + 1..];
        let (hash_part, text_part) = match rest.find('|') {
            Some(pipe) => (&rest[..pipe], Some(rest[pipe + 1..].to_owned())),
            None => (rest, None),
        };
        let hash4 = hash_part.trim().to_ascii_lowercase();
        if !is_valid_hash4(&hash4) {
            return Err(ContractError::MalformedAnchor(raw.to_owned()));
        }
        Ok(Self {
            line_no,
            hash4,
            expected_text: text_part,
            replacement_text: None,
        })
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "line_no": self.line_no,
            "hash4": self.hash4,
            "expected_text": self.expected_text,
            "replacement_text": self.replacement_text,
        })
    }
}

/// Polymorphic anchor input supporting slices of [`HashAnchor`], formatted `line_no:hash4|text`
/// slices, or arrays of anchor lines.
pub trait AnchorInput {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError>;
}

impl AnchorInput for &[HashAnchor] {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        Ok(self.to_vec())
    }
}

impl AnchorInput for &Vec<HashAnchor> {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        Ok(self.clone())
    }
}

impl AnchorInput for Vec<HashAnchor> {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        Ok(self)
    }
}

impl<const N: usize> AnchorInput for &[HashAnchor; N] {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        Ok(self.to_vec())
    }
}

impl AnchorInput for &str {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        parse_hash_anchored_slice(self)
    }
}

impl AnchorInput for &String {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        parse_hash_anchored_slice(self.as_str())
    }
}

impl AnchorInput for &[&str] {
    fn into_anchors(self) -> Result<Vec<HashAnchor>, ContractError> {
        self.iter().map(|line| HashAnchor::parse(line)).collect()
    }
}

/// Compute the canonical 4-lowercase-hex line digest (`sha256(line)[..4]`).
#[must_use]
pub fn compute_line_hash4(line: &str) -> String {
    let clean = line.strip_suffix('\r').unwrap_or(line);
    let hex = sha256_hex(clean.as_bytes());
    hex[..4].to_owned()
}

fn is_valid_hash4(s: &str) -> bool {
    s.len() == 4 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Format an inclusive 1-based line slice (`start_line..=end_line`) as `line_no:hash4|text`.
pub fn format_hash_anchored_slice(
    source: &str,
    start_line: usize,
    end_line: usize,
) -> Result<String, ContractError> {
    let lines = split_source_lines(source);
    let total_lines = lines.len();
    if start_line == 0 || end_line < start_line || start_line > total_lines {
        return Err(ContractError::InvalidLineRange {
            start_line,
            end_line,
            total_lines,
        });
    }

    let clamped_end = end_line.min(total_lines);
    let mut out = Vec::with_capacity(clamped_end - start_line + 1);
    for (offset, clean) in lines[start_line - 1..clamped_end].iter().enumerate() {
        let line_no = start_line + offset;
        let hash4 = compute_line_hash4(clean);
        out.push(format!("{line_no}:{hash4}|{clean}"));
    }
    Ok(out.join("\n"))
}

/// Parse one or more `line_no:hash4|text` lines into structured [`HashAnchor`] records.
pub fn parse_hash_anchored_slice(slice_text: &str) -> Result<Vec<HashAnchor>, ContractError> {
    let mut anchors = Vec::new();
    for line in slice_text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        anchors.push(HashAnchor::parse(line)?);
    }
    if anchors.is_empty() {
        return Err(ContractError::EmptyAnchors);
    }
    Ok(anchors)
}

/// Verification receipt returned by [`verify_hash_anchored_edit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashAnchorVerificationResult {
    pub verified: bool,
    pub verified_lines: Vec<usize>,
    pub updated_source: Option<String>,
}

impl HashAnchorVerificationResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "verified": self.verified,
            "verified_lines": self.verified_lines,
            "has_updated_source": self.updated_source.is_some(),
        })
    }
}

impl Serialize for HashAnchorVerificationResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Verifies every anchor against `source`, rejecting immediately on missing/out-of-bounds line
/// numbers, malformed 4-hex digests, or hash/text mismatches. Applies replacements atomically
/// when anchors specify `replacement_text`.
pub fn verify_hash_anchored_edit<A: AnchorInput>(
    source: &str,
    anchors: A,
) -> Result<HashAnchorVerificationResult, ContractError> {
    let parsed = anchors.into_anchors()?;
    if parsed.is_empty() {
        return Err(ContractError::EmptyAnchors);
    }

    let mut lines: Vec<String> = split_source_lines(source)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let total_lines = lines.len();
    let mut verified_lines = Vec::with_capacity(parsed.len());
    let mut has_replacements = false;

    for anchor in &parsed {
        if anchor.line_no == 0 || anchor.line_no > total_lines {
            return Err(ContractError::LineOutOfBounds {
                line_no: anchor.line_no,
                total_lines,
            });
        }
        let norm_hash = anchor.hash4.to_ascii_lowercase();
        if !is_valid_hash4(&norm_hash) {
            return Err(ContractError::MalformedAnchor(format!(
                "{}:{}",
                anchor.line_no, anchor.hash4
            )));
        }

        let current_line = &lines[anchor.line_no - 1];
        let actual_hash4 = compute_line_hash4(current_line);
        if actual_hash4 != norm_hash {
            return Err(ContractError::HashAnchorMismatch {
                line_no: anchor.line_no,
                expected_hash4: norm_hash,
                actual_hash4,
            });
        }
        if let Some(expected_text) = &anchor.expected_text {
            let clean_expected = expected_text.strip_suffix('\r').unwrap_or(expected_text);
            if current_line != clean_expected {
                return Err(ContractError::AnchorTextMismatch {
                    line_no: anchor.line_no,
                });
            }
        }
        if anchor.replacement_text.is_some() {
            has_replacements = true;
        }
        verified_lines.push(anchor.line_no);
    }

    let updated_source = if has_replacements {
        for anchor in &parsed {
            if let Some(rep) = &anchor.replacement_text {
                lines[anchor.line_no - 1] = rep.strip_suffix('\r').unwrap_or(rep).to_owned();
            }
        }
        let mut joined = lines.join("\n");
        if source.ends_with('\n') && !joined.ends_with('\n') {
            joined.push('\n');
        }
        Some(joined)
    } else {
        None
    };

    Ok(HashAnchorVerificationResult {
        verified: true,
        verified_lines,
        updated_source,
    })
}

fn split_source_lines(source: &str) -> Vec<&str> {
    if source.is_empty() {
        return Vec::new();
    }
    let trimmed = source.strip_suffix('\n').unwrap_or(source);
    let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
    trimmed
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// Supported programming/scripting languages for [`scan_source_for_slop`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SlopLanguage {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    PowerShell,
}

impl SlopLanguage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::PowerShell => "powershell",
        }
    }
}

/// Category of unfinished stub or uncontextualized error-swallowing slop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SlopKind {
    TodoMacro,
    UnimplementedMacro,
    PanicNotImplemented,
    EmptyStubFunction,
    SwallowedError,
}

impl SlopKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TodoMacro => "todo_macro",
            Self::UnimplementedMacro => "unimplemented_macro",
            Self::PanicNotImplemented => "panic_not_implemented",
            Self::EmptyStubFunction => "empty_stub_function",
            Self::SwallowedError => "swallowed_error",
        }
    }
}

/// Single finding emitted by [`scan_source_for_slop`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlopFinding {
    pub kind: SlopKind,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
    pub message: String,
}

impl SlopFinding {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind.as_str(),
            "line": self.line,
            "column": self.column,
            "snippet": self.snippet,
            "message": self.message,
        })
    }
}

impl Serialize for SlopFinding {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Report emitted by [`scan_source_for_slop`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlopScanReport {
    pub language: SlopLanguage,
    pub clean: bool,
    pub findings: Vec<SlopFinding>,
}

impl SlopScanReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "language": self.language.as_str(),
            "clean": self.clean,
            "findings": self.findings.iter().map(SlopFinding::to_json).collect::<Vec<_>>(),
        })
    }
}

impl Serialize for SlopScanReport {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexTokenKind {
    Word,
    Punct(char),
    StringLit,
    Comment,
    Newline,
}

#[derive(Debug, Clone)]
struct LexToken {
    kind: LexTokenKind,
    text: String,
    unquoted: String,
    line: usize,
    col: usize,
}

/// Lexer-aware scanner ignoring string literals and comments while detecting `todo!()`,
/// `unimplemented!()`, `panic!("not implemented")`, empty stub functions, and uncontextualized
/// swallowed errors. Never penalizes valid deletions or clean refactors.
#[must_use]
pub fn scan_source_for_slop(source: &str, language: SlopLanguage) -> SlopScanReport {
    let tokens = lex_source(source, language);
    let mut findings = Vec::new();

    match language {
        SlopLanguage::Rust => scan_rust_tokens(&tokens, &mut findings),
        SlopLanguage::TypeScript | SlopLanguage::JavaScript => {
            scan_js_ts_tokens(&tokens, &mut findings);
        }
        SlopLanguage::Python => scan_python_tokens(&tokens, &mut findings),
        SlopLanguage::PowerShell => scan_powershell_tokens(&tokens, &mut findings),
    }

    findings.sort_by(|a, b| a.line.cmp(&b.line).then_with(|| a.column.cmp(&b.column)));

    SlopScanReport {
        language,
        clean: findings.is_empty(),
        findings,
    }
}

fn lex_source(source: &str, language: SlopLanguage) -> Vec<LexToken> {
    let mut tokens = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0usize;
    let mut line = 1usize;
    let mut line_start = 0usize;

    let col_of = |pos: usize, ls: usize| -> usize { source[ls..pos].chars().count() + 1 };

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\n' {
            tokens.push(LexToken {
                kind: LexTokenKind::Newline,
                text: "\n".to_owned(),
                unquoted: String::new(),
                line,
                col: col_of(i, line_start),
            });
            i += 1;
            line += 1;
            line_start = i;
            continue;
        }
        if b == b' ' || b == b'\t' || b == b'\r' {
            i += 1;
            continue;
        }

        // Language comments
        match language {
            SlopLanguage::Rust | SlopLanguage::TypeScript | SlopLanguage::JavaScript => {
                if source[i..].starts_with("//") {
                    let col = col_of(i, line_start);
                    let start = i;
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    tokens.push(LexToken {
                        kind: LexTokenKind::Comment,
                        text: source[start..i].to_owned(),
                        unquoted: source[start + 2..i].to_owned(),
                        line,
                        col,
                    });
                    continue;
                }
                if source[i..].starts_with("/*") {
                    let start_line = line;
                    let col = col_of(i, line_start);
                    let start = i;
                    let nested_allowed = language == SlopLanguage::Rust;
                    let mut depth = 1usize;
                    i += 2;
                    while i < bytes.len() && depth > 0 {
                        if nested_allowed && source[i..].starts_with("/*") {
                            depth += 1;
                            i += 2;
                        } else if source[i..].starts_with("*/") {
                            depth -= 1;
                            i += 2;
                        } else {
                            if bytes[i] == b'\n' {
                                line += 1;
                                line_start = i + 1;
                            }
                            i += 1;
                        }
                    }
                    tokens.push(LexToken {
                        kind: LexTokenKind::Comment,
                        text: source[start..i].to_owned(),
                        unquoted: String::new(),
                        line: start_line,
                        col,
                    });
                    continue;
                }
            }
            SlopLanguage::Python => {
                if b == b'#' {
                    let col = col_of(i, line_start);
                    let start = i;
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    tokens.push(LexToken {
                        kind: LexTokenKind::Comment,
                        text: source[start..i].to_owned(),
                        unquoted: source[start + 1..i].to_owned(),
                        line,
                        col,
                    });
                    continue;
                }
            }
            SlopLanguage::PowerShell => {
                if source[i..].starts_with("<#") {
                    let start_line = line;
                    let col = col_of(i, line_start);
                    let start = i;
                    i += 2;
                    while i < bytes.len() && !source[i..].starts_with("#>") {
                        if bytes[i] == b'\n' {
                            line += 1;
                            line_start = i + 1;
                        }
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 2;
                    }
                    tokens.push(LexToken {
                        kind: LexTokenKind::Comment,
                        text: source[start..i].to_owned(),
                        unquoted: String::new(),
                        line: start_line,
                        col,
                    });
                    continue;
                }
                if b == b'#' {
                    let col = col_of(i, line_start);
                    let start = i;
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    tokens.push(LexToken {
                        kind: LexTokenKind::Comment,
                        text: source[start..i].to_owned(),
                        unquoted: source[start + 1..i].to_owned(),
                        line,
                        col,
                    });
                    continue;
                }
            }
        }

        // Rust raw strings: r"...", r#"..."#, br"...", br#"..."#, cr"...", cr#"..."#
        if language == SlopLanguage::Rust {
            if let Some((end, inner_start, inner_end)) = try_scan_rust_raw_string(source, i) {
                let start_line = line;
                let col = col_of(i, line_start);
                for (offset, &byte_val) in bytes[i..end].iter().enumerate() {
                    if byte_val == b'\n' {
                        line += 1;
                        line_start = i + offset + 1;
                    }
                }
                tokens.push(LexToken {
                    kind: LexTokenKind::StringLit,
                    text: source[i..end].to_owned(),
                    unquoted: source[inner_start..inner_end].to_owned(),
                    line: start_line,
                    col,
                });
                i = end;
                continue;
            }
        }

        // Python triple-quoted strings (optional r/f/b/u prefix handled cleanly)
        if language == SlopLanguage::Python {
            if let Some((end, unquoted)) =
                try_scan_python_string(source, i, &mut line, &mut line_start)
            {
                let col = col_of(i, line_start);
                tokens.push(LexToken {
                    kind: LexTokenKind::StringLit,
                    text: source[i..end].to_owned(),
                    unquoted,
                    line,
                    col,
                });
                i = end;
                continue;
            }
        }

        // Standard string / template / char literals
        if b == b'"'
            || (b == b'`'
                && matches!(
                    language,
                    SlopLanguage::JavaScript | SlopLanguage::TypeScript
                ))
            || (b == b'\''
                && match language {
                    SlopLanguage::Rust => looks_like_rust_char_literal(source, i),
                    _ => true,
                })
        {
            let quote = b;
            let start_line = line;
            let col = col_of(i, line_start);
            let start = i;
            i += 1;
            let mut unquoted = String::new();
            while i < bytes.len() {
                let c_byte = bytes[i];
                if c_byte == b'\n' {
                    line += 1;
                    line_start = i + 1;
                }
                let is_escape = (c_byte == b'\\' && quote != b'\'')
                    || (language == SlopLanguage::Rust && quote == b'\'' && c_byte == b'\\')
                    || (language == SlopLanguage::PowerShell && c_byte == b'`' && quote == b'"');
                if is_escape && i + 1 < bytes.len() {
                    unquoted.push(bytes[i + 1] as char);
                    i += 2;
                    continue;
                }
                if c_byte == quote {
                    i += 1;
                    break;
                }
                let ch = source[i..].chars().next().unwrap_or('\0');
                unquoted.push(ch);
                i += ch.len_utf8();
            }
            tokens.push(LexToken {
                kind: LexTokenKind::StringLit,
                text: source[start..i].to_owned(),
                unquoted,
                line: start_line,
                col,
            });
            continue;
        }

        // Identifiers / keywords
        if b.is_ascii_alphabetic() || b == b'_' {
            let col = col_of(i, line_start);
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            tokens.push(LexToken {
                kind: LexTokenKind::Word,
                text: source[start..i].to_owned(),
                unquoted: String::new(),
                line,
                col,
            });
            continue;
        }

        // Numbers
        if b.is_ascii_digit() {
            let col = col_of(i, line_start);
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.')
            {
                i += 1;
            }
            tokens.push(LexToken {
                kind: LexTokenKind::Word,
                text: source[start..i].to_owned(),
                unquoted: String::new(),
                line,
                col,
            });
            continue;
        }

        // Single-char punctuation / operator
        let ch = source[i..].chars().next().unwrap_or(' ');
        let col = col_of(i, line_start);
        tokens.push(LexToken {
            kind: LexTokenKind::Punct(ch),
            text: ch.to_string(),
            unquoted: String::new(),
            line,
            col,
        });
        i += ch.len_utf8();
    }

    tokens
}

fn try_scan_rust_raw_string(source: &str, idx: usize) -> Option<(usize, usize, usize)> {
    let rest = &source[idx..];
    let prefix_len = if rest.starts_with("br") || rest.starts_with("cr") {
        2
    } else if rest.starts_with('r') {
        1
    } else {
        return None;
    };

    let after_r = &rest[prefix_len..];
    let hashes = after_r.bytes().take_while(|&b| b == b'#').count();
    if !after_r[hashes..].starts_with('"') {
        return None;
    }

    let inner_start = idx + prefix_len + hashes + 1;
    let mut close_pat = String::with_capacity(1 + hashes);
    close_pat.push('"');
    for _ in 0..hashes {
        close_pat.push('#');
    }

    if let Some(rel) = source[inner_start..].find(&close_pat) {
        let inner_end = inner_start + rel;
        Some((inner_end + close_pat.len(), inner_start, inner_end))
    } else {
        Some((source.len(), inner_start, source.len()))
    }
}

fn try_scan_python_string(
    source: &str,
    idx: usize,
    line: &mut usize,
    line_start: &mut usize,
) -> Option<(usize, String)> {
    let rest = &source[idx..];
    let mut prefix_len = 0usize;
    for b in rest.bytes().take(2) {
        if matches!(b, b'r' | b'R' | b'f' | b'F' | b'b' | b'B' | b'u' | b'U') {
            prefix_len += 1;
        } else {
            break;
        }
    }
    let after = &rest[prefix_len..];
    let (delim, is_triple) = if after.starts_with("\"\"\"") {
        ("\"\"\"", true)
    } else if after.starts_with("'''") {
        ("'''", true)
    } else if prefix_len > 0 && after.starts_with('"') {
        ("\"", false)
    } else if prefix_len > 0 && after.starts_with('\'') {
        ("'", false)
    } else {
        return None;
    };

    let mut pos = idx + prefix_len + delim.len();
    let bytes = source.as_bytes();
    let mut unquoted = String::new();
    while pos < bytes.len() {
        if bytes[pos] == b'\n' {
            *line += 1;
            *line_start = pos + 1;
        }
        if bytes[pos] == b'\\' && pos + 1 < bytes.len() {
            unquoted.push(bytes[pos + 1] as char);
            pos += 2;
            continue;
        }
        if source[pos..].starts_with(delim) {
            return Some((pos + delim.len(), unquoted));
        }
        if !is_triple && bytes[pos] == b'\n' {
            return Some((pos, unquoted));
        }
        let ch = source[pos..].chars().next().unwrap_or('\0');
        unquoted.push(ch);
        pos += ch.len_utf8();
    }
    Some((source.len(), unquoted))
}

fn looks_like_rust_char_literal(source: &str, idx: usize) -> bool {
    let rest = &source[idx..];
    let mut chars = rest.chars();
    let _open = chars.next();
    match chars.next() {
        Some('\\') => {
            // Escape sequence up to closing `'`: max ~10 chars on same line
            let limit = rest[1..].find('\n').map_or(rest.len(), |p| 1 + p).min(14);
            rest[2..limit].contains('\'')
        }
        Some(ch) if ch != '\'' && ch != '\n' => chars.next() == Some('\''),
        _ => false,
    }
}

fn non_ws_code_indices(tokens: &[LexToken]) -> Vec<usize> {
    tokens
        .iter()
        .enumerate()
        .filter_map(|(idx, t)| match t.kind {
            LexTokenKind::Word | LexTokenKind::Punct(_) | LexTokenKind::StringLit => Some(idx),
            LexTokenKind::Comment | LexTokenKind::Newline => None,
        })
        .collect()
}

fn has_comment_in_token_span(tokens: &[LexToken], start_tok: usize, end_tok: usize) -> bool {
    tokens[start_tok..=end_tok]
        .iter()
        .any(|t| t.kind == LexTokenKind::Comment)
}

fn matching_brace_end(
    tokens: &[LexToken],
    open_tok: usize,
    open_ch: char,
    close_ch: char,
) -> Option<usize> {
    let mut depth = 0usize;
    for (idx, tok) in tokens.iter().enumerate().skip(open_tok) {
        if tok.kind == LexTokenKind::Punct(open_ch) {
            depth += 1;
        } else if tok.kind == LexTokenKind::Punct(close_ch) {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(idx);
            }
        }
    }
    None
}

fn is_not_implemented_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("not implemented")
        || lower.contains("not yet implemented")
        || lower.contains("unimplemented")
        || lower.contains("todo")
        || lower.contains("stub")
}

fn scan_rust_tokens(tokens: &[LexToken], findings: &mut Vec<SlopFinding>) {
    let code_idx = non_ws_code_indices(tokens);

    for ci in 0..code_idx.len() {
        let tok_i = code_idx[ci];
        let tok = &tokens[tok_i];
        if tok.kind != LexTokenKind::Word {
            continue;
        }

        // 1. todo!(), unimplemented!(), panic!("not implemented")
        if matches!(tok.text.as_str(), "todo" | "unimplemented" | "panic") {
            let bang_i = code_idx.get(ci + 1).copied();
            let open_i = code_idx.get(ci + 2).copied();
            if let (Some(bi), Some(oi)) = (bang_i, open_i) {
                let is_bang = tokens[bi].kind == LexTokenKind::Punct('!');
                let open_ch = match tokens[oi].kind {
                    LexTokenKind::Punct('(') => Some(('(', ')')),
                    LexTokenKind::Punct('[') => Some(('[', ']')),
                    LexTokenKind::Punct('{') => Some(('{', '}')),
                    _ => None,
                };
                if is_bang {
                    if let Some((och, cch)) = open_ch {
                        match tok.text.as_str() {
                            "todo" => findings.push(SlopFinding {
                                kind: SlopKind::TodoMacro,
                                line: tok.line,
                                column: tok.col,
                                snippet: "todo!(...)".to_owned(),
                                message: "unimplemented `todo!()` macro left in Rust source"
                                    .to_owned(),
                            }),
                            "unimplemented" => findings.push(SlopFinding {
                                kind: SlopKind::UnimplementedMacro,
                                line: tok.line,
                                column: tok.col,
                                snippet: "unimplemented!(...)".to_owned(),
                                message:
                                    "unimplemented `unimplemented!()` macro left in Rust source"
                                        .to_owned(),
                            }),
                            "panic" => {
                                if let Some(close_tok) = matching_brace_end(tokens, oi, och, cch) {
                                    let flagged = tokens[oi + 1..close_tok].iter().any(|arg| {
                                        arg.kind == LexTokenKind::StringLit
                                            && is_not_implemented_message(&arg.unquoted)
                                    });
                                    if flagged {
                                        findings.push(SlopFinding {
                                            kind: SlopKind::PanicNotImplemented,
                                            line: tok.line,
                                            column: tok.col,
                                            snippet: "panic!(\"not implemented\")".to_owned(),
                                            message:
                                                "placeholder `panic!` with unimplemented message"
                                                    .to_owned(),
                                        });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        // 2. Empty stub functions: `fn name(...) [-> ...] { }`
        if tok.text == "fn" {
            let mut scan = ci + 1;
            let mut fn_name = String::from("<anonymous>");
            if let Some(&name_ti) = code_idx.get(scan) {
                if tokens[name_ti].kind == LexTokenKind::Word {
                    fn_name = tokens[name_ti].text.clone();
                    scan += 1;
                }
            }
            let mut hit_semi = false;
            let mut body_open_tok = None;
            let mut paren_depth = 0usize;
            let mut angle_depth = 0usize;
            while scan < code_idx.len() {
                let ti = code_idx[scan];
                match tokens[ti].kind {
                    LexTokenKind::Punct('(') => paren_depth += 1,
                    LexTokenKind::Punct(')') => paren_depth = paren_depth.saturating_sub(1),
                    LexTokenKind::Punct('<') if paren_depth == 0 => angle_depth += 1,
                    LexTokenKind::Punct('>') if paren_depth == 0 && angle_depth > 0 => {
                        angle_depth -= 1;
                    }
                    LexTokenKind::Punct(';') if paren_depth == 0 => {
                        hit_semi = true;
                        break;
                    }
                    LexTokenKind::Punct('{') if paren_depth == 0 => {
                        body_open_tok = Some(ti);
                        break;
                    }
                    _ => {}
                }
                scan += 1;
            }
            if !hit_semi {
                if let Some(open_ti) = body_open_tok {
                    if let Some(close_ti) = matching_brace_end(tokens, open_ti, '{', '}') {
                        let inner_code: Vec<&LexToken> = tokens[open_ti + 1..close_ti]
                            .iter()
                            .filter(|t| {
                                !matches!(t.kind, LexTokenKind::Comment | LexTokenKind::Newline)
                            })
                            .collect();
                        let is_empty_body = inner_code.is_empty()
                            || inner_code
                                .iter()
                                .all(|t| matches!(t.kind, LexTokenKind::Punct(';' | '(' | ')')));
                        let intentional_noop = tokens[open_ti + 1..close_ti].iter().any(|t| {
                            t.kind == LexTokenKind::Comment && {
                                let l = t.unquoted.to_ascii_lowercase();
                                l.contains("noop")
                                    || l.contains("no-op")
                                    || l.contains("intentional")
                            }
                        });
                        if is_empty_body && !intentional_noop {
                            findings.push(SlopFinding {
                                kind: SlopKind::EmptyStubFunction,
                                line: tok.line,
                                column: tok.col,
                                snippet: format!("fn {fn_name}(...) {{}}"),
                                message: format!("empty stub function `{fn_name}`"),
                            });
                        }
                    }
                }
            }
        }

        // 3. Uncontextualized swallowed errors in Rust:
        //    - `Err(_) => {}` / `Err(_) => ()`
        //    - `if let Err(_) = ... {}`
        if tok.text == "Err" {
            if let Some(&open_paren_ti) = code_idx.get(ci + 1) {
                if tokens[open_paren_ti].kind == LexTokenKind::Punct('(') {
                    if let Some(close_paren_ti) =
                        matching_brace_end(tokens, open_paren_ti, '(', ')')
                    {
                        let pattern_ignored = tokens[open_paren_ti + 1..close_paren_ti]
                            .iter()
                            .filter(|t| {
                                !matches!(t.kind, LexTokenKind::Comment | LexTokenKind::Newline)
                            })
                            .all(|t| {
                                (t.kind == LexTokenKind::Word && t.text.starts_with('_'))
                                    || t.kind == LexTokenKind::Punct('.')
                            });
                        if pattern_ignored {
                            // Case A: match arm `Err(_) => {}` or `Err(_) => ()`
                            let cp_ci = code_idx.iter().position(|&x| x == close_paren_ti);
                            if let Some(pos) = cp_ci {
                                if let (Some(&eq_ti), Some(&gt_ti), Some(&rhs_ti)) = (
                                    code_idx.get(pos + 1),
                                    code_idx.get(pos + 2),
                                    code_idx.get(pos + 3),
                                ) {
                                    if tokens[eq_ti].kind == LexTokenKind::Punct('=')
                                        && tokens[gt_ti].kind == LexTokenKind::Punct('>')
                                    {
                                        if tokens[rhs_ti].kind == LexTokenKind::Punct('{') {
                                            if let Some(close_b) =
                                                matching_brace_end(tokens, rhs_ti, '{', '}')
                                            {
                                                if is_uncontextualized_empty_block(
                                                    tokens, rhs_ti, close_b,
                                                ) {
                                                    findings.push(SlopFinding {
                                                        kind: SlopKind::SwallowedError,
                                                        line: tok.line,
                                                        column: tok.col,
                                                        snippet: "Err(_) => {}".to_owned(),
                                                        message: "uncontextualized swallowed error in `Err` match arm".to_owned(),
                                                    });
                                                }
                                            }
                                        } else if tokens[rhs_ti].kind == LexTokenKind::Punct('(') {
                                            if let Some(close_p) =
                                                matching_brace_end(tokens, rhs_ti, '(', ')')
                                            {
                                                if is_uncontextualized_empty_block(
                                                    tokens, rhs_ti, close_p,
                                                ) {
                                                    findings.push(SlopFinding {
                                                        kind: SlopKind::SwallowedError,
                                                        line: tok.line,
                                                        column: tok.col,
                                                        snippet: "Err(_) => ()".to_owned(),
                                                        message: "uncontextualized swallowed error returning `()`".to_owned(),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            // Case B: `if let Err(_) = <expr> {}`
                            if ci >= 2
                                && tokens[code_idx[ci - 2]].text == "if"
                                && tokens[code_idx[ci - 1]].text == "let"
                            {
                                let cp_ci = code_idx.iter().position(|&x| x == close_paren_ti);
                                if let Some(mut pos) = cp_ci {
                                    pos += 1;
                                    let mut p_depth = 0usize;
                                    while pos < code_idx.len() {
                                        let ti = code_idx[pos];
                                        match tokens[ti].kind {
                                            LexTokenKind::Punct('(') => p_depth += 1,
                                            LexTokenKind::Punct(')') => {
                                                p_depth = p_depth.saturating_sub(1);
                                            }
                                            LexTokenKind::Punct('{') if p_depth == 0 => {
                                                if let Some(close_b) =
                                                    matching_brace_end(tokens, ti, '{', '}')
                                                {
                                                    if is_uncontextualized_empty_block(
                                                        tokens, ti, close_b,
                                                    ) {
                                                        findings.push(SlopFinding {
                                                            kind: SlopKind::SwallowedError,
                                                            line: tok.line,
                                                            column: tok.col,
                                                            snippet: "if let Err(_) = ... {}"
                                                                .to_owned(),
                                                            message: "uncontextualized swallowed error in `if let Err(_)`".to_owned(),
                                                        });
                                                    }
                                                }
                                                break;
                                            }
                                            LexTokenKind::Punct(';') if p_depth == 0 => break,
                                            _ => {}
                                        }
                                        pos += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // `.unwrap_or_else(|_| {})` / `.map_err(|_| ())`
        if matches!(tok.text.as_str(), "unwrap_or_else" | "map_err") {
            if let Some(&open_p) = code_idx.get(ci + 1) {
                if tokens[open_p].kind == LexTokenKind::Punct('(') {
                    if let Some(close_p) = matching_brace_end(tokens, open_p, '(', ')') {
                        let inner: Vec<usize> = (open_p + 1..close_p)
                            .filter(|&k| {
                                !matches!(
                                    tokens[k].kind,
                                    LexTokenKind::Comment | LexTokenKind::Newline
                                )
                            })
                            .collect();
                        let swallowed = !has_comment_in_token_span(tokens, open_p, close_p)
                            && inner.len() >= 5
                            && tokens[inner[0]].kind == LexTokenKind::Punct('|')
                            && tokens[inner[1]].text.starts_with('_')
                            && tokens[inner[2]].kind == LexTokenKind::Punct('|')
                            && matches!(
                                (tokens[inner[3]].kind, tokens.get(inner[4]).map(|t| t.kind)),
                                (LexTokenKind::Punct('{'), Some(LexTokenKind::Punct('}')))
                                    | (LexTokenKind::Punct('('), Some(LexTokenKind::Punct(')')))
                            )
                            && inner.len() == 5;
                        if swallowed {
                            findings.push(SlopFinding {
                                kind: SlopKind::SwallowedError,
                                line: tok.line,
                                column: tok.col,
                                snippet: format!(".{}(|_| {{}})", tok.text),
                                message: format!(
                                    "uncontextualized swallowed error inside `.{}`",
                                    tok.text
                                ),
                            });
                        }
                    }
                }
            }
        }
    }
}

fn is_uncontextualized_empty_block(tokens: &[LexToken], open_ti: usize, close_ti: usize) -> bool {
    if has_comment_in_token_span(tokens, open_ti, close_ti) {
        return false;
    }
    tokens[open_ti + 1..close_ti].iter().all(|t| {
        matches!(
            t.kind,
            LexTokenKind::Comment | LexTokenKind::Newline | LexTokenKind::Punct(';')
        )
    })
}

fn scan_js_ts_tokens(tokens: &[LexToken], findings: &mut Vec<SlopFinding>) {
    let code_idx = non_ws_code_indices(tokens);
    for ci in 0..code_idx.len() {
        let tok_i = code_idx[ci];
        let tok = &tokens[tok_i];
        if tok.kind != LexTokenKind::Word {
            continue;
        }
        if tok.text == "function" {
            let mut scan = ci + 1;
            let mut name = String::from("<anonymous>");
            if let Some(&ni) = code_idx.get(scan) {
                if tokens[ni].kind == LexTokenKind::Word {
                    name = tokens[ni].text.clone();
                    scan += 1;
                }
            }
            let mut p_depth = 0usize;
            while scan < code_idx.len() {
                let ti = code_idx[scan];
                match tokens[ti].kind {
                    LexTokenKind::Punct('(') => p_depth += 1,
                    LexTokenKind::Punct(')') => p_depth = p_depth.saturating_sub(1),
                    LexTokenKind::Punct('{') if p_depth == 0 => {
                        if let Some(close_b) = matching_brace_end(tokens, ti, '{', '}') {
                            if is_uncontextualized_empty_block(tokens, ti, close_b) {
                                findings.push(SlopFinding {
                                    kind: SlopKind::EmptyStubFunction,
                                    line: tok.line,
                                    column: tok.col,
                                    snippet: format!("function {name}(...) {{}}"),
                                    message: format!("empty stub function `{name}`"),
                                });
                            }
                        }
                        break;
                    }
                    LexTokenKind::Punct(';') if p_depth == 0 => break,
                    _ => {}
                }
                scan += 1;
            }
        } else if tok.text == "catch" {
            // `catch (e) {}` or `catch {}` or `.catch(() => {})`
            let mut scan = ci + 1;
            if let Some(&next_ti) = code_idx.get(scan) {
                if tokens[next_ti].kind == LexTokenKind::Punct('(') {
                    if let Some(close_p) = matching_brace_end(tokens, next_ti, '(', ')') {
                        let inner_swallowed = !has_comment_in_token_span(tokens, next_ti, close_p)
                            && (next_ti + 1..close_p).any(|k| {
                                tokens[k].kind == LexTokenKind::Punct('{')
                                    && matching_brace_end(tokens, k, '{', '}').is_some_and(|cb| {
                                        is_uncontextualized_empty_block(tokens, k, cb)
                                    })
                            });
                        if inner_swallowed {
                            findings.push(SlopFinding {
                                kind: SlopKind::SwallowedError,
                                line: tok.line,
                                column: tok.col,
                                snippet: ".catch(() => {})".to_owned(),
                                message: "uncontextualized empty `.catch` handler".to_owned(),
                            });
                            continue;
                        }
                        if let Some(cp_ci) = code_idx.iter().position(|&x| x == close_p) {
                            scan = cp_ci + 1;
                        }
                    }
                }
            }
            if let Some(&brace_ti) = code_idx.get(scan) {
                if tokens[brace_ti].kind == LexTokenKind::Punct('{') {
                    if let Some(close_b) = matching_brace_end(tokens, brace_ti, '{', '}') {
                        if is_uncontextualized_empty_block(tokens, brace_ti, close_b) {
                            findings.push(SlopFinding {
                                kind: SlopKind::SwallowedError,
                                line: tok.line,
                                column: tok.col,
                                snippet: "catch (...) {}".to_owned(),
                                message: "uncontextualized empty `catch` block".to_owned(),
                            });
                        }
                    }
                }
            }
        } else if tok.text == "throw" {
            if let Some(&next_ti) = code_idx.get(ci + 1) {
                let scan_end = (ci + 8).min(code_idx.len());
                let is_not_impl = (ci + 1..scan_end).any(|k| {
                    let t = &tokens[code_idx[k]];
                    t.kind == LexTokenKind::StringLit && is_not_implemented_message(&t.unquoted)
                });
                let _ = next_ti;
                if is_not_impl {
                    findings.push(SlopFinding {
                        kind: SlopKind::UnimplementedMacro,
                        line: tok.line,
                        column: tok.col,
                        snippet: "throw ...(\"not implemented\")".to_owned(),
                        message: "unimplemented placeholder throw statement".to_owned(),
                    });
                }
            }
        }
    }
}

fn scan_python_tokens(tokens: &[LexToken], findings: &mut Vec<SlopFinding>) {
    let code_idx = non_ws_code_indices(tokens);
    for ci in 0..code_idx.len() {
        let tok_i = code_idx[ci];
        let tok = &tokens[tok_i];
        if tok.kind != LexTokenKind::Word {
            continue;
        }
        if tok.text == "raise" {
            if let Some(&next_ti) = code_idx.get(ci + 1) {
                if tokens[next_ti].text == "NotImplementedError" {
                    findings.push(SlopFinding {
                        kind: SlopKind::UnimplementedMacro,
                        line: tok.line,
                        column: tok.col,
                        snippet: "raise NotImplementedError".to_owned(),
                        message: "unimplemented `NotImplementedError` stub".to_owned(),
                    });
                }
            }
        } else if tok.text == "def" || tok.text == "except" {
            let mut scan = ci + 1;
            let name = if tok.text == "def" {
                code_idx
                    .get(scan)
                    .map_or("<anonymous>", |&i| tokens[i].text.as_str())
                    .to_owned()
            } else {
                String::new()
            };
            while scan < code_idx.len() && tokens[code_idx[scan]].kind != LexTokenKind::Punct(':') {
                scan += 1;
            }
            if scan < code_idx.len() {
                if let Some(&after_colon_ti) = code_idx.get(scan + 1) {
                    let is_pass = tokens[after_colon_ti].text == "pass";
                    let is_ellipsis = tokens[after_colon_ti].kind == LexTokenKind::Punct('.')
                        && code_idx
                            .get(scan + 2)
                            .is_some_and(|&t2| tokens[t2].kind == LexTokenKind::Punct('.'))
                        && code_idx
                            .get(scan + 3)
                            .is_some_and(|&t3| tokens[t3].kind == LexTokenKind::Punct('.'));
                    if is_pass || is_ellipsis {
                        if tok.text == "def" {
                            findings.push(SlopFinding {
                                kind: SlopKind::EmptyStubFunction,
                                line: tok.line,
                                column: tok.col,
                                snippet: format!("def {name}(...): pass"),
                                message: format!("empty stub function `{name}`"),
                            });
                        } else if !has_comment_in_token_span(tokens, code_idx[scan], after_colon_ti)
                        {
                            findings.push(SlopFinding {
                                kind: SlopKind::SwallowedError,
                                line: tok.line,
                                column: tok.col,
                                snippet: "except: pass".to_owned(),
                                message: "uncontextualized swallowed exception in `except: pass`"
                                    .to_owned(),
                            });
                        }
                    }
                }
            }
        }
    }
}

fn scan_powershell_tokens(tokens: &[LexToken], findings: &mut Vec<SlopFinding>) {
    let code_idx = non_ws_code_indices(tokens);
    for ci in 0..code_idx.len() {
        let tok_i = code_idx[ci];
        let tok = &tokens[tok_i];
        if tok.kind != LexTokenKind::Word {
            continue;
        }
        if tok.text.eq_ignore_ascii_case("function") {
            let mut scan = ci + 1;
            let name = code_idx
                .get(scan)
                .map_or("<anonymous>", |&i| tokens[i].text.as_str())
                .to_owned();
            while scan < code_idx.len() && tokens[code_idx[scan]].kind != LexTokenKind::Punct('{') {
                scan += 1;
            }
            if scan < code_idx.len() {
                let open_ti = code_idx[scan];
                if let Some(close_ti) = matching_brace_end(tokens, open_ti, '{', '}') {
                    if is_uncontextualized_empty_block(tokens, open_ti, close_ti) {
                        findings.push(SlopFinding {
                            kind: SlopKind::EmptyStubFunction,
                            line: tok.line,
                            column: tok.col,
                            snippet: format!("function {name} {{}}"),
                            message: format!("empty stub PowerShell function `{name}`"),
                        });
                    }
                }
            }
        } else if tok.text.eq_ignore_ascii_case("catch") {
            if let Some(&open_ti) = code_idx.get(ci + 1) {
                if tokens[open_ti].kind == LexTokenKind::Punct('{') {
                    if let Some(close_ti) = matching_brace_end(tokens, open_ti, '{', '}') {
                        if is_uncontextualized_empty_block(tokens, open_ti, close_ti) {
                            findings.push(SlopFinding {
                                kind: SlopKind::SwallowedError,
                                line: tok.line,
                                column: tok.col,
                                snippet: "catch {}".to_owned(),
                                message: "uncontextualized empty PowerShell `catch` block"
                                    .to_owned(),
                            });
                        }
                    }
                }
            }
        } else if tok.text.eq_ignore_ascii_case("throw") {
            if let Some(&next_ti) = code_idx.get(ci + 1) {
                if tokens[next_ti].kind == LexTokenKind::StringLit
                    && is_not_implemented_message(&tokens[next_ti].unquoted)
                {
                    findings.push(SlopFinding {
                        kind: SlopKind::UnimplementedMacro,
                        line: tok.line,
                        column: tok.col,
                        snippet: "throw \"not implemented\"".to_owned(),
                        message: "unimplemented placeholder PowerShell `throw`".to_owned(),
                    });
                }
            }
        }
    }
}

/// Outcome classification for one ReAct execution turn evaluated by [`prune_failed_attempts`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOutcome {
    Success,
    FailedCompileOrTest,
    Other,
}

impl AttemptOutcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::FailedCompileOrTest => "failed_compile_or_test",
            Self::Other => "other",
        }
    }
}

/// Single ReAct / build-test iteration turn passed into [`prune_failed_attempts`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptTurn {
    pub turn_index: usize,
    pub role: String,
    pub thought_plan: Option<String>,
    pub content: String,
    pub command: String,
    pub outcome: AttemptOutcome,
    pub exit_code: Option<i32>,
    pub error_summary: String,
}

impl AttemptTurn {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "turn_index": self.turn_index,
            "role": self.role,
            "thought_plan": self.thought_plan,
            "content": SecretRedactor::redact(&self.content),
            "command": SecretRedactor::redact(&self.command),
            "outcome": self.outcome.as_str(),
            "exit_code": self.exit_code,
            "error_summary": SecretRedactor::redact(&self.error_summary),
        }))
    }
}

/// Concise error receipt produced when older consecutive failed iterations are compacted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactedErrorReceipt {
    pub turn_index: usize,
    pub command: String,
    pub exit_code: Option<i32>,
    pub concise_error: String,
    pub original_content_sha256: String,
}

impl CompactedErrorReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "turn_index": self.turn_index,
            "command": SecretRedactor::redact(&self.command),
            "exit_code": self.exit_code,
            "concise_error": SecretRedactor::redact(&self.concise_error),
            "original_content_sha256": self.original_content_sha256,
        }))
    }
}

/// Result of [`prune_failed_attempts`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneAttemptsResult {
    pub turns: Vec<AttemptTurn>,
    pub compacted_count: usize,
    pub max_observed_streak: usize,
    pub anti_helplessness_triggered: bool,
    pub receipts: Vec<CompactedErrorReceipt>,
}

impl PruneAttemptsResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "turns": self.turns.iter().map(AttemptTurn::to_json).collect::<Vec<_>>(),
            "compacted_count": self.compacted_count,
            "max_observed_streak": self.max_observed_streak,
            "anti_helplessness_triggered": self.anti_helplessness_triggered,
            "receipts": self.receipts.iter().map(CompactedErrorReceipt::to_json).collect::<Vec<_>>(),
        })
    }
}

/// ReAct anti-helplessness pruner preserving `<thought_plan>` / `<thinking>` / `<reasoning>`
/// blocks and `thought_plan` fields verbatim while compacting older failed compile/test turns
/// whenever consecutive failures exceed `max_consecutive_failures` (default `2`).
#[must_use]
pub fn prune_failed_attempts(
    turns: &[AttemptTurn],
    max_consecutive_failures: usize,
) -> PruneAttemptsResult {
    let mut out_turns = turns.to_vec();
    let mut receipts = Vec::new();
    let mut max_observed_streak = 0usize;

    // Identify maximal contiguous streaks of FailedCompileOrTest.
    let mut idx = 0usize;
    while idx < out_turns.len() {
        if out_turns[idx].outcome != AttemptOutcome::FailedCompileOrTest {
            idx += 1;
            continue;
        }
        let streak_start = idx;
        while idx < out_turns.len() && out_turns[idx].outcome == AttemptOutcome::FailedCompileOrTest
        {
            idx += 1;
        }
        let streak_end = idx;
        let streak_len = streak_end - streak_start;
        max_observed_streak = max_observed_streak.max(streak_len);

        if streak_len > max_consecutive_failures {
            let compact_until = streak_end - max_consecutive_failures;
            for turn in &mut out_turns[streak_start..compact_until] {
                let receipt = compact_single_failed_turn(turn);
                receipts.push(receipt);
            }
        }
    }

    let compacted_count = receipts.len();
    PruneAttemptsResult {
        turns: out_turns,
        compacted_count,
        max_observed_streak,
        anti_helplessness_triggered: compacted_count > 0,
        receipts,
    }
}

fn compact_single_failed_turn(turn: &mut AttemptTurn) -> CompactedErrorReceipt {
    let original_sha = sha256_hex(turn.content.as_bytes());
    let preserved_blocks = extract_verbatim_reasoning_blocks(&turn.content);

    let raw_summary = if !turn.error_summary.trim().is_empty() {
        turn.error_summary.as_str()
    } else {
        turn.content.as_str()
    };
    let concise_error = build_concise_error_digest(raw_summary);
    let clean_cmd = SecretRedactor::redact(turn.command.trim());
    let exit_str = turn
        .exit_code
        .map_or_else(|| "unknown".to_owned(), |c| c.to_string());

    let receipt_line = format!(
        "[COMPACTED_ERROR_RECEIPT turn={} cmd=\"{}\" exit={} digest={} summary=\"{}\"]",
        turn.turn_index,
        clean_cmd,
        exit_str,
        &original_sha[..12],
        concise_error
    );

    let mut rebuilt = String::new();
    for block in preserved_blocks {
        rebuilt.push_str(&block);
        rebuilt.push('\n');
    }
    rebuilt.push_str(&receipt_line);

    turn.content = rebuilt;
    turn.error_summary = concise_error.clone();

    CompactedErrorReceipt {
        turn_index: turn.turn_index,
        command: clean_cmd,
        exit_code: turn.exit_code,
        concise_error,
        original_content_sha256: original_sha,
    }
}

fn extract_verbatim_reasoning_blocks(content: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let tag_pairs = [
        ("<thought_plan>", "</thought_plan>"),
        ("<thinking>", "</thinking>"),
        ("<reasoning>", "</reasoning>"),
    ];

    let mut pos = 0usize;
    while pos < content.len() {
        let mut earliest: Option<(usize, &str, &str)> = None;
        for &(open, close) in &tag_pairs {
            if let Some(rel) = content[pos..].find(open) {
                let abs = pos + rel;
                if earliest.is_none_or(|(best, _, _)| abs < best) {
                    earliest = Some((abs, open, close));
                }
            }
        }
        let Some((start, open, close)) = earliest else {
            break;
        };
        if let Some(close_rel) = content[start + open.len()..].find(close) {
            let end = start + open.len() + close_rel + close.len();
            blocks.push(content[start..end].to_owned());
            pos = end;
        } else {
            blocks.push(content[start..].to_owned());
            break;
        }
    }
    blocks
}

fn build_concise_error_digest(raw: &str) -> String {
    let scrubbed = SecretRedactor::redact(raw);
    let first_error_line = scrubbed
        .lines()
        .map(str::trim)
        .find(|l| {
            let lower = l.to_ascii_lowercase();
            !l.is_empty()
                && (lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("panic")
                    || lower.contains("assert"))
        })
        .or_else(|| scrubbed.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or("compile_or_test_failed");

    let compact: String = first_error_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    omnia_core::truncate_utf8_word_safe(&compact, 160)
}

/// Receipt returned by [`validate_shadow_git_index`] confirming an external shadow `GIT_INDEX_FILE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowGitIndexReceipt {
    pub git_index_path: String,
    pub workspace_root: String,
    pub is_external: bool,
}

impl ShadowGitIndexReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "git_index_path": self.git_index_path,
            "workspace_root": self.workspace_root,
            "is_external": self.is_external,
        })
    }
}

/// Requires an explicit absolute `GIT_INDEX_FILE` located strictly outside `workspace_root`,
/// rejecting implicit/relative paths, `..` traversal, symlinks/reparse points, and direct
/// `.git/index` mutation.
pub fn validate_shadow_git_index(
    git_index_path: impl AsRef<Path>,
    workspace_root: impl AsRef<Path>,
) -> Result<ShadowGitIndexReceipt, ContractError> {
    let idx_path = git_index_path.as_ref();
    let ws_path = workspace_root.as_ref();

    let idx_raw = idx_path.to_string_lossy();
    let ws_raw = ws_path.to_string_lossy();

    if idx_raw.trim().is_empty() || ws_raw.trim().is_empty() {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "empty_path".to_owned(),
        });
    }
    if idx_path.as_os_str().as_encoded_bytes().contains(&0)
        || ws_path.as_os_str().as_encoded_bytes().contains(&0)
    {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "nul_byte_in_path".to_owned(),
        });
    }
    if idx_raw.starts_with(r"\\.\") || idx_raw.starts_with(r"//./") {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "windows_device_prefix_forbidden".to_owned(),
        });
    }

    let clean_idx = strip_verbatim_drive_prefix(idx_path);
    let clean_ws = strip_verbatim_drive_prefix(ws_path);

    if !clean_idx.is_absolute() {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "git_index_file_must_be_explicit_absolute_path".to_owned(),
        });
    }
    if !clean_ws.is_absolute() {
        return Err(ContractError::InvalidShadowGitIndex {
            path: ws_raw.into_owned(),
            reason: "workspace_root_must_be_absolute_path".to_owned(),
        });
    }

    if has_parent_dir_component(&clean_idx) || has_parent_dir_component(&clean_ws) {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "parent_traversal_forbidden".to_owned(),
        });
    }

    // Reject `.git/index` suffix regardless of location.
    let norm_idx_slash = clean_idx.to_string_lossy().replace('\\', "/");
    let lower_slash = norm_idx_slash.to_ascii_lowercase();
    if lower_slash.ends_with("/.git/index") || lower_slash == ".git/index" {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "direct_dot_git_index_mutation_forbidden".to_owned(),
        });
    }

    // Reject symlink/reparse points on target or existing ancestors, and resolve physical paths if present.
    let resolved_ws = resolve_existing_or_lexical(&clean_ws)?;
    let resolved_idx = resolve_existing_or_lexical(&clean_idx)?;

    if path_is_within(&resolved_idx, &resolved_ws) || path_is_within(&clean_idx, &clean_ws) {
        return Err(ContractError::InvalidShadowGitIndex {
            path: idx_raw.into_owned(),
            reason: "shadow_git_index_must_reside_outside_workspace_root".to_owned(),
        });
    }

    Ok(ShadowGitIndexReceipt {
        git_index_path: resolved_idx.to_string_lossy().into_owned(),
        workspace_root: resolved_ws.to_string_lossy().into_owned(),
        is_external: true,
    })
}

fn strip_verbatim_drive_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/')
            {
                return PathBuf::from(rest);
            }
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn has_parent_dir_component(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || meta.file_type().is_symlink()
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn resolve_existing_or_lexical(path: &Path) -> Result<PathBuf, ContractError> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if is_reparse_or_symlink(&meta) {
            return Err(ContractError::InvalidShadowGitIndex {
                path: path.display().to_string(),
                reason: "reparse_point_or_symlink_forbidden".to_owned(),
            });
        }
        if let Ok(canon) = fs::canonicalize(path) {
            return Ok(strip_verbatim_drive_prefix(&canon));
        }
    }

    // Check longest existing ancestor for symlinks/reparse points and canonical location.
    let mut anc = path.to_path_buf();
    let mut tail_segs = Vec::new();
    while !anc.exists() {
        let Some(name) = anc.file_name() else {
            break;
        };
        tail_segs.push(name.to_os_string());
        if !anc.pop() {
            break;
        }
    }
    if anc.exists() {
        if let Ok(meta) = fs::symlink_metadata(&anc) {
            if is_reparse_or_symlink(&meta) {
                return Err(ContractError::InvalidShadowGitIndex {
                    path: anc.display().to_string(),
                    reason: "reparse_point_or_symlink_forbidden".to_owned(),
                });
            }
        }
        if let Ok(canon_anc) = fs::canonicalize(&anc) {
            let mut combined = strip_verbatim_drive_prefix(&canon_anc);
            for seg in tail_segs.into_iter().rev() {
                combined.push(seg);
            }
            return Ok(combined);
        }
    }

    Ok(path.to_path_buf())
}

fn normalize_components(path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => {
                let s = match p.kind() {
                    Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                        format!("{}:", (d as char).to_ascii_lowercase())
                    }
                    _ => p.as_os_str().to_string_lossy().to_ascii_lowercase(),
                };
                out.push(s);
            }
            Component::RootDir => out.push("/".to_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.push("..".to_owned());
            }
            Component::Normal(s) => {
                let str_val = s.to_string_lossy();
                #[cfg(windows)]
                out.push(str_val.to_ascii_lowercase());
                #[cfg(not(windows))]
                out.push(str_val.into_owned());
            }
        }
    }
    out
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    let cand_c = normalize_components(candidate);
    let root_c = normalize_components(root);
    if root_c.is_empty() || cand_c.len() < root_c.len() {
        return false;
    }
    cand_c[..root_c.len()] == root_c[..]
}

/// Pure RFC-2104 HMAC-SHA256 using `omnia_core::sha256_bytes` (64-byte block size).
#[must_use]
pub fn hmac_sha256_bytes(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut k0 = [0u8; HMAC_SHA256_BLOCK_SIZE];
    if key.len() > HMAC_SHA256_BLOCK_SIZE {
        let hashed_key = sha256_bytes(key);
        k0[..32].copy_from_slice(&hashed_key);
    } else {
        k0[..key.len()].copy_from_slice(key);
    }

    let mut ipad_and_msg = Vec::with_capacity(HMAC_SHA256_BLOCK_SIZE + message.len());
    for &b in &k0 {
        ipad_and_msg.push(b ^ 0x36);
    }
    ipad_and_msg.extend_from_slice(message);
    let inner_hash = sha256_bytes(&ipad_and_msg);

    let mut opad_and_inner = [0u8; HMAC_SHA256_BLOCK_SIZE + 32];
    for (i, &b) in k0.iter().enumerate() {
        opad_and_inner[i] = b ^ 0x5c;
    }
    opad_and_inner[HMAC_SHA256_BLOCK_SIZE..].copy_from_slice(&inner_hash);
    sha256_bytes(&opad_and_inner)
}

/// Lowercase 64-character hex RFC-2104 HMAC-SHA256 digest.
#[must_use]
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    hex_encode(&hmac_sha256_bytes(key, message))
}

/// Cryptographically signed receipt binding command, exit code, stdout/stderr digests, and
/// timestamp under RFC-2104 HMAC-SHA256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReceipt {
    pub schema_version: String,
    pub command: String,
    pub exit_code: i32,
    pub stdout_sha256: String,
    pub stderr_sha256: String,
    pub timestamp_ms: i64,
    pub signature_hmac_sha256: String,
}

impl ExecutionReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "schema_version": self.schema_version,
            "command": SecretRedactor::redact(&self.command),
            "exit_code": self.exit_code,
            "stdout_sha256": self.stdout_sha256,
            "stderr_sha256": self.stderr_sha256,
            "timestamp_ms": self.timestamp_ms,
            "signature_hmac_sha256": self.signature_hmac_sha256,
        }))
    }
}

impl Serialize for ExecutionReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Signs a command execution outcome (binding redacted command, exit code, stdout/stderr SHA-256
/// digests, and timestamp) using pure RFC-2104 HMAC-SHA256.
#[must_use]
pub fn sign_execution_receipt(
    key: &[u8],
    command: &str,
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
    timestamp_ms: i64,
) -> ExecutionReceipt {
    let clean_cmd = SecretRedactor::redact(command);
    let stdout_sha256 = sha256_hex(stdout);
    let stderr_sha256 = sha256_hex(stderr);
    let canonical = build_receipt_signing_bytes(
        EXECUTION_RECEIPT_SCHEMA,
        &clean_cmd,
        exit_code,
        &stdout_sha256,
        &stderr_sha256,
        timestamp_ms,
    );
    let signature_hmac_sha256 = hmac_sha256_hex(key, &canonical);

    ExecutionReceipt {
        schema_version: EXECUTION_RECEIPT_SCHEMA.to_owned(),
        command: clean_cmd,
        exit_code,
        stdout_sha256,
        stderr_sha256,
        timestamp_ms,
        signature_hmac_sha256,
    }
}

/// Signs precomputed 64-hex stdout/stderr SHA-256 digests under RFC-2104 HMAC-SHA256.
pub fn sign_execution_receipt_digests(
    key: &[u8],
    command: &str,
    exit_code: i32,
    stdout_sha256: &str,
    stderr_sha256: &str,
    timestamp_ms: i64,
) -> Result<ExecutionReceipt, ContractError> {
    if !is_valid_sha256_hex(stdout_sha256) {
        return Err(ContractError::InvalidDigest(stdout_sha256.to_owned()));
    }
    if !is_valid_sha256_hex(stderr_sha256) {
        return Err(ContractError::InvalidDigest(stderr_sha256.to_owned()));
    }
    let clean_cmd = SecretRedactor::redact(command);
    let out_norm = stdout_sha256.to_ascii_lowercase();
    let err_norm = stderr_sha256.to_ascii_lowercase();
    let canonical = build_receipt_signing_bytes(
        EXECUTION_RECEIPT_SCHEMA,
        &clean_cmd,
        exit_code,
        &out_norm,
        &err_norm,
        timestamp_ms,
    );
    let signature_hmac_sha256 = hmac_sha256_hex(key, &canonical);
    Ok(ExecutionReceipt {
        schema_version: EXECUTION_RECEIPT_SCHEMA.to_owned(),
        command: clean_cmd,
        exit_code,
        stdout_sha256: out_norm,
        stderr_sha256: err_norm,
        timestamp_ms,
        signature_hmac_sha256,
    })
}

/// Verifies an [`ExecutionReceipt`] signature in constant time against `key`, rejecting any
/// tampering across schema, command, exit code, stdout/stderr digests, or timestamp.
#[must_use]
pub fn verify_execution_receipt(key: &[u8], receipt: &ExecutionReceipt) -> bool {
    if key.is_empty()
        || receipt.schema_version != EXECUTION_RECEIPT_SCHEMA
        || !is_valid_sha256_hex(&receipt.stdout_sha256)
        || !is_valid_sha256_hex(&receipt.stderr_sha256)
    {
        return false;
    }
    let Ok(provided_sig) = hex_decode(&receipt.signature_hmac_sha256) else {
        return false;
    };
    if provided_sig.len() != 32 {
        return false;
    }

    let canonical = build_receipt_signing_bytes(
        &receipt.schema_version,
        &receipt.command,
        receipt.exit_code,
        &receipt.stdout_sha256.to_ascii_lowercase(),
        &receipt.stderr_sha256.to_ascii_lowercase(),
        receipt.timestamp_ms,
    );
    let expected_sig = hmac_sha256_bytes(key, &canonical);
    constant_time_eq(&expected_sig, &provided_sig)
}

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn build_receipt_signing_bytes(
    schema: &str,
    command: &str,
    exit_code: i32,
    stdout_sha256: &str,
    stderr_sha256: &str,
    timestamp_ms: i64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64 + schema.len() + command.len() + 128);
    push_len_prefixed(&mut buf, schema.as_bytes());
    push_len_prefixed(&mut buf, command.as_bytes());
    buf.extend_from_slice(&exit_code.to_be_bytes());
    push_len_prefixed(&mut buf, stdout_sha256.as_bytes());
    push_len_prefixed(&mut buf, stderr_sha256.as_bytes());
    buf.extend_from_slice(&timestamp_ms.to_be_bytes());
    buf
}

fn push_len_prefixed(buf: &mut Vec<u8>, bytes: &[u8]) {
    let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(bytes);
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_core::uuid_v4;

    #[test]
    fn hash_anchored_slice_and_edit_verification() {
        let src = "fn alpha() {\n    let x = 1;\n}\n";
        let formatted = format_hash_anchored_slice(src, 1, 3).expect("slice");
        let lines: Vec<&str> = formatted.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("1:"));
        assert!(lines[0].ends_with("|fn alpha() {"));
        assert!(lines[1].starts_with("2:"));
        assert!(lines[1].ends_with("|    let x = 1;"));

        let verified = verify_hash_anchored_edit(src, formatted.as_str()).expect("valid anchors");
        assert!(verified.verified);
        assert_eq!(verified.verified_lines, vec![1, 2, 3]);

        // Replacement via HashAnchor works when hash matches.
        let h2 = compute_line_hash4("    let x = 1;");
        let rep = verify_hash_anchored_edit(
            src,
            &[HashAnchor::with_replacement(2, &h2, "    let x = 42;")],
        )
        .expect("replace line 2");
        assert_eq!(
            rep.updated_source.as_deref(),
            Some("fn alpha() {\n    let x = 42;\n}\n")
        );

        // Stale or tampered source must reject on hash mismatch.
        let drifted = "fn alpha() {\n    let x = 2;\n}\n";
        let err = verify_hash_anchored_edit(drifted, formatted.as_str())
            .expect_err("hash mismatch must reject");
        assert!(matches!(
            err,
            ContractError::HashAnchorMismatch { line_no: 2, .. }
        ));
    }

    #[test]
    fn lexer_aware_slop_scanner_ignores_strings_and_comments_and_catches_real_slop() {
        let clean_rust = r##"
// Never leave todo!() or unimplemented!() or panic!("not implemented") in code.
/* /* nested comment todo!() */ fn ghost() {} */
pub fn validate_non_empty(items: &[i32]) -> usize {
    let doc = "todo!() unimplemented!() panic!(\"not implemented\")";
    let raw = r#"fn fake_stub() {} if let Err(_) = res {}"#;
    if items.is_empty() {
        panic!("items must not be empty");
    }
    let _ = (doc, raw);
    items.len()
}
"##;
        let clean_report = scan_source_for_slop(clean_rust, SlopLanguage::Rust);
        assert!(
            clean_report.clean,
            "unexpected findings: {:?}",
            clean_report.findings
        );

        let sloppy_rust = r#"
pub fn a() {
    todo!();
}
pub fn b() {
    unimplemented!();
}
pub fn c() {
    panic!("not implemented yet");
}
pub fn empty_stub() {}
pub fn swallows(res: Result<(), i32>) {
    match res {
        Ok(()) => {}
        Err(_) => {}
    }
    if let Err(_) = res {}
}
"#;
        let bad_report = scan_source_for_slop(sloppy_rust, SlopLanguage::Rust);
        assert!(!bad_report.clean);
        assert!(bad_report
            .findings
            .iter()
            .any(|f| f.kind == SlopKind::TodoMacro));
        assert!(bad_report
            .findings
            .iter()
            .any(|f| f.kind == SlopKind::UnimplementedMacro));
        assert!(bad_report
            .findings
            .iter()
            .any(|f| f.kind == SlopKind::PanicNotImplemented));
        assert!(bad_report
            .findings
            .iter()
            .any(|f| f.kind == SlopKind::EmptyStubFunction));
        assert!(
            bad_report
                .findings
                .iter()
                .filter(|f| f.kind == SlopKind::SwallowedError)
                .count()
                >= 2
        );
    }

    #[test]
    fn react_anti_helplessness_pruner_preserves_thought_plans_verbatim() {
        let mk_fail = |idx: usize| {
            AttemptTurn {
            turn_index: idx,
            role: "assistant".to_owned(),
            thought_plan: Some(format!("plan-{idx}")),
            content: format!(
                "<thought_plan>Inspect borrow issue step {idx}</thought_plan>\nVerbose 200-line compiler trace for step {idx}\nerror[E0308]: mismatched types at step {idx}"
            ),
            command: "cargo test -p omnia-harness --offline --locked".to_owned(),
            outcome: AttemptOutcome::FailedCompileOrTest,
            exit_code: Some(101),
            error_summary: format!("error[E0308]: mismatched types at step {idx}"),
        }
        };

        let turns = vec![mk_fail(1), mk_fail(2), mk_fail(3), mk_fail(4)];
        let pruned = prune_failed_attempts(&turns, DEFAULT_MAX_CONSECUTIVE_FAILURES);
        assert!(pruned.anti_helplessness_triggered);
        assert_eq!(pruned.max_observed_streak, 4);
        assert_eq!(pruned.compacted_count, 2);

        // First two older failures compacted while <thought_plan> preserved verbatim; latest 2 intact.
        for (i, turn) in pruned.turns.iter().enumerate().take(2) {
            assert!(turn.content.contains(&format!(
                "<thought_plan>Inspect borrow issue step {}</thought_plan>",
                i + 1
            )));
            assert!(turn.content.contains("[COMPACTED_ERROR_RECEIPT"));
            assert!(!turn
                .content
                .contains("Verbose 200-line compiler trace"));
        }
        assert!(pruned.turns[2]
            .content
            .contains("Verbose 200-line compiler trace"));
        assert!(pruned.turns[3]
            .content
            .contains("Verbose 200-line compiler trace"));

        // <=2 consecutive failures must never compact.
        let short = prune_failed_attempts(&turns[0..2], 2);
        assert_eq!(short.compacted_count, 0);
        assert!(!short.anti_helplessness_triggered);
    }

    #[test]
    fn shadow_git_index_validation_enforces_external_location() {
        let temp_base = std::env::temp_dir().join(format!("omnia-shadow-idx-{}", uuid_v4()));
        let ws = temp_base.join("repo");
        let ext = temp_base.join("external_index").join("shadow.index");
        fs::create_dir_all(ws.join(".git")).expect("mkdir .git");
        fs::create_dir_all(ext.parent().expect("parent")).expect("mkdir ext");

        let ok = validate_shadow_git_index(&ext, &ws).expect("external shadow index allowed");
        assert!(ok.is_external);

        let inside_dot_git = ws.join(".git").join("index");
        let err_git = validate_shadow_git_index(&inside_dot_git, &ws)
            .expect_err("direct .git/index must fail");
        assert!(matches!(
            err_git,
            ContractError::InvalidShadowGitIndex { .. }
        ));

        let inside_ws = ws.join("shadow.index");
        let err_ws = validate_shadow_git_index(&inside_ws, &ws)
            .expect_err("index inside workspace must fail");
        assert!(matches!(
            err_ws,
            ContractError::InvalidShadowGitIndex { .. }
        ));

        let rel_err =
            validate_shadow_git_index(".git/index", &ws).expect_err("relative path must fail");
        assert!(matches!(
            rel_err,
            ContractError::InvalidShadowGitIndex { .. }
        ));

        let _ = fs::remove_dir_all(&temp_base);
    }

    #[test]
    fn rfc4231_hmac_sha256_vectors_and_execution_receipt_signing() {
        // RFC 4231 Test Case 1: Key = 0x0b * 20, Data = "Hi There"
        let key1 = [0x0bu8; 20];
        let mac1 = hmac_sha256_hex(&key1, b"Hi There");
        assert_eq!(
            mac1,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );

        // RFC 4231 Test Case 2: Key = "Jefe", Data = "what do ya want for nothing?"
        let mac2 = hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            mac2,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );

        // RFC 4231 Test Case 6: Key > 64 bytes (131 bytes of 0xaa)
        let key6 = [0xaau8; 131];
        let mac6 = hmac_sha256_hex(
            &key6,
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            mac6,
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );

        let signing_key = b"synthetic-fixture-signing-key";
        let receipt = sign_execution_receipt(
            signing_key,
            "cargo test -p omnia-harness --offline --locked",
            0,
            b"test result: ok. 12 passed; 0 failed",
            b"",
            1_731_628_800_000,
        );
        assert!(verify_execution_receipt(signing_key, &receipt));
        assert!(!verify_execution_receipt(b"wrong-key", &receipt));

        let mut tampered_exit = receipt.clone();
        tampered_exit.exit_code = 1;
        assert!(!verify_execution_receipt(signing_key, &tampered_exit));

        let mut tampered_cmd = receipt.clone();
        tampered_cmd.command.push_str(" --force");
        assert!(!verify_execution_receipt(signing_key, &tampered_cmd));

        let mut tampered_ts = receipt;
        tampered_ts.timestamp_ms += 1;
        assert!(!verify_execution_receipt(signing_key, &tampered_ts));
    }
}
