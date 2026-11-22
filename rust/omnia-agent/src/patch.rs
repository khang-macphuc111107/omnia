//! OpenAI Codex `apply_patch` Native Rust Parser & Atomic Multi-File Patch Engine (`v0.3.0`).
//!
//! Upgrades in `v0.3.0`:
//! - Hashline `@@ 42:a3f` anchor support inside hunks
//! - Defensive strip guard if a model accidentally copies `42:a3f| ` prefixes into hunk lines
//! - Tier-3 `imara-diff` Histogram fuzzy hunk fallback (strict `sim >= 0.88 && margin >= 0.10` proof)
//! - Compact post-patch unified diff preview with fresh Hashlines (`diff_preview`)
//! - 100% atomic in-memory dry-run validation + backup rollback + workspace containment preserved!

use crate::edit::{
    find_unique_histogram_window, format_compact_unified_diff, line_hash_tag, parse_hashline_anchor,
    strip_accidental_hashline_prefixes,
};
use crate::graph_locator::verify_syntax_delta;
use crate::sanitizer::atomic_write_bytes;
use anyhow::{bail, Context, Result};
use crate::path_guard::ensure_within_workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HunkLine {
    Context(String),
    Remove(String),
    Add(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchHunk {
    pub anchor: Option<String>,
    pub lines: Vec<HunkLine>,
    pub is_eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilePatchOp {
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
        hunks: Vec<PatchHunk>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchReport {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub moved: Vec<(String, String)>,
    pub deleted: Vec<String>,
    pub touched_paths: Vec<PathBuf>,
    pub diff_preview: String,
    #[serde(default)]
    pub syntax_diagnostics: Vec<String>,
}

/// Parse Codex `*** Begin Patch` ... `*** End Patch` text into structured operations.
pub fn parse_codex_patch(raw: &str) -> Result<Vec<FilePatchOp>> {
    let normalized = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.lines().collect();

    let start_idx = lines
        .iter()
        .position(|l| l.trim() == "*** Begin Patch")
        .ok_or_else(|| anyhow::anyhow!("patch missing '*** Begin Patch' header"))?;

    let mut ops = Vec::new();
    let mut i = start_idx + 1;
    let mut found_end = false;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed == "*** End Patch" {
            found_end = true;
            break;
        }
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Add File:") {
            let path = path.trim().to_string();
            if path.is_empty() {
                bail!("empty path in '*** Add File:' at line {}", i + 1);
            }
            i += 1;
            let mut body_lines = Vec::new();
            while i < lines.len() {
                let l = lines[i];
                if l.starts_with("*** ") {
                    break;
                }
                if let Some(rest) = l.strip_prefix('+') {
                    body_lines.push(rest);
                } else {
                    bail!(
                        "Add File '{}' line {} must start with '+': {:?}",
                        path,
                        i + 1,
                        l
                    );
                }
                i += 1;
            }
            let mut content = body_lines.join("\n");
            if !body_lines.is_empty() {
                content.push('\n');
            }
            ops.push(FilePatchOp::Add { path, content });
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Delete File:") {
            let path = path.trim().to_string();
            if path.is_empty() {
                bail!("empty path in '*** Delete File:' at line {}", i + 1);
            }
            ops.push(FilePatchOp::Delete { path });
            i += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Update File:") {
            let path = path.trim().to_string();
            if path.is_empty() {
                bail!("empty path in '*** Update File:' at line {}", i + 1);
            }
            i += 1;
            let mut move_to = None;
            if i < lines.len() {
                if let Some(dst) = lines[i].strip_prefix("*** Move to:") {
                    let dst = dst.trim().to_string();
                    if dst.is_empty() {
                        bail!("empty path in '*** Move to:' at line {}", i + 1);
                    }
                    move_to = Some(dst);
                    i += 1;
                }
            }

            let mut hunks = Vec::new();
            while i < lines.len() {
                let l = lines[i];
                if l.starts_with("*** ") && l.trim() != "*** End of File" {
                    break;
                }
                if l.starts_with("@@") {
                    let anchor_txt = l.trim_start_matches('@').trim();
                    let anchor = if anchor_txt.is_empty() {
                        None
                    } else {
                        Some(anchor_txt.to_string())
                    };
                    i += 1;
                    let mut hunk_lines = Vec::new();
                    let mut is_eof = false;
                    while i < lines.len() {
                        let hl = lines[i];
                        if hl.trim() == "*** End of File" {
                            is_eof = true;
                            i += 1;
                            break;
                        }
                        if hl.starts_with("@@") || hl.starts_with("*** ") {
                            break;
                        }
                        if let Some(rest) = hl.strip_prefix(' ') {
                            hunk_lines.push(HunkLine::Context(rest.to_string()));
                        } else if let Some(rest) = hl.strip_prefix('-') {
                            hunk_lines.push(HunkLine::Remove(rest.to_string()));
                        } else if let Some(rest) = hl.strip_prefix('+') {
                            hunk_lines.push(HunkLine::Add(rest.to_string()));
                        } else if hl.is_empty() {
                            hunk_lines.push(HunkLine::Context(String::new()));
                        } else {
                            bail!(
                                "invalid hunk line in '{}' at line {} (expected ' ', '-', or '+'): {:?}",
                                path,
                                i + 1,
                                hl
                            );
                        }
                        i += 1;
                    }
                    if hunk_lines.is_empty() {
                        bail!("empty @@ hunk in '{}'", path);
                    }
                    hunks.push(PatchHunk {
                        anchor,
                        lines: hunk_lines,
                        is_eof,
                    });
                } else if l.starts_with(' ') || l.starts_with('-') || l.starts_with('+') {
                    let mut hunk_lines = Vec::new();
                    let mut is_eof = false;
                    while i < lines.len() {
                        let hl = lines[i];
                        if hl.trim() == "*** End of File" {
                            is_eof = true;
                            i += 1;
                            break;
                        }
                        if hl.starts_with("@@") || hl.starts_with("*** ") {
                            break;
                        }
                        if let Some(rest) = hl.strip_prefix(' ') {
                            hunk_lines.push(HunkLine::Context(rest.to_string()));
                        } else if let Some(rest) = hl.strip_prefix('-') {
                            hunk_lines.push(HunkLine::Remove(rest.to_string()));
                        } else if let Some(rest) = hl.strip_prefix('+') {
                            hunk_lines.push(HunkLine::Add(rest.to_string()));
                        } else if hl.is_empty() {
                            hunk_lines.push(HunkLine::Context(String::new()));
                        } else {
                            break;
                        }
                        i += 1;
                    }
                    if !hunk_lines.is_empty() {
                        hunks.push(PatchHunk {
                            anchor: None,
                            lines: hunk_lines,
                            is_eof,
                        });
                    }
                } else if l.trim().is_empty() {
                    i += 1;
                } else {
                    bail!(
                        "unexpected line inside Update File '{}' at line {}: {:?}",
                        path,
                        i + 1,
                        l
                    );
                }
            }

            if hunks.is_empty() && move_to.is_none() {
                bail!("Update File '{}' has no hunks and no Move to target", path);
            }
            ops.push(FilePatchOp::Update {
                path,
                move_to,
                hunks,
            });
            continue;
        }

        bail!("unexpected patch directive at line {}: {:?}", i + 1, line);
    }

    if !found_end {
        bail!("patch missing '*** End Patch' footer");
    }
    if ops.is_empty() {
        bail!("patch contains zero file operations");
    }
    Ok(ops)
}

#[derive(Debug, Clone)]
enum PlannedWrite {
    Write { abs_path: PathBuf, bytes: Vec<u8> },
    Delete { abs_path: PathBuf },
}

/// Validate and apply a Codex patch atomically inside `workspace_root`.
pub fn apply_codex_patch<F>(
    workspace_root: &Path,
    patch_text: &str,
    mut authorize: F,
) -> Result<ApplyPatchReport>
where
    F: FnMut(&str, &Path) -> Result<()>,
{
    let ops = parse_codex_patch(patch_text)?;

    let mut virtual_files: HashMap<PathBuf, Option<String>> = HashMap::new();
    let mut original_crlf: HashMap<PathBuf, bool> = HashMap::new();
    let mut planned: Vec<PlannedWrite> = Vec::new();
    let mut diff_chunks: Vec<String> = Vec::new();
    let mut report = ApplyPatchReport {
        added: Vec::new(),
        updated: Vec::new(),
        moved: Vec::new(),
        deleted: Vec::new(),
        touched_paths: Vec::new(),
        diff_preview: String::new(),
        syntax_diagnostics: Vec::new(),
    };

    for op in &ops {
        match op {
            FilePatchOp::Add { path, content } => {
                let abs = ensure_within_workspace(workspace_root, path)?;
                authorize("patch", &abs)?;
                if abs.exists() && virtual_files.get(&abs).map(|o| o.is_some()).unwrap_or(true) {
                    bail!("Add File target already exists: {path}");
                }
                let raw_clean = strip_accidental_hashline_prefixes(content)
                    .unwrap_or_else(|| content.clone());
                let clean = raw_clean
                    .strip_prefix('\u{FEFF}')
                    .unwrap_or(&raw_clean)
                    .to_string();
                report
                    .syntax_diagnostics
                    .extend(verify_syntax_delta(path, "", &clean, None).format_lines());
                virtual_files.insert(abs.clone(), Some(clean.clone()));
                planned.push(PlannedWrite::Write {
                    abs_path: abs.clone(),
                    bytes: clean.as_bytes().to_vec(),
                });
                report.added.push(path.clone());
                report.touched_paths.push(abs);
            }
            FilePatchOp::Delete { path } => {
                let abs = ensure_within_workspace(workspace_root, path)?;
                authorize("patch", &abs)?;
                let exists = virtual_files
                    .get(&abs)
                    .map(|o| o.is_some())
                    .unwrap_or_else(|| abs.exists());
                if !exists {
                    bail!("Delete File target does not exist: {path}");
                }
                virtual_files.insert(abs.clone(), None);
                planned.push(PlannedWrite::Delete {
                    abs_path: abs.clone(),
                });
                report.deleted.push(path.clone());
                report.touched_paths.push(abs);
            }
            FilePatchOp::Update {
                path,
                move_to,
                hunks,
            } => {
                let src_abs = ensure_within_workspace(workspace_root, path)?;
                authorize("patch", &src_abs)?;

                let current_text = if let Some(entry) = virtual_files.get(&src_abs) {
                    entry
                        .clone()
                        .ok_or_else(|| anyhow::anyhow!("file already deleted in patch: {path}"))?
                } else {
                    let raw = fs::read_to_string(&src_abs)
                        .with_context(|| format!("failed to read Update File target: {path}"))?;
                    let uses_crlf = raw.contains("\r\n");
                    original_crlf.insert(src_abs.clone(), uses_crlf);
                    raw.replace("\r\n", "\n")
                };

                let updated_text = apply_hunks_to_text(path, &current_text, hunks)?;
                let target_rel = move_to.as_deref().unwrap_or(path);
                report.syntax_diagnostics.extend(
                    verify_syntax_delta(target_rel, &current_text, &updated_text, None)
                        .format_lines(),
                );
                let diff = format_compact_unified_diff(
                    target_rel,
                    &current_text,
                    &updated_text,
                    24,
                );
                if !diff.is_empty() && diff_chunks.len() < 4 {
                    diff_chunks.push(diff);
                }

                let uses_crlf = original_crlf.get(&src_abs).copied().unwrap_or(false);
                let final_str = if uses_crlf {
                    updated_text.replace('\n', "\r\n")
                } else {
                    updated_text.clone()
                };

                if let Some(dst_rel) = move_to {
                    let dst_abs = ensure_within_workspace(workspace_root, dst_rel)?;
                    authorize("patch", &dst_abs)?;
                    virtual_files.insert(src_abs.clone(), None);
                    virtual_files.insert(dst_abs.clone(), Some(updated_text));
                    planned.push(PlannedWrite::Delete {
                        abs_path: src_abs.clone(),
                    });
                    planned.push(PlannedWrite::Write {
                        abs_path: dst_abs.clone(),
                        bytes: final_str.into_bytes(),
                    });
                    report.moved.push((path.clone(), dst_rel.clone()));
                    report.touched_paths.push(src_abs);
                    report.touched_paths.push(dst_abs);
                } else {
                    virtual_files.insert(src_abs.clone(), Some(updated_text));
                    planned.push(PlannedWrite::Write {
                        abs_path: src_abs.clone(),
                        bytes: final_str.into_bytes(),
                    });
                    report.updated.push(path.clone());
                    report.touched_paths.push(src_abs);
                }
            }
        }
    }

    // Phase 2: Snapshot backups of all touched existing files
    let mut backups: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();
    for p in &planned {
        let abs = match p {
            PlannedWrite::Write { abs_path, .. } | PlannedWrite::Delete { abs_path } => abs_path,
        };
        if !backups.contains_key(abs) {
            let prev = if abs.exists() {
                Some(fs::read(abs).with_context(|| format!("failed to backup {}", abs.display()))?)
            } else {
                None
            };
            backups.insert(abs.clone(), prev);
        }
    }

    // Phase 3: Commit atomically with BOM-free temp-write-rename + rollback on OS I/O error
    let commit_res: Result<()> = (|| {
        for p in &planned {
            match p {
                PlannedWrite::Write { abs_path, bytes } => {
                    atomic_write_bytes(abs_path, bytes)?;
                }
                PlannedWrite::Delete { abs_path } => {
                    if abs_path.exists() {
                        fs::remove_file(abs_path)?;
                    }
                }
            }
        }
        Ok(())
    })();

    if let Err(err) = commit_res {
        for (abs, prev) in backups {
            match prev {
                Some(bytes) => {
                    let _ = fs::write(&abs, bytes);
                }
                None => {
                    let _ = fs::remove_file(&abs);
                }
            }
        }
        return Err(err.context("apply_patch commit failed; rolled back all files cleanly"));
    }

    report.diff_preview = diff_chunks.join("\n");
    Ok(report)
}

fn apply_hunks_to_text(path: &str, original: &str, hunks: &[PatchHunk]) -> Result<String> {
    let had_trailing_newline = original.ends_with('\n');
    let mut doc_lines: Vec<String> = if original.is_empty() {
        Vec::new()
    } else {
        original
            .strip_suffix('\n')
            .unwrap_or(original)
            .split('\n')
            .map(String::from)
            .collect()
    };

    let mut search_from = 0usize;

    for (h_idx, hunk) in hunks.iter().enumerate() {
        let mut old_seq: Vec<String> = hunk
            .lines
            .iter()
            .filter_map(|l| match l {
                HunkLine::Context(s) | HunkLine::Remove(s) => Some(s.clone()),
                HunkLine::Add(_) => None,
            })
            .collect();
        let mut new_seq: Vec<String> = hunk
            .lines
            .iter()
            .filter_map(|l| match l {
                HunkLine::Context(s) | HunkLine::Add(s) => Some(s.clone()),
                HunkLine::Remove(_) => None,
            })
            .collect();

        // Defensive strip guard if model copied `42:a3f| ` prefixes into hunk lines
        let joined_old = old_seq.join("\n");
        if let Some(cleaned) = strip_accidental_hashline_prefixes(&joined_old) {
            old_seq = cleaned.split('\n').map(String::from).collect();
            let joined_new = new_seq.join("\n");
            if let Some(cleaned_n) = strip_accidental_hashline_prefixes(&joined_new) {
                new_seq = cleaned_n.split('\n').map(String::from).collect();
            }
        }

        if old_seq.is_empty() {
            let insert_at = if hunk.is_eof {
                doc_lines.len()
            } else if let Some(ref anc) = hunk.anchor {
                find_anchor_line(&doc_lines, anc, search_from)
                    .map(|idx| idx + 1)
                    .unwrap_or(doc_lines.len())
            } else {
                doc_lines.len()
            };
            doc_lines.splice(insert_at..insert_at, new_seq.iter().cloned());
            search_from = insert_at + new_seq.len();
            continue;
        }

        let anchor_hint = hunk
            .anchor
            .as_deref()
            .and_then(|anc| find_anchor_line(&doc_lines, anc, search_from))
            .unwrap_or(search_from);

        let old_refs: Vec<&str> = old_seq.iter().map(|s| s.as_str()).collect();
        let (pos, match_len) = find_sequence_span(&doc_lines, &old_refs, anchor_hint, hunk.is_eof)
            .or_else(|| find_sequence_span(&doc_lines, &old_refs, 0, hunk.is_eof))
            .ok_or_else(|| {
                let preview = old_refs.iter().take(4).copied().collect::<Vec<_>>().join("\n");
                anyhow::anyhow!(
                    "apply_patch failed on '{path}' hunk #{}: could not locate expected lines:\n{preview}",
                    h_idx + 1
                )
            })?;

        doc_lines.splice(pos..(pos + match_len), new_seq.iter().cloned());
        search_from = pos + new_seq.len();
    }

    let mut result = doc_lines.join("\n");
    if (had_trailing_newline || original.is_empty()) && !result.is_empty() {
        result.push('\n');
    }
    Ok(result)
}

fn find_anchor_line(doc: &[String], anchor: &str, start: usize) -> Option<usize> {
    let anc = anchor.trim();
    if anc.is_empty() {
        return None;
    }
    // Support Hashline anchor in `@@ 42:a3f` header!
    if let Ok((line_1, tag)) = parse_hashline_anchor(anc) {
        let doc_refs: Vec<&str> = doc.iter().map(|s| s.as_str()).collect();
        let check = |idx0: usize| -> bool {
            if idx0 >= doc_refs.len() {
                return false;
            }
            let prev = if idx0 > 0 { doc_refs[idx0 - 1].trim() } else { "" };
            let curr = doc_refs[idx0].trim();
            let next = if idx0 + 1 < doc_refs.len() {
                doc_refs[idx0 + 1].trim()
            } else {
                ""
            };
            line_hash_tag(prev, curr, next) == tag
        };
        if check(line_1 - 1) {
            return Some(line_1 - 1);
        }
        let lo = line_1.saturating_sub(16);
        let hi = (line_1 + 15).min(doc.len().saturating_sub(1));
        let hits: Vec<usize> = (lo..=hi).filter(|&i| check(i)).collect();
        if hits.len() == 1 {
            return Some(hits[0]);
        }
    }

    (start..doc.len())
        .find(|&i| doc[i].trim() == anc)
        .or_else(|| (start..doc.len()).find(|&i| doc[i].contains(anc)))
}

fn find_sequence_span(
    doc: &[String],
    needle: &[&str],
    start: usize,
    eof: bool,
) -> Option<(usize, usize)> {
    if needle.is_empty() || needle.len() > doc.len() {
        return None;
    }
    let max_start = doc.len() - needle.len();
    let candidates: Vec<usize> = if eof {
        vec![max_start]
    } else {
        (start.min(max_start)..=max_start).collect()
    };

    // Tier 1: exact line match
    for &i in &candidates {
        if (0..needle.len()).all(|j| doc[i + j] == needle[j]) {
            return Some((i, needle.len()));
        }
    }
    // Tier 1b: trailing whitespace-tolerant match
    for &i in &candidates {
        if (0..needle.len()).all(|j| doc[i + j].trim_end() == needle[j].trim_end()) {
            return Some((i, needle.len()));
        }
    }
    // Tier 2: full trimmed match (must be unique in search window)
    let trimmed_hits: Vec<usize> = candidates
        .into_iter()
        .filter(|&i| (0..needle.len()).all(|j| doc[i + j].trim() == needle[j].trim()))
        .collect();
    if trimmed_hits.len() == 1 {
        return Some((trimmed_hits[0], needle.len()));
    }

    // Tier 3: `imara-diff` Histogram fuzzy hunk fallback (unique >= 0.88, margin >= 0.10)
    if !eof {
        let doc_refs: Vec<&str> = doc.iter().map(|s| s.as_str()).collect();
        if let Some((s, e)) = find_unique_histogram_window(&doc_refs, needle) {
            return Some((s, e - s));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_multi_file_codex_patch_atomically_and_rolls_back_on_error() {
        let tmp = std::env::temp_dir().join(format!("omni_patch_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.py"), "def add(x, y):\n    return x - y\n").unwrap();
        fs::write(tmp.join("old.txt"), "remove me\n").unwrap();

        // 1. Failing multi-file patch must NOT touch a.py on disk (dry-run rollback!)
        let bad_patch = "\
*** Begin Patch
*** Update File: a.py
@@ def add(x, y):
 def add(x, y):
-    return x - y
+    return x + y
*** Update File: nonexistent.py
@@
-foo
+bar
*** End Patch";
        assert!(apply_codex_patch(&tmp, bad_patch, |_, _| Ok(())).is_err());
        assert_eq!(
            fs::read_to_string(tmp.join("a.py")).unwrap(),
            "def add(x, y):\n    return x - y\n",
            "failed dry-run patch must leave workspace untouched"
        );

        // 2. Valid multi-file patch (update + add + delete) succeeds cleanly with unified diff preview
        let good_patch = "\
*** Begin Patch
*** Update File: a.py
@@ def add(x, y):
 def add(x, y):
-    return x - y
+    return x + y
*** Add File: sub/b.py
+def mul(x, y):
+    return x * y
*** Delete File: old.txt
*** End Patch";
        let rep = apply_codex_patch(&tmp, good_patch, |_, _| Ok(())).unwrap();
        assert_eq!(rep.updated, vec!["a.py"]);
        assert_eq!(rep.added, vec!["sub/b.py"]);
        assert_eq!(rep.deleted, vec!["old.txt"]);
        assert!(rep.diff_preview.contains("return x + y"));
        assert_eq!(
            fs::read_to_string(tmp.join("a.py")).unwrap(),
            "def add(x, y):\n    return x + y\n"
        );
        assert!(tmp.join("sub/b.py").exists());
        assert!(!tmp.join("old.txt").exists());

        // 3. Traversal escape must be blocked before touching anything
        let evil_patch = "\
*** Begin Patch
*** Add File: ../escaped.txt
+pwned
*** End Patch";
        assert!(apply_codex_patch(&tmp, evil_patch, |_, _| Ok(())).is_err());

        // 4. Move to + whitespace-tolerant hunk update
        let move_patch = "\
*** Begin Patch
*** Update File: a.py
*** Move to: pkg/math_ops.py
@@
 def add(x, y):
-  return x + y
+    return int(x + y)
*** End Patch";
        let rep2 = apply_codex_patch(&tmp, move_patch, |_, _| Ok(())).unwrap();
        assert_eq!(rep2.moved, vec![("a.py".into(), "pkg/math_ops.py".into())]);
        assert!(!tmp.join("a.py").exists());
        assert_eq!(
            fs::read_to_string(tmp.join("pkg/math_ops.py")).unwrap(),
            "def add(x, y):\n    return int(x + y)\n"
        );

        // 5. Multiple trailing blank lines are preserved across updates
        fs::write(tmp.join("blanks.txt"), "alpha\nbeta\n\n\n").unwrap();
        let blank_patch = "\
*** Begin Patch
*** Update File: blanks.txt
@@
-alpha
+ALPHA
 beta
*** End Patch";
        apply_codex_patch(&tmp, blank_patch, |_, _| Ok(())).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.join("blanks.txt")).unwrap(),
            "ALPHA\nbeta\n\n\n",
            "multiple trailing blank lines must be preserved"
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
