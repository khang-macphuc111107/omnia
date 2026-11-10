//! Review pane backend: a structured working-tree diff for the session folder
//! plus per-hunk "stage" and "revert" actions.
//!
//! `git` is spawned directly (no shell) from the repository root. Hunks are
//! addressed by a content hash, so an action can never apply anything other
//! than a hunk that was just recomputed from the live working tree.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::HarnessHub;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILES: usize = 300;
const MAX_UNTRACKED_FILE_BYTES: u64 = 256 * 1024;
const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Add,
    Del,
    Ctx,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub id: String,
    pub header: String,
    pub lines: Vec<DiffLine>,
    /// Verbatim hunk text (header line + body), used to rebuild a patch.
    #[serde(skip)]
    raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    /// `modified`, `added` or `deleted`.
    pub status: &'static str,
    pub untracked: bool,
    pub binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<DiffHunk>,
    /// Verbatim `diff --git` header block, used to rebuild a patch.
    #[serde(skip)]
    patch_header: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiff {
    pub git: bool,
    pub files: Vec<DiffFile>,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRequest {
    pub session_id: String,
    pub file: String,
    pub hunk_id: String,
}

// ---------------------------------------------------------------- parsing --

fn hunk_id(path: &str, header: &str, raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(header.as_bytes());
    hasher.update([0]);
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unquote(value: &str) -> String {
    let value = value.trim_end_matches(['\t', '\r']);
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return value.to_owned();
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Strips the `a/` or `b/` prefix from a `---` / `+++` path; `None` for /dev/null.
fn patch_path(value: &str) -> Option<String> {
    let value = unquote(value);
    if value == "/dev/null" {
        return None;
    }
    Some(
        value
            .strip_prefix("a/")
            .or_else(|| value.strip_prefix("b/"))
            .unwrap_or(&value)
            .to_owned(),
    )
}

/// Parses `@@ -a[,b] +c[,d] @@` into (old_start, old_len, new_start, new_len).
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |text: &str| -> Option<(u32, u32)> {
        match text.split_once(',') {
            Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (os, ol) = range(old)?;
    let (ns, nl) = range(new)?;
    Some((os, ol, ns, nl))
}

struct OpenHunk {
    header: String,
    raw: String,
    lines: Vec<DiffLine>,
    old_no: u32,
    new_no: u32,
    old_left: u32,
    new_left: u32,
}

struct OpenFile {
    file: DiffFile,
    old_path: Option<String>,
    hunk: Option<OpenHunk>,
}

impl OpenFile {
    fn close_hunk(&mut self) {
        let Some(hunk) = self.hunk.take() else { return };
        // A hunk cut short by the size cap cannot be applied safely: drop it.
        if hunk.old_left != 0 || hunk.new_left != 0 {
            return;
        }
        self.file.hunks.push(DiffHunk {
            id: hunk_id(&self.file.path, &hunk.header, &hunk.raw),
            header: hunk.header,
            lines: hunk.lines,
            raw: hunk.raw,
        });
    }

    fn finish(mut self) -> DiffFile {
        self.close_hunk();
        if self.file.path.is_empty() {
            self.file.path = self.old_path.take().unwrap_or_default();
        }
        for hunk in &self.file.hunks {
            for line in &hunk.lines {
                match line.kind {
                    LineKind::Add => self.file.additions += 1,
                    LineKind::Del => self.file.deletions += 1,
                    LineKind::Ctx => {}
                }
            }
        }
        self.file
    }
}

fn header_default_path(line: &str) -> String {
    // "diff --git a/x b/x": best effort; the ---/+++ lines override it.
    let rest = line.strip_prefix("diff --git ").unwrap_or(line);
    match rest.rfind(" b/") {
        Some(index) => unquote(&rest[index + 3..]),
        None => String::new(),
    }
}

/// Parses `git diff` output into files → hunks → lines.
pub fn parse_diff(text: &str) -> Vec<DiffFile> {
    let mut files = Vec::new();
    let mut current: Option<OpenFile> = None;
    for line in text.split('\n') {
        let line_body = line.strip_suffix('\r').unwrap_or(line);
        // Inside a hunk every line belongs to it until both counts are spent.
        if let Some(open) = current.as_mut() {
            if let Some(hunk) = open.hunk.as_mut() {
                if line.starts_with('\\') {
                    hunk.raw.push_str(line);
                    hunk.raw.push('\n');
                    continue;
                }
                if hunk.old_left > 0 || hunk.new_left > 0 {
                    let (kind, text) = match line.chars().next() {
                        Some('+') => (LineKind::Add, &line_body[1..]),
                        Some('-') => (LineKind::Del, &line_body[1..]),
                        Some(' ') => (LineKind::Ctx, &line_body[1..]),
                        // Editors may strip the lone space of an empty context line.
                        None => (LineKind::Ctx, ""),
                        Some(_) => (LineKind::Ctx, line_body),
                    };
                    let (old_no, new_no) = match kind {
                        LineKind::Add => (None, Some(hunk.new_no)),
                        LineKind::Del => (Some(hunk.old_no), None),
                        LineKind::Ctx => (Some(hunk.old_no), Some(hunk.new_no)),
                    };
                    if kind != LineKind::Add {
                        hunk.old_no += 1;
                        hunk.old_left = hunk.old_left.saturating_sub(1);
                    }
                    if kind != LineKind::Del {
                        hunk.new_no += 1;
                        hunk.new_left = hunk.new_left.saturating_sub(1);
                    }
                    hunk.raw.push_str(line);
                    hunk.raw.push('\n');
                    hunk.lines.push(DiffLine {
                        kind,
                        old_no,
                        new_no,
                        text: text.to_owned(),
                    });
                    continue;
                }
            }
        }
        if line.starts_with("diff --git ") {
            if let Some(open) = current.take() {
                files.push(open.finish());
            }
            current = Some(OpenFile {
                file: DiffFile {
                    path: header_default_path(line),
                    status: "modified",
                    untracked: false,
                    binary: false,
                    additions: 0,
                    deletions: 0,
                    hunks: Vec::new(),
                    patch_header: format!("{line}\n"),
                },
                old_path: None,
                hunk: None,
            });
            continue;
        }
        let Some(open) = current.as_mut() else {
            continue;
        };
        if line.starts_with("@@ ") {
            open.close_hunk();
            if let Some((os, ol, ns, nl)) = parse_hunk_header(line_body) {
                open.hunk = Some(OpenHunk {
                    header: line_body.to_owned(),
                    raw: format!("{line}\n"),
                    lines: Vec::new(),
                    old_no: os,
                    new_no: ns,
                    old_left: ol,
                    new_left: nl,
                });
            }
            continue;
        }
        // Still in the file header block (stray lines after a hunk are ignored).
        if open.hunk.is_some() || line.is_empty() {
            continue;
        }
        open.file.patch_header.push_str(line);
        open.file.patch_header.push('\n');
        if let Some(value) = line.strip_prefix("--- ") {
            open.old_path = patch_path(value);
        } else if let Some(value) = line.strip_prefix("+++ ") {
            if let Some(path) = patch_path(value) {
                open.file.path = path;
            }
        } else if line.starts_with("new file mode") {
            open.file.status = "added";
        } else if line.starts_with("deleted file mode") {
            open.file.status = "deleted";
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            open.file.binary = true;
        }
    }
    if let Some(open) = current.take() {
        files.push(open.finish());
    }
    files
}

/// Renders a readable untracked file as an all-additions "new file" diff.
fn untracked_file(path: &str, content: Option<&str>) -> DiffFile {
    let mut file = DiffFile {
        path: path.to_owned(),
        status: "added",
        untracked: true,
        binary: content.is_none(),
        additions: 0,
        deletions: 0,
        hunks: Vec::new(),
        patch_header: String::new(),
    };
    let Some(content) = content.filter(|text| !text.is_empty()) else {
        return file;
    };
    let ends_with_newline = content.ends_with('\n');
    let body = content.strip_suffix('\n').unwrap_or(content);
    let rows: Vec<&str> = body.split('\n').collect();
    let header = format!("@@ -0,0 +1,{} @@", rows.len());
    let mut raw = format!("{header}\n");
    let mut lines = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        raw.push('+');
        raw.push_str(row);
        raw.push('\n');
        lines.push(DiffLine {
            kind: LineKind::Add,
            old_no: None,
            new_no: Some(index as u32 + 1),
            text: row.strip_suffix('\r').unwrap_or(row).to_owned(),
        });
    }
    if !ends_with_newline {
        raw.push_str("\\ No newline at end of file\n");
    }
    file.additions = lines.len() as u32;
    file.hunks.push(DiffHunk {
        id: hunk_id(path, &header, &raw),
        header,
        lines,
        raw,
    });
    file
}

// ------------------------------------------------------------------- git --

struct GitOut {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

fn run_git(
    cwd: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
    cap: usize,
) -> Result<GitOut, String> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
        "--no-pager",
    ])
    .args(args)
    .current_dir(cwd)
    .stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_EDITOR", "true");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git was not found on PATH".to_owned()
        } else {
            format!("failed to run git: {error}")
        }
    })?;
    let writer = stdin.and_then(|data| {
        child.stdin.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            })
        })
    });
    let err_reader = child.stderr.take().map(|pipe| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.take(64 * 1024).read_to_string(&mut text);
            text
        })
    });
    let mut stdout = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        let _ = pipe.take(cap as u64 + 1).read_to_end(&mut stdout);
    }
    let truncated = stdout.len() > cap;
    if truncated {
        stdout.truncate(cap);
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for git: {error}"))?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stderr = err_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    Ok(GitOut {
        ok: truncated || status.success(),
        stdout,
        stderr,
        truncated,
    })
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = run_git(cwd, args, None, 64 * 1024)?;
    if !out.ok {
        return Err(out.stderr.trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn not_git(error: Option<String>) -> WorkspaceDiff {
    WorkspaceDiff {
        git: false,
        error,
        ..WorkspaceDiff::default()
    }
}

/// Repository root of `cwd`, or `None` when it is not inside a work tree.
fn repo_root(cwd: &Path) -> Result<Option<PathBuf>, String> {
    match git_text(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(root) if !root.is_empty() => Ok(Some(PathBuf::from(root))),
        Ok(_) => Ok(None),
        Err(message) if message.contains("not a git repository") => Ok(None),
        Err(message) if message.starts_with("git was not found") => Err(message),
        Err(_) => Ok(None),
    }
}

fn compute_diff(cwd: &Path) -> WorkspaceDiff {
    let root = match repo_root(cwd) {
        Ok(Some(root)) => root,
        Ok(None) => return not_git(None),
        Err(message) => return not_git(Some(message)),
    };
    let base = if git_text(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
        "HEAD".to_owned()
    } else {
        // Fresh repository without commits: compare against the empty tree.
        run_git(
            &root,
            &["hash-object", "-t", "tree", "--stdin"],
            Some(Vec::new()),
            256,
        )
        .ok()
        .filter(|out| out.ok)
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|hash| !hash.is_empty())
        .unwrap_or_else(|| EMPTY_TREE_SHA1.to_owned())
    };
    let out = match run_git(
        &root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--ignore-submodules=all",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "-U3",
            &base,
            "--",
        ],
        None,
        MAX_DIFF_BYTES,
    ) {
        Ok(out) if out.ok => out,
        Ok(out) => {
            return WorkspaceDiff {
                git: true,
                error: Some(out.stderr.trim().to_owned()),
                ..WorkspaceDiff::default()
            }
        }
        Err(message) => return not_git(Some(message)),
    };
    let mut truncated = out.truncated;
    let mut used = out.stdout.len();
    let mut files = parse_diff(&String::from_utf8_lossy(&out.stdout));

    if !truncated {
        if let Ok(listing) = run_git(
            &root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
            MAX_DIFF_BYTES,
        ) {
            truncated |= listing.truncated;
            for name in listing
                .stdout
                .split(|byte| *byte == 0)
                .filter(|name| !name.is_empty())
            {
                let Ok(name) = std::str::from_utf8(name) else {
                    continue;
                };
                if name.ends_with('/') {
                    continue;
                }
                if files.len() >= MAX_FILES || used >= MAX_DIFF_BYTES {
                    truncated = true;
                    break;
                }
                let full = root.join(name);
                let Ok(meta) = std::fs::symlink_metadata(&full) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let content = if meta.len() <= MAX_UNTRACKED_FILE_BYTES {
                    std::fs::read(&full).ok().and_then(|bytes| {
                        let head = &bytes[..bytes.len().min(8192)];
                        if head.contains(&0) {
                            None
                        } else {
                            String::from_utf8(bytes).ok()
                        }
                    })
                } else {
                    None
                };
                used += content.as_ref().map_or(0, String::len);
                files.push(untracked_file(name, content.as_deref()));
            }
        }
    }
    if files.len() > MAX_FILES {
        files.truncate(MAX_FILES);
        truncated = true;
    }
    WorkspaceDiff {
        git: true,
        files,
        truncated,
        error: None,
    }
}

fn find_hunk<'a>(
    diff: &'a WorkspaceDiff,
    file: &str,
    hunk_id: &str,
) -> Result<(&'a DiffFile, &'a DiffHunk), NativeError> {
    let file = diff
        .files
        .iter()
        .find(|entry| entry.path == file)
        .ok_or_else(|| {
            NativeError::new(
                "review_stale",
                "That file no longer has changes. Refresh and try again.",
            )
        })?;
    let hunk = file
        .hunks
        .iter()
        .find(|hunk| hunk.id == hunk_id)
        .ok_or_else(|| {
            NativeError::new(
                "review_stale",
                "That change was modified since it was shown. Refresh and try again.",
            )
        })?;
    Ok((file, hunk))
}

fn apply_hunk(
    root: &Path,
    file: &DiffFile,
    hunk: &DiffHunk,
    args: &[&str],
) -> Result<(), NativeError> {
    let patch = format!("{}{}", file.patch_header, hunk.raw);
    let out = run_git(root, args, Some(patch.into_bytes()), 64 * 1024)
        .map_err(|message| NativeError::new("review_git_failed", message))?;
    if out.ok {
        Ok(())
    } else {
        let detail = out.stderr.trim();
        Err(NativeError::new(
            "review_git_failed",
            if detail.is_empty() {
                "git could not apply this change".to_owned()
            } else {
                detail.to_owned()
            },
        ))
    }
}

fn require_repo(cwd: &Path) -> Result<PathBuf, NativeError> {
    match repo_root(cwd) {
        Ok(Some(root)) => Ok(root),
        Ok(None) => Err(NativeError::new(
            "review_not_git",
            "This folder is not a git repository.",
        )),
        Err(message) => Err(NativeError::new("review_git_failed", message)),
    }
}

fn revert_hunk(cwd: &Path, file: &str, hunk_id: &str) -> Result<(), NativeError> {
    let root = require_repo(cwd)?;
    let diff = compute_diff(cwd);
    let (entry, hunk) = find_hunk(&diff, file, hunk_id)?;
    if entry.untracked {
        return Err(NativeError::new(
            "review_unsupported",
            "Revert is not supported for new files; delete the file yourself.",
        ));
    }
    apply_hunk(
        &root,
        entry,
        hunk,
        &["apply", "-R", "--whitespace=nowarn", "-"],
    )
}

fn stage_hunk(cwd: &Path, file: &str, hunk_id: &str) -> Result<(), NativeError> {
    let root = require_repo(cwd)?;
    let diff = compute_diff(cwd);
    let (entry, hunk) = find_hunk(&diff, file, hunk_id)?;
    if entry.untracked {
        let out = run_git(&root, &["add", "--", &entry.path], None, 64 * 1024)
            .map_err(|message| NativeError::new("review_git_failed", message))?;
        return if out.ok {
            Ok(())
        } else {
            Err(NativeError::new(
                "review_git_failed",
                out.stderr.trim().to_owned(),
            ))
        };
    }
    apply_hunk(
        &root,
        entry,
        hunk,
        &["apply", "--cached", "--whitespace=nowarn", "-"],
    )
}

// -------------------------------------------------------------- commands --

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> NativeResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| NativeError::new("review_failed", "The review task did not complete"))
}

#[tauri::command]
pub async fn agent_workspace_diff(
    hub: State<'_, HarnessHub>,
    request: ReviewRequest,
) -> NativeResult<WorkspaceDiff> {
    let cwd = hub.session_workspace(&request.session_id)?;
    blocking(move || compute_diff(&cwd)).await
}

#[tauri::command]
pub async fn agent_hunk_revert(
    hub: State<'_, HarnessHub>,
    request: HunkRequest,
) -> NativeResult<WorkspaceDiff> {
    let cwd = hub.session_workspace(&request.session_id)?;
    if hub.run_active(&request.session_id) {
        return Err(NativeError::new(
            "review_run_active",
            "Wait for the agent run to finish before reverting changes.",
        ));
    }
    blocking(move || {
        revert_hunk(&cwd, &request.file, &request.hunk_id)?;
        Ok::<_, NativeError>(compute_diff(&cwd))
    })
    .await?
}

#[tauri::command]
pub async fn agent_hunk_stage(
    hub: State<'_, HarnessHub>,
    request: HunkRequest,
) -> NativeResult<WorkspaceDiff> {
    let cwd = hub.session_workspace(&request.session_id)?;
    blocking(move || {
        stage_hunk(&cwd, &request.file, &request.hunk_id)?;
        Ok::<_, NativeError>(compute_diff(&cwd))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/src/a.txt b/src/a.txt\nindex 111..222 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,4 +1,4 @@ fn x\n one\n-two\n+TWO\n three\n four\n@@ -10,2 +10,3 @@\n ten\n+ten and a half\n eleven\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 000..333\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+--- not a header\n+diff --git inside\ndiff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 444..000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n";

    #[test]
    fn parses_files_hunks_and_line_numbers() {
        let files = parse_diff(SAMPLE);
        let names: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(names, ["src/a.txt", "new.txt", "gone.txt", "img.png"]);
        let a = &files[0];
        assert_eq!(
            (a.status, a.additions, a.deletions, a.hunks.len()),
            ("modified", 2, 1, 2)
        );
        let first = &a.hunks[0];
        assert_eq!(first.header, "@@ -1,4 +1,4 @@ fn x");
        let kinds: Vec<_> = first
            .lines
            .iter()
            .map(|line| (line.kind, line.old_no, line.new_no, line.text.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (LineKind::Ctx, Some(1), Some(1), "one"),
                (LineKind::Del, Some(2), None, "two"),
                (LineKind::Add, None, Some(2), "TWO"),
                (LineKind::Ctx, Some(3), Some(3), "three"),
                (LineKind::Ctx, Some(4), Some(4), "four"),
            ]
        );
        // The no-newline marker stays in the raw patch text but is not a row.
        assert!(a.hunks[1].raw.contains("\\ No newline at end of file"));
        assert_eq!(a.hunks[1].lines.len(), 3);
        assert_eq!(a.hunks[1].lines[1].new_no, Some(11));
    }

    #[test]
    fn handles_added_deleted_binary_and_header_lookalikes() {
        let files = parse_diff(SAMPLE);
        let added = &files[1];
        assert_eq!((added.status, added.additions), ("added", 2));
        assert_eq!(added.hunks[0].lines[0].text, "--- not a header");
        assert_eq!(added.hunks[0].lines[1].text, "diff --git inside");
        let gone = &files[2];
        assert_eq!(
            (gone.status, gone.path.as_str(), gone.deletions),
            ("deleted", "gone.txt", 1)
        );
        assert!(files[3].binary && files[3].hunks.is_empty());
    }

    #[test]
    fn hunk_ids_are_stable_and_content_sensitive() {
        let first = parse_diff(SAMPLE);
        let second = parse_diff(SAMPLE);
        assert_eq!(first[0].hunks[0].id, second[0].hunks[0].id);
        assert_ne!(first[0].hunks[0].id, first[0].hunks[1].id);
        let edited = parse_diff(&SAMPLE.replace("+TWO", "+Two"));
        assert_ne!(first[0].hunks[0].id, edited[0].hunks[0].id);
        assert_eq!(first[0].hunks[1].id, edited[0].hunks[1].id);
    }

    #[test]
    fn drops_hunks_cut_off_by_the_size_cap() {
        let cut = &SAMPLE[..SAMPLE.find("+ten and a half").unwrap()];
        let files = parse_diff(cut);
        assert_eq!(files[0].hunks.len(), 1);
    }

    #[test]
    fn rebuilds_a_single_hunk_patch() {
        let files = parse_diff(SAMPLE);
        let patch = format!("{}{}", files[0].patch_header, files[0].hunks[1].raw);
        assert!(patch.starts_with("diff --git a/src/a.txt b/src/a.txt\nindex 111..222 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -10,2 +10,3 @@\n"));
        assert!(!patch.contains("TWO"));
    }

    #[test]
    fn quoted_paths_and_crlf_content() {
        assert_eq!(unquote("\"we\\\"ird\\tname\""), "we\"ird\tname");
        assert_eq!(
            patch_path("b/with space.txt\t"),
            Some("with space.txt".to_owned())
        );
        let files = parse_diff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\r\n+b\r\n");
        assert_eq!(files[0].hunks[0].lines[1].text, "b");
        assert!(files[0].hunks[0].raw.contains("+b\r\n"));
    }

    #[test]
    fn renders_untracked_files_as_new_file_diffs() {
        let file = untracked_file("n.txt", Some("a\nb"));
        assert!(file.untracked);
        assert_eq!(
            (file.additions, file.hunks[0].header.as_str()),
            (2, "@@ -0,0 +1,2 @@")
        );
        assert!(file.hunks[0]
            .raw
            .ends_with("\\ No newline at end of file\n"));
        assert!(untracked_file("bin", None).binary);
        assert!(untracked_file("empty", Some("")).hunks.is_empty());
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = run_git(dir, args, None, 1 << 20).expect("git runs");
        assert!(out.ok, "git {args:?} failed: {}", out.stderr);
    }

    #[test]
    fn stage_and_revert_against_a_real_repository() {
        if !git_available() {
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("omnia-review-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dunce::canonicalize(&dir).unwrap();
        git_ok(&dir, &["init", "-q"]);
        git_ok(&dir, &["config", "user.email", "t@example.test"]);
        git_ok(&dir, &["config", "user.name", "t"]);
        git_ok(&dir, &["config", "core.autocrlf", "false"]);
        let original: String = (1..=30).map(|n| format!("line {n}\n")).collect();
        std::fs::write(dir.join("f.txt"), &original).unwrap();
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-q", "-m", "init"]);

        let edited = original
            .replace("line 2\n", "line two\n")
            .replace("line 28\n", "line 28!\n");
        std::fs::write(dir.join("f.txt"), &edited).unwrap();
        std::fs::write(dir.join("fresh.txt"), "hello\n").unwrap();

        let diff = compute_diff(&dir);
        assert!(diff.git && !diff.truncated);
        let f = diff.files.iter().find(|file| file.path == "f.txt").unwrap();
        assert_eq!(f.hunks.len(), 2);
        let fresh = diff
            .files
            .iter()
            .find(|file| file.path == "fresh.txt")
            .unwrap();
        assert!(fresh.untracked);

        // Revert only the first hunk.
        revert_hunk(&dir, "f.txt", &f.hunks[0].id).unwrap();
        let now = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(now.contains("line 2\n") && now.contains("line 28!\n"));

        // Stage the remaining hunk, and check the index received it.
        let after = compute_diff(&dir);
        let f = after
            .files
            .iter()
            .find(|file| file.path == "f.txt")
            .unwrap();
        assert_eq!(f.hunks.len(), 1);
        stage_hunk(&dir, "f.txt", &f.hunks[0].id).unwrap();
        let cached = git_text(&dir, &["diff", "--cached", "--stat"]).unwrap();
        assert!(cached.contains("f.txt"));

        // New files: revert refused, stage allowed.
        let fresh_hunk = after
            .files
            .iter()
            .find(|file| file.path == "fresh.txt")
            .unwrap()
            .hunks[0]
            .id
            .clone();
        let refused = revert_hunk(&dir, "fresh.txt", &fresh_hunk).unwrap_err();
        assert_eq!(refused.code, "review_unsupported");
        assert!(dir.join("fresh.txt").exists());
        stage_hunk(&dir, "fresh.txt", &fresh_hunk).unwrap();
        assert!(git_text(&dir, &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("fresh.txt"));

        // A stale id is rejected rather than applied.
        assert_eq!(
            revert_hunk(&dir, "f.txt", "deadbeef").unwrap_err().code,
            "review_stale"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_repository_folders_report_git_false() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("omnia-review-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A temp dir may itself sit inside a repository on some machines.
        if repo_root(&dir).ok().flatten().is_none() {
            let diff = compute_diff(&dir);
            assert!(!diff.git && diff.files.is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
