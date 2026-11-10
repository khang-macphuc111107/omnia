//! read_file, write_file, edit_file, multi_edit, list_dir.

use std::path::Path;

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{display_path, finish, parse_input, truncate_chars};
use crate::{Block, EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const DEFAULT_LINE_LIMIT: usize = 2000;
const MAX_LINE_CHARS: usize = 2000;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_DIFF_CHARS: usize = 4000;

pub(crate) fn detect_crlf(text: &str) -> bool {
    text.contains("\r\n")
}

pub(crate) fn to_lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

pub(crate) fn from_lf(text: &str, crlf: bool) -> String {
    if crlf {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

pub(crate) async fn read_text_file(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if looks_binary(&bytes) {
        return Err(format!("{} is a binary file", path.display()));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_string)
        .unwrap_or(text))
}

fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let diff = similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    if diff.chars().count() > MAX_DIFF_CHARS {
        format!(
            "{}\n... diff truncated ...",
            truncate_chars(&diff, MAX_DIFF_CHARS)
        )
    } else {
        diff
    }
}

// ---------------------------------------------------------------- read_file

pub struct ReadFileTool;

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[async_trait]
impl Tool for ReadFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_file".into(),
            description: "Read a file from the filesystem. Text files are returned with line \
numbers (`   12\\tcontent`). By default up to 2000 lines are returned from the start; use `offset` \
(1-based line number) and `limit` to page through large files. Lines longer than 2000 characters \
are truncated. PNG/JPEG/GIF/WebP images are returned as images. Jupyter notebooks (.ipynb) are rendered cell by cell with \
text outputs; .docx/.xlsx/.pptx files are returned as extracted text. PDFs are not supported \
(use a shell tool such as pdftotext). Other binary files are rejected. Relative paths resolve against the working directory."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path (absolute or relative to the working directory)."},
                    "offset": {"type": "integer", "minimum": 1, "description": "1-based line number to start reading from."},
                    "limit": {"type": "integer", "minimum": 1, "description": "Maximum number of lines to read (default 2000)."}
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("Read {}", input["path"].as_str().unwrap_or("?"))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(read_file(ctx, input).await)
    }
}

async fn read_file(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: ReadArgs = parse_input(input)?;
    let path = ctx.resolve(&args.path);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if meta.is_dir() {
        return Err(format!(
            "{} is a directory; use list_dir instead",
            path.display()
        ));
    }
    if let Some(media_type) = image_media_type(&path) {
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "image is too large ({} bytes, max {MAX_IMAGE_BYTES})",
                bytes.len()
            ));
        }
        return Ok(ToolOutput {
            content: vec![
                Block::text(format!("Image {} ({} bytes)", args.path, bytes.len())),
                Block::Image {
                    media_type: media_type.into(),
                    data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                },
            ],
            is_error: false,
        });
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let text = match ext.as_str() {
        "pdf" => {
            return Err(format!(
                "{} is a PDF; read_file cannot return PDF documents. Extract text with a shell tool instead, e.g. `pdftotext -layout file.pdf -` (poppler) or `python -m pypdf`",
                path.display()
            ))
        }
        "ipynb" => render_notebook(&read_text_file(&path).await?)?,
        "docx" | "xlsx" | "pptx" => {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
            let kind = ext.clone();
            tokio::task::spawn_blocking(move || super::office::extract_text(&kind, bytes))
                .await
                .map_err(|error| format!("extraction failed: {error}"))?
                .map_err(|error| format!("cannot read {}: {error}", path.display()))?
        }
        _ => read_text_file(&path).await?,
    };
    if text.is_empty() {
        return Ok(ToolOutput::text("(file is empty)"));
    }
    paginate(&text, args.offset, args.limit)
}

fn paginate(text: &str, offset: Option<usize>, limit: Option<usize>) -> Result<ToolOutput, String> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    let total = lines.len();
    let start = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(DEFAULT_LINE_LIMIT).max(1);
    if start > total {
        return Err(format!(
            "offset {start} is beyond the end of the file ({total} lines)"
        ));
    }
    let end = (start - 1 + limit).min(total);
    let mut out = String::new();
    for (index, line) in lines[start - 1..end].iter().enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = if line.chars().count() > MAX_LINE_CHARS {
            format!("{} [line truncated]", truncate_chars(line, MAX_LINE_CHARS))
        } else {
            line.to_string()
        };
        out.push_str(&format!("{:>6}\t{}\n", start + index, line));
    }
    if end < total {
        out.push_str(&format!(
            "\n[showing lines {start}-{end} of {total}; use offset={} to continue]\n",
            end + 1
        ));
    }
    Ok(ToolOutput::text(out))
}

/// Joins a notebook text field that is either a string or an array of strings.
fn nb_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

/// Renders a Jupyter notebook as plain text (images are mentioned, not inlined).
fn render_notebook(raw: &str) -> Result<String, String> {
    let nb: Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid notebook JSON: {error}"))?;
    let cells = nb["cells"]
        .as_array()
        .ok_or("notebook has no `cells` array")?;
    let mut out = String::new();
    for (index, cell) in cells.iter().enumerate() {
        let kind = cell["cell_type"].as_str().unwrap_or("unknown");
        out.push_str(&format!("## [{kind}] cell {}\n", index + 1));
        out.push_str(nb_text(&cell["source"]).trim_end());
        out.push('\n');
        for output in cell["outputs"].as_array().into_iter().flatten() {
            match output["output_type"].as_str().unwrap_or("") {
                "stream" => push_output(&mut out, &nb_text(&output["text"])),
                "error" => push_output(
                    &mut out,
                    &format!(
                        "{}: {}",
                        output["ename"].as_str().unwrap_or("Error"),
                        output["evalue"].as_str().unwrap_or("")
                    ),
                ),
                _ => {
                    let data = &output["data"];
                    if let Some(map) = data.as_object() {
                        let text = nb_text(&data["text/plain"]);
                        if !text.is_empty() {
                            push_output(&mut out, &text);
                        }
                        for key in map.keys().filter(|k| k.starts_with("image/")) {
                            out.push_str(&format!("[output: {key} image omitted]\n"));
                        }
                    }
                }
            }
        }
        out.push('\n');
    }
    Ok(out)
}

fn push_output(out: &mut String, text: &str) {
    out.push_str("[output]\n");
    out.push_str(text.trim_end());
    out.push('\n');
}

// --------------------------------------------------------------- write_file

pub struct WriteFileTool;

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

#[async_trait]
impl Tool for WriteFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write_file".into(),
            description: "Create a file or completely overwrite an existing one with `content`. \
Parent directories are created automatically. Prefer edit_file for modifying existing files; \
only use write_file for new files or full rewrites. Read an existing file first before overwriting it."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path (absolute or relative to the working directory)."},
                    "content": {"type": "string", "description": "Full file content."}
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("Write {}", input["path"].as_str().unwrap_or("?"))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(write_file(ctx, input).await)
    }
}

async fn write_file(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: WriteArgs = parse_input(input)?;
    let path = ctx.resolve(&args.path);
    let _mutation = ctx.lock_file_mutation(&path).await?;
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }
    ctx.checkpoint_before(&path)?;
    let existed = path.exists();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    tokio::fs::write(&path, args.content.as_bytes())
        .await
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    let lines = args.content.lines().count();
    Ok(ToolOutput::text(format!(
        "{} {} ({lines} lines, {} bytes)",
        if existed { "Overwrote" } else { "Created" },
        display_path(ctx, &path),
        args.content.len()
    )))
}

// ----------------------------------------------------------------- edit_file

/// Replace `old` with `new` in LF-normalised `content`. Returns the new
/// content and the number of replacements.
pub(crate) fn replace_in(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    if old.is_empty() {
        return Err("old_string must not be empty".into());
    }
    if old == new {
        return Err("old_string and new_string are identical; nothing to change".into());
    }
    let count = content.matches(old).count();
    if count == 0 {
        let squash = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        let hint = if squash(content).contains(&squash(old)) {
            " A match exists that differs only in whitespace/indentation; copy the text exactly as it appears in the file (use read_file)."
        } else {
            " Re-read the file with read_file and copy the text exactly, including whitespace."
        };
        return Err(format!("old_string was not found in the file.{hint}"));
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string matches {count} places. Include more surrounding context to make it unique, or set replace_all=true to replace every occurrence."
        ));
    }
    if replace_all {
        Ok((content.replace(old, new), count))
    } else {
        Ok((content.replacen(old, new, 1), 1))
    }
}

pub struct EditFileTool;

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[async_trait]
impl Tool for EditFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "edit_file".into(),
            description:
                "Replace an exact string in an existing file. `old_string` must match the \
file text exactly (including whitespace) and be unique unless `replace_all` is true; otherwise the \
edit fails and nothing is changed. Include enough surrounding context to make `old_string` unique. \
Line endings (CRLF/LF) of the file are preserved. Returns a unified diff of the change. \
To create a new file with an empty `old_string`, the file must not exist yet."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File to edit."},
                    "old_string": {"type": "string", "description": "Exact text to replace."},
                    "new_string": {"type": "string", "description": "Replacement text (must differ from old_string)."},
                    "replace_all": {"type": "boolean", "description": "Replace every occurrence instead of requiring uniqueness (default false)."}
                },
                "required": ["path", "old_string", "new_string"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("Edit {}", input["path"].as_str().unwrap_or("?"))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(edit_file(ctx, input).await)
    }
}

async fn edit_file(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: EditArgs = parse_input(input)?;
    let path = ctx.resolve(&args.path);
    let _mutation = ctx.lock_file_mutation(&path).await?;
    let shown = display_path(ctx, &path);
    if args.old_string.is_empty() && !path.exists() {
        ctx.checkpoint_before(&path)?;
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(&path, args.new_string.as_bytes())
            .await
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        return Ok(ToolOutput::text(format!("Created {shown}")));
    }
    let original = read_text_file(&path).await?;
    let crlf = detect_crlf(&original);
    let lf = to_lf(&original);
    let (updated, count) = replace_in(
        &lf,
        &to_lf(&args.old_string),
        &to_lf(&args.new_string),
        args.replace_all,
    )?;
    ctx.checkpoint_before(&path)?;
    tokio::fs::write(&path, from_lf(&updated, crlf).as_bytes())
        .await
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(ToolOutput::text(format!(
        "Edited {shown} ({count} replacement{})\n{}",
        if count == 1 { "" } else { "s" },
        unified_diff(&shown, &lf, &updated)
    )))
}

// ---------------------------------------------------------------- multi_edit

pub struct MultiEditTool;

#[derive(Deserialize)]
struct MultiEditArgs {
    path: String,
    edits: Vec<MultiEditItem>,
}

#[derive(Deserialize)]
struct MultiEditItem {
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[async_trait]
impl Tool for MultiEditTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "multi_edit".into(),
            description:
                "Apply several exact-string edits to one file in order, atomically: if any \
edit fails (not found / not unique) the file is left untouched. Each edit sees the result of the \
previous ones. Same matching rules as edit_file."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File to edit."},
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {"type": "string"},
                                "new_string": {"type": "string"},
                                "replace_all": {"type": "boolean"}
                            },
                            "required": ["old_string", "new_string"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["path", "edits"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        let count = input["edits"].as_array().map_or(0, Vec::len);
        format!(
            "Apply {count} edits to {}",
            input["path"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(multi_edit(ctx, input).await)
    }
}

async fn multi_edit(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: MultiEditArgs = parse_input(input)?;
    if args.edits.is_empty() {
        return Err("edits must not be empty".into());
    }
    let path = ctx.resolve(&args.path);
    let _mutation = ctx.lock_file_mutation(&path).await?;
    let shown = display_path(ctx, &path);
    let original = read_text_file(&path).await?;
    let crlf = detect_crlf(&original);
    let lf = to_lf(&original);
    let mut current = lf.clone();
    for (index, edit) in args.edits.iter().enumerate() {
        let (next, _) = replace_in(
            &current,
            &to_lf(&edit.old_string),
            &to_lf(&edit.new_string),
            edit.replace_all,
        )
        .map_err(|error| {
            format!(
                "edit {} of {} failed: {error} No changes were written.",
                index + 1,
                args.edits.len()
            )
        })?;
        current = next;
    }
    ctx.checkpoint_before(&path)?;
    tokio::fs::write(&path, from_lf(&current, crlf).as_bytes())
        .await
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(ToolOutput::text(format!(
        "Applied {} edits to {shown}\n{}",
        args.edits.len(),
        unified_diff(&shown, &lf, &current)
    )))
}

// ------------------------------------------------------------------ list_dir

pub struct ListDirTool;

#[derive(Deserialize)]
struct ListArgs {
    #[serde(default)]
    path: Option<String>,
}

#[async_trait]
impl Tool for ListDirTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_dir".into(),
            description:
                "List the entries of a directory (non-recursive): directories first, then \
files with their size in bytes. Use glob or grep to search recursively."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (default: working directory)."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("List {}", input["path"].as_str().unwrap_or("."))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(list_dir(ctx, input).await)
    }
}

async fn list_dir(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: ListArgs = parse_input(input)?;
    let path = ctx.resolve(args.path.as_deref().unwrap_or("."));
    let mut reader = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| format!("cannot list {}: {error}", path.display()))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| format!("cannot list {}: {error}", path.display()))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        match tokio::fs::metadata(entry.path()).await.ok() {
            Some(meta) if meta.is_dir() => dirs.push(format!("{name}/")),
            Some(meta) => files.push(format!("{name} ({} bytes)", meta.len())),
            None => files.push(format!("{name} (unreadable)")),
        }
    }
    dirs.sort();
    files.sort();
    let total = dirs.len() + files.len();
    let shown = display_path(ctx, &path);
    let mut out = format!(
        "{} ({total} entries)\n",
        if shown.is_empty() { "." } else { &shown }
    );
    for line in dirs.into_iter().chain(files) {
        out.push_str("  ");
        out.push_str(&line);
        out.push('\n');
    }
    Ok(ToolOutput::text(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn ctx(dir: &tempfile::TempDir) -> ToolContext {
        ToolContext::new(dir.path())
    }

    fn text(out: &ToolOutput) -> String {
        match &out.content[0] {
            Block::Text { text } => text.clone(),
            other => panic!("not text: {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_offset_limit_and_numbers() {
        let dir = tempdir().unwrap();
        let body: String = (1..=10).map(|n| format!("line{n}\n")).collect();
        std::fs::write(dir.path().join("a.txt"), body).unwrap();
        let out = ReadFileTool
            .call(
                &ctx(&dir),
                json!({"path": "a.txt", "offset": 3, "limit": 2}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(!out.is_error);
        assert!(t.contains("     3\tline3\n     4\tline4\n"));
        assert!(!t.contains("line5\n     6"));
        assert!(t.contains("offset=5"));
    }

    #[tokio::test]
    async fn read_notebook_renders_cells() {
        let dir = tempdir().unwrap();
        let nb = json!({"cells": [
            {"cell_type": "markdown", "source": ["# Title\n", "text"]},
            {"cell_type": "code", "source": "print(1)", "outputs": [
                {"output_type": "stream", "name": "stdout", "text": ["1\n"]},
                {"output_type": "display_data", "data": {"image/png": "AAAA", "text/plain": ["<Figure>"]}},
                {"output_type": "error", "ename": "ValueError", "evalue": "bad", "traceback": []}
            ]}
        ], "metadata": {}});
        std::fs::write(dir.path().join("n.ipynb"), nb.to_string()).unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "n.ipynb"}))
            .await
            .unwrap();
        let t = text(&out);
        assert!(!out.is_error, "{t}");
        assert!(t.contains("## [markdown] cell 1"), "{t}");
        assert!(t.contains("## [code] cell 2"));
        assert!(t.contains("print(1)") && t.contains("<Figure>"));
        assert!(t.contains("image/png image omitted"));
        assert!(t.contains("ValueError: bad"));
        assert!(!t.contains("AAAA"));
        let out = ReadFileTool
            .call(
                &ctx(&dir),
                json!({"path": "n.ipynb", "offset": 3, "limit": 1}),
            )
            .await
            .unwrap();
        assert!(text(&out).contains("offset=4"));
    }

    #[tokio::test]
    async fn read_office_and_pdf() {
        let dir = tempdir().unwrap();
        let xml = br#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Hi docx</w:t></w:r></w:p></w:body></w:document>"#;
        let zip = super::super::office::testutil::make_zip(&[("word/document.xml", xml, true)]);
        std::fs::write(dir.path().join("d.docx"), zip).unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "d.docx"}))
            .await
            .unwrap();
        assert!(
            !out.is_error && text(&out).contains("Hi docx"),
            "{}",
            text(&out)
        );
        std::fs::write(dir.path().join("bad.xlsx"), b"not a zip at all, sorry!!").unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "bad.xlsx"}))
            .await
            .unwrap();
        assert!(out.is_error);
        std::fs::write(dir.path().join("p.pdf"), b"%PDF-1.4").unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "p.pdf"}))
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("pdftotext"));
    }

    #[tokio::test]
    async fn read_binary_missing_dir_and_long_lines() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("b.bin"), [1u8, 0, 2, 3]).unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "b.bin"}))
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("binary"));
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "nope.txt"}))
            .await
            .unwrap();
        assert!(out.is_error);
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "."}))
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("list_dir"));
        std::fs::write(dir.path().join("long.txt"), "x".repeat(5000)).unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "long.txt"}))
            .await
            .unwrap();
        assert!(text(&out).contains("[line truncated]"));
    }

    #[tokio::test]
    async fn read_image() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("p.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let out = ReadFileTool
            .call(&ctx(&dir), json!({"path": "p.png"}))
            .await
            .unwrap();
        assert!(matches!(
            &out.content[1],
            Block::Image { media_type, data } if media_type == "image/png" && !data.is_empty()
        ));
    }

    #[tokio::test]
    async fn write_creates_dirs_and_overwrites() {
        let dir = tempdir().unwrap();
        let out = WriteFileTool
            .call(
                &ctx(&dir),
                json!({"path": "x/y/z.txt", "content": "a\nb\n"}),
            )
            .await
            .unwrap();
        assert!(text(&out).starts_with("Created x/y/z.txt"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x/y/z.txt")).unwrap(),
            "a\nb\n"
        );
        let out = WriteFileTool
            .call(&ctx(&dir), json!({"path": "x/y/z.txt", "content": "c"}))
            .await
            .unwrap();
        assert!(text(&out).starts_with("Overwrote"));
    }

    #[tokio::test]
    async fn edit_unique_nonunique_replace_all() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("e.txt");
        std::fs::write(&p, "foo bar\nfoo baz\n").unwrap();
        let c = ctx(&dir);
        let out = EditFileTool
            .call(
                &c,
                json!({"path": "e.txt", "old_string": "foo", "new_string": "qux"}),
            )
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("2 places"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "foo bar\nfoo baz\n");
        let out = EditFileTool
            .call(
                &c,
                json!({"path": "e.txt", "old_string": "bar", "new_string": "BAR"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error);
        assert!(text(&out).contains("-foo bar") && text(&out).contains("+foo BAR"));
        let out = EditFileTool
            .call(
                &c,
                json!({"path": "e.txt", "old_string": "foo", "new_string": "qux", "replace_all": true}),
            )
            .await
            .unwrap();
        assert!(!out.is_error);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "qux BAR\nqux baz\n");
        let out = EditFileTool
            .call(
                &c,
                json!({"path": "e.txt", "old_string": "zzz", "new_string": "y"}),
            )
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("not found"));
    }

    #[tokio::test]
    async fn edit_preserves_crlf() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("c.txt");
        std::fs::write(&p, "one\r\ntwo\r\nthree\r\n").unwrap();
        let out = EditFileTool
            .call(
                &ctx(&dir),
                json!({"path": "c.txt", "old_string": "one\ntwo", "new_string": "1\n2\n2b"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "1\r\n2\r\n2b\r\nthree\r\n"
        );
    }

    #[tokio::test]
    async fn multi_edit_is_atomic() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("m.txt");
        std::fs::write(&p, "alpha\nbeta\n").unwrap();
        let c = ctx(&dir);
        let out = MultiEditTool
            .call(
                &c,
                json!({"path": "m.txt", "edits": [
                    {"old_string": "alpha", "new_string": "A"},
                    {"old_string": "missing", "new_string": "B"}
                ]}),
            )
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("edit 2 of 2"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "alpha\nbeta\n");
        let out = MultiEditTool
            .call(
                &c,
                json!({"path": "m.txt", "edits": [
                    {"old_string": "alpha", "new_string": "A"},
                    {"old_string": "A\nbeta", "new_string": "AB"}
                ]}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "AB\n");
    }

    #[tokio::test]
    async fn sibling_edits_to_one_file_are_serialized_and_preserve_both_changes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("siblings.txt");
        std::fs::write(&path, "alpha\nbeta\n").unwrap();
        let parent = ctx(&dir);
        let left = parent.clone();
        let right = parent.clone();
        let (left_result, right_result) = tokio::join!(
            EditFileTool.call(
                &left,
                json!({"path": "siblings.txt", "old_string": "alpha", "new_string": "ALPHA"}),
            ),
            EditFileTool.call(
                &right,
                json!({"path": "siblings.txt", "old_string": "beta", "new_string": "BETA"}),
            ),
        );
        assert!(!left_result.unwrap().is_error);
        assert!(!right_result.unwrap().is_error);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "ALPHA\nBETA\n");
    }

    #[tokio::test]
    async fn waiting_file_mutation_can_be_cancelled_without_blocking_later_writer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cancel.txt");
        std::fs::write(&path, "one\ntwo\n").unwrap();
        let owner = ctx(&dir);
        let guard = owner.lock_file_mutation(&path).await.unwrap();
        let mut waiter = ToolContext::new(dir.path());
        waiter.file_mutations = Arc::clone(&owner.file_mutations);
        let waiter_cancel = waiter.cancel.clone();
        let waiting = tokio::spawn(async move {
            EditFileTool
                .call(
                    &waiter,
                    json!({"path": "cancel.txt", "old_string": "one", "new_string": "ONE"}),
                )
                .await
        });
        tokio::task::yield_now().await;
        // The guard keeps the second call queued; cancellation must release its
        // wait without poisoning the shared arbiter.
        waiter_cancel.cancel();
        assert!(waiting.await.unwrap().unwrap().is_error);
        drop(guard);
        let out = EditFileTool
            .call(
                &owner,
                json!({"path": "cancel.txt", "old_string": "one", "new_string": "ONE"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "ONE\ntwo\n");
    }

    #[tokio::test]
    async fn list_dir_entries() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("f.txt"), "hello").unwrap();
        let out = ListDirTool.call(&ctx(&dir), json!({})).await.unwrap();
        let t = text(&out);
        assert!(t.contains("sub/") && t.contains("f.txt (5 bytes)"));
        assert!(t.find("sub/").unwrap() < t.find("f.txt").unwrap());
    }
}
