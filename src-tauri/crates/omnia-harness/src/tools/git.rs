//! git_status, git_diff, git_log, git_show, git_conflicts (read-only);
//! git_commit, git_branch, git_worktree, git_merge, git_rebase, git_resolve
//! (workspace writes); git_pull, git_push, gh_pr (network).
//!
//! `git` is spawned directly (no shell) with the session cwd. Hooks are never
//! bypassed and history is never rewritten unless `amend` is explicitly set.

use std::process::Stdio;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::{cancelled, finish, parse_input, short};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const MAX_OUTPUT_BYTES: usize = 100 * 1024;
const DEFAULT_LOG: usize = 20;
const MAX_LOG: usize = 200;

struct Captured {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// Runs `git <args>`. Outer error = cancellation; inner error = model-visible.
async fn git(
    ctx: &ToolContext,
    args: &[String],
    read_only: bool,
) -> HarnessResult<Result<Captured, String>> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
        "--no-pager",
    ])
    .args(args)
    .current_dir(&ctx.cwd)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_EDITOR", "true")
    .kill_on_drop(true);
    if read_only {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    exec(ctx, cmd, "git").await
}

/// Spawns a prepared command and captures its output (cancellable).
async fn exec(
    ctx: &ToolContext,
    mut cmd: Command,
    program: &str,
) -> HarnessResult<Result<Captured, String>> {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Err(format!("{program} was not found on PATH")))
        }
        Err(error) => return Ok(Err(format!("failed to run {program}: {error}"))),
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_end(&mut buf).await;
        }
        buf
    });
    let status = tokio::select! {
        status = child.wait() => status,
        _ = ctx.cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(cancelled());
        }
    };
    let status = match status {
        Ok(status) => status,
        Err(error) => return Ok(Err(format!("failed to wait for {program}: {error}"))),
    };
    let stdout = out_task.await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err_task.await.unwrap_or_default())
        .trim()
        .to_string();
    Ok(Ok(Captured {
        ok: status.success(),
        stdout,
        stderr,
    }))
}

/// Text output capped at ~100 KB on a char boundary, with a note.
fn capped(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX_OUTPUT_BYTES {
        return text.into_owned();
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[output truncated: showing first {} of {} bytes; narrow with `path` or a smaller range]",
        &text[..end],
        end,
        text.len()
    )
}

fn failure(captured: &Captured) -> String {
    let mut message = captured.stderr.clone();
    if message.is_empty() {
        message = String::from_utf8_lossy(&captured.stdout).trim().to_string();
    }
    if message.is_empty() {
        message = "git exited with a non-zero status".into();
    }
    message
}

/// Rejects values that git would parse as options.
fn check_plain(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("`{label}` is empty"));
    }
    if value.starts_with('-') {
        return Err(format!("`{label}` must not start with `-`"));
    }
    if value.contains('\0') || value.contains('\n') {
        return Err(format!("`{label}` contains invalid characters"));
    }
    Ok(())
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

macro_rules! run {
    ($ctx:expr, $args:expr, $ro:expr) => {
        match git($ctx, &$args, $ro).await? {
            Ok(captured) => captured,
            Err(message) => return Ok(ToolOutput::error(message)),
        }
    };
}

// ----------------------------------------------------------------- git_status

pub struct GitStatusTool;

#[async_trait]
impl Tool for GitStatusTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_status".into(),
            description: "Show the repository state as JSON: current branch, upstream, \
ahead/behind counts, staged and unstaged changes, untracked and conflicted files."
                .into(),
            input_schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, _input: &Value) -> String {
        "Show git status".into()
    }

    async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
        let args = strings(&[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ]);
        let captured = run!(ctx, args, true);
        if !captured.ok {
            return Ok(ToolOutput::error(failure(&captured)));
        }
        let summary = parse_status(&String::from_utf8_lossy(&captured.stdout));
        Ok(ToolOutput::text(
            serde_json::to_string_pretty(&summary).unwrap_or_default(),
        ))
    }
}

fn status_word(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'T' => "type_changed",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        _ => "unknown",
    }
}

fn parse_status(raw: &str) -> Value {
    let mut oid = Value::Null;
    let mut head = Value::Null;
    let mut upstream = Value::Null;
    let (mut ahead, mut behind) = (0_i64, 0_i64);
    let (mut staged, mut unstaged, mut untracked, mut conflicted) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut entries = raw.split('\0').filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(rest) = entry.strip_prefix("# ") {
            if let Some(value) = rest.strip_prefix("branch.oid ") {
                oid = json!(value);
            } else if let Some(value) = rest.strip_prefix("branch.head ") {
                head = json!(value);
            } else if let Some(value) = rest.strip_prefix("branch.upstream ") {
                upstream = json!(value);
            } else if let Some(value) = rest.strip_prefix("branch.ab ") {
                for part in value.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = entry.chars().next().unwrap_or(' ');
        match kind {
            '1' | '2' => {
                let fields: Vec<&str> = entry
                    .splitn(if kind == '1' { 9 } else { 10 }, ' ')
                    .collect();
                let (Some(xy), Some(path)) = (fields.get(1), fields.last()) else {
                    continue;
                };
                let mut codes = xy.chars();
                let (x, y) = (codes.next().unwrap_or('.'), codes.next().unwrap_or('.'));
                let original = if kind == '2' { entries.next() } else { None };
                let change = |code: char, bucket: &mut Vec<Value>| {
                    if code != '.' {
                        let mut item = json!({"path": path, "status": status_word(code)});
                        if let Some(original) = original {
                            item["from"] = json!(original);
                        }
                        bucket.push(item);
                    }
                };
                change(x, &mut staged);
                change(y, &mut unstaged);
            }
            'u' => {
                if let Some(path) = entry.splitn(11, ' ').last() {
                    conflicted.push(json!(path));
                }
            }
            '?' => untracked.push(json!(entry[1..].trim_start())),
            _ => {}
        }
    }
    let clean =
        staged.is_empty() && unstaged.is_empty() && untracked.is_empty() && conflicted.is_empty();
    json!({
        "branch": head,
        "oid": oid,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "clean": clean,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "conflicted": conflicted,
    })
}

// ------------------------------------------------------------------- git_diff

pub struct GitDiffTool;

#[derive(Deserialize)]
struct DiffArgs {
    #[serde(default)]
    staged: bool,
    path: Option<String>,
    /// Ref or range such as `HEAD~2`, `main..feature`, `main...HEAD`.
    #[serde(rename = "ref")]
    range: Option<String>,
    #[serde(default)]
    stat: bool,
}

#[async_trait]
impl Tool for GitDiffTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_diff".into(),
            description: "Show changes as a unified diff. Default: unstaged changes. `staged` \
shows the index against HEAD; `ref` compares against a commit or range (`HEAD~1`, \
`main..HEAD`); `path` limits the files; `stat` gives only a diffstat. Output is truncated at \
about 100 KB."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "staged": {"type": "boolean", "description": "Diff the index against HEAD."},
                    "path": {"type": "string", "description": "Limit the diff to this path."},
                    "ref": {"type": "string", "description": "Commit or range to diff, e.g. `HEAD~1` or `main..HEAD`."},
                    "stat": {"type": "boolean", "description": "Show only a diffstat."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!("Show git diff {}", input["ref"].as_str().unwrap_or(""))
            .trim()
            .to_string()
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(diff(ctx, input)).await
    }
}

async fn finish_async(
    future: impl std::future::Future<Output = HarnessResult<Result<ToolOutput, String>>>,
) -> HarnessResult<ToolOutput> {
    finish(future.await?)
}

async fn diff(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: DiffArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let mut argv = strings(&["diff", "--no-ext-diff"]);
    if args.staged {
        argv.push("--cached".into());
    }
    if args.stat {
        argv.push("--stat".into());
    }
    if let Some(range) = &args.range {
        if let Err(error) = check_plain("ref", range) {
            return Ok(Err(error));
        }
        argv.push(range.clone());
    }
    if let Some(path) = &args.path {
        if let Err(error) = check_plain("path", path) {
            return Ok(Err(error));
        }
        argv.push("--".into());
        argv.push(path.clone());
    }
    let captured = match git(ctx, &argv, true).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(failure(&captured)));
    }
    if captured.stdout.is_empty() {
        return Ok(Ok(ToolOutput::text("No differences.")));
    }
    Ok(Ok(ToolOutput::text(capped(&captured.stdout))))
}

// -------------------------------------------------------------------- git_log

pub struct GitLogTool;

#[derive(Deserialize)]
struct LogArgs {
    n: Option<usize>,
    path: Option<String>,
    #[serde(default)]
    oneline: bool,
    #[serde(rename = "ref")]
    range: Option<String>,
}

#[async_trait]
impl Tool for GitLogTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_log".into(),
            description: "Show commit history (default 20 commits, max 200). `oneline` gives \
`<short sha> <subject>` per commit; `path` limits to a file or directory; `ref` picks the \
branch, commit or range to start from."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Number of commits (default 20)."},
                    "path": {"type": "string", "description": "Only commits touching this path."},
                    "oneline": {"type": "boolean", "description": "Compact one line per commit."},
                    "ref": {"type": "string", "description": "Branch, commit or range to log."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, _input: &Value) -> String {
        "Show git log".into()
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(log(ctx, input)).await
    }
}

async fn log(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: LogArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let n = args.n.unwrap_or(DEFAULT_LOG).clamp(1, MAX_LOG);
    let mut argv = vec!["log".to_string(), format!("--max-count={n}")];
    argv.push(if args.oneline {
        "--oneline".into()
    } else {
        "--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n    %s%n%n%b%n".into()
    });
    if let Some(range) = &args.range {
        if let Err(error) = check_plain("ref", range) {
            return Ok(Err(error));
        }
        argv.push(range.clone());
    }
    if let Some(path) = &args.path {
        if let Err(error) = check_plain("path", path) {
            return Ok(Err(error));
        }
        argv.push("--".into());
        argv.push(path.clone());
    }
    let captured = match git(ctx, &argv, true).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(failure(&captured)));
    }
    if captured.stdout.is_empty() {
        return Ok(Ok(ToolOutput::text("No commits.")));
    }
    Ok(Ok(ToolOutput::text(capped(&captured.stdout))))
}

// ------------------------------------------------------------------- git_show

pub struct GitShowTool;

#[derive(Deserialize)]
struct ShowArgs {
    #[serde(rename = "ref")]
    target: Option<String>,
    path: Option<String>,
    #[serde(default)]
    stat: bool,
}

#[async_trait]
impl Tool for GitShowTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_show".into(),
            description: "Show a commit (message and diff), default HEAD. With `path`, limits \
the diff to that path. `stat` gives only a diffstat. Output is truncated at about 100 KB."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "ref": {"type": "string", "description": "Commit, tag or branch (default HEAD)."},
                    "path": {"type": "string", "description": "Limit the diff to this path."},
                    "stat": {"type": "boolean", "description": "Show only a diffstat."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Show git commit {}",
            input["ref"].as_str().unwrap_or("HEAD")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(show(ctx, input)).await
    }
}

async fn show(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: ShowArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let mut argv = strings(&["show", "--no-ext-diff"]);
    if args.stat {
        argv.push("--stat".into());
    }
    let target = args.target.unwrap_or_else(|| "HEAD".into());
    if let Err(error) = check_plain("ref", &target) {
        return Ok(Err(error));
    }
    argv.push(target);
    if let Some(path) = &args.path {
        if let Err(error) = check_plain("path", path) {
            return Ok(Err(error));
        }
        argv.push("--".into());
        argv.push(path.clone());
    }
    let captured = match git(ctx, &argv, true).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(failure(&captured)));
    }
    Ok(Ok(ToolOutput::text(capped(&captured.stdout))))
}

// ----------------------------------------------------------------- git_commit

pub struct GitCommitTool;

#[derive(Deserialize)]
struct CommitArgs {
    message: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    all: bool,
    #[serde(default)]
    amend: bool,
}

#[async_trait]
impl Tool for GitCommitTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_commit".into(),
            description: "Create a commit. `paths` stages and commits just those files; `all` \
stages every change (including untracked files) first; with neither, commits what is already \
staged. Repository hooks always run. History is never rewritten unless `amend` is true."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Commit message."},
                    "paths": {"type": "array", "items": {"type": "string"}, "description": "Files to stage and commit."},
                    "all": {"type": "boolean", "description": "Stage all changes (git add -A) before committing."},
                    "amend": {"type": "boolean", "description": "Amend the previous commit. Only set when explicitly requested."}
                },
                "required": ["message"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        let amend = if input["amend"].as_bool().unwrap_or(false) {
            " (amend)"
        } else {
            ""
        };
        format!(
            "Commit{amend}: {}",
            short(input["message"].as_str().unwrap_or(""))
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(commit(ctx, input)).await
    }
}

async fn commit(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: CommitArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    if args.message.trim().is_empty() {
        return Ok(Err("`message` is empty".into()));
    }
    if args.all && !args.paths.is_empty() {
        return Ok(Err("use either `all` or `paths`, not both".into()));
    }
    for path in &args.paths {
        if let Err(error) = check_plain("paths", path) {
            return Ok(Err(error));
        }
    }
    if args.all {
        let captured = match git(ctx, &strings(&["add", "-A"]), false).await? {
            Ok(captured) => captured,
            Err(error) => return Ok(Err(error)),
        };
        if !captured.ok {
            return Ok(Err(failure(&captured)));
        }
    } else if !args.paths.is_empty() {
        let mut add = strings(&["add", "--"]);
        add.extend(args.paths.iter().cloned());
        let captured = match git(ctx, &add, false).await? {
            Ok(captured) => captured,
            Err(error) => return Ok(Err(error)),
        };
        if !captured.ok {
            return Ok(Err(failure(&captured)));
        }
    }
    let mut argv = strings(&["commit"]);
    if args.amend {
        argv.push("--amend".into());
    }
    argv.push("-m".into());
    argv.push(args.message.clone());
    if !args.paths.is_empty() {
        argv.push("--".into());
        argv.extend(args.paths.iter().cloned());
    }
    let captured = match git(ctx, &argv, false).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        let mut message = failure(&captured);
        let stdout = String::from_utf8_lossy(&captured.stdout);
        if !captured.stderr.is_empty() && !stdout.trim().is_empty() {
            message = format!("{}\n{}", stdout.trim(), message);
        }
        return Ok(Err(message));
    }
    let mut text = capped(&captured.stdout).trim().to_string();
    if let Ok(Ok(head)) = git(ctx, &strings(&["rev-parse", "--short", "HEAD"]), true).await {
        if head.ok {
            text.push_str(&format!(
                "\nHEAD is now {}",
                String::from_utf8_lossy(&head.stdout).trim()
            ));
        }
    }
    Ok(Ok(ToolOutput::text(text)))
}

// ----------------------------------------------------------------- git_branch

pub struct GitBranchTool;

#[derive(Deserialize)]
struct BranchArgs {
    action: String,
    name: String,
    start_point: Option<String>,
}

#[async_trait]
impl Tool for GitBranchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_branch".into(),
            description: "Create (and switch to) a new branch, or switch to an existing one. \
Uncommitted changes that conflict with the target make the switch fail rather than being \
discarded."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "switch"], "description": "`create` makes and switches to a new branch; `switch` moves to an existing one."},
                    "name": {"type": "string", "description": "Branch name."},
                    "start_point": {"type": "string", "description": "For `create`: commit or branch to start from (default HEAD)."}
                },
                "required": ["action", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "git branch {} {}",
            input["action"].as_str().unwrap_or("?"),
            input["name"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(branch(ctx, input)).await
    }
}

async fn branch(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: BranchArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    if let Err(error) = check_plain("name", &args.name) {
        return Ok(Err(error));
    }
    let mut argv = strings(&["switch"]);
    match args.action.as_str() {
        "create" => {
            argv.push("-c".into());
            argv.push(args.name.clone());
            if let Some(start) = &args.start_point {
                if let Err(error) = check_plain("start_point", start) {
                    return Ok(Err(error));
                }
                argv.push(start.clone());
            }
        }
        "switch" => argv.push(args.name.clone()),
        other => {
            return Ok(Err(format!(
                "unknown action `{other}` (use create or switch)"
            )))
        }
    }
    let captured = match git(ctx, &argv, false).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(failure(&captured)));
    }
    let verb = if args.action == "create" {
        "Created and switched to"
    } else {
        "Switched to"
    };
    Ok(Ok(ToolOutput::text(format!(
        "{verb} branch `{}`.",
        args.name
    ))))
}

// ------------------------------------------------- shared helpers (collab tools)

/// stdout and stderr joined, for commands (merge, push, ...) that report on both.
fn combined(captured: &Captured) -> String {
    let stdout = String::from_utf8_lossy(&captured.stdout);
    let mut parts: Vec<&str> = Vec::new();
    if !stdout.trim().is_empty() {
        parts.push(stdout.trim());
    }
    if !captured.stderr.is_empty() {
        parts.push(captured.stderr.as_str());
    }
    let text = parts.join("\n");
    if text.is_empty() {
        "Done.".into()
    } else {
        capped(text.as_bytes())
    }
}

/// Failure text including stdout (merge/rebase print `CONFLICT` lines there).
fn failure_with_stdout(captured: &Captured) -> String {
    let stdout = String::from_utf8_lossy(&captured.stdout);
    if stdout.trim().is_empty() || captured.stderr.is_empty() {
        return failure(captured);
    }
    format!("{}\n{}", stdout.trim(), captured.stderr)
}

/// Runs `git <argv>`; Ok(text) on success, Err(message) otherwise.
async fn run_text(
    ctx: &ToolContext,
    argv: &[String],
    with_stdout_on_failure: bool,
) -> HarnessResult<Result<String, String>> {
    let captured = match git(ctx, argv, false).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(if with_stdout_on_failure {
            failure_with_stdout(&captured)
        } else {
            failure(&captured)
        }));
    }
    Ok(Ok(combined(&captured)))
}

fn text_result(result: Result<String, String>) -> Result<ToolOutput, String> {
    result.map(ToolOutput::text)
}

fn conflict_hint(message: String) -> String {
    if message.contains("CONFLICT") || message.contains("Automatic merge failed") {
        format!(
            "{message}\n\nThe operation stopped on conflicts. Use git_conflicts to list them, \
git_resolve to resolve each file, then finish with git_commit (merge) or git_rebase continue."
        )
    } else {
        message
    }
}

// --------------------------------------------------------------- git_worktree

pub struct GitWorktreeTool;

#[derive(Deserialize)]
struct WorktreeArgs {
    action: String,
    path: Option<String>,
    branch: Option<String>,
    base: Option<String>,
}

#[async_trait]
impl Tool for GitWorktreeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_worktree".into(),
            description: "Manage linked worktrees. `add` checks out a branch in a new directory \
(`branch` is created from `base` (default HEAD) when it does not exist yet, otherwise checked \
out as is; without `branch` git picks one from the directory name); `list` shows all \
worktrees; `remove` deletes a clean worktree (never forced); `prune` clears stale worktree \
records. `path` is relative to the session cwd."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "list", "remove", "prune"]},
                    "path": {"type": "string", "description": "Worktree directory (required for add and remove)."},
                    "branch": {"type": "string", "description": "For add: branch to create or check out."},
                    "base": {"type": "string", "description": "For add: start point for a new branch (default HEAD)."}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "git worktree {} {}",
            input["action"].as_str().unwrap_or("?"),
            input["path"].as_str().unwrap_or("")
        )
        .trim()
        .to_string()
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(worktree(ctx, input)).await
    }
}

async fn worktree(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: WorktreeArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let need_path = |args: &WorktreeArgs| -> Result<String, String> {
        let path = args
            .path
            .clone()
            .ok_or_else(|| format!("`path` is required for {}", args.action))?;
        check_plain("path", &path)?;
        Ok(path)
    };
    match args.action.as_str() {
        "list" => {
            let argv = strings(&["worktree", "list", "--porcelain"]);
            let captured = match git(ctx, &argv, true).await? {
                Ok(captured) => captured,
                Err(error) => return Ok(Err(error)),
            };
            if !captured.ok {
                return Ok(Err(failure(&captured)));
            }
            Ok(Ok(ToolOutput::text(capped(&captured.stdout))))
        }
        "prune" => Ok(text_result(
            run_text(ctx, &strings(&["worktree", "prune", "--verbose"]), false).await?,
        )),
        "remove" => {
            let path = match need_path(&args) {
                Ok(path) => path,
                Err(error) => return Ok(Err(error)),
            };
            let argv = vec![
                "worktree".to_string(),
                "remove".into(),
                "--".into(),
                path.clone(),
            ];
            let result = run_text(ctx, &argv, false).await?;
            Ok(result.map(|_| ToolOutput::text(format!("Removed worktree `{path}`."))))
        }
        "add" => {
            let path = match need_path(&args) {
                Ok(path) => path,
                Err(error) => return Ok(Err(error)),
            };
            for (label, value) in [("branch", &args.branch), ("base", &args.base)] {
                if let Some(value) = value {
                    if let Err(error) = check_plain(label, value) {
                        return Ok(Err(error));
                    }
                }
            }
            let mut argv = strings(&["worktree", "add"]);
            match &args.branch {
                Some(branch) => {
                    let probe = vec![
                        "rev-parse".to_string(),
                        "--verify".into(),
                        "--quiet".into(),
                        format!("refs/heads/{branch}"),
                    ];
                    let exists = match git(ctx, &probe, true).await? {
                        Ok(captured) => captured.ok,
                        Err(error) => return Ok(Err(error)),
                    };
                    if exists {
                        if args.base.is_some() {
                            return Ok(Err(format!(
                                "branch `{branch}` already exists; omit `base` to check it out"
                            )));
                        }
                        argv.extend(["--".to_string(), path.clone(), branch.clone()]);
                    } else {
                        argv.extend(["-b".to_string(), branch.clone(), "--".into(), path.clone()]);
                        if let Some(base) = &args.base {
                            argv.push(base.clone());
                        }
                    }
                }
                None => {
                    argv.extend(["--".to_string(), path.clone()]);
                    if let Some(base) = &args.base {
                        argv.push(base.clone());
                    }
                }
            }
            let result = run_text(ctx, &argv, false).await?;
            Ok(result.map(|text| ToolOutput::text(format!("Added worktree `{path}`.\n{text}"))))
        }
        other => Ok(Err(format!(
            "unknown action `{other}` (use add, list, remove or prune)"
        ))),
    }
}

// ------------------------------------------------------------------ git_merge

pub struct GitMergeTool;

#[derive(Deserialize)]
struct MergeArgs {
    branch: Option<String>,
    #[serde(default)]
    no_ff: bool,
    #[serde(default)]
    abort: bool,
}

#[async_trait]
impl Tool for GitMergeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_merge".into(),
            description: "Merge a branch into the current branch (non-interactive, default \
message). `no_ff` always creates a merge commit. On conflicts the merge stays in progress: \
use git_conflicts and git_resolve, then git_commit; or set `abort` to cancel the merge \
(`branch` is not needed then)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "branch": {"type": "string", "description": "Branch or commit to merge in."},
                    "no_ff": {"type": "boolean", "description": "Create a merge commit even when fast-forward is possible."},
                    "abort": {"type": "boolean", "description": "Abort the merge in progress instead."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        if input["abort"].as_bool().unwrap_or(false) {
            "git merge --abort".into()
        } else {
            format!("git merge {}", input["branch"].as_str().unwrap_or("?"))
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(merge(ctx, input)).await
    }
}

async fn merge(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: MergeArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    if args.abort {
        let result = run_text(ctx, &strings(&["merge", "--abort"]), false).await?;
        return Ok(result.map(|_| ToolOutput::text("Merge aborted.")));
    }
    let Some(branch) = args.branch else {
        return Ok(Err("`branch` is required unless `abort` is set".into()));
    };
    if let Err(error) = check_plain("branch", &branch) {
        return Ok(Err(error));
    }
    let mut argv = strings(&["merge", "--no-edit"]);
    if args.no_ff {
        argv.push("--no-ff".into());
    }
    argv.push(branch);
    let result = run_text(ctx, &argv, true).await?;
    Ok(text_result(result.map_err(conflict_hint)))
}

// ----------------------------------------------------------------- git_rebase

pub struct GitRebaseTool;

#[derive(Deserialize)]
struct RebaseArgs {
    onto: Option<String>,
    #[serde(default)]
    abort: bool,
    #[serde(rename = "continue", default)]
    resume: bool,
}

#[async_trait]
impl Tool for GitRebaseTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_rebase".into(),
            description: "Rebase the current branch onto another branch or commit \
(non-interactive only; rewrites local history, so avoid on published branches). On conflicts \
the rebase stays in progress: resolve with git_conflicts/git_resolve and set `continue`, or \
set `abort` to restore the original branch. Note that during a rebase `ours` is the branch \
being rebased onto and `theirs` is your commit being replayed."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "onto": {"type": "string", "description": "Branch or commit to rebase onto (required unless abort/continue)."},
                    "abort": {"type": "boolean", "description": "Abort the rebase in progress."},
                    "continue": {"type": "boolean", "description": "Continue after resolving conflicts (all must be staged)."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        if input["abort"].as_bool().unwrap_or(false) {
            "git rebase --abort".into()
        } else if input["continue"].as_bool().unwrap_or(false) {
            "git rebase --continue".into()
        } else {
            format!("git rebase onto {}", input["onto"].as_str().unwrap_or("?"))
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(rebase(ctx, input)).await
    }
}

async fn rebase(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: RebaseArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    if args.abort && args.resume {
        return Ok(Err("use either `abort` or `continue`, not both".into()));
    }
    if args.abort {
        let result = run_text(ctx, &strings(&["rebase", "--abort"]), false).await?;
        return Ok(result.map(|_| ToolOutput::text("Rebase aborted.")));
    }
    if args.resume {
        let argv = strings(&["-c", "core.editor=true", "rebase", "--continue"]);
        let result = run_text(ctx, &argv, true).await?;
        return Ok(text_result(result.map_err(conflict_hint)));
    }
    let Some(onto) = args.onto else {
        return Ok(Err(
            "`onto` is required unless `abort` or `continue` is set".into(),
        ));
    };
    if let Err(error) = check_plain("onto", &onto) {
        return Ok(Err(error));
    }
    let argv = vec!["rebase".to_string(), onto];
    let result = run_text(ctx, &argv, true).await?;
    Ok(text_result(result.map_err(conflict_hint)))
}

// ------------------------------------------------------------------- git_pull

pub struct GitPullTool;

#[derive(Deserialize)]
struct PullArgs {
    remote: Option<String>,
    branch: Option<String>,
    #[serde(default)]
    rebase: bool,
}

#[async_trait]
impl Tool for GitPullTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_pull".into(),
            description: "Fetch from a remote and integrate into the current branch (merge by \
default, `rebase` to rebase instead). Defaults to the branch's upstream; `branch` requires \
`remote`. Conflicts leave the merge/rebase in progress (see git_conflicts)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "remote": {"type": "string", "description": "Remote name (default: the branch's upstream remote)."},
                    "branch": {"type": "string", "description": "Remote branch to pull (requires `remote`)."},
                    "rebase": {"type": "boolean", "description": "Rebase local commits onto the fetched ones instead of merging."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "git pull{} from {} {}",
            if input["rebase"].as_bool().unwrap_or(false) {
                " --rebase"
            } else {
                ""
            },
            input["remote"].as_str().unwrap_or("upstream"),
            input["branch"].as_str().unwrap_or("")
        )
        .trim()
        .to_string()
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(pull(ctx, input)).await
    }
}

async fn pull(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: PullArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let mut argv = strings(&["pull", "--no-edit"]);
    argv.push(
        if args.rebase {
            "--rebase"
        } else {
            "--no-rebase"
        }
        .into(),
    );
    if args.branch.is_some() && args.remote.is_none() {
        return Ok(Err("`branch` requires `remote`".into()));
    }
    for (label, value) in [("remote", &args.remote), ("branch", &args.branch)] {
        if let Some(value) = value {
            if let Err(error) = check_plain(label, value) {
                return Ok(Err(error));
            }
            argv.push(value.clone());
        }
    }
    let result = run_text(ctx, &argv, true).await?;
    Ok(text_result(result.map_err(conflict_hint)))
}

// ------------------------------------------------------------------- git_push

pub struct GitPushTool;

#[derive(Deserialize)]
struct PushArgs {
    remote: Option<String>,
    branch: Option<String>,
    #[serde(default)]
    set_upstream: bool,
    #[serde(default)]
    force_with_lease: bool,
}

#[async_trait]
impl Tool for GitPushTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_push".into(),
            description: "Publish commits to a remote repository (outward-facing: other people \
can see them). Defaults to the current branch and its upstream; `branch` without `remote` \
pushes to `origin`. `set_upstream` records the tracking branch; `force_with_lease` overwrites \
the remote branch only if nobody else has pushed to it since your last fetch. Plain --force \
and refspecs (`+x`, `a:b`, deletions) are not supported."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "remote": {"type": "string", "description": "Remote name (default: upstream remote, else origin)."},
                    "branch": {"type": "string", "description": "Branch to push (default: current branch)."},
                    "set_upstream": {"type": "boolean", "description": "Set the pushed branch's upstream (git push -u)."},
                    "force_with_lease": {"type": "boolean", "description": "Use --force-with-lease (safe force). Only when explicitly requested."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        // The most outward-facing class available: the call leaves the machine.
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        let remote = input["remote"].as_str().unwrap_or("the upstream remote");
        let branch = input["branch"].as_str().unwrap_or("the current branch");
        let lease = if input["force_with_lease"].as_bool().unwrap_or(false) {
            " (force-with-lease)"
        } else {
            ""
        };
        format!("Push {branch} to remote {remote}{lease}")
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(push(ctx, input)).await
    }
}

async fn push(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: PushArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let mut argv = strings(&["push"]);
    if args.set_upstream {
        argv.push("--set-upstream".into());
    }
    if args.force_with_lease {
        argv.push("--force-with-lease".into());
    }
    let remote = match (&args.remote, &args.branch) {
        (Some(remote), _) => Some(remote.clone()),
        (None, Some(_)) => Some("origin".to_string()),
        (None, None) => None,
    };
    if let Some(remote) = &remote {
        if let Err(error) = check_plain("remote", remote) {
            return Ok(Err(error));
        }
        argv.push(remote.clone());
    }
    if let Some(branch) = &args.branch {
        if let Err(error) = check_plain("branch", branch) {
            return Ok(Err(error));
        }
        if branch.starts_with('+') || branch.contains(':') {
            return Ok(Err(
                "`branch` must be a plain branch name (no `+` force prefix, no `src:dst` refspec)"
                    .into(),
            ));
        }
        argv.push(branch.clone());
    }
    let result = run_text(ctx, &argv, false).await?;
    Ok(result.map(|text| {
        ToolOutput::text(format!(
            "Pushed {} to {}.\n{text}",
            args.branch.as_deref().unwrap_or("current branch"),
            remote.as_deref().unwrap_or("upstream")
        ))
    }))
}

// -------------------------------------------------------------- git_conflicts

pub struct GitConflictsTool;

#[derive(Clone, Copy)]
enum Part {
    Ours,
    Base,
    Theirs,
}

#[derive(Default)]
struct OpenHunk<'a> {
    start: usize,
    ours_label: String,
    base_label: String,
    ours: Vec<&'a str>,
    base: Vec<&'a str>,
    theirs: Vec<&'a str>,
}

fn marker_label<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(marker)?;
    (rest.is_empty() || rest.starts_with(' ')).then_some(rest.trim())
}

/// Parses conflict markers (merge and diff3 styles) into hunks.
fn parse_conflict_hunks(text: &str) -> Vec<Value> {
    let mut hunks = Vec::new();
    let mut open: Option<(Part, OpenHunk)> = None;
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        let Some((part, hunk)) = open.as_mut() else {
            if let Some(label) = marker_label(line, "<<<<<<<") {
                open = Some((
                    Part::Ours,
                    OpenHunk {
                        start: number,
                        ours_label: label.to_string(),
                        ..OpenHunk::default()
                    },
                ));
            }
            continue;
        };
        if matches!(part, Part::Ours) {
            if let Some(label) = marker_label(line, "|||||||") {
                *part = Part::Base;
                hunk.base_label = label.to_string();
                continue;
            }
        }
        if line == "=======" && !matches!(part, Part::Theirs) {
            *part = Part::Theirs;
            continue;
        }
        if matches!(part, Part::Theirs) {
            if let Some(label) = marker_label(line, ">>>>>>>") {
                let mut out = json!({
                    "start_line": hunk.start,
                    "end_line": number,
                    "ours_label": hunk.ours_label,
                    "theirs_label": label,
                    "ours": hunk.ours.join("\n"),
                    "theirs": hunk.theirs.join("\n"),
                });
                if !hunk.base_label.is_empty() || !hunk.base.is_empty() {
                    out["base_label"] = json!(hunk.base_label);
                    out["base"] = json!(hunk.base.join("\n"));
                }
                hunks.push(out);
                open = None;
                continue;
            }
        }
        match part {
            Part::Ours => hunk.ours.push(line),
            Part::Base => hunk.base.push(line),
            Part::Theirs => hunk.theirs.push(line),
        }
    }
    hunks
}

#[async_trait]
impl Tool for GitConflictsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_conflicts".into(),
            description: "List files with unresolved merge/rebase conflicts as JSON, each with \
its conflict hunks (line range, `ours`/`theirs` text and labels, plus `base` when the repo \
uses diff3 conflict style). Resolve each file with git_resolve."
                .into(),
            input_schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, _input: &Value) -> String {
        "List git merge conflicts".into()
    }

    async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
        finish_async(conflicts(ctx)).await
    }
}

async fn conflicts(ctx: &ToolContext) -> HarnessResult<Result<ToolOutput, String>> {
    let argv = strings(&["diff", "--name-only", "--diff-filter=U", "--relative", "-z"]);
    let captured = match git(ctx, &argv, true).await? {
        Ok(captured) => captured,
        Err(error) => return Ok(Err(error)),
    };
    if !captured.ok {
        return Ok(Err(failure(&captured)));
    }
    let listing = String::from_utf8_lossy(&captured.stdout).into_owned();
    let mut files = Vec::new();
    for path in listing.split('\0').filter(|path| !path.is_empty()) {
        match std::fs::read(ctx.cwd.join(path)) {
            Ok(bytes) => {
                let hunks = parse_conflict_hunks(&String::from_utf8_lossy(&bytes));
                let mut entry = json!({"path": path, "hunks": hunks});
                if entry["hunks"].as_array().is_some_and(|h| h.is_empty()) {
                    entry["note"] = json!(
                        "no conflict markers found (binary file or modify/delete conflict); \
resolve with strategy ours or theirs"
                    );
                }
                files.push(entry);
            }
            Err(_) => files.push(json!({
                "path": path,
                "hunks": [],
                "note": "file is missing in the working tree (delete conflict); resolve with strategy ours or theirs"
            })),
        }
    }
    let summary = json!({"count": files.len(), "files": files});
    Ok(Ok(ToolOutput::text(capped(
        serde_json::to_string_pretty(&summary)
            .unwrap_or_default()
            .as_bytes(),
    ))))
}

// ----------------------------------------------------------------- git_resolve

pub struct GitResolveTool;

#[derive(Deserialize)]
struct ResolveArgs {
    path: String,
    strategy: String,
    content: Option<String>,
}

#[async_trait]
impl Tool for GitResolveTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_resolve".into(),
            description: "Resolve one conflicted file and stage it (git add). `ours` / `theirs` \
take that side of the whole file (during a rebase the sides are swapped: `ours` is the \
upstream you rebase onto); `content` replaces the file with the supplied text (merge the \
hunks yourself). Afterwards finish with git_commit (merge) or git_rebase continue."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Conflicted file, relative to the session cwd."},
                    "strategy": {"type": "string", "enum": ["ours", "theirs", "content"]},
                    "content": {"type": "string", "description": "Full resolved file text (required for strategy `content`, must not contain conflict markers)."}
                },
                "required": ["path", "strategy"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Resolve conflict in {} using {}",
            input["path"].as_str().unwrap_or("?"),
            input["strategy"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(resolve(ctx, input)).await
    }
}

async fn resolve(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    use std::path::Component;
    let args: ResolveArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    if let Err(error) = check_plain("path", &args.path) {
        return Ok(Err(error));
    }
    match args.strategy.as_str() {
        "ours" | "theirs" => {
            if args.content.is_some() {
                return Ok(Err("`content` is only used with strategy `content`".into()));
            }
            let argv = vec![
                "checkout".to_string(),
                format!("--{}", args.strategy),
                "--".into(),
                args.path.clone(),
            ];
            if let Err(error) = run_text(ctx, &argv, false).await? {
                return Ok(Err(error));
            }
        }
        "content" => {
            let Some(content) = &args.content else {
                return Ok(Err("`content` is required for strategy `content`".into()));
            };
            if content.lines().any(|line| {
                line.starts_with("<<<<<<< ") || line.starts_with(">>>>>>> ") || line == "======="
            }) {
                return Ok(Err("`content` still contains conflict markers".into()));
            }
            let relative = std::path::Path::new(&args.path);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
            {
                return Ok(Err(
                    "`path` must be relative and stay inside the session cwd".into(),
                ));
            }
            let full = ctx.cwd.join(relative);
            if let Err(error) = ctx.checkpoint_before(&full) {
                return Ok(Err(error));
            }
            if let Err(error) = std::fs::write(&full, content) {
                return Ok(Err(format!("cannot write {}: {error}", args.path)));
            }
        }
        other => {
            return Ok(Err(format!(
                "unknown strategy `{other}` (use ours, theirs or content)"
            )))
        }
    }
    let add = vec!["add".to_string(), "--".into(), args.path.clone()];
    if let Err(error) = run_text(ctx, &add, false).await? {
        return Ok(Err(error));
    }
    Ok(Ok(ToolOutput::text(format!(
        "Resolved `{}` ({}) and staged it.",
        args.path, args.strategy
    ))))
}

// ---------------------------------------------------------------------- gh_pr

pub struct GhPrTool;

#[derive(Deserialize)]
struct GhPrArgs {
    action: String,
    title: Option<String>,
    body: Option<String>,
    base: Option<String>,
    head: Option<String>,
    #[serde(default)]
    draft: bool,
    /// PR number; omitted means the PR of the current branch.
    number: Option<u64>,
    state: Option<String>,
    limit: Option<u32>,
}

#[async_trait]
impl Tool for GhPrTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "gh_pr".into(),
            description: "Work with GitHub pull requests through the `gh` CLI (must be \
installed and already logged in by the user). `create` (needs `title` and `body`; optional \
`base`, `head`, `draft`), `view` (JSON; `number` or the current branch's PR), `list` (`state` \
open|closed|merged|all, `limit`), `checks` (CI status), `comment` (needs `body`; `number` or \
the current branch's PR)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "view", "list", "checks", "comment"]},
                    "title": {"type": "string", "description": "create: PR title."},
                    "body": {"type": "string", "description": "create/comment: markdown body."},
                    "base": {"type": "string", "description": "create: target branch."},
                    "head": {"type": "string", "description": "create: source branch (default current)."},
                    "draft": {"type": "boolean", "description": "create: open as draft."},
                    "number": {"type": "integer", "minimum": 1, "description": "view/checks/comment: PR number (default: current branch's PR)."},
                    "state": {"type": "string", "enum": ["open", "closed", "merged", "all"], "description": "list: state filter (default open)."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "list: max PRs (default 30)."}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        let number = input["number"]
            .as_u64()
            .map(|n| format!(" #{n}"))
            .unwrap_or_default();
        match input["action"].as_str().unwrap_or("?") {
            "create" => format!(
                "Create GitHub PR: {}",
                short(input["title"].as_str().unwrap_or(""))
            ),
            "comment" => format!("Comment on GitHub PR{number}"),
            other => format!("gh pr {other}{number}"),
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish_async(gh_pr(ctx, input)).await
    }
}

const PR_VIEW_FIELDS: &str =
    "number,title,state,isDraft,url,headRefName,baseRefName,author,mergeable,reviewDecision,body";
const PR_LIST_FIELDS: &str = "number,title,state,isDraft,url,headRefName,author";

/// Builds the `gh` argv for a request (pure; unit tested).
fn gh_pr_argv(args: &GhPrArgs) -> Result<Vec<String>, String> {
    let mut argv = strings(&["pr"]);
    let need = |label: &str, value: &Option<String>| -> Result<String, String> {
        match value {
            Some(v) if !v.trim().is_empty() => Ok(v.clone()),
            _ => Err(format!("`{label}` is required for {}", args.action)),
        }
    };
    match args.action.as_str() {
        "create" => {
            argv.push("create".into());
            argv.extend(["--title".into(), need("title", &args.title)?]);
            argv.extend(["--body".into(), need("body", &args.body)?]);
            for (flag, label, value) in [
                ("--base", "base", &args.base),
                ("--head", "head", &args.head),
            ] {
                if let Some(value) = value {
                    check_plain(label, value)?;
                    argv.extend([flag.to_string(), value.clone()]);
                }
            }
            if args.draft {
                argv.push("--draft".into());
            }
        }
        "view" => {
            argv.push("view".into());
            if let Some(number) = args.number {
                argv.push(number.to_string());
            }
            argv.extend(["--json".into(), PR_VIEW_FIELDS.into()]);
        }
        "list" => {
            argv.push("list".into());
            let state = args.state.as_deref().unwrap_or("open");
            if !["open", "closed", "merged", "all"].contains(&state) {
                return Err(format!(
                    "unknown state `{state}` (use open, closed, merged or all)"
                ));
            }
            argv.extend(["--state".into(), state.into()]);
            argv.extend([
                "--limit".into(),
                args.limit.unwrap_or(30).clamp(1, 100).to_string(),
            ]);
            argv.extend(["--json".into(), PR_LIST_FIELDS.into()]);
        }
        "checks" => {
            argv.push("checks".into());
            if let Some(number) = args.number {
                argv.push(number.to_string());
            }
        }
        "comment" => {
            argv.push("comment".into());
            if let Some(number) = args.number {
                argv.push(number.to_string());
            }
            argv.extend(["--body".into(), need("body", &args.body)?]);
        }
        other => {
            return Err(format!(
                "unknown action `{other}` (use create, view, list, checks or comment)"
            ))
        }
    }
    Ok(argv)
}

/// Turns gh's failure output into guidance when it is an auth problem.
fn gh_failure_message(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication")
        || lower.contains("gh_token")
    {
        format!(
            "{stderr}\n\nThe GitHub CLI is not authenticated. Ask the user to run `gh auth login` \
in a terminal; tokens are never handled by this tool."
        )
    } else {
        stderr.to_string()
    }
}

async fn gh_pr(ctx: &ToolContext, input: Value) -> HarnessResult<Result<ToolOutput, String>> {
    let args: GhPrArgs = match parse_input(input) {
        Ok(args) => args,
        Err(error) => return Ok(Err(error)),
    };
    let argv = match gh_pr_argv(&args) {
        Ok(argv) => argv,
        Err(error) => return Ok(Err(error)),
    };
    let mut cmd = Command::new("gh");
    cmd.args(&argv)
        .current_dir(&ctx.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PAGER", "")
        .kill_on_drop(true);
    let captured = match exec(ctx, cmd, "gh").await? {
        Ok(captured) => captured,
        Err(error) if error.ends_with("was not found on PATH") => return Ok(Err(
            "the GitHub CLI (`gh`) is not installed or not on PATH. Ask the user to install it \
from https://cli.github.com/ and run `gh auth login`."
                .into(),
        )),
        Err(error) => return Ok(Err(error)),
    };
    let stdout = String::from_utf8_lossy(&captured.stdout).trim().to_string();
    if !captured.ok {
        // `gh pr checks` exits non-zero while checks fail or are pending but still prints the table.
        if args.action == "checks" && !stdout.is_empty() {
            return Ok(Ok(ToolOutput::text(capped(stdout.as_bytes()))));
        }
        return Ok(Err(gh_failure_message(&failure(&captured))));
    }
    Ok(Ok(ToolOutput::text(if stdout.is_empty() {
        combined(&captured)
    } else {
        capped(stdout.as_bytes())
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    fn sync_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo() -> Option<tempfile::TempDir> {
        if !git_available() {
            eprintln!("git not available; skipping");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        sync_git(dir.path(), &["init", "-q", "-b", "main"]);
        sync_git(dir.path(), &["config", "user.email", "t@example.com"]);
        sync_git(dir.path(), &["config", "user.name", "Tester"]);
        sync_git(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        sync_git(dir.path(), &["add", "."]);
        sync_git(dir.path(), &["commit", "-q", "-m", "first"]);
        Some(dir)
    }

    fn text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                crate::Block::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parses_status() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 M. N... 100644 100644 100644 h h staged.txt\0\
1 .M N... 100644 100644 100644 h h dir/with space.txt\0\
2 R. N... 100644 100644 100644 h h R100 new.txt\0old.txt\0\
u UU N... 1 2 3 4 h1 h2 h3 conflict.txt\0\
? new file.txt\0";
        let v = parse_status(raw);
        assert_eq!(v["branch"], "main");
        assert_eq!(v["upstream"], "origin/main");
        assert_eq!(v["ahead"], 2);
        assert_eq!(v["behind"], 1);
        assert_eq!(v["clean"], false);
        assert_eq!(v["staged"][0]["path"], "staged.txt");
        assert_eq!(v["staged"][1]["status"], "renamed");
        assert_eq!(v["staged"][1]["from"], "old.txt");
        assert_eq!(v["unstaged"][0]["path"], "dir/with space.txt");
        assert_eq!(v["conflicted"][0], "conflict.txt");
        assert_eq!(v["untracked"][0], "new file.txt");
    }

    #[tokio::test]
    async fn status_diff_log_show_commit_branch() {
        let Some(dir) = init_repo() else { return };
        let ctx = ToolContext::new(dir.path());

        let out = GitStatusTool.call(&ctx, json!({})).await.unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let v: Value = serde_json::from_str(&text(&out)).unwrap();
        assert_eq!(v["branch"], "main");
        assert_eq!(v["clean"], true);

        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "new\n").unwrap();
        let v: Value =
            serde_json::from_str(&text(&GitStatusTool.call(&ctx, json!({})).await.unwrap()))
                .unwrap();
        assert_eq!(v["unstaged"][0]["path"], "a.txt");
        assert_eq!(v["untracked"][0], "b.txt");

        let out = GitDiffTool
            .call(&ctx, json!({"path": "a.txt"}))
            .await
            .unwrap();
        assert!(text(&out).contains("+two"), "{}", text(&out));
        let out = GitDiffTool
            .call(&ctx, json!({"staged": true}))
            .await
            .unwrap();
        assert_eq!(text(&out), "No differences.");
        let out = GitDiffTool
            .call(&ctx, json!({"ref": "--output=x"}))
            .await
            .unwrap();
        assert!(out.is_error);

        let out = GitCommitTool
            .call(
                &ctx,
                json!({"message": "second", "paths": ["a.txt", "b.txt"]}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let log = GitLogTool
            .call(&ctx, json!({"oneline": true, "n": 5}))
            .await
            .unwrap();
        assert_eq!(text(&log).lines().count(), 2);
        assert!(text(&log).contains("second"));
        let log = GitLogTool
            .call(&ctx, json!({"path": "b.txt"}))
            .await
            .unwrap();
        assert!(text(&log).contains("second") && !text(&log).contains("first"));
        let shown = GitShowTool.call(&ctx, json!({"stat": true})).await.unwrap();
        assert!(text(&shown).contains("b.txt"), "{}", text(&shown));
        let diff = GitDiffTool
            .call(&ctx, json!({"ref": "HEAD~1"}))
            .await
            .unwrap();
        assert!(text(&diff).contains("+new"));

        // all + amend
        std::fs::write(dir.path().join("c.txt"), "c\n").unwrap();
        let out = GitCommitTool
            .call(&ctx, json!({"message": "third", "all": true}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let out = GitCommitTool
            .call(&ctx, json!({"message": "nothing to commit"}))
            .await
            .unwrap();
        assert!(out.is_error);
        let out = GitCommitTool
            .call(
                &ctx,
                json!({"message": "x", "all": true, "paths": ["a.txt"]}),
            )
            .await
            .unwrap();
        assert!(out.is_error);

        let out = GitBranchTool
            .call(&ctx, json!({"action": "create", "name": "feature/x"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let v: Value =
            serde_json::from_str(&text(&GitStatusTool.call(&ctx, json!({})).await.unwrap()))
                .unwrap();
        assert_eq!(v["branch"], "feature/x");
        let out = GitBranchTool
            .call(&ctx, json!({"action": "switch", "name": "main"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let out = GitBranchTool
            .call(&ctx, json!({"action": "switch", "name": "-f"}))
            .await
            .unwrap();
        assert!(out.is_error);
    }

    #[tokio::test]
    async fn truncates_large_diff() {
        let Some(dir) = init_repo() else { return };
        let ctx = ToolContext::new(dir.path());
        std::fs::write(dir.path().join("a.txt"), "x\n".repeat(120_000)).unwrap();
        let out = GitDiffTool.call(&ctx, json!({})).await.unwrap();
        assert!(text(&out).contains("output truncated"));
        assert!(text(&out).len() < MAX_OUTPUT_BYTES + 300);
    }

    #[tokio::test]
    async fn not_a_repo_is_a_tool_error() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        let out = GitStatusTool.call(&ctx, json!({})).await.unwrap();
        assert!(out.is_error);
    }

    #[tokio::test]
    async fn cancelled_run_returns_cancelled() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        ctx.cancel.cancel();
        let result = GitLogTool.call(&ctx, json!({})).await;
        assert!(result.is_err() || result.unwrap().is_error);
    }

    // ------------------------------------------------ collaboration tools

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn commit_all(dir: &Path, message: &str) {
        sync_git(dir, &["add", "-A"]);
        sync_git(dir, &["commit", "-q", "-m", message]);
    }

    /// main and feature both change a.txt on the same line.
    fn divergent_repo() -> Option<tempfile::TempDir> {
        let dir = init_repo()?;
        sync_git(dir.path(), &["switch", "-q", "-c", "feature"]);
        write(dir.path(), "a.txt", "feature\n");
        commit_all(dir.path(), "feature change");
        sync_git(dir.path(), &["switch", "-q", "main"]);
        write(dir.path(), "a.txt", "main\n");
        commit_all(dir.path(), "main change");
        Some(dir)
    }

    /// File text with CRLF (autocrlf checkouts on Windows) normalized.
    fn read_norm(dir: &Path, name: &str) -> String {
        let text = std::fs::read_to_string(dir.join(name)).unwrap();
        text.lines().collect::<Vec<_>>().join("\n") + "\n"
    }

    async fn status_json(ctx: &ToolContext) -> Value {
        serde_json::from_str(&text(&GitStatusTool.call(ctx, json!({})).await.unwrap())).unwrap()
    }

    #[tokio::test]
    async fn worktree_add_list_remove_prune() {
        let Some(dir) = init_repo() else { return };
        let holder = tempfile::tempdir().unwrap();
        let wt = holder.path().join("wt-one");
        let wt_str = wt.to_string_lossy().to_string();
        let ctx = ToolContext::new(dir.path());

        let out = GitWorktreeTool
            .call(
                &ctx,
                json!({"action": "add", "path": wt_str, "branch": "wt/one"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert!(wt.join("a.txt").exists());
        let listed = text(
            &GitWorktreeTool
                .call(&ctx, json!({"action": "list"}))
                .await
                .unwrap(),
        );
        assert!(
            listed.contains("wt-one") && listed.contains("refs/heads/wt/one"),
            "{listed}"
        );

        // Existing branch cannot be given a base; plain checkout of it elsewhere works after removal.
        let out = GitWorktreeTool
            .call(
                &ctx,
                json!({"action": "add", "path": "x", "branch": "wt/one", "base": "main"}),
            )
            .await
            .unwrap();
        assert!(out.is_error);

        let out = GitWorktreeTool
            .call(&ctx, json!({"action": "remove", "path": wt_str}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert!(!wt.exists());
        let listed = text(
            &GitWorktreeTool
                .call(&ctx, json!({"action": "list"}))
                .await
                .unwrap(),
        );
        assert!(!listed.contains("wt-one"), "{listed}");

        // Re-add using the now-existing branch, then prune a manually deleted one.
        let wt2 = holder.path().join("wt-two");
        let out = GitWorktreeTool
            .call(
                &ctx,
                json!({"action": "add", "path": wt2.to_string_lossy(), "branch": "wt/one"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        std::fs::remove_dir_all(&wt2).unwrap();
        let out = GitWorktreeTool
            .call(&ctx, json!({"action": "prune"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let listed = text(
            &GitWorktreeTool
                .call(&ctx, json!({"action": "list"}))
                .await
                .unwrap(),
        );
        assert!(!listed.contains("wt-two"), "{listed}");

        for bad in [
            json!({"action": "add"}),
            json!({"action": "remove", "path": "-f"}),
            json!({"action": "nope"}),
        ] {
            assert!(GitWorktreeTool.call(&ctx, bad).await.unwrap().is_error);
        }
    }

    #[test]
    fn parses_conflict_hunks_plain_and_diff3() {
        let plain = "top\n<<<<<<< HEAD\nmine 1\nmine 2\n=======\ntheirs 1\n>>>>>>> feature\nmid\n";
        let hunks = parse_conflict_hunks(plain);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0]["start_line"], 2);
        assert_eq!(hunks[0]["end_line"], 7);
        assert_eq!(hunks[0]["ours"], "mine 1\nmine 2");
        assert_eq!(hunks[0]["theirs"], "theirs 1");
        assert_eq!(hunks[0]["ours_label"], "HEAD");
        assert_eq!(hunks[0]["theirs_label"], "feature");
        assert!(hunks[0].get("base").is_none());

        let diff3 = "<<<<<<< HEAD\nA\n||||||| merged common ancestors\nO\n=======\nB\n>>>>>>> topic\nok\n<<<<<<< HEAD\nC\n=======\nD\n>>>>>>> topic\n";
        let hunks = parse_conflict_hunks(diff3);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0]["base"], "O");
        assert_eq!(hunks[0]["base_label"], "merged common ancestors");
        assert_eq!(hunks[0]["ours"], "A");
        assert_eq!(hunks[0]["theirs"], "B");
        assert_eq!(hunks[1]["ours"], "C");
        assert_eq!(hunks[1]["theirs"], "D");
        assert!(parse_conflict_hunks("a\n=======\nb\n").is_empty());
        // CRLF files
        let crlf = parse_conflict_hunks("<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n");
        assert_eq!(crlf[0]["ours"], "x");
    }

    #[tokio::test]
    async fn merge_conflict_list_resolve_commit_and_abort() {
        let Some(dir) = divergent_repo() else { return };
        let ctx = ToolContext::new(dir.path());

        // Conflict, then abort.
        let out = GitMergeTool
            .call(&ctx, json!({"branch": "feature"}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert!(text(&out).contains("git_conflicts"), "{}", text(&out));
        assert_eq!(status_json(&ctx).await["conflicted"][0], "a.txt");
        let out = GitMergeTool
            .call(&ctx, json!({"abort": true}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(status_json(&ctx).await["clean"], true);

        // Conflict again, parse (diff3 style on), resolve with content, commit.
        sync_git(dir.path(), &["config", "merge.conflictstyle", "diff3"]);
        assert!(
            GitMergeTool
                .call(&ctx, json!({"branch": "feature", "no_ff": true}))
                .await
                .unwrap()
                .is_error
        );
        let listing: Value = serde_json::from_str(&text(
            &GitConflictsTool.call(&ctx, json!({})).await.unwrap(),
        ))
        .unwrap();
        assert_eq!(listing["count"], 1);
        let file = &listing["files"][0];
        assert_eq!(file["path"], "a.txt");
        let hunk = &file["hunks"][0];
        assert_eq!(hunk["ours"], "main");
        assert_eq!(hunk["theirs"], "feature");
        assert_eq!(hunk["base"], "one");
        assert_eq!(hunk["theirs_label"], "feature");

        let bad = GitResolveTool
            .call(
                &ctx,
                json!({"path": "a.txt", "strategy": "content", "content": "<<<<<<< HEAD\nx\n"}),
            )
            .await
            .unwrap();
        assert!(bad.is_error);
        let bad = GitResolveTool
            .call(
                &ctx,
                json!({"path": "../evil", "strategy": "content", "content": "x"}),
            )
            .await
            .unwrap();
        assert!(bad.is_error);
        let out = GitResolveTool
            .call(
                &ctx,
                json!({"path": "a.txt", "strategy": "content", "content": "main+feature\n"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let listing: Value = serde_json::from_str(&text(
            &GitConflictsTool.call(&ctx, json!({})).await.unwrap(),
        ))
        .unwrap();
        assert_eq!(listing["count"], 0);
        let out = GitCommitTool
            .call(&ctx, json!({"message": "merge feature"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(read_norm(dir.path(), "a.txt"), "main+feature\n");
        assert_eq!(status_json(&ctx).await["clean"], true);
        let parents = std::process::Command::new("git")
            .args(["rev-list", "--parents", "-n", "1", "HEAD"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&parents.stdout)
                .split_whitespace()
                .count(),
            3
        );

        assert!(GitMergeTool.call(&ctx, json!({})).await.unwrap().is_error);
        assert!(
            GitMergeTool
                .call(&ctx, json!({"branch": "--abort"}))
                .await
                .unwrap()
                .is_error
        );
    }

    #[tokio::test]
    async fn resolve_theirs_and_ours() {
        let Some(dir) = divergent_repo() else { return };
        let ctx = ToolContext::new(dir.path());
        assert!(
            GitMergeTool
                .call(&ctx, json!({"branch": "feature"}))
                .await
                .unwrap()
                .is_error
        );
        let out = GitResolveTool
            .call(&ctx, json!({"path": "a.txt", "strategy": "theirs"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(read_norm(dir.path(), "a.txt"), "feature\n");
        assert!(
            !GitCommitTool
                .call(&ctx, json!({"message": "merge"}))
                .await
                .unwrap()
                .is_error
        );

        // ours variant on a fresh conflict (reset main first).
        sync_git(dir.path(), &["reset", "-q", "--hard", "HEAD~1"]);
        assert!(
            GitMergeTool
                .call(&ctx, json!({"branch": "feature"}))
                .await
                .unwrap()
                .is_error
        );
        let out = GitResolveTool
            .call(&ctx, json!({"path": "a.txt", "strategy": "ours"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(read_norm(dir.path(), "a.txt"), "main\n");
        let bad = GitResolveTool
            .call(
                &ctx,
                json!({"path": "a.txt", "strategy": "ours", "content": "x"}),
            )
            .await
            .unwrap();
        assert!(bad.is_error);
    }

    #[tokio::test]
    async fn rebase_abort_and_continue() {
        let Some(dir) = divergent_repo() else { return };
        let ctx = ToolContext::new(dir.path());
        sync_git(dir.path(), &["switch", "-q", "feature"]);

        let out = GitRebaseTool
            .call(&ctx, json!({"onto": "main"}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert!(text(&out).contains("git_conflicts"), "{}", text(&out));
        assert_eq!(status_json(&ctx).await["conflicted"][0], "a.txt");
        let out = GitRebaseTool
            .call(&ctx, json!({"abort": true}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let status = status_json(&ctx).await;
        assert_eq!(status["clean"], true);
        assert_eq!(status["branch"], "feature");
        assert_eq!(read_norm(dir.path(), "a.txt"), "feature\n");

        // Again, resolve and continue.
        assert!(
            GitRebaseTool
                .call(&ctx, json!({"onto": "main"}))
                .await
                .unwrap()
                .is_error
        );
        assert!(
            GitRebaseTool
                .call(&ctx, json!({"continue": true}))
                .await
                .unwrap()
                .is_error
        ); // unresolved
        let out = GitResolveTool
            .call(
                &ctx,
                json!({"path": "a.txt", "strategy": "content", "content": "merged\n"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let out = GitRebaseTool
            .call(&ctx, json!({"continue": true}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let status = status_json(&ctx).await;
        assert_eq!(status["clean"], true);
        assert_eq!(status["branch"], "feature");
        let log = GitLogTool
            .call(&ctx, json!({"oneline": true}))
            .await
            .unwrap();
        assert!(text(&log).contains("main change") && text(&log).contains("feature change"));

        for bad in [
            json!({}),
            json!({"onto": "-i"}),
            json!({"abort": true, "continue": true}),
        ] {
            assert!(GitRebaseTool.call(&ctx, bad).await.unwrap().is_error);
        }
    }

    #[tokio::test]
    async fn push_and_pull_against_local_bare_remote() {
        let Some(dir) = init_repo() else { return };
        let remote = tempfile::tempdir().unwrap();
        sync_git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        let remote_path = remote.path().to_string_lossy().to_string();
        sync_git(dir.path(), &["remote", "add", "origin", &remote_path]);
        let ctx = ToolContext::new(dir.path());

        // Safety and metadata.
        assert_eq!(GitPushTool.effect(), EffectClass::Network);
        let described = GitPushTool.describe(&json!({"remote": "origin", "branch": "main"}));
        assert!(
            described.contains("origin") && described.contains("main"),
            "{described}"
        );
        for bad in [
            json!({"branch": "+main"}),
            json!({"remote": "origin", "branch": "main:other"}),
            json!({"remote": "--force"}),
            json!({"branch": "--delete"}),
            json!({"force": true}),
        ] {
            assert!(GitPushTool.call(&ctx, bad).await.unwrap().is_error);
        }

        let out = GitPushTool
            .call(
                &ctx,
                json!({"remote": "origin", "branch": "main", "set_upstream": true}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(status_json(&ctx).await["upstream"], "origin/main");

        // A second clone pushes a new commit.
        let other = tempfile::tempdir().unwrap();
        let other_path = other.path().join("clone");
        sync_git(other.path(), &["clone", "-q", &remote_path, "clone"]);
        sync_git(&other_path, &["config", "user.email", "o@example.com"]);
        sync_git(&other_path, &["config", "user.name", "Other"]);
        sync_git(&other_path, &["config", "commit.gpgsign", "false"]);
        write(&other_path, "b.txt", "from other\n");
        commit_all(&other_path, "other commit");
        sync_git(&other_path, &["push", "-q", "origin", "main"]);

        // Pull (merge, fast-forward) brings it in.
        let out = GitPullTool.call(&ctx, json!({})).await.unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert!(dir.path().join("b.txt").exists());
        assert!(
            GitPullTool
                .call(&ctx, json!({"branch": "main"}))
                .await
                .unwrap()
                .is_error
        );

        // Diverge: local commit + remote commit, pull with rebase, then push.
        write(&other_path, "c.txt", "remote only\n");
        commit_all(&other_path, "remote second");
        sync_git(&other_path, &["push", "-q", "origin", "main"]);
        write(dir.path(), "d.txt", "local only\n");
        commit_all(dir.path(), "local commit");
        let out = GitPullTool
            .call(
                &ctx,
                json!({"remote": "origin", "branch": "main", "rebase": true}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert!(dir.path().join("c.txt").exists() && dir.path().join("d.txt").exists());
        let status = status_json(&ctx).await;
        assert_eq!(status["ahead"], 1);
        let out = GitPushTool.call(&ctx, json!({})).await.unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert_eq!(status_json(&ctx).await["ahead"], 0);

        // Rewrite history: plain push is rejected, force-with-lease succeeds.
        sync_git(
            dir.path(),
            &["commit", "-q", "--amend", "-m", "local commit (amended)"],
        );
        let out = GitPushTool.call(&ctx, json!({})).await.unwrap();
        assert!(out.is_error, "{}", text(&out));
        let out = GitPushTool
            .call(&ctx, json!({"force_with_lease": true}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        let remote_log = std::process::Command::new("git")
            .args(["log", "--oneline", "-n", "1", "main"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&remote_log.stdout).contains("amended"));
    }

    #[test]
    fn gh_pr_argv_building() {
        let make = |value: Value| -> Result<Vec<String>, String> {
            gh_pr_argv(&serde_json::from_value::<GhPrArgs>(value).unwrap())
        };
        assert_eq!(
            make(json!({"action": "create", "title": "T", "body": "B", "base": "main", "draft": true})).unwrap(),
            ["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--draft"]
        );
        assert!(make(json!({"action": "create", "title": "T"})).is_err());
        assert!(
            make(json!({"action": "create", "title": "T", "body": "B", "base": "--web"})).is_err()
        );
        let view = make(json!({"action": "view", "number": 7})).unwrap();
        assert_eq!(&view[..3], ["pr", "view", "7"]);
        assert!(view.contains(&"--json".to_string()));
        let list = make(json!({"action": "list", "state": "merged", "limit": 500})).unwrap();
        assert!(list.windows(2).any(|w| w == ["--state", "merged"]));
        assert!(list.windows(2).any(|w| w == ["--limit", "100"]));
        assert!(make(json!({"action": "list", "state": "bogus"})).is_err());
        assert_eq!(make(json!({"action": "checks"})).unwrap(), ["pr", "checks"]);
        assert_eq!(
            make(json!({"action": "comment", "number": 3, "body": "hi"})).unwrap(),
            ["pr", "comment", "3", "--body", "hi"]
        );
        assert!(make(json!({"action": "comment"})).is_err());
        assert!(make(json!({"action": "merge"})).is_err());

        assert!(
            gh_failure_message("To get started with GitHub CLI, please run:  gh auth login")
                .contains("Ask the user to run `gh auth login`")
        );
        assert_eq!(
            gh_failure_message("no pull requests found"),
            "no pull requests found"
        );
        assert_eq!(GhPrTool.effect(), EffectClass::Network);
        assert!(GhPrTool
            .describe(&json!({"action": "create", "title": "Add x"}))
            .contains("Add x"));
    }

    #[test]
    fn collab_tool_specs_are_objects() {
        let tools: Vec<Box<dyn Tool>> = vec![
            Box::new(GitWorktreeTool),
            Box::new(GitMergeTool),
            Box::new(GitRebaseTool),
            Box::new(GitPullTool),
            Box::new(GitPushTool),
            Box::new(GitConflictsTool),
            Box::new(GitResolveTool),
            Box::new(GhPrTool),
        ];
        for tool in tools {
            let spec = tool.spec();
            assert_eq!(spec.input_schema["type"], "object", "{}", spec.name);
            assert!(!tool.effect().is_read_only() || spec.name == "git_conflicts");
        }
    }
}
