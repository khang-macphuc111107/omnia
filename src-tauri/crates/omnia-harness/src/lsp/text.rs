//! Positions, URIs and WorkspaceEdit application.
//!
//! LSP positions are `(line, character)` with `character` counted in UTF-16
//! code units; tool arguments use 1-based lines and 1-based *character*
//! (Unicode scalar) columns, matching what editors and `read_file` show.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Start offsets of each line (a `\n`, `\r\n` or lone `\r` ends a line).
pub struct LineIndex<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    pub fn new(text: &'a str) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0];
        for (i, byte) in bytes.iter().enumerate() {
            match byte {
                b'\n' => starts.push(i + 1),
                b'\r' if bytes.get(i + 1) != Some(&b'\n') => starts.push(i + 1),
                _ => {}
            }
        }
        Self { text, starts }
    }

    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    /// Text of line `line` without its terminator ("" when out of range).
    pub fn line_text(&self, line: usize) -> &'a str {
        let Some(&start) = self.starts.get(line) else {
            return "";
        };
        let end = self
            .starts
            .get(line + 1)
            .copied()
            .unwrap_or(self.text.len());
        self.text[start..end].trim_end_matches(['\r', '\n'])
    }

    /// Byte offset of an LSP position; out-of-range values clamp to the end of
    /// the line / document as the specification requires.
    pub fn offset(&self, line: usize, utf16: usize) -> usize {
        let Some(&start) = self.starts.get(line) else {
            return self.text.len();
        };
        let line_text = self.line_text(line);
        let mut units = 0;
        for (idx, ch) in line_text.char_indices() {
            if units >= utf16 {
                return start + idx;
            }
            units += ch.len_utf16();
        }
        start + line_text.len()
    }
}

/// UTF-16 offset of the `char_col0`-th character of `line` (clamped).
pub fn char_col_to_utf16(line: &str, char_col0: usize) -> usize {
    line.chars().take(char_col0).map(char::len_utf16).sum()
}

/// Character index for a UTF-16 offset (rounds down inside a surrogate pair,
/// clamps past the end of the line).
pub fn utf16_to_char_col(line: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (n, ch) in line.chars().enumerate() {
        let next = units + ch.len_utf16();
        if next > utf16 {
            return n;
        }
        units = next;
    }
    line.chars().count()
}

// ---- URIs ------------------------------------------------------------------

pub fn path_to_uri(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        s.insert(0, '/');
    }
    let mut out = String::from("file://");
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    if !uri.get(..7)?.eq_ignore_ascii_case("file://") {
        return None;
    }
    let mut rest = &uri[7..];
    if let Some(stripped) = rest.strip_prefix("localhost") {
        rest = stripped;
    }
    let raw = rest.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() + 1 {
            if let Some(v) = rest
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                bytes.push(v);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let mut s = String::from_utf8(bytes).ok()?;
    let b = s.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[2] == b':' && b[1].is_ascii_alphabetic() {
        s.remove(0);
    }
    if cfg!(windows) {
        s = s.replace('/', "\\");
    }
    Some(PathBuf::from(s))
}

/// Case/separator-insensitive (on Windows) key for comparing paths and URIs.
pub fn path_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    if cfg!(windows) {
        s.make_ascii_lowercase();
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

pub fn uri_key(uri: &str) -> String {
    match uri_to_path(uri) {
        Some(path) => path_key(&path),
        None => uri.to_string(),
    }
}

/// `path` relative to `root` (with `/`) when inside it, else `None`.
pub fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let mut roots = vec![root.to_path_buf()];
    if let Ok(canonical) = root.canonicalize() {
        roots.push(canonical);
    }
    let shown = path.to_string_lossy().replace('\\', "/");
    let shown = shown.strip_prefix("//?/").unwrap_or(&shown).to_string();
    let lower = if cfg!(windows) {
        shown.to_ascii_lowercase()
    } else {
        shown.clone()
    };
    for root in roots {
        let mut key = path_key(&root);
        key.push('/');
        if let Some(rest) = lower.strip_prefix(&key) {
            if rest.is_empty() {
                continue;
            }
            return Some(shown[shown.len() - rest.len()..].to_string());
        }
    }
    None
}

// ---- edits -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub start: (usize, usize),
    pub end: (usize, usize),
    pub new_text: String,
}

fn position(value: &Value) -> Option<(usize, usize)> {
    Some((
        value.get("line")?.as_u64()? as usize,
        value.get("character")?.as_u64()? as usize,
    ))
}

pub fn parse_text_edit(value: &Value) -> Result<TextEdit, String> {
    let range = value.get("range").ok_or("text edit without range")?;
    Ok(TextEdit {
        start: position(range.get("start").ok_or("range without start")?)
            .ok_or("bad range start")?,
        end: position(range.get("end").ok_or("range without end")?).ok_or("bad range end")?,
        new_text: value
            .get("newText")
            .and_then(Value::as_str)
            .ok_or("text edit without newText")?
            .to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEdits {
    pub uri: String,
    pub edits: Vec<TextEdit>,
}

fn add_file_edits(files: &mut Vec<FileEdits>, uri: &str, edits: Vec<TextEdit>) {
    let key = uri_key(uri);
    match files.iter_mut().find(|f| uri_key(&f.uri) == key) {
        Some(existing) => existing.edits.extend(edits),
        None => files.push(FileEdits {
            uri: uri.to_string(),
            edits,
        }),
    }
}

fn parse_edit_list(value: &Value) -> Result<Vec<TextEdit>, String> {
    value
        .as_array()
        .ok_or("edits is not an array")?
        .iter()
        .map(parse_text_edit)
        .collect()
}

/// Flattens a `WorkspaceEdit` (`documentChanges` preferred over `changes`).
/// File create/rename/delete operations are refused.
pub fn parse_workspace_edit(edit: &Value) -> Result<Vec<FileEdits>, String> {
    let mut files: Vec<FileEdits> = Vec::new();
    if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
        for change in changes {
            if let Some(kind) = change.get("kind").and_then(Value::as_str) {
                return Err(format!(
                    "the server's rename needs a file `{kind}` operation, which lsp_rename does not apply"
                ));
            }
            let uri = change
                .pointer("/textDocument/uri")
                .and_then(Value::as_str)
                .ok_or("documentChanges entry without textDocument.uri")?;
            let edits = parse_edit_list(
                change
                    .get("edits")
                    .ok_or("documentChanges entry without edits")?,
            )?;
            add_file_edits(&mut files, uri, edits);
        }
    } else if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            add_file_edits(&mut files, uri, parse_edit_list(edits)?);
        }
    }
    Ok(files)
}

/// Byte ranges of `edits` in `text`, sorted by start (ties keep array order).
pub fn resolve_edits(
    text: &str,
    edits: &[TextEdit],
) -> Result<Vec<(usize, usize, String)>, String> {
    let index = LineIndex::new(text);
    let mut ranges: Vec<(usize, usize, String)> = edits
        .iter()
        .map(|e| {
            (
                index.offset(e.start.0, e.start.1),
                index.offset(e.end.0, e.end.1),
                e.new_text.clone(),
            )
        })
        .collect();
    if ranges.iter().any(|(s, e, _)| s > e) {
        return Err("a text edit has its end before its start".into());
    }
    ranges.sort_by_key(|(start, _, _)| *start);
    let mut prev_end = 0;
    for (start, end, _) in &ranges {
        if *start < prev_end {
            return Err("the server returned overlapping text edits".into());
        }
        prev_end = *end;
    }
    Ok(ranges)
}

/// Applies non-overlapping edits against the original text.
pub fn apply_text_edits(text: &str, edits: &[TextEdit]) -> Result<String, String> {
    let ranges = resolve_edits(text, edits)?;
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end, new_text) in ranges {
        out.push_str(&text[cursor..start]);
        out.push_str(&new_text);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_conversion_emoji_and_cjk() {
        let line = "a😀漢b";
        // chars: a=0 😀=1 漢=2 b=3 ; utf16: a=0 😀=1..3 漢=3 b=4
        assert_eq!(char_col_to_utf16(line, 0), 0);
        assert_eq!(char_col_to_utf16(line, 2), 3);
        assert_eq!(char_col_to_utf16(line, 3), 4);
        assert_eq!(char_col_to_utf16(line, 99), 5);
        assert_eq!(utf16_to_char_col(line, 1), 1);
        assert_eq!(
            utf16_to_char_col(line, 2),
            1,
            "inside a surrogate pair rounds down"
        );
        assert_eq!(utf16_to_char_col(line, 3), 2);
        assert_eq!(utf16_to_char_col(line, 4), 3);
        assert_eq!(utf16_to_char_col(line, 99), 4);
        let idx = LineIndex::new(line);
        assert_eq!(idx.offset(0, 3), "a😀".len());
        assert_eq!(idx.offset(0, 4), "a😀漢".len());
    }

    #[test]
    fn line_index_terminators() {
        let idx = LineIndex::new("a\r\nb\rc\nd");
        assert_eq!(idx.line_count(), 4);
        assert_eq!(
            (0..4).map(|i| idx.line_text(i)).collect::<Vec<_>>(),
            ["a", "b", "c", "d"]
        );
        assert_eq!(idx.offset(9, 0), 8);
    }

    fn edit(sl: usize, sc: usize, el: usize, ec: usize, text: &str) -> TextEdit {
        TextEdit {
            start: (sl, sc),
            end: (el, ec),
            new_text: text.into(),
        }
    }

    #[test]
    fn multiple_edits_same_line_any_order() {
        let text = "foo 😀 foo foo\nbar";
        // utf16: foo=0..3, 😀=4..6, second foo=7..10, third foo=11..14
        let edits = vec![
            edit(0, 11, 0, 14, "X"),
            edit(0, 0, 0, 3, "LONGER"),
            edit(0, 7, 0, 10, "Y"),
        ];
        assert_eq!(
            apply_text_edits(text, &edits).unwrap(),
            "LONGER 😀 Y X\nbar"
        );
    }

    #[test]
    fn same_position_inserts_keep_order_and_overlap_rejected() {
        let ins = vec![edit(0, 1, 0, 1, "A"), edit(0, 1, 0, 1, "B")];
        assert_eq!(apply_text_edits("xy", &ins).unwrap(), "xABy");
        let overlap = vec![edit(0, 0, 0, 2, "A"), edit(0, 1, 0, 3, "B")];
        assert!(apply_text_edits("xyz", &overlap).is_err());
    }

    #[test]
    fn multiline_edit() {
        let edits = vec![edit(0, 1, 2, 1, "-")];
        assert_eq!(apply_text_edits("a\nb\nc\n", &edits).unwrap(), "a-\n");
    }

    #[test]
    fn workspace_edit_forms() {
        let changes = json!({"changes": {"file:///x/a.rs": [
            {"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"newText":"b"}]}});
        let files = parse_workspace_edit(&changes).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].edits[0].new_text, "b");

        let doc = json!({"documentChanges": [
            {"textDocument":{"uri":"file:///x/a.rs","version":1},"edits":[
                {"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"newText":"b"}]},
            {"textDocument":{"uri":"file:///x/a.rs"},"edits":[
                {"range":{"start":{"line":1,"character":0},"end":{"line":1,"character":1}},"newText":"c"}]},
            {"textDocument":{"uri":"file:///x/b.rs"},"edits":[]}
        ]});
        let files = parse_workspace_edit(&doc).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].edits.len(), 2);

        let rename = json!({"documentChanges":[{"kind":"rename","oldUri":"file:///a","newUri":"file:///b"}]});
        let err = parse_workspace_edit(&rename).unwrap_err();
        assert!(err.contains("rename"), "{err}");
    }

    #[test]
    fn uri_roundtrip() {
        let p = Path::new(if cfg!(windows) {
            "C:\\my dir\\é.rs"
        } else {
            "/my dir/é.rs"
        });
        let uri = path_to_uri(p);
        assert!(uri.starts_with("file:///"), "{uri}");
        assert!(uri.contains("my%20dir"), "{uri}");
        assert_eq!(path_key(&uri_to_path(&uri).unwrap()), path_key(p));
        if cfg!(windows) {
            let back = uri_to_path("file:///c%3A/Users/x/a.rs").unwrap();
            assert_eq!(path_key(&back), "c:/users/x/a.rs");
        }
        assert!(uri_to_path("http://x").is_none());
    }

    #[test]
    fn relative_paths() {
        let root = Path::new(if cfg!(windows) {
            "C:\\Work\\proj"
        } else {
            "/work/proj"
        });
        let inside = Path::new(if cfg!(windows) {
            "c:\\work\\proj\\src\\A.rs"
        } else {
            "/work/proj/src/A.rs"
        });
        assert_eq!(relative_to(root, inside).as_deref(), Some("src/A.rs"));
        let outside = Path::new(if cfg!(windows) {
            "C:\\Work\\other\\a.rs"
        } else {
            "/work/other/a.rs"
        });
        assert_eq!(relative_to(root, outside), None);
    }
}
