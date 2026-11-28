//! Safe UTF-8 LF file reads, numbered snippet slices, atomic temp+rename writes,
//! unified diff generation, and external rollback receipts (`D:\OmniaData\...`).

use crate::path_guard::{
    ensure_outside_workspace, is_reparse_point_metadata, relative_posix_path,
    resolve_contained_path, resolve_workspace_root,
};
use crate::{io_err, WorkspaceOpsError};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Controls how `\r\n` / `\r` line endings are handled on read and write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineEndingPolicy {
    /// Normalize `\r\n` and lone `\r` into pure LF (`\n`).
    #[default]
    NormalizeToLf,
    /// Reject any input/file containing `\r` (`\r\n` or lone `\r`).
    RejectCrlf,
}

impl LineEndingPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NormalizeToLf => "normalize_to_lf",
            Self::RejectCrlf => "reject_crlf",
        }
    }
}

/// Result of reading a workspace-contained UTF-8 file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFileResult {
    pub resolved_path: PathBuf,
    pub relative_path: String,
    pub content: String,
    pub sha256: String,
    pub raw_sha256: String,
    pub byte_len: usize,
    pub line_count: usize,
    pub had_crlf: bool,
}

impl Serialize for ReadFileResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("ReadFileResult", 8)?;
        s.serialize_field("resolved_path", &self.resolved_path.display().to_string())?;
        s.serialize_field("relative_path", &self.relative_path)?;
        s.serialize_field("content", &self.content)?;
        s.serialize_field("sha256", &self.sha256)?;
        s.serialize_field("raw_sha256", &self.raw_sha256)?;
        s.serialize_field("byte_len", &self.byte_len)?;
        s.serialize_field("line_count", &self.line_count)?;
        s.serialize_field("had_crlf", &self.had_crlf)?;
        s.end()
    }
}

/// A single 1-based numbered line returned by [`read_snippet`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberedLine {
    pub line_number: usize,
    pub text: String,
}

impl Serialize for NumberedLine {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("NumberedLine", 2)?;
        s.serialize_field("line_number", &self.line_number)?;
        s.serialize_field("text", &self.text)?;
        s.end()
    }
}

/// Line-numbered snippet slice from a workspace-contained UTF-8 file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetResult {
    pub resolved_path: PathBuf,
    pub relative_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub lines: Vec<NumberedLine>,
    pub formatted: String,
    pub sha256: String,
}

impl Serialize for SnippetResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("SnippetResult", 8)?;
        s.serialize_field("resolved_path", &self.resolved_path.display().to_string())?;
        s.serialize_field("relative_path", &self.relative_path)?;
        s.serialize_field("start_line", &self.start_line)?;
        s.serialize_field("end_line", &self.end_line)?;
        s.serialize_field("total_lines", &self.total_lines)?;
        s.serialize_field("lines", &self.lines)?;
        s.serialize_field("formatted", &self.formatted)?;
        s.serialize_field("sha256", &self.sha256)?;
        s.end()
    }
}

/// Options governing [`write_atomic`].
#[derive(Debug, Clone)]
pub struct WriteOptions {
    pub line_ending_policy: LineEndingPolicy,
    pub create_parents: bool,
    /// Optional external directory (must lie outside workspace `root`) for backup blobs and
    /// rollback receipt JSON. Backup `.bak` files are never created inside the workspace.
    pub rollback_dir: Option<PathBuf>,
    pub diff_context_lines: usize,
}

impl Default for WriteOptions {
    fn default() -> Self {
        Self {
            line_ending_policy: LineEndingPolicy::NormalizeToLf,
            create_parents: true,
            rollback_dir: None,
            diff_context_lines: 3,
        }
    }
}

/// Summary and unified diff produced by [`unified_diff`] and [`write_atomic`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSummary {
    pub changed: bool,
    pub lines_added: usize,
    pub lines_removed: usize,
    pub hunk_count: usize,
    pub unified_diff: String,
}

impl Serialize for DiffSummary {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("DiffSummary", 5)?;
        s.serialize_field("changed", &self.changed)?;
        s.serialize_field("lines_added", &self.lines_added)?;
        s.serialize_field("lines_removed", &self.lines_removed)?;
        s.serialize_field("hunk_count", &self.hunk_count)?;
        s.serialize_field("unified_diff", &self.unified_diff)?;
        s.end()
    }
}

/// External rollback receipt written outside the workspace when `rollback_dir` is configured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackReceipt {
    pub receipt_id: String,
    pub workspace_root: PathBuf,
    pub relative_path: String,
    pub target_path: PathBuf,
    pub existed_before: bool,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
    pub backup_blob_path: Option<PathBuf>,
    pub receipt_path: PathBuf,
    pub created_epoch_ms: u64,
}

impl Serialize for RollbackReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("RollbackReceipt", 10)?;
        s.serialize_field("receipt_id", &self.receipt_id)?;
        s.serialize_field("workspace_root", &self.workspace_root.display().to_string())?;
        s.serialize_field("relative_path", &self.relative_path)?;
        s.serialize_field("target_path", &self.target_path.display().to_string())?;
        s.serialize_field("existed_before", &self.existed_before)?;
        s.serialize_field("before_sha256", &self.before_sha256)?;
        s.serialize_field("after_sha256", &self.after_sha256)?;
        s.serialize_field(
            "backup_blob_path",
            &self
                .backup_blob_path
                .as_ref()
                .map(|p| p.display().to_string()),
        )?;
        s.serialize_field("receipt_path", &self.receipt_path.display().to_string())?;
        s.serialize_field("created_epoch_ms", &self.created_epoch_ms)?;
        s.end()
    }
}

/// Receipt emitted by [`write_atomic`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteReceipt {
    pub resolved_path: PathBuf,
    pub relative_path: String,
    pub existed_before: bool,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
    pub bytes_written: usize,
    pub had_crlf_input: bool,
    pub diff: DiffSummary,
    pub rollback: Option<RollbackReceipt>,
}

impl Serialize for WriteReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("WriteReceipt", 9)?;
        s.serialize_field("resolved_path", &self.resolved_path.display().to_string())?;
        s.serialize_field("relative_path", &self.relative_path)?;
        s.serialize_field("existed_before", &self.existed_before)?;
        s.serialize_field("before_sha256", &self.before_sha256)?;
        s.serialize_field("after_sha256", &self.after_sha256)?;
        s.serialize_field("bytes_written", &self.bytes_written)?;
        s.serialize_field("had_crlf_input", &self.had_crlf_input)?;
        s.serialize_field("diff", &self.diff)?;
        s.serialize_field("rollback", &self.rollback)?;
        s.end()
    }
}

/// Result emitted by [`rollback_write`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackOutcome {
    pub receipt_id: String,
    pub restored_path: PathBuf,
    pub relative_path: String,
    pub action: String,
    pub restored_sha256: Option<String>,
}

impl Serialize for RollbackOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("RollbackOutcome", 5)?;
        s.serialize_field("receipt_id", &self.receipt_id)?;
        s.serialize_field("restored_path", &self.restored_path.display().to_string())?;
        s.serialize_field("relative_path", &self.relative_path)?;
        s.serialize_field("action", &self.action)?;
        s.serialize_field("restored_sha256", &self.restored_sha256)?;
        s.end()
    }
}

/// Computes lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Reads a contained UTF-8 text file, enforcing `policy` for line endings.
pub fn read_text_file(
    root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
    policy: LineEndingPolicy,
) -> Result<ReadFileResult, WorkspaceOpsError> {
    let canonical_root = resolve_workspace_root(root)?;
    let target = resolve_contained_path(&canonical_root, candidate)?;

    let meta = fs::symlink_metadata(&target).map_err(|e| io_err("symlink_metadata", &target, e))?;
    if is_reparse_point_metadata(&meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: target.display().to_string(),
        });
    }
    if !meta.is_file() {
        return Err(WorkspaceOpsError::NotAFile {
            path: target.display().to_string(),
        });
    }

    let raw_bytes = fs::read(&target).map_err(|e| io_err("read", &target, e))?;
    let raw_sha256 = sha256_hex(&raw_bytes);
    let raw_text = String::from_utf8(raw_bytes).map_err(|_| WorkspaceOpsError::InvalidUtf8 {
        path: target.display().to_string(),
    })?;

    let had_crlf = raw_text.contains('\r');
    if had_crlf && policy == LineEndingPolicy::RejectCrlf {
        return Err(WorkspaceOpsError::CrlfDetected {
            path: target.display().to_string(),
        });
    }

    let content = normalize_lf(&raw_text);
    let sha256 = sha256_hex(content.as_bytes());
    let byte_len = content.len();
    let line_count = split_lf_lines(&content).len();
    let relative_path = relative_posix_path(&canonical_root, &target)?;

    Ok(ReadFileResult {
        resolved_path: target,
        relative_path,
        content,
        sha256,
        raw_sha256,
        byte_len,
        line_count,
        had_crlf,
    })
}

/// Reads a 1-based inclusive line slice (`start_line..=end_line`) with formatted line numbers.
pub fn read_snippet(
    root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
    start_line: usize,
    end_line: usize,
    policy: LineEndingPolicy,
) -> Result<SnippetResult, WorkspaceOpsError> {
    if start_line == 0 || end_line < start_line {
        return Err(WorkspaceOpsError::InvalidLineRange {
            start_line,
            end_line,
        });
    }

    let read = read_text_file(root, candidate, policy)?;
    let all_lines = split_lf_lines(&read.content);
    let total_lines = all_lines.len();

    if total_lines == 0 || start_line > total_lines {
        return Ok(SnippetResult {
            resolved_path: read.resolved_path,
            relative_path: read.relative_path,
            start_line,
            end_line: 0,
            total_lines,
            lines: Vec::new(),
            formatted: String::new(),
            sha256: read.sha256,
        });
    }

    let clamped_end = end_line.min(total_lines);
    let width = clamped_end.to_string().len().max(1);
    let mut lines = Vec::with_capacity(clamped_end - start_line + 1);
    let mut formatted = String::new();

    for (offset, raw_line) in all_lines[(start_line - 1)..clamped_end].iter().enumerate() {
        let line_number = start_line + offset;
        let text = (*raw_line).to_string();
        if !formatted.is_empty() {
            formatted.push('\n');
        }
        use std::fmt::Write as _;
        let _ = write!(&mut formatted, "{line_number:>width$} | {text}");
        lines.push(NumberedLine { line_number, text });
    }

    Ok(SnippetResult {
        resolved_path: read.resolved_path,
        relative_path: read.relative_path,
        start_line,
        end_line: clamped_end,
        total_lines,
        lines,
        formatted,
        sha256: read.sha256,
    })
}

/// Atomically writes UTF-8 LF text (`temp + sync_all + rename`) inside `root`, computing
/// before/after SHA-256 digests, unified diff summary, and optional external rollback receipts.
pub fn write_atomic(
    root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
    content: &str,
    options: &WriteOptions,
) -> Result<WriteReceipt, WorkspaceOpsError> {
    let canonical_root = resolve_workspace_root(root)?;
    let target = resolve_contained_path(&canonical_root, candidate)?;
    if target == canonical_root {
        return Err(WorkspaceOpsError::NotAFile {
            path: target.display().to_string(),
        });
    }

    let had_crlf_input = content.contains('\r');
    if had_crlf_input && options.line_ending_policy == LineEndingPolicy::RejectCrlf {
        return Err(WorkspaceOpsError::CrlfDetected {
            path: target.display().to_string(),
        });
    }

    let external_rollback_dir = match options.rollback_dir {
        Some(ref dir) => Some(ensure_outside_workspace(&canonical_root, dir)?),
        None => None,
    };

    let normalized = normalize_lf(content);
    let after_bytes = normalized.as_bytes();
    let after_sha256 = sha256_hex(after_bytes);

    let parent = target.parent().ok_or_else(|| WorkspaceOpsError::NotAFile {
        path: target.display().to_string(),
    })?;

    if !parent.exists() {
        if options.create_parents {
            fs::create_dir_all(parent).map_err(|e| io_err("create_dir_all", parent, e))?;
            // Re-verify parent containment after creating missing directories.
            let _ = resolve_contained_path(&canonical_root, parent)?;
        } else {
            return Err(io_err(
                "stat_parent",
                parent,
                io::Error::new(io::ErrorKind::NotFound, "parent directory does not exist"),
            ));
        }
    }

    let parent_meta =
        fs::symlink_metadata(parent).map_err(|e| io_err("symlink_metadata", parent, e))?;
    if is_reparse_point_metadata(&parent_meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: parent.display().to_string(),
        });
    }
    if !parent_meta.is_dir() {
        return Err(WorkspaceOpsError::NotADirectory {
            path: parent.display().to_string(),
        });
    }

    let (existed_before, before_bytes, before_sha256) = match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if is_reparse_point_metadata(&meta) {
                return Err(WorkspaceOpsError::ReparsePointDetected {
                    path: target.display().to_string(),
                });
            }
            if !meta.is_file() {
                return Err(WorkspaceOpsError::NotAFile {
                    path: target.display().to_string(),
                });
            }
            let bytes = fs::read(&target).map_err(|e| io_err("read", &target, e))?;
            let digest = sha256_hex(&bytes);
            (true, Some(bytes), Some(digest))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => (false, None, None),
        Err(e) => return Err(io_err("symlink_metadata", &target, e)),
    };

    let relative_path = relative_posix_path(&canonical_root, &target)?;

    let mut diff = match before_bytes.as_deref() {
        None => unified_diff(
            &relative_path,
            false,
            "",
            &normalized,
            options.diff_context_lines,
        ),
        Some(raw) => match std::str::from_utf8(raw) {
            Ok(before_str) => {
                let before_lf = normalize_lf(before_str);
                let mut summary = unified_diff(
                    &relative_path,
                    true,
                    &before_lf,
                    &normalized,
                    options.diff_context_lines,
                );
                if raw != after_bytes && !summary.changed {
                    summary.changed = true;
                    summary.unified_diff = format!(
                        "--- a/{relative_path}\n+++ b/{relative_path}\n\\ Line endings normalized (CRLF -> LF)\n"
                    );
                }
                summary
            }
            Err(_) => DiffSummary {
                changed: raw != after_bytes,
                lines_added: 0,
                lines_removed: 0,
                hunk_count: 0,
                unified_diff: format!(
                    "--- a/{relative_path} (binary)\n+++ b/{relative_path} (utf-8 text)\n"
                ),
            },
        },
    };
    if !existed_before && after_bytes.is_empty() {
        diff.changed = true;
    }

    // Write external backup blob BEFORE replacing the workspace target so pre-write bytes are durable.
    let rollback_prep = if let Some(ref rb_dir) = external_rollback_dir {
        fs::create_dir_all(rb_dir).map_err(|e| io_err("create_dir_all", rb_dir, e))?;
        let receipt_id = generate_receipt_id();
        let backup_blob_path = if let Some(ref orig_bytes) = before_bytes {
            let blob_path = rb_dir.join(format!("{receipt_id}.before.bin"));
            write_bytes_atomic_in_dir(rb_dir, &blob_path, orig_bytes)?;
            Some(blob_path)
        } else {
            None
        };
        let receipt_path = rb_dir.join(format!("{receipt_id}.rollback.json"));
        Some((receipt_id, backup_blob_path, receipt_path))
    } else {
        None
    };

    write_bytes_atomic_in_dir(parent, &target, after_bytes)?;

    let rollback = if let Some((receipt_id, backup_blob_path, receipt_path)) = rollback_prep {
        let receipt = RollbackReceipt {
            receipt_id,
            workspace_root: canonical_root,
            relative_path: relative_path.clone(),
            target_path: target.clone(),
            existed_before,
            before_sha256: before_sha256.clone(),
            after_sha256: after_sha256.clone(),
            backup_blob_path,
            receipt_path: receipt_path.clone(),
            created_epoch_ms: epoch_ms(),
        };
        let json = serde_json::to_vec_pretty(&receipt)?;
        let rb_parent = receipt_path.parent().unwrap_or_else(|| Path::new("."));
        write_bytes_atomic_in_dir(rb_parent, &receipt_path, &json)?;
        Some(receipt)
    } else {
        None
    };

    Ok(WriteReceipt {
        resolved_path: target,
        relative_path,
        existed_before,
        before_sha256,
        after_sha256,
        bytes_written: after_bytes.len(),
        had_crlf_input,
        diff,
        rollback,
    })
}

/// Restores a previous [`write_atomic`] operation using its external rollback JSON receipt.
pub fn rollback_write(
    root: impl AsRef<Path>,
    receipt_path: impl AsRef<Path>,
) -> Result<RollbackOutcome, WorkspaceOpsError> {
    let canonical_root = resolve_workspace_root(root)?;
    let rpath = receipt_path.as_ref();
    let raw_bytes = fs::read(rpath).map_err(|e| io_err("read", rpath, e))?;
    let val: serde_json::Value = serde_json::from_slice(&raw_bytes)?;

    let receipt_id = json_req_str(&val, "receipt_id", rpath)?;
    let recorded_root = json_req_str(&val, "workspace_root", rpath)?;
    let relative_path = json_req_str(&val, "relative_path", rpath)?;
    let existed_before = val
        .get("existed_before")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| WorkspaceOpsError::InvalidRollbackReceipt {
            path: rpath.display().to_string(),
            reason: "missing boolean field `existed_before`".to_string(),
        })?;
    let after_sha256 = json_req_str(&val, "after_sha256", rpath)?;

    let recorded_root_canon = resolve_workspace_root(&recorded_root)?;
    if recorded_root_canon != canonical_root {
        return Err(WorkspaceOpsError::OutsideWorkspace {
            root: canonical_root.display().to_string(),
            candidate: recorded_root_canon.display().to_string(),
        });
    }

    let target = resolve_contained_path(&canonical_root, &relative_path)?;
    if target == canonical_root {
        return Err(WorkspaceOpsError::NotAFile {
            path: target.display().to_string(),
        });
    }

    if existed_before {
        let expected_before_sha = json_req_str(&val, "before_sha256", rpath)?;
        let blob_path_str = json_req_str(&val, "backup_blob_path", rpath)?;
        let blob_path = PathBuf::from(&blob_path_str);
        let blob_bytes = fs::read(&blob_path).map_err(|e| io_err("read", &blob_path, e))?;
        let actual_sha = sha256_hex(&blob_bytes);
        if actual_sha != expected_before_sha {
            return Err(WorkspaceOpsError::RollbackIntegrityMismatch {
                expected: expected_before_sha,
                actual: actual_sha,
            });
        }

        let parent = target.parent().ok_or_else(|| WorkspaceOpsError::NotAFile {
            path: target.display().to_string(),
        })?;
        fs::create_dir_all(parent).map_err(|e| io_err("create_dir_all", parent, e))?;
        let _ = resolve_contained_path(&canonical_root, parent)?;

        if let Ok(meta) = fs::symlink_metadata(&target) {
            if is_reparse_point_metadata(&meta) {
                return Err(WorkspaceOpsError::ReparsePointDetected {
                    path: target.display().to_string(),
                });
            }
        }

        write_bytes_atomic_in_dir(parent, &target, &blob_bytes)?;

        Ok(RollbackOutcome {
            receipt_id,
            restored_path: target,
            relative_path,
            action: "restored_original_content".to_string(),
            restored_sha256: Some(expected_before_sha),
        })
    } else {
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if is_reparse_point_metadata(&meta) {
                    return Err(WorkspaceOpsError::ReparsePointDetected {
                        path: target.display().to_string(),
                    });
                }
                if !meta.is_file() {
                    return Err(WorkspaceOpsError::NotAFile {
                        path: target.display().to_string(),
                    });
                }
                let current_bytes = fs::read(&target).map_err(|e| io_err("read", &target, e))?;
                let current_sha = sha256_hex(&current_bytes);
                if current_sha != after_sha256 {
                    return Err(WorkspaceOpsError::RollbackIntegrityMismatch {
                        expected: after_sha256,
                        actual: current_sha,
                    });
                }
                fs::remove_file(&target).map_err(|e| io_err("remove_file", &target, e))?;
                Ok(RollbackOutcome {
                    receipt_id,
                    restored_path: target,
                    relative_path,
                    action: "removed_created_file".to_string(),
                    restored_sha256: None,
                })
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(RollbackOutcome {
                receipt_id,
                restored_path: target,
                relative_path,
                action: "already_absent".to_string(),
                restored_sha256: None,
            }),
            Err(e) => Err(io_err("symlink_metadata", &target, e)),
        }
    }
}

/// Computes a unified diff and line-change summary between `before` and `after`.
pub fn unified_diff(
    relative_path: &str,
    existed_before: bool,
    before: &str,
    after: &str,
    context_lines: usize,
) -> DiffSummary {
    if existed_before && before == after {
        return DiffSummary {
            changed: false,
            lines_added: 0,
            lines_removed: 0,
            hunk_count: 0,
            unified_diff: String::new(),
        };
    }

    let old_lines = split_lf_lines(before);
    let new_lines = split_lf_lines(after);
    let ops = compute_line_diff_ops(&old_lines, &new_lines);

    let mut lines_added = 0usize;
    let mut lines_removed = 0usize;
    for op in &ops {
        match op {
            DiffOp::Insert(_) => lines_added += 1,
            DiffOp::Delete(_) => lines_removed += 1,
            DiffOp::Equal(_) => {}
        }
    }

    if lines_added == 0 && lines_removed == 0 {
        let trailing_newline_changed = existed_before && before != after;
        let note = if trailing_newline_changed {
            format!("--- a/{relative_path}\n+++ b/{relative_path}\n\\ Trailing newline modified\n")
        } else {
            String::new()
        };
        return DiffSummary {
            changed: !existed_before || trailing_newline_changed,
            lines_added: 0,
            lines_removed: 0,
            hunk_count: 0,
            unified_diff: note,
        };
    }

    // Collect contiguous changed intervals in `ops`, expanded by `context_lines` and merged.
    let change_indices: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(idx, op)| (!matches!(op, DiffOp::Equal(_))).then_some(idx))
        .collect();

    let mut hunk_ranges: Vec<(usize, usize)> = Vec::new();
    for idx in change_indices {
        let start = idx.saturating_sub(context_lines);
        let end = (idx + context_lines + 1).min(ops.len());
        if let Some(last) = hunk_ranges.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        hunk_ranges.push((start, end));
    }

    // Track 1-based line numbers preceding each op index.
    let mut old_pos_before = Vec::with_capacity(ops.len() + 1);
    let mut new_pos_before = Vec::with_capacity(ops.len() + 1);
    let (mut old_cur, mut new_cur) = (1usize, 1usize);
    for op in &ops {
        old_pos_before.push(old_cur);
        new_pos_before.push(new_cur);
        match op {
            DiffOp::Equal(_) => {
                old_cur += 1;
                new_cur += 1;
            }
            DiffOp::Delete(_) => old_cur += 1,
            DiffOp::Insert(_) => new_cur += 1,
        }
    }
    old_pos_before.push(old_cur);
    new_pos_before.push(new_cur);

    let mut out = String::new();
    use std::fmt::Write as _;
    if existed_before {
        let _ = writeln!(&mut out, "--- a/{relative_path}");
    } else {
        let _ = writeln!(&mut out, "--- /dev/null");
    }
    let _ = writeln!(&mut out, "+++ b/{relative_path}");

    for (start_op, end_op) in &hunk_ranges {
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        for op in &ops[*start_op..*end_op] {
            match op {
                DiffOp::Equal(_) => {
                    old_count += 1;
                    new_count += 1;
                }
                DiffOp::Delete(_) => old_count += 1,
                DiffOp::Insert(_) => new_count += 1,
            }
        }

        let old_start = if old_count == 0 {
            old_pos_before[*start_op].saturating_sub(1)
        } else {
            old_pos_before[*start_op]
        };
        let new_start = if new_count == 0 {
            new_pos_before[*start_op].saturating_sub(1)
        } else {
            new_pos_before[*start_op]
        };

        let _ = writeln!(
            &mut out,
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@"
        );
        for op in &ops[*start_op..*end_op] {
            match op {
                DiffOp::Equal(line) => {
                    let _ = writeln!(&mut out, " {line}");
                }
                DiffOp::Delete(line) => {
                    let _ = writeln!(&mut out, "-{line}");
                }
                DiffOp::Insert(line) => {
                    let _ = writeln!(&mut out, "+{line}");
                }
            }
        }
    }

    DiffSummary {
        changed: true,
        lines_added,
        lines_removed,
        hunk_count: hunk_ranges.len(),
        unified_diff: out,
    }
}

#[derive(Debug, Clone)]
enum DiffOp<'a> {
    Equal(&'a str),
    Delete(&'a str),
    Insert(&'a str),
}

fn compute_line_diff_ops<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<DiffOp<'a>> {
    // Strip common prefix and suffix first to keep the LCS table minimal.
    let mut prefix = 0usize;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix + prefix < old.len()
        && suffix + prefix < new.len()
        && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_mid = &old[prefix..old.len() - suffix];
    let new_mid = &new[prefix..new.len() - suffix];

    let mut ops = Vec::with_capacity(old.len() + new.len());
    for line in &old[..prefix] {
        ops.push(DiffOp::Equal(line));
    }

    const MAX_LCS_CELLS: usize = 4_000_000;
    if old_mid.len().saturating_mul(new_mid.len()) <= MAX_LCS_CELLS {
        let rows = old_mid.len() + 1;
        let cols = new_mid.len() + 1;
        let mut dp = vec![0u32; rows * cols];
        for i in (0..old_mid.len()).rev() {
            for j in (0..new_mid.len()).rev() {
                dp[i * cols + j] = if old_mid[i] == new_mid[j] {
                    dp[(i + 1) * cols + (j + 1)] + 1
                } else {
                    dp[(i + 1) * cols + j].max(dp[i * cols + (j + 1)])
                };
            }
        }
        let (mut i, mut j) = (0usize, 0usize);
        while i < old_mid.len() && j < new_mid.len() {
            if old_mid[i] == new_mid[j] {
                ops.push(DiffOp::Equal(old_mid[i]));
                i += 1;
                j += 1;
            } else if dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)] {
                ops.push(DiffOp::Delete(old_mid[i]));
                i += 1;
            } else {
                ops.push(DiffOp::Insert(new_mid[j]));
                j += 1;
            }
        }
        while i < old_mid.len() {
            ops.push(DiffOp::Delete(old_mid[i]));
            i += 1;
        }
        while j < new_mid.len() {
            ops.push(DiffOp::Insert(new_mid[j]));
            j += 1;
        }
    } else {
        for line in old_mid {
            ops.push(DiffOp::Delete(line));
        }
        for line in new_mid {
            ops.push(DiffOp::Insert(line));
        }
    }

    for line in &old[old.len() - suffix..] {
        ops.push(DiffOp::Equal(line));
    }
    ops
}

fn normalize_lf(input: &str) -> String {
    if !input.contains('\r') {
        return input.to_string();
    }
    input.replace("\r\n", "\n").replace('\r', "\n")
}

fn split_lf_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn defuse(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(ref p) = self.path {
            let _ = fs::remove_file(p);
        }
    }
}

fn write_bytes_atomic_in_dir(
    dir: &Path,
    target: &Path,
    bytes: &[u8],
) -> Result<(), WorkspaceOpsError> {
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_name = format!(".omnia-tmp-{}-{nanos}-{seq}.tmp", std::process::id());
    let tmp_path = dir.join(tmp_name);

    let mut guard = TempFileGuard::new(tmp_path.clone());
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(|e| io_err("open_temp", &tmp_path, e))?;
        file.write_all(bytes)
            .map_err(|e| io_err("write_temp", &tmp_path, e))?;
        file.sync_all()
            .map_err(|e| io_err("sync_temp", &tmp_path, e))?;
    }

    fs::rename(&tmp_path, target).map_err(|e| io_err("rename_atomic", target, e))?;
    guard.defuse();
    Ok(())
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_receipt_id() -> String {
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ms = epoch_ms();
    format!("omnia-rb-{ms}-{}-{seq}", std::process::id())
}

fn json_req_str(
    val: &serde_json::Value,
    field: &str,
    path: &Path,
) -> Result<String, WorkspaceOpsError> {
    val.get(field)
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .ok_or_else(|| WorkspaceOpsError::InvalidRollbackReceipt {
            path: path.display().to_string(),
            reason: format!("missing string field `{field}`"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    struct FsSandbox {
        base: PathBuf,
        root: PathBuf,
        external_rollback: PathBuf,
        junctions: Vec<PathBuf>,
    }

    impl FsSandbox {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "omnia-fs-ops-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            let root = base.join("workspace");
            let external_rollback = base.join("external-rollback");
            fs::create_dir_all(&root).expect("create workspace");
            Self {
                base,
                root,
                external_rollback,
                junctions: Vec::new(),
            }
        }
    }

    impl Drop for FsSandbox {
        fn drop(&mut self) {
            for j in self.junctions.drain(..).rev() {
                let _ = fs::remove_dir(&j);
            }
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn read_normalizes_crlf_to_lf_and_rejects_crlf_when_strict() {
        let sb = FsSandbox::new("crlf-read");
        let file = sb.root.join("sample.txt");
        fs::write(&file, b"line1\r\nline2\r\nline3\n").expect("seed file");

        let normalized = read_text_file(&sb.root, "sample.txt", LineEndingPolicy::NormalizeToLf)
            .expect("normalize read");
        assert!(normalized.had_crlf);
        assert!(!normalized.content.contains('\r'));
        assert_eq!(normalized.content, "line1\nline2\nline3\n");
        assert_eq!(normalized.line_count, 3);
        assert_eq!(
            normalized.raw_sha256,
            sha256_hex(b"line1\r\nline2\r\nline3\n")
        );
        assert_eq!(normalized.sha256, sha256_hex(b"line1\nline2\nline3\n"));

        let strict_err = read_text_file(&sb.root, "sample.txt", LineEndingPolicy::RejectCrlf)
            .expect_err("strict CRLF must fail");
        assert!(matches!(strict_err, WorkspaceOpsError::CrlfDetected { .. }));

        let bin = sb.root.join("bad.bin");
        fs::write(&bin, [0xffu8, 0xfe, 0x00, 0x80]).expect("seed binary");
        let utf8_err = read_text_file(&sb.root, "bad.bin", LineEndingPolicy::NormalizeToLf)
            .expect_err("invalid utf-8 must fail");
        assert!(matches!(utf8_err, WorkspaceOpsError::InvalidUtf8 { .. }));
    }

    #[test]
    fn read_snippet_returns_numbered_lines_and_validates_range() {
        let sb = FsSandbox::new("snippet");
        let content = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
        write_atomic(&sb.root, "src/data.txt", content, &WriteOptions::default())
            .expect("seed data");

        let snip = read_snippet(&sb.root, "src/data.txt", 2, 4, LineEndingPolicy::RejectCrlf)
            .expect("snippet");
        assert_eq!(snip.start_line, 2);
        assert_eq!(snip.end_line, 4);
        assert_eq!(snip.total_lines, 5);
        assert_eq!(snip.lines.len(), 3);
        assert_eq!(snip.lines[0].line_number, 2);
        assert_eq!(snip.lines[0].text, "beta");
        assert_eq!(snip.formatted, "2 | beta\n3 | gamma\n4 | delta");

        let bad_range = read_snippet(
            &sb.root,
            "src/data.txt",
            0,
            2,
            LineEndingPolicy::NormalizeToLf,
        )
        .expect_err("zero line invalid");
        assert!(matches!(
            bad_range,
            WorkspaceOpsError::InvalidLineRange { .. }
        ));
    }

    #[test]
    fn atomic_write_normalizes_lf_computes_sha256_and_writes_diff() {
        let sb = FsSandbox::new("atomic-diff");
        let opts = WriteOptions::default();

        let first = write_atomic(
            &sb.root,
            "nested/module.rs",
            "fn a() {}\r\nfn b() {}\r\n",
            &opts,
        )
        .expect("create file");
        assert!(!first.existed_before);
        assert_eq!(first.before_sha256, None);
        assert_eq!(first.after_sha256, sha256_hex(b"fn a() {}\nfn b() {}\n"));
        assert!(first.had_crlf_input);
        assert!(first.diff.changed);
        assert_eq!(first.diff.lines_added, 2);
        assert_eq!(first.diff.lines_removed, 0);
        assert!(first.diff.unified_diff.contains("--- /dev/null"));
        assert!(first.diff.unified_diff.contains("+++ b/nested/module.rs"));

        let second = write_atomic(
            &sb.root,
            "nested/module.rs",
            "fn a() {}\nfn b_updated() {}\nfn c() {}\n",
            &opts,
        )
        .expect("update file");
        assert!(second.existed_before);
        assert_eq!(second.before_sha256, Some(first.after_sha256.clone()));
        assert_eq!(second.diff.lines_removed, 1);
        assert_eq!(second.diff.lines_added, 2);
        assert!(second.diff.unified_diff.contains("-fn b() {}"));
        assert!(second.diff.unified_diff.contains("+fn b_updated() {}"));

        // Confirm zero `.bak` or leftover `.omnia-tmp-*` files exist inside the workspace.
        let entries: Vec<_> = fs::read_dir(sb.root.join("nested"))
            .expect("read dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["module.rs".to_string()]);
    }

    #[test]
    fn atomic_write_rejects_crlf_under_strict_policy_without_modifying_target() {
        let sb = FsSandbox::new("strict-write");
        write_atomic(
            &sb.root,
            "clean.txt",
            "original\n",
            &WriteOptions::default(),
        )
        .expect("seed clean");

        let strict_opts = WriteOptions {
            line_ending_policy: LineEndingPolicy::RejectCrlf,
            ..WriteOptions::default()
        };
        let err = write_atomic(&sb.root, "clean.txt", "changed\r\n", &strict_opts)
            .expect_err("strict CRLF write must fail");
        assert!(matches!(err, WorkspaceOpsError::CrlfDetected { .. }));

        let after = fs::read_to_string(sb.root.join("clean.txt")).expect("read unchanged");
        assert_eq!(after, "original\n");
    }

    #[test]
    fn atomic_write_and_external_rollback_restores_existing_and_new_files() {
        let sb = FsSandbox::new("rollback");
        let opts = WriteOptions {
            rollback_dir: Some(sb.external_rollback.clone()),
            ..WriteOptions::default()
        };

        // 1) Create new file with rollback receipt, verify rollback removes it cleanly.
        let create_receipt =
            write_atomic(&sb.root, "docs/new_note.md", "# Title\n", &opts).expect("create");
        let create_rb = create_receipt.rollback.as_ref().expect("rollback receipt");
        let canonical_receipt =
            fs::canonicalize(&create_rb.receipt_path).expect("canonicalize receipt path");
        let canonical_rollback_dir =
            fs::canonicalize(&sb.external_rollback).expect("canonicalize rollback dir");
        assert!(canonical_receipt.starts_with(&canonical_rollback_dir));
        assert!(sb.root.join("docs/new_note.md").exists());

        // 2) Update existing file with rollback receipt, verify rollback restores original bytes.
        let update_receipt = write_atomic(
            &sb.root,
            "docs/new_note.md",
            "# Title\nUpdated body\n",
            &opts,
        )
        .expect("update");
        let update_rb = update_receipt.rollback.as_ref().expect("update rollback");
        assert_eq!(
            fs::read_to_string(sb.root.join("docs/new_note.md")).expect("read updated"),
            "# Title\nUpdated body\n"
        );

        let restored = rollback_write(&sb.root, &update_rb.receipt_path).expect("rollback update");
        assert_eq!(restored.action, "restored_original_content");
        assert_eq!(
            fs::read_to_string(sb.root.join("docs/new_note.md")).expect("read restored"),
            "# Title\n"
        );

        let removed = rollback_write(&sb.root, &create_rb.receipt_path).expect("rollback create");
        assert_eq!(removed.action, "removed_created_file");
        assert!(!sb.root.join("docs/new_note.md").exists());
    }

    #[test]
    fn atomic_write_rejects_rollback_dir_inside_workspace() {
        let sb = FsSandbox::new("rb-inside");
        let opts = WriteOptions {
            rollback_dir: Some(sb.root.join(".rollback")),
            ..WriteOptions::default()
        };
        let err = write_atomic(&sb.root, "file.txt", "hello\n", &opts)
            .expect_err("rollback dir inside workspace must be rejected");
        assert!(matches!(
            err,
            WorkspaceOpsError::RollbackDirInsideWorkspace { .. }
        ));
    }

    #[test]
    fn write_and_read_reject_reparse_point_target() {
        let mut sb = FsSandbox::new("fs-reparse");
        let outside_dir = sb.base.join("outside_target");
        fs::create_dir_all(&outside_dir).expect("mkdir outside");
        fs::write(outside_dir.join("escape.txt"), "outside\n").expect("write outside");

        let link = sb.root.join("escape_link");

        #[cfg(windows)]
        let created = {
            let out = Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link.to_string_lossy(),
                    &outside_dir.to_string_lossy(),
                ])
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    sb.junctions.push(link.clone());
                    true
                }
                _ => false,
            }
        };

        #[cfg(not(windows))]
        let created = std::os::unix::fs::symlink(&outside_dir, &link).is_ok();

        if !created {
            eprintln!("skipping fs_ops reparse test: junction/symlink privilege unavailable");
            return;
        }

        let read_err = read_text_file(
            &sb.root,
            "escape_link/escape.txt",
            LineEndingPolicy::NormalizeToLf,
        )
        .expect_err("read through junction must fail");
        assert!(matches!(
            read_err,
            WorkspaceOpsError::ReparsePointDetected { .. }
        ));

        let write_err = write_atomic(
            &sb.root,
            "escape_link/new.txt",
            "pwn\n",
            &WriteOptions::default(),
        )
        .expect_err("write through junction must fail");
        assert!(matches!(
            write_err,
            WorkspaceOpsError::ReparsePointDetected { .. }
        ));
    }

    #[test]
    fn unified_diff_detects_trailing_newline_change() {
        let diff = unified_diff("file.txt", true, "line1\n", "line1", 3);
        assert!(diff.changed);
        assert_eq!(diff.lines_added, 0);
        assert_eq!(diff.lines_removed, 0);
        assert!(diff.unified_diff.contains("Trailing newline modified"));
    }

    #[test]
    fn receipts_serialize_and_rollback_detects_tampering() {
        let sb = FsSandbox::new("integrity");
        let opts = WriteOptions {
            rollback_dir: Some(sb.external_rollback.clone()),
            ..WriteOptions::default()
        };

        let first = write_atomic(&sb.root, "a.txt", "v1\n", &opts).expect("seed");
        assert!(serde_json::to_string_pretty(&first).is_ok());

        let second = write_atomic(&sb.root, "a.txt", "v2\n", &opts).expect("update");
        let rb = second.rollback.as_ref().expect("rollback receipt");
        let blob = rb.backup_blob_path.as_ref().expect("backup blob");
        fs::write(blob, b"tampered\n").expect("tamper backup blob");

        let err = rollback_write(&sb.root, &rb.receipt_path)
            .expect_err("tampered backup blob must fail integrity check");
        assert!(matches!(
            err,
            WorkspaceOpsError::RollbackIntegrityMismatch { .. }
        ));
    }
}
