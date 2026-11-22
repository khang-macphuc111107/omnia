//! Frontier `v0.3.0` Hashline Content-Addressable Anchors (`42:a3f|`) +
//! Claude Code `(mtime, blake3)` Pre-Read Guard + 3-Tier `imara-diff` Histogram Edit Engine.
//!
//! Features:
//! 1. **Hashline 12-bit (`3` hex chars) Content+Neighbor Anchors** via `xxhash_rust::xxh3::xxh3_64`.
//! 2. **Mode 1 (`start_anchor` / `end_anchor`):** $O(1)$ verified line-range splice with unique
//!    $\pm 15$-line relocation on line-number drift (cuts edit output tokens by 50–80%!).
//! 3. **Mode 2 (`old_string` / `new_string`) 3-Tier Fallback Cascade:**
//!    - Tier 1: SIMD exact match (`memchr::memmem::find_iter`) + **defensive Hashline-prefix strip guard**
//!      if a model accidentally copied `42:a3f| ` prefixes from `read_file`.
//!    - Tier 2: Unique indentation-normalized Fast Apply preserving real base indentation.
//!    - Tier 3: `imara-diff` Histogram fuzzy hunk alignment (multi-line `>= 3` lines ONLY, strict
//!      uniqueness proof: `sim_best >= 0.88 && (sim_best - sim_second_best) >= 0.10` + boundary match!).
//! 4. **Post-Edit Compact Unified Diff (`imara-diff`)** with fresh Hashlines for instant verification.

use crate::cache_guard::blake3_hex;
use crate::graph_locator::verify_syntax_delta;
use crate::sanitizer::{atomic_write_bom_free, format_fail_fast_error};
use anyhow::{bail, Context, Result};
use imara_diff::{Algorithm, Diff, InternedInput};
use memchr::memmem;
use crate::path_guard::ensure_within_workspace;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use xxhash_rust::xxh3::xxh3_64;

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Compute deterministic 12-bit (3 lowercase ASCII hex chars) Hashline anchor from trimmed
/// line content plus immediate neighbor lines so repeated braces/blank lines get unique tags.
pub fn line_hash_tag(prev_trimmed: &str, curr_trimmed: &str, next_trimmed: &str) -> [u8; 3] {
    let mut buf = Vec::with_capacity(prev_trimmed.len() + curr_trimmed.len() + next_trimmed.len() + 2);
    buf.extend_from_slice(prev_trimmed.as_bytes());
    buf.push(0x1f);
    buf.extend_from_slice(curr_trimmed.as_bytes());
    buf.push(0x1f);
    buf.extend_from_slice(next_trimmed.as_bytes());
    let h = xxh3_64(&buf);
    let n0 = ((h >> 8) & 0x0f) as usize;
    let n1 = ((h >> 4) & 0x0f) as usize;
    let n2 = (h & 0x0f) as usize;
    [HEX_LOWER[n0], HEX_LOWER[n1], HEX_LOWER[n2]]
}

pub fn line_hash_tag_str(lines: &[&str], idx0: usize) -> String {
    let prev = if idx0 > 0 { lines[idx0 - 1].trim() } else { "" };
    let curr = lines[idx0].trim();
    let next = if idx0 + 1 < lines.len() {
        lines[idx0 + 1].trim()
    } else {
        ""
    };
    let tag = line_hash_tag(prev, curr, next);
    String::from_utf8_lossy(&tag).into_owned()
}

pub fn format_hashline(line_num_1: usize, tag: &[u8; 3], line_text: &str) -> String {
    let tag_s = std::str::from_utf8(tag).unwrap_or("000");
    format!("{line_num_1:>4}:{tag_s}| {line_text}")
}

/// Parse a Hashline anchor such as `"42:a3f"` or `"L42:a3f"` into `(1-based line, 3-char tag)`.
pub fn parse_hashline_anchor(raw: &str) -> Result<(usize, [u8; 3])> {
    let clean = raw
        .trim()
        .trim_start_matches(['L', 'l'])
        .trim_end_matches('|');
    let (line_s, hash_s) = clean
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("invalid hashline anchor '{raw}' (expected '<line>:<3-hex>', e.g. '42:a3f')"))?;
    let line_1: usize = line_s
        .trim()
        .parse()
        .with_context(|| format!("invalid line number in anchor '{raw}'"))?;
    if line_1 == 0 {
        bail!("anchor line number must be >= 1 in '{raw}'");
    }
    let hb = hash_s.trim().to_ascii_lowercase();
    let bytes = hb.as_bytes();
    if bytes.len() != 3 || !bytes.iter().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid 3-hex hash in anchor '{raw}' (expected e.g. '42:a3f')");
    }
    Ok((line_1, [bytes[0], bytes[1], bytes[2]]))
}

/// Defensive guard: if a model accidentally copied `  42:a3f| ` prefixes from `read_file`
/// into `old_string` or a patch hunk, strip them cleanly so Tier-1 exact matching succeeds!
pub fn strip_accidental_hashline_prefixes(text: &str) -> Option<String> {
    static HL_PREFIX: OnceLock<Regex> = OnceLock::new();
    let re = HL_PREFIX.get_or_init(|| Regex::new(r"^[ \t]*\d+:[0-9a-fA-F]{3}\|[ ]?").unwrap());

    let lines: Vec<&str> = text.split('\n').collect();
    let non_empty: usize = lines.iter().filter(|l| !l.trim().is_empty()).count();
    if non_empty == 0 {
        return None;
    }
    let matched: usize = lines
        .iter()
        .filter(|l| !l.trim().is_empty() && re.is_match(l))
        .count();
    if matched == 0 || matched * 2 < non_empty {
        return None;
    }

    let cleaned: Vec<String> = lines
        .into_iter()
        .map(|l| re.replace(l, "").into_owned())
        .collect();
    Some(cleaned.join("\n"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileReadSnapshot {
    pub mtime_secs: i64,
    pub mtime_nanos: u32,
    pub sha256: String,
}

#[derive(Debug, Clone, Default)]
pub struct FileReadTracker {
    entries: Arc<Mutex<HashMap<PathBuf, FileReadSnapshot>>>,
}

impl FileReadTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_read(&self, abs_path: &Path, raw_bytes: &[u8]) {
        let (mtime_secs, mtime_nanos) = fs::metadata(abs_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| (d.as_secs() as i64, d.subsec_nanos()))
            .unwrap_or((0, 0));
        let digest = blake3_hex(raw_bytes);
        self.entries.lock().unwrap().insert(
            abs_path.to_path_buf(),
            FileReadSnapshot {
                mtime_secs,
                mtime_nanos,
                sha256: digest,
            },
        );
    }

    pub fn refresh_from_disk(&self, abs_path: &Path) {
        if let Ok(bytes) = fs::read(abs_path) {
            self.record_read(abs_path, &bytes);
        }
    }

    pub fn get(&self, abs_path: &Path) -> Option<FileReadSnapshot> {
        self.entries.lock().unwrap().get(abs_path).cloned()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditFileResult {
    pub path: String,
    pub replacements: usize,
    pub match_mode: String,
    pub line_start: usize,
    pub line_end: usize,
    pub diff_preview: String,
    #[serde(default)]
    pub syntax_diagnostics: Vec<String>,
}

fn verify_pre_read_guard(
    workspace_root: &Path,
    rel_path: &str,
    tracker: &FileReadTracker,
) -> Result<(PathBuf, String, bool, bool)> {
    let abs = ensure_within_workspace(workspace_root, rel_path)?;
    if !abs.exists() {
        bail!(
            "{}",
            format_fail_fast_error(
                "edit_file target does not exist",
                "path",
                rel_path,
                "Use write_file to create new files or check path via workspace_map"
            )
        );
    }
    let raw_bytes = fs::read(&abs).with_context(|| format!("failed to read {rel_path}"))?;
    let current_digest = blake3_hex(&raw_bytes);

    match tracker.get(&abs) {
        None => {
            bail!(
                "{}",
                format_fail_fast_error(
                    "Pre-Read Guard: file not yet read in this session",
                    "path",
                    rel_path,
                    &format!("Call read_file(path=\"{rel_path}\") before edit_file")
                )
            );
        }
        Some(snap) if snap.sha256 != current_digest => {
            bail!(
                "{}",
                format_fail_fast_error(
                    "Pre-Read Guard: file changed on disk since last read_file",
                    "path",
                    &format!("{rel_path} (expected {}, actual {})", &snap.sha256[..12], &current_digest[..12]),
                    &format!("Call read_file(path=\"{rel_path}\") again before edit_file")
                )
            );
        }
        Some(_) => {}
    }

    let raw_text = String::from_utf8(raw_bytes)
        .with_context(|| format!("'{rel_path}' is not valid UTF-8"))?;
    let had_bom = raw_text.starts_with('\u{FEFF}');
    let uses_crlf = raw_text.contains("\r\n");
    let norm = raw_text.replace("\r\n", "\n");
    Ok((abs, norm, uses_crlf, had_bom))
}

/// Mode 1: Hashline Content-Addressable Line-Range Splice (`start_anchor`, optional `end_anchor`).
pub fn edit_file_by_hashline(
    workspace_root: &Path,
    rel_path: &str,
    start_anchor: &str,
    end_anchor: Option<&str>,
    new_string: &str,
    tracker: &FileReadTracker,
) -> Result<EditFileResult> {
    let (abs, norm_content, uses_crlf, had_bom) =
        verify_pre_read_guard(workspace_root, rel_path, tracker)?;
    let (start_1, start_tag) = parse_hashline_anchor(start_anchor)?;
    let (end_1, end_tag) = match end_anchor.filter(|s| !s.trim().is_empty()) {
        Some(ea) => parse_hashline_anchor(ea)?,
        None => (start_1, start_tag),
    };
    if end_1 < start_1 {
        bail!("end_anchor line {end_1} must be >= start_anchor line {start_1}");
    }

    let had_trailing_nl = norm_content.ends_with('\n');
    let doc_lines: Vec<&str> = if norm_content.is_empty() {
        Vec::new()
    } else {
        norm_content
            .strip_suffix('\n')
            .unwrap_or(&norm_content)
            .split('\n')
            .collect()
    };
    let total = doc_lines.len();
    let span = end_1 - start_1 + 1;

    let tag_at = |idx0: usize| -> [u8; 3] {
        let prev = if idx0 > 0 { doc_lines[idx0 - 1].trim() } else { "" };
        let curr = doc_lines[idx0].trim();
        let next = if idx0 + 1 < total {
            doc_lines[idx0 + 1].trim()
        } else {
            ""
        };
        line_hash_tag(prev, curr, next)
    };

    let mut match_mode = "hashline_exact";
    let (resolved_start0, resolved_end0) = if end_1 <= total
        && tag_at(start_1 - 1) == start_tag
        && tag_at(end_1 - 1) == end_tag
    {
        (start_1 - 1, end_1 - 1)
    } else {
        // Unique relocation within +-15 lines radius for drifted line numbers
        let lo = start_1.saturating_sub(16);
        let hi = (start_1 + 15).min(total.saturating_sub(span));
        let mut cands = Vec::new();
        if total >= span {
            for s0 in lo..=hi {
                let e0 = s0 + span - 1;
                if e0 < total && tag_at(s0) == start_tag && tag_at(e0) == end_tag {
                    cands.push((s0, e0));
                }
            }
        }
        if cands.len() == 1 {
            match_mode = "hashline_relocated";
            cands[0]
        } else {
            let preview = render_fresh_window(&doc_lines, start_1.saturating_sub(1), 5);
            bail!(
                "Hashline mismatch in '{rel_path}' for anchor '{start_anchor}'..'{:?}' (file has {total} lines). Fresh anchors around line {start_1}:\n{preview}",
                end_anchor.unwrap_or(start_anchor)
            );
        }
    };

    let clean_new = strip_accidental_hashline_prefixes(new_string).unwrap_or_else(|| new_string.to_string());
    let norm_new = clean_new.replace("\r\n", "\n");
    let new_lines: Vec<&str> = if norm_new.is_empty() {
        Vec::new()
    } else {
        norm_new
            .strip_suffix('\n')
            .unwrap_or(&norm_new)
            .split('\n')
            .collect()
    };

    let mut out_lines: Vec<&str> = Vec::with_capacity(total + new_lines.len());
    out_lines.extend_from_slice(&doc_lines[..resolved_start0]);
    out_lines.extend_from_slice(&new_lines);
    out_lines.extend_from_slice(&doc_lines[(resolved_end0 + 1)..]);

    let mut updated_norm = out_lines.join("\n");
    if (had_trailing_nl || norm_new.ends_with('\n')) && !updated_norm.is_empty() {
        updated_norm.push('\n');
    }

    let diff_preview = format_compact_unified_diff(rel_path, &norm_content, &updated_norm, 40);
    let ls = resolved_start0 + 1;
    let le = resolved_start0 + new_lines.len().max(1);
    let syntax_diagnostics =
        verify_syntax_delta(rel_path, &norm_content, &updated_norm, Some((ls, le))).format_lines();
    let final_output = if uses_crlf {
        updated_norm.replace('\n', "\r\n")
    } else {
        updated_norm
    };

    atomic_write_bom_free(&abs, &final_output, had_bom)
        .with_context(|| format!("failed to write edited file {rel_path}"))?;
    let written_bytes = if had_bom {
        final_output.as_bytes()
    } else {
        final_output.strip_prefix('\u{FEFF}').unwrap_or(&final_output).as_bytes()
    };
    tracker.record_read(&abs, written_bytes);

    Ok(EditFileResult {
        path: rel_path.to_string(),
        replacements: 1,
        match_mode: match_mode.to_string(),
        line_start: ls,
        line_end: le,
        diff_preview,
        syntax_diagnostics,
    })
}

/// Mode 2: Classic `(old_string, new_string)` with 3-Tier Cascade + Defensive Hashline Strip Guard.
pub fn edit_file_guarded(
    workspace_root: &Path,
    rel_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    tracker: &FileReadTracker,
) -> Result<EditFileResult> {
    if old_string.is_empty() {
        bail!(
            "{}",
            format_fail_fast_error(
                "old_string must not be empty",
                "old_string",
                "\"\"",
                "Provide non-empty old_string or use start_anchor/end_anchor hashlines"
            )
        );
    }
    if old_string == new_string {
        bail!(
            "{}",
            format_fail_fast_error(
                "old_string and new_string are identical (no-op edit)",
                "new_string",
                "identical to old_string",
                "Provide a different new_string reflecting the desired change"
            )
        );
    }

    let (abs, norm_content, uses_crlf, had_bom) =
        verify_pre_read_guard(workspace_root, rel_path, tracker)?;
    let mut norm_old = old_string.replace("\r\n", "\n");
    let mut norm_new = new_string.replace("\r\n", "\n");

    // Tier 1: SIMD exact match via `memchr::memmem`
    let mut exact_positions: Vec<usize> =
        memmem::find_iter(norm_content.as_bytes(), norm_old.as_bytes()).collect();

    // Defensive strip guard: if Tier 1 missed AND old_string has copied `42:a3f| ` prefixes, strip & retry!
    let mut stripped_hashlines = false;
    if exact_positions.is_empty() {
        if let Some(cleaned_old) = strip_accidental_hashline_prefixes(&norm_old) {
            let cleaned_new =
                strip_accidental_hashline_prefixes(&norm_new).unwrap_or_else(|| norm_new.clone());
            let retry_pos: Vec<usize> =
                memmem::find_iter(norm_content.as_bytes(), cleaned_old.as_bytes()).collect();
            norm_old = cleaned_old;
            norm_new = cleaned_new;
            exact_positions = retry_pos;
            stripped_hashlines = true;
        }
    }

    let (updated_norm, replacements, match_mode, line_start, line_end) = if !exact_positions.is_empty()
    {
        if replace_all {
            let first_line = byte_offset_to_line(&norm_content, exact_positions[0]);
            let last_line = byte_offset_to_line(
                &norm_content,
                *exact_positions.last().unwrap() + norm_old.len(),
            );
            (
                norm_content.replace(&norm_old, &norm_new),
                exact_positions.len(),
                "exact_all".to_string(),
                first_line,
                last_line,
            )
        } else if exact_positions.len() == 1 {
            let pos = exact_positions[0];
            let line_start = byte_offset_to_line(&norm_content, pos);
            let mut out = String::with_capacity(
                norm_content.len() - norm_old.len() + norm_new.len(),
            );
            out.push_str(&norm_content[..pos]);
            out.push_str(&norm_new);
            out.push_str(&norm_content[pos + norm_old.len()..]);
            let line_end = line_start + norm_new.matches('\n').count();
            let mode = if stripped_hashlines {
                "exact_hashline_stripped"
            } else {
                "exact"
            };
            (out, 1, mode.to_string(), line_start, line_end)
        } else {
            let line_nums: Vec<String> = exact_positions
                .iter()
                .take(8)
                .map(|&p| byte_offset_to_line(&norm_content, p).to_string())
                .collect();
            bail!(
                "edit_file ambiguity in '{rel_path}': old_string matched {} times (lines {}). Include more surrounding context, use start_anchor/end_anchor hashlines, or pass replace_all: true.",
                exact_positions.len(),
                line_nums.join(", ")
            );
        }
    } else if !replace_all {
        // Tier 2: Unique indentation-normalized Fast Apply
        if let Some((updated, ls, le)) =
            fast_apply_indent_normalized(&norm_content, &norm_old, &norm_new)
        {
            (
                updated,
                1,
                "fast_apply_indent_normalized".to_string(),
                ls,
                le,
            )
        } else if let Some((updated, ls, le)) =
            tier3_imara_histogram_fuzzy_apply(&norm_content, &norm_old, &norm_new)
        {
            // Tier 3: `imara-diff` Histogram fuzzy hunk with formal uniqueness proof (sim >= 0.88, margin >= 0.10)
            (updated, 1, "imara_histogram_fuzzy".to_string(), ls, le)
        } else {
            bail!(
                "edit_file failed on '{rel_path}': old_string not found (exact, indent-normalized, and strict unique Histogram fuzzy all missed). Re-read the target lines with read_file and use exact text or start_anchor/end_anchor hashlines."
            );
        }
    } else {
        bail!("edit_file failed on '{rel_path}': old_string not found for replace_all");
    };

    let diff_preview = format_compact_unified_diff(rel_path, &norm_content, &updated_norm, 40);
    let syntax_diagnostics = verify_syntax_delta(
        rel_path,
        &norm_content,
        &updated_norm,
        Some((line_start, line_end)),
    )
    .format_lines();
    let final_output = if uses_crlf {
        updated_norm.replace('\n', "\r\n")
    } else {
        updated_norm
    };

    atomic_write_bom_free(&abs, &final_output, had_bom)
        .with_context(|| format!("failed to write edited file {rel_path}"))?;
    let written_bytes = if had_bom {
        final_output.as_bytes()
    } else {
        final_output.strip_prefix('\u{FEFF}').unwrap_or(&final_output).as_bytes()
    };
    tracker.record_read(&abs, written_bytes);

    Ok(EditFileResult {
        path: rel_path.to_string(),
        replacements,
        match_mode,
        line_start,
        line_end,
        diff_preview,
        syntax_diagnostics,
    })
}

fn byte_offset_to_line(text: &str, byte_idx: usize) -> usize {
    let clamped = byte_idx.min(text.len());
    memchr::memchr_iter(b'\n', &text.as_bytes()[..clamped]).count() + 1
}

fn render_fresh_window(lines: &[&str], center0: usize, radius: usize) -> String {
    if lines.is_empty() {
        return "(empty file)".into();
    }
    let lo = center0.saturating_sub(radius).min(lines.len() - 1);
    let hi = (center0 + radius).min(lines.len() - 1);
    let mut out = Vec::new();
    for i in lo..=hi {
        let prev = if i > 0 { lines[i - 1].trim() } else { "" };
        let curr = lines[i].trim();
        let next = if i + 1 < lines.len() { lines[i + 1].trim() } else { "" };
        let tag = line_hash_tag(prev, curr, next);
        out.push(format_hashline(i + 1, &tag, lines[i]));
    }
    out.join("\n")
}

/// Tier 2: Cursor Fast Apply fallback — matches when ONLY horizontal indentation differs,
/// strictly unique match ONLY, preserving file's real base indentation on replacement lines.
fn fast_apply_indent_normalized(
    content: &str,
    old_str: &str,
    new_str: &str,
) -> Option<(String, usize, usize)> {
    let had_trailing_nl = content.ends_with('\n');
    let content_lines: Vec<&str> = content
        .strip_suffix('\n')
        .unwrap_or(content)
        .split('\n')
        .collect();
    let old_lines: Vec<&str> = old_str
        .strip_suffix('\n')
        .unwrap_or(old_str)
        .split('\n')
        .collect();
    if old_lines.is_empty() || old_lines.len() > content_lines.len() {
        return None;
    }

    let norm_old: Vec<&str> = old_lines.iter().map(|l| l.trim()).collect();
    if norm_old.iter().all(|l| l.is_empty()) {
        return None;
    }

    let mut matches = Vec::new();
    for start in 0..=(content_lines.len() - old_lines.len()) {
        let ok = (0..old_lines.len()).all(|j| content_lines[start + j].trim() == norm_old[j]);
        if ok {
            matches.push(start);
        }
    }

    if matches.len() != 1 {
        return None;
    }
    let start = matches[0];
    let reindented_new = reindent_replacement(&content_lines, start, &old_lines, new_str);

    let mut out_lines: Vec<String> = Vec::with_capacity(content_lines.len() + reindented_new.len());
    for l in &content_lines[..start] {
        out_lines.push((*l).to_string());
    }
    out_lines.extend(reindented_new.iter().cloned());
    for l in &content_lines[(start + old_lines.len())..] {
        out_lines.push((*l).to_string());
    }

    let mut joined = out_lines.join("\n");
    if had_trailing_nl {
        joined.push('\n');
    }
    Some((joined, start + 1, start + reindented_new.len()))
}

/// Tier 3: `imara-diff` Histogram-anchored fuzzy hunk matcher with formal uniqueness proof:
/// - Requires `>= 3` non-empty lines in `old_str`.
/// - Boundary lines (first & last non-empty lines of `old_str`) must match trimmed.
/// - Computes normalized Histogram LCS similarity `sim = 2 * kept / (|W| + |Q|)`.
/// - Accepts ONLY if `best_sim >= 0.88` AND `(best_sim - second_best_sim) >= 0.10`!
pub fn find_unique_histogram_window(doc_lines: &[&str], needle_lines: &[&str]) -> Option<(usize, usize)> {
    let non_empty_count = needle_lines.iter().filter(|l| !l.trim().is_empty()).count();
    if non_empty_count < 3 || doc_lines.len() < 3 {
        return None;
    }

    let first_ne = needle_lines.iter().position(|l| !l.trim().is_empty())?;
    let last_ne = needle_lines.iter().rposition(|l| !l.trim().is_empty())?;
    let first_trim = needle_lines[first_ne].trim();
    let last_trim = needle_lines[last_ne].trim();

    let m = needle_lines.len();
    let min_win = ((m as f64 * 0.8).floor() as usize).max(3);
    let max_win = ((m as f64 * 1.2).ceil() as usize).min(doc_lines.len());
    let needle_trimmed: String = needle_lines
        .iter()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join("\n");

    let mut scored: Vec<(f64, usize, usize)> = Vec::new();
    for s in 0..doc_lines.len() {
        // Anchor start: first non-empty line matches trimmed
        let check_s = s + first_ne;
        if check_s >= doc_lines.len() || doc_lines[check_s].trim() != first_trim {
            continue;
        }
        let mut best_for_s: Option<(f64, usize)> = None;
        for len in min_win..=max_win {
            let end_excl = s + len;
            if end_excl > doc_lines.len() {
                break;
            }
            // Boundary check: last line of window matches last non-empty line trimmed
            let last_idx = end_excl - 1 - (m - 1 - last_ne).min(len - 1);
            if doc_lines[last_idx].trim() != last_trim {
                continue;
            }
            let win_trimmed: String = doc_lines[s..end_excl]
                .iter()
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join("\n");
            let sim = histogram_line_similarity(&win_trimmed, &needle_trimmed, len, m);
            if best_for_s.is_none_or(|(bs, _)| sim > bs) {
                best_for_s = Some((sim, end_excl));
            }
        }
        if let Some((sim, end_excl)) = best_for_s {
            if sim >= 0.70 {
                scored.push((sim, s, end_excl));
            }
        }
    }

    if scored.is_empty() {
        return None;
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best_sim, best_s, best_e) = scored[0];
    if best_sim < 0.88 {
        return None;
    }
    // Find best non-overlapping competitor window for uniqueness margin proof
    let second_sim = scored
        .iter()
        .skip(1)
        .find(|&&(_, s, e)| e <= best_s || s >= best_e)
        .map(|&(sim, _, _)| sim)
        .unwrap_or(0.0);

    if (best_sim - second_sim) >= 0.10 {
        Some((best_s, best_e))
    } else {
        None
    }
}

fn histogram_line_similarity(win_trimmed: &str, needle_trimmed: &str, win_len: usize, needle_len: usize) -> f64 {
    if win_len + needle_len == 0 {
        return 1.0;
    }
    let input = InternedInput::new(win_trimmed, needle_trimmed);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    let removed = diff.count_removals() as usize;
    let lcs = win_len.saturating_sub(removed);
    (2.0 * lcs as f64) / ((win_len + needle_len) as f64)
}

fn tier3_imara_histogram_fuzzy_apply(
    content: &str,
    old_str: &str,
    new_str: &str,
) -> Option<(String, usize, usize)> {
    let had_trailing_nl = content.ends_with('\n');
    let content_lines: Vec<&str> = content
        .strip_suffix('\n')
        .unwrap_or(content)
        .split('\n')
        .collect();
    let old_lines: Vec<&str> = old_str
        .strip_suffix('\n')
        .unwrap_or(old_str)
        .split('\n')
        .collect();

    let (start, end_excl) = find_unique_histogram_window(&content_lines, &old_lines)?;
    let reindented_new = reindent_replacement(&content_lines, start, &old_lines, new_str);

    let mut out_lines: Vec<String> = Vec::with_capacity(content_lines.len() + reindented_new.len());
    for l in &content_lines[..start] {
        out_lines.push((*l).to_string());
    }
    out_lines.extend(reindented_new.iter().cloned());
    for l in &content_lines[end_excl..] {
        out_lines.push((*l).to_string());
    }

    let mut joined = out_lines.join("\n");
    if had_trailing_nl {
        joined.push('\n');
    }
    Some((joined, start + 1, start + reindented_new.len()))
}

fn reindent_replacement(
    content_lines: &[&str],
    start: usize,
    old_lines: &[&str],
    new_str: &str,
) -> Vec<String> {
    let first_non_empty = old_lines
        .iter()
        .position(|l| !l.trim().is_empty())
        .unwrap_or(0);
    let actual_indent = leading_ws(
        content_lines
            .get(start + first_non_empty)
            .copied()
            .unwrap_or(""),
    );
    let old_indent = leading_ws(old_lines[first_non_empty]);
    let new_lines_raw: Vec<&str> = new_str
        .strip_suffix('\n')
        .unwrap_or(new_str)
        .split('\n')
        .collect();

    new_lines_raw
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else if let Some(rest) = l.strip_prefix(old_indent) {
                format!("{actual_indent}{rest}")
            } else {
                let l_ws = leading_ws(l);
                if l_ws.len() >= old_indent.len() {
                    format!("{actual_indent}{}", &l[old_indent.len()..])
                } else {
                    format!("{actual_indent}{}", l.trim_start())
                }
            }
        })
        .collect()
}

/// Produce a compact 3-context-line unified diff with fresh Hashlines on added/context lines
/// using `imara-diff` Histogram diff (capped at `max_lines`).
pub fn format_compact_unified_diff(
    rel_path: &str,
    before: &str,
    after: &str,
    max_lines: usize,
) -> String {
    let before_lines: Vec<&str> = if before.is_empty() {
        Vec::new()
    } else {
        before.strip_suffix('\n').unwrap_or(before).split('\n').collect()
    };
    let after_lines: Vec<&str> = if after.is_empty() {
        Vec::new()
    } else {
        after.strip_suffix('\n').unwrap_or(after).split('\n').collect()
    };

    let input = InternedInput::new(before, after);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    let mut out = vec![format!("--- {rel_path}"), format!("+++ {rel_path}")];

    for hunk in diff.hunks() {
        let b_start = hunk.before.start as usize;
        let b_end = hunk.before.end as usize;
        let a_start = hunk.after.start as usize;
        let a_end = hunk.after.end as usize;

        let ctx_before_lo = b_start.saturating_sub(2);
        let ctx_after_lo = a_start.saturating_sub(2);
        let ctx_after_hi = (a_end + 2).min(after_lines.len());

        out.push(format!(
            "@@ -{},{} +{},{} @@",
            b_start + 1,
            b_end.saturating_sub(b_start),
            a_start + 1,
            a_end.saturating_sub(a_start)
        ));

        for li in ctx_before_lo..b_start {
            if li < before_lines.len() {
                out.push(format!("     | {}", before_lines[li]));
            }
        }
        for li in b_start..b_end {
            if li < before_lines.len() {
                out.push(format!("-{:>4}| {}", li + 1, before_lines[li]));
            }
        }
        for li in a_start..a_end {
            if li < after_lines.len() {
                let tag = line_hash_tag_str(&after_lines, li);
                out.push(format!("+{:>4}:{tag}| {}", li + 1, after_lines[li]));
            }
        }
        let tail_start = a_end.max(ctx_after_lo);
        for li in tail_start..ctx_after_hi {
            if li < after_lines.len() {
                let tag = line_hash_tag_str(&after_lines, li);
                out.push(format!(" {:>4}:{tag}| {}", li + 1, after_lines[li]));
            }
        }

        if out.len() >= max_lines {
            out.truncate(max_lines);
            out.push("... [diff truncated]".into());
            break;
        }
    }

    if out.len() <= 2 {
        String::new()
    } else {
        out.join("\n")
    }
}

fn leading_ws(s: &str) -> &str {
    let end = s
        .find(|c: char| c != ' ' && c != '\t')
        .unwrap_or(s.len());
    &s[..end]
}

/// Model-family edit format affinity (`arXiv:2607.21674`, Bölük 2026, Diff-XYZ `arXiv:2510.12487`).
/// DeepSeek/Codex families exhibit native unified-diff/`apply_patch` affinity while Claude,
/// Gemini, Grok, GLM, and Qwen achieve +11–61% higher edit reliability & fewer output tokens
/// with Hashline v2 content-addressed line anchors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelEditAffinity {
    HashlineV2,
    UnifiedDiffPatch,
    SyntacticBlockDiff,
}

impl ModelEditAffinity {
    /// Route optimal preferred edit mode for a given model identifier while keeping all modes accepted.
    #[must_use]
    pub fn for_model(model_id: &str) -> Self {
        let lower = model_id.to_ascii_lowercase();
        if lower.contains("deepseek") || lower.contains("codex") {
            Self::UnifiedDiffPatch
        } else {
            Self::HashlineV2
        }
    }

    /// Compact, KV-safe Tail-or-Turn-1 hint explaining the optimal edit mode for this model.
    #[must_use]
    pub const fn mode_label(self) -> &'static str {
        match self {
            Self::HashlineV2 => "hashline_v2",
            Self::UnifiedDiffPatch => "unified_diff_patch",
            Self::SyntacticBlockDiff => "syntactic_block_diff",
        }
    }
}

/// Tree-sitter `BlockDiff` (`arXiv:2604.27296`): replace an entire syntactically coherent
/// symbol span `[start_line_1..=end_line_1]` with `new_block`, guarded by `FileReadTracker`
/// and returning a compact unified diff + syntax delta.
#[allow(clippy::too_many_arguments)]
pub fn edit_file_by_symbol_block(
    workspace_root: &Path,
    rel_path: &str,
    symbol_name: &str,
    start_line_1: usize,
    end_line_1: usize,
    new_block: &str,
    tracker: &FileReadTracker,
) -> Result<EditFileResult> {
    let (abs, normalized, uses_crlf, had_bom) =
        verify_pre_read_guard(workspace_root, rel_path, tracker)?;
    let trailing_nl = normalized.ends_with('\n');
    let lines: Vec<&str> = normalized
        .strip_suffix('\n')
        .unwrap_or(&normalized)
        .split('\n')
        .collect();

    if start_line_1 == 0 || end_line_1 < start_line_1 || end_line_1 > lines.len() {
        bail!(
            "symbol '{symbol_name}' span L{start_line_1}-L{end_line_1} is out of bounds for '{rel_path}' ({} lines)",
            lines.len()
        );
    }

    let mut out_lines: Vec<String> = Vec::with_capacity(lines.len() + 16);
    for l in &lines[..start_line_1 - 1] {
        out_lines.push((*l).to_string());
    }
    let clean_new = new_block.replace("\r\n", "\n");
    let inserted_len = if !clean_new.is_empty() {
        let parts: Vec<&str> = clean_new.strip_suffix('\n').unwrap_or(&clean_new).split('\n').collect();
        for l in &parts {
            out_lines.push((*l).to_string());
        }
        parts.len()
    } else {
        0
    };
    for l in &lines[end_line_1..] {
        out_lines.push((*l).to_string());
    }

    let mut updated = out_lines.join("\n");
    if trailing_nl && !updated.ends_with('\n') {
        updated.push('\n');
    }
    if updated == normalized {
        bail!("block edit produced no change for symbol '{symbol_name}' in '{rel_path}'");
    }

    let final_str = if uses_crlf {
        updated.replace('\n', "\r\n")
    } else {
        updated.clone()
    };
    atomic_write_bom_free(&abs, &final_str, had_bom)?;
    tracker.record_read(&abs, final_str.as_bytes());

    let new_end = start_line_1 + inserted_len.saturating_sub(1);
    let diff_preview = format_compact_unified_diff(rel_path, &normalized, &updated, 48);
    let syntax_diagnostics = verify_syntax_delta(
        rel_path,
        &normalized,
        &updated,
        Some((start_line_1.saturating_sub(2), new_end + 2)),
    )
    .format_lines();

    Ok(EditFileResult {
        path: rel_path.to_string(),
        replacements: 1,
        match_mode: format!("block_diff({symbol_name}:L{start_line_1}-L{end_line_1})"),
        line_start: start_line_1,
        line_end: new_end,
        diff_preview,
        syntax_diagnostics,
    })
}

/// Fast targeted post-edit compiler/syntax check (`python -m py_compile` for `.py`,
/// `node --check` for `.js/.mjs/.cjs`, bounded `<= 2.5s` via supervised command).
/// Returns `Some(diagnostic)` ONLY when a concrete syntax/compile error is detected.
pub fn run_fast_compiler_syntax_check(workspace_root: &Path, abs_path: &Path) -> Option<String> {
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())?;

    let (prog, args): (String, Vec<String>) = match ext.as_str() {
        "py" => {
            let py = which::which("python")
                .or_else(|_| which::which("python3"))
                .ok()?;
            (
                py.to_string_lossy().into_owned(),
                vec![
                    "-B".into(),
                    "-m".into(),
                    "py_compile".into(),
                    abs_path.to_string_lossy().into_owned(),
                ],
            )
        }
        "js" | "mjs" | "cjs" => {
            let node = which::which("node").ok()?;
            (
                node.to_string_lossy().into_owned(),
                vec!["--check".into(), abs_path.to_string_lossy().into_owned()],
            )
        }
        _ => return None,
    };

    let mut cmd = std::process::Command::new(prog);
    cmd.args(&args)
        .current_dir(workspace_root)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let (mut child, sup) = crate::supervisor::spawn_supervised_command(&mut cmd).ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_500);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                if st.success() {
                    return None;
                }
                let out = child.wait_with_output().ok()?;
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let msg = if !stderr.is_empty() { stderr } else { stdout };
                if msg.is_empty() {
                    return None;
                }
                let clipped: String = msg.chars().take(600).collect();
                return Some(format!("[Compiler Syntax Check FAILED]\n{clipped}"));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    sup.kill_tree();
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => {
                sup.kill_tree();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_pre_read_guard_and_supports_fast_apply_indent_fallback() {
        let tmp = std::env::temp_dir().join(format!("omni_edit_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("calc.py");
        let initial = "class Calc:\n    def mul(self, a, b):\n        return a + b\n";
        fs::write(&file, initial).unwrap();

        let tracker = FileReadTracker::new();

        // 1. Pre-Read Guard blocks edit before read_file
        let err = edit_file_guarded(&tmp, "calc.py", "return a + b", "return a * b", false, &tracker)
            .unwrap_err();
        assert!(err.to_string().contains("Pre-Read Guard"));

        // 2. Record read -> Fast Apply fallback matches despite wrong indentation AND preserves real indentation!
        let abs = ensure_within_workspace(&tmp, "calc.py").unwrap();
        tracker.record_read(&abs, initial.as_bytes());
        let res = edit_file_guarded(
            &tmp,
            "calc.py",
            "def mul(self, a, b):\n    return a + b",
            "def mul(self, a, b):\n    return a * b",
            false,
            &tracker,
        )
        .unwrap();
        assert_eq!(res.match_mode, "fast_apply_indent_normalized");
        assert!(res.diff_preview.contains("+   3:"));
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "class Calc:\n    def mul(self, a, b):\n        return a * b\n"
        );

        // 3. External disk mutation invalidates Pre-Read Guard
        fs::write(&file, "class Calc:\n    def mul(self, a, b):\n        return 0\n").unwrap();
        let stale = edit_file_guarded(&tmp, "calc.py", "return 0", "return 1", false, &tracker)
            .unwrap_err();
        assert!(stale.to_string().contains("changed on disk"));

        // 4. Ambiguous match rejected unless replace_all = true
        let dup_body = "x = foo()\ny = foo()\n";
        fs::write(&file, dup_body).unwrap();
        tracker.record_read(&abs, dup_body.as_bytes());
        assert!(edit_file_guarded(&tmp, "calc.py", "foo()", "bar()", false, &tracker).is_err());
        let rep_all =
            edit_file_guarded(&tmp, "calc.py", "foo()", "bar()", true, &tracker).unwrap();
        assert_eq!(rep_all.replacements, 2);
        assert_eq!(fs::read_to_string(&file).unwrap(), "x = bar()\ny = bar()\n");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn hashline_read_and_anchor_edit_rejects_stale_hash_and_relocates_unique_shift() {
        let tmp = std::env::temp_dir().join(format!("omni_hl_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("app.py");
        let body = "def f():\n    x = 1\n    y = 2\n    return x + y\n";
        fs::write(&file, body).unwrap();
        let abs = ensure_within_workspace(&tmp, "app.py").unwrap();
        let tracker = FileReadTracker::new();
        tracker.record_read(&abs, body.as_bytes());

        let lines: Vec<&str> = body.strip_suffix('\n').unwrap().split('\n').collect();
        let t2 = line_hash_tag_str(&lines, 1);
        let t3 = line_hash_tag_str(&lines, 2);

        // Wrong hash rejected with fresh anchors preview
        assert!(edit_file_by_hashline(&tmp, "app.py", "2:fff", Some("3:fff"), "    x = 9", &tracker).is_err());

        // Unique relocation when line numbers drifted by +2 (passing 4:t2..5:t3 when lines are at 2..3!)
        let res = edit_file_by_hashline(
            &tmp,
            "app.py",
            &format!("4:{t2}"),
            Some(&format!("5:{t3}")),
            "    x = 10\n    y = 20",
            &tracker,
        )
        .unwrap();
        assert_eq!(res.match_mode, "hashline_relocated");
        assert!(fs::read_to_string(&file).unwrap().contains("x = 10\n    y = 20"));

        // Defensive strip guard: copied `   1:abc| ` prefix inside old_string still succeeds cleanly!
        let cur = fs::read_to_string(&file).unwrap();
        let cur_lines: Vec<&str> = cur.strip_suffix('\n').unwrap().split('\n').collect();
        let t4 = line_hash_tag_str(&cur_lines, 3);
        let res2 = edit_file_guarded(
            &tmp,
            "app.py",
            &format!("   4:{t4}|     return x + y"),
            "    return x * y",
            false,
            &tracker,
        )
        .unwrap();
        assert_eq!(res2.match_mode, "exact_hashline_stripped");
        assert!(fs::read_to_string(&file).unwrap().contains("return x * y"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tier3_imara_histogram_fuzzy_edit_applies_unique_match_and_rejects_ambiguous() {
        let tmp = std::env::temp_dir().join(format!("omni_t3_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("engine.py");
        let body = "\
def compute(items):
    total = 0
    for item in items:
        if item.active:
            total += item.price
            total -= item.discount
            total += item.tax
    return total
";
        fs::write(&file, body).unwrap();
        let abs = ensure_within_workspace(&tmp, "engine.py").unwrap();
        let tracker = FileReadTracker::new();
        tracker.record_read(&abs, body.as_bytes());

        // 1-line minor mismatch inside an 8-line unique block -> sim = 14/16 = 0.875? Make 9-line block -> 16/18 = 0.888 >= 0.88!
        let body9 = "\
def compute(items):
    total = 0
    count = 0
    for item in items:
        if item.active:
            total += item.price
            total -= item.discount
            total += item.tax
            count += 1
    return total, count
";
        fs::write(&file, body9).unwrap();
        tracker.record_read(&abs, body9.as_bytes());

        let slightly_off_old = "\
def compute(items):
    total = 0
    count = 0
    for item in items:
        if item.active:
            total += item.price
            total -= item.rebate
            total += item.tax
            count += 1
    return total, count";
        let replacement = "\
def compute(items):
    total = 0
    count = 0
    for item in items:
        if item.active:
            total += item.price - item.discount + item.tax
            count += 1
    return total, count";
        let res = edit_file_guarded(&tmp, "engine.py", slightly_off_old, replacement, false, &tracker).unwrap();
        assert_eq!(res.match_mode, "imara_histogram_fuzzy");
        assert!(res.diff_preview.contains("item.price - item.discount + item.tax"));

        // Ambiguous duplicated block -> Tier 3 MUST REJECT (margin < 0.10)!
        let dup = format!("{body9}\n# second copy\n{body9}");
        fs::write(&file, &dup).unwrap();
        tracker.record_read(&abs, dup.as_bytes());
        assert!(
            edit_file_guarded(&tmp, "engine.py", slightly_off_old, replacement, false, &tracker)
                .is_err(),
            "ambiguous fuzzy match MUST be rejected by uniqueness margin proof"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn model_edit_affinity_routes_deepseek_codex_to_diff_and_others_to_hashline() {
        assert_eq!(
            ModelEditAffinity::for_model("deepseek-v4"),
            ModelEditAffinity::UnifiedDiffPatch
        );
        assert_eq!(
            ModelEditAffinity::for_model("gpt-5.2-codex"),
            ModelEditAffinity::UnifiedDiffPatch
        );
        assert_eq!(
            ModelEditAffinity::for_model("claude-sonnet-5-5"),
            ModelEditAffinity::HashlineV2
        );
        assert_eq!(
            ModelEditAffinity::for_model("gemini-3.8-flash"),
            ModelEditAffinity::HashlineV2
        );
        assert_eq!(
            ModelEditAffinity::for_model("qwen3-coder"),
            ModelEditAffinity::HashlineV2
        );
    }

    #[test]
    fn edit_file_by_symbol_block_replaces_ast_span_with_syntax_check() {
        let tmp = std::env::temp_dir().join(format!("omni_blockdiff_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let src = "def alpha():\n    return 1\n\ndef beta(x):\n    return x + 1\n";
        let f = tmp.join("calc.py");
        fs::write(&f, src).unwrap();

        let abs = ensure_within_workspace(&tmp, "calc.py").unwrap();
        let tracker = FileReadTracker::new();
        tracker.record_read(&abs, src.as_bytes());

        let res = edit_file_by_symbol_block(
            &tmp,
            "calc.py",
            "beta",
            4,
            5,
            "def beta(x):\n    return x * 10",
            &tracker,
        )
        .unwrap();
        assert!(res.match_mode.starts_with("block_diff(beta"));
        assert!(res.syntax_diagnostics.is_empty());
        assert_eq!(
            fs::read_to_string(&f).unwrap(),
            "def alpha():\n    return 1\n\ndef beta(x):\n    return x * 10\n"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fast_compiler_syntax_check_catches_broken_python_and_js() {
        let tmp = std::env::temp_dir().join(format!("omni_fastchk_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();

        let py_good = tmp.join("good.py");
        let py_bad = tmp.join("bad.py");
        fs::write(&py_good, "def ok():\n    return 42\n").unwrap();
        fs::write(&py_bad, "def broken(:\n    return 42\n").unwrap();

        assert!(run_fast_compiler_syntax_check(&tmp, &py_good).is_none());
        if which::which("python").is_ok() || which::which("python3").is_ok() {
            let diag = run_fast_compiler_syntax_check(&tmp, &py_bad);
            assert!(
                diag.is_some(),
                "py_compile must report syntax error on broken Python file"
            );
        }

        let js_good = tmp.join("good.js");
        let js_bad = tmp.join("bad.js");
        fs::write(&js_good, "export function ok() { return 1; }\n").unwrap();
        fs::write(&js_bad, "function broken( { return 1; }\n").unwrap();
        assert!(run_fast_compiler_syntax_check(&tmp, &js_good).is_none());
        if which::which("node").is_ok() {
            let diag = run_fast_compiler_syntax_check(&tmp, &js_bad);
            assert!(
                diag.is_some(),
                "node --check must report syntax error on broken JS file"
            );
        }

        let _ = fs::remove_dir_all(&tmp);
    }
}
