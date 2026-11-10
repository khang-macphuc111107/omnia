//! glob and grep (gitignore-aware, built on the `ignore` and `regex` crates).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use async_trait::async_trait;
use globset::{Glob, GlobBuilder, GlobMatcher};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};

use super::fs::looks_binary;
use super::{display_path, finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const GLOB_CAP: usize = 1000;
const GREP_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const GREP_DEFAULT_HEAD: usize = 250;
const GREP_LINE_CHARS: usize = 500;

fn build_matcher(pattern: &str) -> Result<GlobMatcher, String> {
    let pattern = pattern.replace('\\', "/");
    let pattern = if pattern.contains('/') {
        pattern.trim_start_matches("./").to_string()
    } else {
        format!("**/{pattern}")
    };
    let glob: Glob = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .build()
        .map_err(|error| format!("invalid glob `{pattern}`: {error}"))?;
    Ok(glob.compile_matcher())
}

fn walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    builder
}

fn rel_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------------------------------------------------------------- glob

pub struct GlobTool;

#[derive(Deserialize)]
struct GlobArgs {
    pattern: String,
    path: Option<String>,
}

#[async_trait]
impl Tool for GlobTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "glob".into(),
            description:
                "Find files by glob pattern (e.g. `**/*.rs`, `src/**/*.{ts,tsx}`, `*.md`). \
A pattern without `/` matches file names at any depth. Respects .gitignore and skips `.git`. \
Results are sorted by modification time (newest first) and capped at 1000. Paths are relative \
to the working directory."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern."},
                    "path": {"type": "string", "description": "Directory to search (default: working directory)."}
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Find files matching `{}`",
            input["pattern"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(glob(ctx, input).await)
    }
}

async fn glob(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: GlobArgs = parse_input(input)?;
    let root = ctx.resolve(args.path.as_deref().unwrap_or("."));
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let matcher = build_matcher(&args.pattern)?;
    let cancel = ctx.cancel.clone();
    let walk_root = root.clone();
    let mut found: Vec<(SystemTime, PathBuf)> = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        for entry in walker(&walk_root).build().flatten() {
            if cancel.is_cancelled() {
                break;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let rel = rel_slash(&walk_root, entry.path());
            if matcher.is_match(&rel) {
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                found.push((mtime, entry.into_path()));
            }
        }
        found
    })
    .await
    .map_err(|error| format!("glob failed: {error}"))?;
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = found.len();
    if total == 0 {
        return Ok(ToolOutput::text("No files matched."));
    }
    let mut out: Vec<String> = found
        .iter()
        .take(GLOB_CAP)
        .map(|(_, path)| display_path(ctx, path))
        .collect();
    if total > GLOB_CAP {
        out.push(format!(
            "[{} more files not shown; narrow the pattern]",
            total - GLOB_CAP
        ));
    }
    Ok(ToolOutput::text(out.join("\n")))
}

// ---------------------------------------------------------------------- grep

pub struct GrepTool;

#[derive(Deserialize)]
struct GrepArgs {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default)]
    output_mode: Option<String>,
    context: Option<usize>,
    head_limit: Option<usize>,
}

#[async_trait]
impl Tool for GrepTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "grep".into(),
            description: "Search file contents with a regular expression (Rust regex syntax, like \
ripgrep). Respects .gitignore, skips binary files. `output_mode`: `files_with_matches` (default; \
file paths), `content` (matching lines as `path:line:text`, with `context` lines before/after as \
`path-line-text`), or `count` (matches per file). Use `glob` (e.g. `*.rs`) to restrict files and \
`head_limit` to cap output entries (default 250)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression to search for."},
                    "path": {"type": "string", "description": "File or directory to search (default: working directory)."},
                    "glob": {"type": "string", "description": "Only search files matching this glob, e.g. `*.rs` or `src/**/*.ts`."},
                    "case_insensitive": {"type": "boolean", "description": "Ignore case (default false)."},
                    "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"], "description": "Result format (default files_with_matches)."},
                    "context": {"type": "integer", "minimum": 0, "description": "Lines of context around each match (content mode)."},
                    "head_limit": {"type": "integer", "minimum": 1, "description": "Maximum number of output entries (default 250)."}
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("Search for `{}`", input["pattern"].as_str().unwrap_or("?"))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(grep(ctx, input).await)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Content,
    Files,
    Count,
}

async fn grep(ctx: &ToolContext, input: Value) -> Result<ToolOutput, String> {
    let args: GrepArgs = parse_input(input)?;
    let mode = match args.output_mode.as_deref() {
        None | Some("files_with_matches") => Mode::Files,
        Some("content") => Mode::Content,
        Some("count") => Mode::Count,
        Some(other) => {
            return Err(format!(
                "unknown output_mode `{other}` (use content, files_with_matches or count)"
            ))
        }
    };
    let regex = RegexBuilder::new(&args.pattern)
        .case_insensitive(args.case_insensitive)
        .build()
        .map_err(|error| format!("invalid regex: {error}"))?;
    let target = ctx.resolve(args.path.as_deref().unwrap_or("."));
    if !target.exists() {
        return Err(format!("{} does not exist", target.display()));
    }
    let matcher = args.glob.as_deref().map(build_matcher).transpose()?;
    let context = args.context.unwrap_or(0);
    let head = args.head_limit.unwrap_or(GREP_DEFAULT_HEAD).max(1);
    let cancel = ctx.cancel.clone();
    let cwd = ctx.cwd.clone();

    let (entries, truncated) = tokio::task::spawn_blocking(move || {
        let (root, files): (PathBuf, Vec<PathBuf>) = if target.is_file() {
            (
                target.parent().map(Path::to_path_buf).unwrap_or_default(),
                vec![target.clone()],
            )
        } else {
            let mut builder = walker(&target);
            builder.sort_by_file_path(|a, b| a.cmp(b));
            let files = builder
                .build()
                .flatten()
                .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
                .map(|e| e.into_path())
                .collect();
            (target.clone(), files)
        };
        let mut entries: Vec<String> = Vec::new();
        let mut truncated = false;
        'files: for file in files {
            if cancel.is_cancelled() {
                break;
            }
            if let Some(m) = &matcher {
                if !m.is_match(rel_slash(&root, &file)) {
                    continue;
                }
            }
            let Ok(meta) = std::fs::metadata(&file) else {
                continue;
            };
            if meta.len() > GREP_MAX_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&file) else {
                continue;
            };
            if looks_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let hits: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, l)| regex.is_match(l))
                .map(|(i, _)| i)
                .collect();
            if hits.is_empty() {
                continue;
            }
            let shown = file
                .strip_prefix(&cwd)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            match mode {
                Mode::Files => entries.push(shown),
                Mode::Count => entries.push(format!("{shown}:{}", hits.len())),
                Mode::Content => {
                    let mut last_printed: Option<usize> = None;
                    for &hit in &hits {
                        let start = hit.saturating_sub(context);
                        let end = (hit + context).min(lines.len() - 1);
                        let start = match last_printed {
                            Some(last) => {
                                if start > last + 1 && context > 0 {
                                    entries.push("--".to_string());
                                }
                                start.max(last + 1)
                            }
                            None => start,
                        };
                        for (n, line) in lines.iter().enumerate().take(end + 1).skip(start) {
                            let sep = if n == hit || hits.binary_search(&n).is_ok() {
                                ':'
                            } else {
                                '-'
                            };
                            let line = super::truncate_chars(line, GREP_LINE_CHARS);
                            entries.push(format!("{shown}{sep}{}{sep}{line}", n + 1));
                            if entries.len() >= head {
                                truncated = true;
                                break 'files;
                            }
                        }
                        last_printed = Some(end);
                    }
                }
            }
            if entries.len() >= head {
                truncated = true;
                break;
            }
        }
        entries.truncate(head);
        (entries, truncated)
    })
    .await
    .map_err(|error| format!("grep failed: {error}"))?;

    if entries.is_empty() {
        return Ok(ToolOutput::text("No matches found."));
    }
    let mut out = entries.join("\n");
    if truncated {
        out.push_str(&format!(
            "\n[output limited to {head} entries; refine the pattern or raise head_limit]"
        ));
    }
    Ok(ToolOutput::text(out))
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

    fn fixture() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::create_dir_all(p.join("target")).unwrap();
        std::fs::write(p.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(
            p.join("src/main.rs"),
            "fn main() {\n    println!(\"Hello\");\n}\n",
        )
        .unwrap();
        std::fs::write(
            p.join("src/lib.rs"),
            "pub fn hello() {}\npub fn other() {}\n",
        )
        .unwrap();
        std::fs::write(p.join("target/out.rs"), "fn hello() {}\n").unwrap();
        std::fs::write(p.join("debug.log"), "hello log\n").unwrap();
        std::fs::write(p.join("notes.md"), "# hello\n").unwrap();
        std::fs::write(
            p.join("blob.bin"),
            [0u8, 1, 2, b'h', b'e', b'l', b'l', b'o'],
        )
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn glob_respects_gitignore() {
        let dir = fixture();
        let ctx = ToolContext::new(dir.path());
        let out = GlobTool
            .call(&ctx, json!({"pattern": "**/*.rs"}))
            .await
            .unwrap();
        let t = text(&out);
        assert!(t.contains("src/main.rs") && t.contains("src/lib.rs"));
        assert!(!t.contains("target"));
        let out = GlobTool
            .call(&ctx, json!({"pattern": "*.log"}))
            .await
            .unwrap();
        assert_eq!(text(&out), "No files matched.");
        let out = GlobTool
            .call(&ctx, json!({"pattern": "*.rs", "path": "src"}))
            .await
            .unwrap();
        assert!(text(&out).contains("src/lib.rs"));
    }

    #[tokio::test]
    async fn glob_sorted_by_mtime() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old.txt");
        std::fs::write(&old, "a").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - std::time::Duration::from_secs(3600))
            .unwrap();
        std::fs::write(dir.path().join("new.txt"), "b").unwrap();
        let out = GlobTool
            .call(&ToolContext::new(dir.path()), json!({"pattern": "*.txt"}))
            .await
            .unwrap();
        assert_eq!(text(&out), "new.txt\nold.txt");
    }

    #[tokio::test]
    async fn grep_modes() {
        let dir = fixture();
        let ctx = ToolContext::new(dir.path());
        let out = GrepTool
            .call(&ctx, json!({"pattern": "hello", "case_insensitive": true}))
            .await
            .unwrap();
        let t = text(&out);
        assert!(t.contains("src/main.rs") && t.contains("src/lib.rs") && t.contains("notes.md"));
        assert!(!t.contains("target") && !t.contains("debug.log") && !t.contains("blob.bin"));

        let out = GrepTool
            .call(&ctx, json!({"pattern": "hello", "output_mode": "count"}))
            .await
            .unwrap();
        assert_eq!(
            text(&out),
            "notes.md:1
src/lib.rs:1"
        );

        let out = GrepTool
            .call(
                &ctx,
                json!({"pattern": "println", "output_mode": "content", "context": 1, "glob": "*.rs"}),
            )
            .await
            .unwrap();
        assert_eq!(
            text(&out),
            "src/main.rs-1-fn main() {\nsrc/main.rs:2:    println!(\"Hello\");\nsrc/main.rs-3-}"
        );

        let out = GrepTool
            .call(&ctx, json!({"pattern": "nomatch_zzz"}))
            .await
            .unwrap();
        assert_eq!(text(&out), "No matches found.");
        let out = GrepTool.call(&ctx, json!({"pattern": "("})).await.unwrap();
        assert!(out.is_error);
    }

    #[tokio::test]
    async fn grep_head_limit_and_single_file() {
        let dir = fixture();
        let ctx = ToolContext::new(dir.path());
        let out = GrepTool
            .call(
                &ctx,
                json!({"pattern": "pub", "output_mode": "content", "head_limit": 1}),
            )
            .await
            .unwrap();
        assert!(text(&out).contains("src/lib.rs:1:pub fn hello"));
        assert!(text(&out).contains("limited to 1"));
        let out = GrepTool
            .call(
                &ctx,
                json!({"pattern": "other", "path": "src/lib.rs", "output_mode": "content"}),
            )
            .await
            .unwrap();
        assert_eq!(text(&out), "src/lib.rs:2:pub fn other() {}");
    }
}
