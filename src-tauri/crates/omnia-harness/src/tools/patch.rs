//! apply_patch: multi-file patches in the `*** Begin Patch` envelope format
//! or as standard unified diffs. All-or-nothing: every file is computed in
//! memory first and only written when every hunk applied.

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::fs::{detect_crlf, from_lf, read_text_file, to_lf};
use super::{display_path, finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

#[derive(Debug, Clone, PartialEq)]
enum Op {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        hunks: Vec<Hunk>,
    },
}

#[derive(Debug, Clone, PartialEq, Default)]
struct Hunk {
    /// Text after `@@` (envelope format) used to locate the hunk.
    header: Option<String>,
    /// 0-based line hint (unified format).
    hint: Option<usize>,
    /// (' ' | '-' | '+', text)
    lines: Vec<(char, String)>,
    eof: bool,
}

fn parse_patch(patch: &str) -> Result<Vec<Op>, String> {
    if patch.lines().any(|l| l.trim() == "*** Begin Patch") {
        parse_envelope(patch)
    } else {
        parse_unified(patch)
    }
}

fn is_op_marker(line: &str) -> bool {
    line.starts_with("*** Add File:")
        || line.starts_with("*** Delete File:")
        || line.starts_with("*** Update File:")
        || line.starts_with("*** End Patch")
}

fn parse_envelope(patch: &str) -> Result<Vec<Op>, String> {
    let lines: Vec<&str> = patch.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut i = lines
        .iter()
        .position(|l| l.trim() == "*** Begin Patch")
        .ok_or("missing '*** Begin Patch'")?
        + 1;
    let mut ops = Vec::new();
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == "*** End Patch" {
            break;
        }
        if let Some(path) = line.strip_prefix("*** Add File:") {
            i += 1;
            let mut body = Vec::new();
            while i < lines.len() && !lines[i].starts_with("***") {
                let l = lines[i];
                match l.strip_prefix('+') {
                    Some(rest) => body.push(rest),
                    None if l.is_empty() => body.push(""),
                    None => {
                        return Err(format!(
                            "line {}: lines of an added file must start with '+': {l:?}",
                            i + 1
                        ))
                    }
                }
                i += 1;
            }
            let mut content = body.join("\n");
            if !body.is_empty() {
                content.push('\n');
            }
            ops.push(Op::Add {
                path: path.trim().to_string(),
                content,
            });
        } else if let Some(path) = line.strip_prefix("*** Delete File:") {
            ops.push(Op::Delete {
                path: path.trim().to_string(),
            });
            i += 1;
        } else if let Some(path) = line.strip_prefix("*** Update File:") {
            i += 1;
            let mut move_to = None;
            if i < lines.len() {
                if let Some(target) = lines[i].strip_prefix("*** Move to:") {
                    move_to = Some(target.trim().to_string());
                    i += 1;
                }
            }
            let mut hunks: Vec<Hunk> = Vec::new();
            let mut current: Option<Hunk> = None;
            while i < lines.len() && !is_op_marker(lines[i]) {
                let l = lines[i];
                if l.starts_with("*** End of File") {
                    if let Some(h) = current.as_mut() {
                        h.eof = true;
                    }
                } else if let Some(rest) = l.strip_prefix("@@") {
                    if let Some(h) = current.take() {
                        hunks.push(h);
                    }
                    let header = rest.trim();
                    current = Some(Hunk {
                        header: (!header.is_empty()).then(|| header.to_string()),
                        ..Hunk::default()
                    });
                } else {
                    let h = current.get_or_insert_with(Hunk::default);
                    match l.chars().next() {
                        Some(c @ (' ' | '-' | '+')) => h.lines.push((c, l[1..].to_string())),
                        None => h.lines.push((' ', String::new())),
                        Some(_) => {
                            return Err(format!(
                                "line {}: unexpected line in update hunk (must start with ' ', '-' or '+'): {l:?}",
                                i + 1
                            ))
                        }
                    }
                }
                i += 1;
            }
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            if hunks.is_empty() && move_to.is_none() {
                return Err(format!("update of {} has no hunks", path.trim()));
            }
            ops.push(Op::Update {
                path: path.trim().to_string(),
                move_to,
                hunks,
            });
        } else if line.trim().is_empty() {
            i += 1;
        } else {
            return Err(format!("line {}: unexpected line {line:?}", i + 1));
        }
    }
    if ops.is_empty() {
        return Err("patch contains no operations".into());
    }
    Ok(ops)
}

fn strip_diff_path(raw: &str) -> String {
    let raw = raw.split('\t').next().unwrap_or(raw).trim();
    let raw = raw.trim_matches('"');
    if raw == "/dev/null" {
        return raw.to_string();
    }
    for prefix in ["a/", "b/"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    raw.to_string()
}

fn parse_hunk_header(line: &str) -> Option<usize> {
    // @@ -12,3 +12,4 @@ optional
    let rest = line.strip_prefix("@@")?.trim_start().strip_prefix('-')?;
    let num: String = rest.chars().take_while(char::is_ascii_digit).collect();
    num.parse::<usize>().ok().map(|n| n.saturating_sub(1))
}

fn parse_unified(patch: &str) -> Result<Vec<Op>, String> {
    let lines: Vec<&str> = patch.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut ops = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].starts_with("--- ") && i + 1 < lines.len() && lines[i + 1].starts_with("+++ ") {
            let old = strip_diff_path(&lines[i][4..]);
            let new = strip_diff_path(&lines[i + 1][4..]);
            i += 2;
            let mut hunks = Vec::new();
            while i < lines.len() && lines[i].starts_with("@@") {
                let mut hunk = Hunk {
                    hint: parse_hunk_header(lines[i]),
                    ..Hunk::default()
                };
                i += 1;
                while i < lines.len() {
                    let l = lines[i];
                    if l.starts_with("@@")
                        || l.starts_with("diff ")
                        || (l.starts_with("--- ")
                            && i + 1 < lines.len()
                            && lines[i + 1].starts_with("+++ "))
                    {
                        break;
                    }
                    match l.chars().next() {
                        Some(c @ (' ' | '-' | '+')) => hunk.lines.push((c, l[1..].to_string())),
                        Some('\\') => {}
                        None => hunk.lines.push((' ', String::new())),
                        Some(_) => {
                            return Err(format!("line {}: unexpected line in hunk: {l:?}", i + 1))
                        }
                    }
                    i += 1;
                }
                hunks.push(hunk);
            }
            if old == "/dev/null" {
                let mut content = String::new();
                for hunk in &hunks {
                    for (c, text) in &hunk.lines {
                        if *c == '+' {
                            content.push_str(text);
                            content.push('\n');
                        }
                    }
                }
                ops.push(Op::Add { path: new, content });
            } else if new == "/dev/null" {
                ops.push(Op::Delete { path: old });
            } else {
                if hunks.is_empty() {
                    return Err(format!("diff for {new} has no hunks"));
                }
                ops.push(Op::Update {
                    move_to: (old != new).then(|| new.clone()),
                    path: old,
                    hunks,
                });
            }
        } else {
            i += 1;
        }
    }
    if ops.is_empty() {
        return Err(
            "no operations found. Use the '*** Begin Patch' format or a unified diff with '--- a/file' / '+++ b/file' headers"
                .into(),
        );
    }
    Ok(ops)
}

fn find_sequence(
    lines: &[String],
    needle: &[&str],
    from: usize,
    eq: impl Fn(&str, &str) -> bool,
) -> Option<usize> {
    if needle.len() > lines.len() {
        return None;
    }
    (from..=lines.len() - needle.len())
        .find(|&start| (0..needle.len()).all(|k| eq(&lines[start + k], needle[k])))
}

fn apply_hunks(path: &str, original: &str, hunks: &[Hunk]) -> Result<String, String> {
    let crlf = detect_crlf(original);
    let lf = to_lf(original);
    let ends_nl = lf.is_empty() || lf.ends_with('\n');
    let mut lines: Vec<String> = lf.split('\n').map(str::to_string).collect();
    if lf.ends_with('\n') || lf.is_empty() {
        lines.pop();
    }
    let mut cursor = 0usize;
    for (index, hunk) in hunks.iter().enumerate() {
        if let Some(header) = &hunk.header {
            if let Some(pos) = lines
                .iter()
                .enumerate()
                .skip(cursor)
                .find(|(_, l)| l.trim() == header.trim())
                .map(|(p, _)| p)
            {
                cursor = pos + 1;
            }
        }
        let old: Vec<&str> = hunk
            .lines
            .iter()
            .filter(|(c, _)| *c != '+')
            .map(|(_, t)| t.as_str())
            .collect();
        let new: Vec<String> = hunk
            .lines
            .iter()
            .filter(|(c, _)| *c != '-')
            .map(|(_, t)| t.clone())
            .collect();
        if old.is_empty() {
            let pos = if hunk.eof {
                lines.len()
            } else {
                hunk.hint.unwrap_or(lines.len()).min(lines.len())
            };
            let len = new.len();
            lines.splice(pos..pos, new);
            cursor = pos + len;
            continue;
        }
        let matchers: [fn(&str, &str) -> bool; 3] = [
            |a, b| a == b,
            |a, b| a.trim_end() == b.trim_end(),
            |a, b| a.trim() == b.trim(),
        ];
        let mut found = None;
        for eq in matchers {
            if hunk.eof && lines.len() >= old.len() {
                let start = lines.len() - old.len();
                if (0..old.len()).all(|k| eq(&lines[start + k], old[k])) {
                    found = Some(start);
                }
            }
            if found.is_none() {
                found = find_sequence(&lines, &old, cursor, eq);
            }
            if found.is_none() {
                found = find_sequence(&lines, &old, 0, eq);
            }
            if found.is_some() {
                break;
            }
        }
        let Some(pos) = found else {
            let preview: Vec<&str> = old.iter().take(4).copied().collect();
            return Err(format!(
                "hunk {} for {path} does not apply: could not find these lines in the file:\n{}\nRe-read the file and regenerate the patch.",
                index + 1,
                preview.join("\n")
            ));
        };
        let len = new.len();
        lines.splice(pos..pos + old.len(), new);
        cursor = pos + len;
    }
    let mut out = lines.join("\n");
    if ends_nl && !lines.is_empty() {
        out.push('\n');
    }
    Ok(from_lf(&out, crlf))
}

pub struct ApplyPatchTool;

#[derive(Deserialize)]
struct PatchArgs {
    patch: String,
}

#[async_trait]
impl Tool for ApplyPatchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "apply_patch".into(),
            description:
                "Apply a multi-file patch (add / update / delete / move files) atomically. \
Preferred format:\n\
*** Begin Patch\n\
*** Add File: path/new.txt\n\
+every line prefixed with +\n\
*** Update File: path/existing.rs\n\
*** Move to: path/renamed.rs   (optional)\n\
@@ optional line of context to locate the hunk (e.g. a function signature)\n\
 unchanged context line (leading space)\n\
-removed line\n\
+added line\n\
*** Delete File: path/old.txt\n\
*** End Patch\n\
Include ~3 lines of context around each change. Standard unified diffs (`--- a/f`, `+++ b/f`, \
`@@ -1,3 +1,4 @@`) are also accepted. If any hunk fails to apply nothing is written. \
Paths are relative to the working directory."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "patch": {"type": "string", "description": "The patch text."}
                },
                "required": ["patch"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        let patch = input["patch"].as_str().unwrap_or("");
        match parse_patch(patch) {
            Ok(ops) => {
                let names: Vec<String> = ops
                    .iter()
                    .map(|op| match op {
                        Op::Add { path, .. } | Op::Delete { path } | Op::Update { path, .. } => {
                            path.clone()
                        }
                    })
                    .collect();
                format!("Apply patch to {}", names.join(", "))
            }
            Err(_) => "Apply patch".into(),
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(apply_patch(ctx, input).await)
    }
}

async fn apply_patch(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: PatchArgs = parse_input(input)?;
    let ops = parse_patch(&args.patch)?;
    // Overlay of pending file states: Some(content) = write, None = delete.
    let mut overlay: HashMap<PathBuf, Option<String>> = HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    let mut summary = Vec::new();

    async fn current(
        overlay: &HashMap<PathBuf, Option<String>>,
        path: &PathBuf,
    ) -> Result<String, String> {
        match overlay.get(path) {
            Some(Some(content)) => Ok(content.clone()),
            Some(None) => Err(format!(
                "{} was deleted earlier in this patch",
                path.display()
            )),
            None => read_text_file(path).await,
        }
    }

    for op in &ops {
        match op {
            Op::Add { path, content } => {
                let full = ctx.resolve(path);
                let existed = matches!(overlay.get(&full), Some(Some(_))) || full.is_file();
                overlay.insert(full.clone(), Some(content.clone()));
                order.push(full.clone());
                summary.push(format!(
                    "{} {}",
                    if existed { "M" } else { "A" },
                    display_path(ctx, &full)
                ));
            }
            Op::Delete { path } => {
                let full = ctx.resolve(path);
                if !matches!(overlay.get(&full), Some(Some(_))) && !full.is_file() {
                    return Err(format!("cannot delete {path}: file does not exist"));
                }
                overlay.insert(full.clone(), None);
                order.push(full.clone());
                summary.push(format!("D {}", display_path(ctx, &full)));
            }
            Op::Update {
                path,
                move_to,
                hunks,
            } => {
                let full = ctx.resolve(path);
                let original = current(&overlay, &full).await?;
                let updated = apply_hunks(path, &original, hunks)?;
                match move_to {
                    Some(target) => {
                        let dest = ctx.resolve(target);
                        overlay.insert(full.clone(), None);
                        overlay.insert(dest.clone(), Some(updated));
                        order.push(full.clone());
                        order.push(dest.clone());
                        summary.push(format!(
                            "R {} -> {}",
                            display_path(ctx, &full),
                            display_path(ctx, &dest)
                        ));
                    }
                    None => {
                        overlay.insert(full.clone(), Some(updated));
                        order.push(full.clone());
                        summary.push(format!("M {}", display_path(ctx, &full)));
                    }
                }
            }
        }
    }

    let mut done = std::collections::HashSet::new();
    for path in order {
        if !done.insert(path.clone()) {
            continue;
        }
        ctx.checkpoint_before(&path)?;
        match overlay.get(&path) {
            Some(Some(content)) => {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
                }
                tokio::fs::write(&path, content.as_bytes())
                    .await
                    .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            }
            Some(None) if path.exists() => {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| format!("cannot delete {}: {e}", path.display()))?;
            }
            _ => {}
        }
    }
    Ok(ToolOutput::text(format!(
        "Patch applied:\n{}",
        summary.join("\n")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Block;
    use tempfile::tempdir;

    fn text(out: &ToolOutput) -> String {
        match &out.content[0] {
            Block::Text { text } => text.clone(),
            other => panic!("{other:?}"),
        }
    }

    async fn run(dir: &tempfile::TempDir, patch: &str) -> ToolOutput {
        ApplyPatchTool
            .call(&ToolContext::new(dir.path()), json!({"patch": patch}))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn add_update_delete_move() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        std::fs::write(dir.path().join("old.txt"), "x\ny\n").unwrap();
        let patch = "*** Begin Patch\n\
*** Add File: sub/new.txt\n\
+hello\n\
+world\n\
*** Update File: a.txt\n\
@@\n\
\x20one\n\
-two\n\
+TWO\n\
+two-b\n\
\x20three\n\
*** Delete File: gone.txt\n\
*** Update File: old.txt\n\
*** Move to: moved/new.txt\n\
@@\n\
-x\n\
+X\n\
\x20y\n\
*** End Patch";
        let out = run(&dir, patch).await;
        assert!(!out.is_error, "{}", text(&out));
        let read = |p: &str| std::fs::read_to_string(dir.path().join(p)).unwrap();
        assert_eq!(read("sub/new.txt"), "hello\nworld\n");
        assert_eq!(read("a.txt"), "one\nTWO\ntwo-b\nthree\n");
        assert!(!dir.path().join("gone.txt").exists());
        assert!(!dir.path().join("old.txt").exists());
        assert_eq!(read("moved/new.txt"), "X\ny\n");
    }

    #[tokio::test]
    async fn failure_is_atomic() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        let patch = "*** Begin Patch\n\
*** Add File: b.txt\n\
+new\n\
*** Update File: a.txt\n\
@@\n\
-nonexistent\n\
+x\n\
*** End Patch";
        let out = run(&dir, patch).await;
        assert!(out.is_error && text(&out).contains("does not apply"));
        assert!(!dir.path().join("b.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "one\n"
        );
    }

    #[tokio::test]
    async fn header_context_and_whitespace_fuzz() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("f.rs"),
            "fn a() {\n    let x = 1;\n}\nfn b() {\n    let x = 1;\n}\n",
        )
        .unwrap();
        let patch = "*** Begin Patch\n*** Update File: f.rs\n@@ fn b() {\n-    let x = 1;\n+    let x = 2;\n*** End Patch";
        let out = run(&dir, patch).await;
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "fn a() {\n    let x = 1;\n}\nfn b() {\n    let x = 2;\n}\n"
        );
    }

    #[tokio::test]
    async fn unified_diff_update_add_delete_and_crlf() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("u.txt"), "a\r\nb\r\nc\r\n").unwrap();
        std::fs::write(dir.path().join("d.txt"), "z\n").unwrap();
        let patch = "diff --git a/u.txt b/u.txt\n--- a/u.txt\n+++ b/u.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+n1\n+n2\n--- a/d.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n";
        let out = run(&dir, patch).await;
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("u.txt")).unwrap(),
            "a\r\nB\r\nc\r\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("n.txt")).unwrap(),
            "n1\nn2\n"
        );
        assert!(!dir.path().join("d.txt").exists());
    }

    #[tokio::test]
    async fn bad_patch_reports_error() {
        let dir = tempdir().unwrap();
        let out = run(&dir, "nonsense").await;
        assert!(out.is_error);
        let out = run(
            &dir,
            "*** Begin Patch\n*** Delete File: nope\n*** End Patch",
        )
        .await;
        assert!(out.is_error);
    }
}
