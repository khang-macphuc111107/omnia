//! `rtk`-style shell output micro-compactor, ANSI/progress scrubber, traceback-preserving cap,
//! and external `>4 KB` spill writer.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default threshold above which raw shell output is spilled to an external artifact file.
pub const DEFAULT_SPILL_THRESHOLD_BYTES: usize = 4096;

static SPILL_SEQ: AtomicU64 = AtomicU64::new(1);

/// Result of compressing shell command stdout/stderr for agent context efficiency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactedShellOutput {
    pub content: String,
    pub original_bytes: usize,
    pub compacted_bytes: usize,
    pub profile: String,
    pub was_compacted: bool,
}

/// Receipt emitted when oversized shell output (`> threshold_bytes`) is spilled to disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellSpillReceipt {
    pub spilled: bool,
    pub spill_path: Option<PathBuf>,
    pub raw_bytes: usize,
    pub summary: String,
}

/// Strips ANSI CSI/OSC escape codes, collapses `\r` progress overwrites, and deduplicates
/// consecutive repeated lines (`>= 4` repetitions).
#[must_use]
pub fn scrub_shell_output(raw: &str) -> String {
    let no_ansi = strip_ansi_sequences(raw);
    let mut lines: Vec<String> = Vec::new();
    for raw_line in no_ansi.split('\n') {
        let collapsed = if raw_line.contains('\r') {
            raw_line
                .rsplit('\r')
                .find(|segment| !segment.is_empty())
                .unwrap_or("")
        } else {
            raw_line
        };
        lines.push(collapsed.trim_end_matches('\r').to_string());
    }

    let mut deduped: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0usize;
    while i < lines.len() {
        let mut j = i + 1;
        while j < lines.len() && lines[j] == lines[i] {
            j += 1;
        }
        let count = j - i;
        if count >= 4 {
            deduped.push(lines[i].clone());
            deduped.push(format!("... [repeated {} more times]", count - 1));
        } else {
            for line in &lines[i..j] {
                deduped.push(line.clone());
            }
        }
        i = j;
    }

    deduped.join("\n")
}

/// Applies command-aware micro-compaction (`cargo`, `pytest`/`unittest`, `jest`/`vitest`/`bun test`,
/// `git diff`/`git show`, package installs) while preserving errors, panics, and tracebacks.
#[must_use]
pub fn compact_shell_output(
    command: &str,
    stdout: &str,
    stderr: &str,
    exit_code: i32,
) -> CompactedShellOutput {
    let combined_raw = if stderr.trim().is_empty() {
        stdout.to_string()
    } else if stdout.trim().is_empty() {
        stderr.to_string()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let original_bytes = combined_raw.len();
    let scrubbed = scrub_shell_output(&combined_raw);
    let cmd_lower = command.to_ascii_lowercase();

    let (profile, compacted) = if is_cargo_command(&cmd_lower) {
        ("cargo", compact_cargo_output(&scrubbed, exit_code))
    } else if is_git_diff_command(&cmd_lower) {
        ("git_diff", compact_git_diff_output(&scrubbed))
    } else if is_test_runner_command(&cmd_lower) {
        ("test_runner", compact_test_runner_output(&scrubbed, exit_code))
    } else if is_pkg_install_command(&cmd_lower) {
        ("pkg_install", compact_install_output(&scrubbed, exit_code))
    } else {
        ("generic", scrubbed)
    };

    let compacted_bytes = compacted.len();
    let was_compacted = compacted_bytes < original_bytes;
    CompactedShellOutput {
        content: compacted,
        original_bytes,
        compacted_bytes,
        profile: profile.to_string(),
        was_compacted,
    }
}

/// Truncates `output` to at most `max_bytes` UTF-8 bytes while preserving the head, any
/// diagnostic/error/traceback section, and the tail.
#[must_use]
pub fn cap_output_traceback_preserving(output: &str, max_bytes: usize) -> String {
    if output.len() <= max_bytes {
        return output.to_string();
    }
    if max_bytes < 128 {
        return truncate_utf8_prefix(output, max_bytes).to_string();
    }

    let lines: Vec<&str> = output.lines().collect();
    let mut diagnostic_lines: Vec<&str> = Vec::new();
    let mut diag_budget = max_bytes / 3;

    for (idx, line) in lines.iter().enumerate() {
        if is_diagnostic_line(line) {
            let start = idx.saturating_sub(1);
            let end = (idx + 3).min(lines.len());
            for &ctx in &lines[start..end] {
                if diag_budget <= ctx.len() + 1 {
                    break;
                }
                if diagnostic_lines.last().copied() != Some(ctx) {
                    diag_budget = diag_budget.saturating_sub(ctx.len() + 1);
                    diagnostic_lines.push(ctx);
                }
            }
        }
    }

    let head_budget = max_bytes / 4;
    let tail_budget = max_bytes / 4;
    let head = truncate_utf8_prefix(output, head_budget);
    let tail = truncate_utf8_suffix(output, tail_budget);

    let mut out = String::with_capacity(max_bytes);
    out.push_str(head);
    out.push_str("\n... [truncated middle bytes; diagnostic excerpt below] ...\n");
    if !diagnostic_lines.is_empty() {
        for line in diagnostic_lines {
            if out.len() + line.len() + 1 + tail.len() + 48 >= max_bytes {
                break;
            }
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("... [tail] ...\n");
    }
    let remaining = max_bytes.saturating_sub(out.len());
    out.push_str(truncate_utf8_suffix(tail, remaining));
    out
}

/// Spills `raw_output` to an external directory (`spill_dir`) whenever its size exceeds
/// `threshold_bytes`, returning a concise diagnostic summary + spill path receipt.
pub fn spill_oversized_output(
    command: &str,
    raw_output: &str,
    spill_dir: &Path,
    threshold_bytes: usize,
) -> io::Result<ShellSpillReceipt> {
    let raw_bytes = raw_output.len();
    if raw_bytes <= threshold_bytes {
        return Ok(ShellSpillReceipt {
            spilled: false,
            spill_path: None,
            raw_bytes,
            summary: raw_output.to_string(),
        });
    }

    fs::create_dir_all(spill_dir)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SPILL_SEQ.fetch_add(1, Ordering::Relaxed);
    let file_name = format!(
        "omnia-shell-spill-{}-{nanos}-{seq}.log",
        std::process::id()
    );
    let spill_path = spill_dir.join(file_name);
    fs::write(&spill_path, raw_output.as_bytes())?;

    let preview_cap = threshold_bytes.min(2048);
    let excerpt = cap_output_traceback_preserving(raw_output, preview_cap);
    let summary = format!(
        "[shell output spilled: {raw_bytes} bytes > {threshold_bytes} byte threshold | command: `{command}` | full log: {}]\n{excerpt}",
        spill_path.display()
    );

    Ok(ShellSpillReceipt {
        spilled: true,
        spill_path: Some(spill_path),
        raw_bytes,
        summary,
    })
}

fn strip_ansi_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1B && i + 1 < bytes.len() {
            match bytes[i + 1] {
                // CSI: ESC [ ... final_byte (0x40..=0x7E)
                b'[' => {
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    }
                    continue;
                }
                // OSC: ESC ] ... (BEL or ESC \)
                b']' => {
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                _ => {
                    i += 2;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_cargo_command(cmd: &str) -> bool {
    cmd.contains("cargo ")
        && (cmd.contains("build")
            || cmd.contains("check")
            || cmd.contains("test")
            || cmd.contains("clippy"))
}

fn is_git_diff_command(cmd: &str) -> bool {
    cmd.contains("git diff") || cmd.contains("git show")
}

fn is_test_runner_command(cmd: &str) -> bool {
    cmd.contains("pytest")
        || cmd.contains("unittest")
        || cmd.contains("vitest")
        || cmd.contains("jest")
        || cmd.contains("bun test")
        || cmd.contains("npm test")
}

fn is_pkg_install_command(cmd: &str) -> bool {
    cmd.contains("pip install")
        || cmd.contains("uv pip")
        || cmd.contains("uv sync")
        || cmd.contains("npm install")
        || cmd.contains("npm ci")
        || cmd.contains("bun install")
}

fn compact_cargo_output(text: &str, exit_code: i32) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut compiling_suppressed = 0usize;
    let mut ok_tests_suppressed = 0usize;
    let mut in_diagnostic_block = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("Compiling ")
            || trimmed.starts_with("Checking ")
            || trimmed.starts_with("Downloading ")
            || trimmed.starts_with("Downloaded ")
            || trimmed.starts_with("Fresh ")
            || trimmed.starts_with("Blocking waiting for file lock")
        {
            compiling_suppressed += 1;
            in_diagnostic_block = false;
            continue;
        }
        if exit_code == 0 && trimmed.starts_with("test ") && trimmed.ends_with("... ok") {
            ok_tests_suppressed += 1;
            in_diagnostic_block = false;
            continue;
        }
        if trimmed.starts_with("error")
            || trimmed.starts_with("warning:")
            || trimmed.starts_with("failures:")
            || trimmed.starts_with("thread '")
            || trimmed.starts_with("panicked at")
        {
            in_diagnostic_block = true;
            kept.push(line);
            continue;
        }
        if in_diagnostic_block
            || trimmed.starts_with("Finished ")
            || trimmed.starts_with("test result:")
            || trimmed.starts_with("Running ")
            || trimmed.contains("FAILED")
            || exit_code != 0
        {
            if trimmed.is_empty() {
                in_diagnostic_block = false;
            }
            kept.push(line);
        }
    }

    let mut header = Vec::new();
    if compiling_suppressed > 0 {
        header.push(format!(
            "[cargo: {compiling_suppressed} compile/check progress lines compacted]"
        ));
    }
    if ok_tests_suppressed > 0 {
        header.push(format!(
            "[cargo test: {ok_tests_suppressed} passing test lines compacted]"
        ));
    }
    header.extend(kept.into_iter().map(str::to_string));
    header.join("\n")
}

fn compact_git_diff_output(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut skip_lockfile = false;
    let mut skipped_lines = 0usize;
    let mut current_lockfile = String::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if skip_lockfile && skipped_lines > 0 {
                out.push(format!(
                    "... [lockfile `{current_lockfile}`: {skipped_lines} diff lines omitted]"
                ));
            }
            let lower = rest.to_ascii_lowercase();
            skip_lockfile = lower.contains("cargo.lock")
                || lower.contains("package-lock.json")
                || lower.contains("yarn.lock")
                || lower.contains("pnpm-lock.yaml")
                || lower.contains("bun.lock");
            skipped_lines = 0;
            current_lockfile = rest.to_string();
            out.push(line.to_string());
            continue;
        }

        if skip_lockfile {
            skipped_lines += 1;
        } else {
            out.push(line.to_string());
        }
    }

    if skip_lockfile && skipped_lines > 0 {
        out.push(format!(
            "... [lockfile `{current_lockfile}`: {skipped_lines} diff lines omitted]"
        ));
    }

    out.join("\n")
}

fn compact_test_runner_output(text: &str, exit_code: i32) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut passed_suppressed = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        let is_pass_noise = exit_code == 0
            && (trimmed.ends_with(" PASSED")
                || trimmed.starts_with("PASS ")
                || trimmed.starts_with("✓ ")
                || trimmed.starts_with("√ ")
                || trimmed.starts_with("(pass) "));
        if is_pass_noise {
            passed_suppressed += 1;
            continue;
        }
        kept.push(line);
    }

    if passed_suppressed == 0 {
        return text.to_string();
    }
    let mut out = vec![format!(
        "[tests: {passed_suppressed} passing detail lines compacted]"
    )];
    out.extend(kept.into_iter().map(str::to_string));
    out.join("\n")
}

fn compact_install_output(text: &str, exit_code: i32) -> String {
    if exit_code != 0 {
        return text.to_string();
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= 16 {
        return text.to_string();
    }
    let mut out = Vec::new();
    let mut suppressed = 0usize;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if idx < 4
            || idx + 6 >= lines.len()
            || trimmed.starts_with("Successfully ")
            || trimmed.starts_with("Installed ")
            || trimmed.starts_with("added ")
            || trimmed.starts_with("warn")
            || trimmed.starts_with("WARN")
            || trimmed.starts_with("error")
            || trimmed.starts_with("ERROR")
        {
            out.push((*line).to_string());
        } else {
            suppressed += 1;
        }
    }
    if suppressed > 0 {
        out.insert(
            4.min(out.len()),
            format!("... [{suppressed} install progress lines compacted] ..."),
        );
    }
    out.join("\n")
}

fn is_diagnostic_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("error:")
        || lower.contains("error[")
        || lower.contains("traceback")
        || lower.contains("panicked at")
        || lower.contains("assertion")
        || lower.contains("failed")
        || lower.contains("exception")
}

fn truncate_utf8_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn truncate_utf8_suffix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len().saturating_sub(max_bytes);
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_strips_ansi_cr_and_repeated_runs() {
        let raw = "\x1b[32mDownloading 10%\rDownloading 100%\x1b[0m\nnoise\nnoise\nnoise\nnoise\nnoise\ndone";
        let scrubbed = scrub_shell_output(raw);
        assert!(!scrubbed.contains("\x1b["));
        assert!(scrubbed.contains("Downloading 100%"));
        assert!(!scrubbed.contains("Downloading 10%"));
        assert!(scrubbed.contains("[repeated 4 more times]"));
        assert!(scrubbed.ends_with("done"));
    }

    #[test]
    fn compact_cargo_preserves_errors_and_compacts_compiling_noise() {
        let raw = concat!(
            "   Compiling a v0.1.0\n",
            "   Compiling b v0.1.0\n",
            "   Compiling c v0.1.0\n",
            "error[E0308]: mismatched types\n",
            "  --> src/lib.rs:10:5\n",
            "   |\n",
            "10 |     42\n",
            "   |     ^^ expected `&str`, found integer\n"
        );
        let out = compact_shell_output("cargo check --workspace", raw, "", 101);
        assert!(out.was_compacted);
        assert_eq!(out.profile, "cargo");
        assert!(out.content.contains("error[E0308]: mismatched types"));
        assert!(out.content.contains("src/lib.rs:10:5"));
        assert!(!out.content.contains("Compiling a"));
    }

    #[test]
    fn compact_git_diff_omits_lockfile_hunks_and_keeps_code() {
        let mut diff = String::from("diff --git a/Cargo.lock b/Cargo.lock\n");
        for i in 0..80 {
            diff.push_str(&format!("+checksum-{i} = \"abcdef\"\n"));
        }
        diff.push_str("diff --git a/src/main.rs b/src/main.rs\n+fn important() {}\n");
        let out = compact_shell_output("git diff", &diff, "", 0);
        assert!(out.was_compacted);
        assert!(out.content.contains("lockfile `a/Cargo.lock b/Cargo.lock`: 80 diff lines omitted"));
        assert!(out.content.contains("+fn important() {}"));
    }

    #[test]
    fn spill_oversized_output_writes_external_log_above_4kb() {
        let dir = std::env::temp_dir().join(format!("omnia-spill-test-{}", std::process::id()));
        let mut big = String::new();
        for i in 0..300 {
            big.push_str(&format!("line {i:04}: ok\n"));
        }
        big.push_str("Traceback (most recent call last):\n  File \"app.py\", line 7\nValueError: boom\n");
        let receipt = spill_oversized_output(
            "pytest -q",
            &big,
            &dir,
            DEFAULT_SPILL_THRESHOLD_BYTES,
        )
        .expect("spill succeeds");
        assert!(receipt.spilled);
        let spill_path = receipt.spill_path.expect("spill path present");
        assert!(spill_path.exists());
        assert_eq!(fs::read_to_string(&spill_path).unwrap(), big);
        assert!(receipt.summary.contains("ValueError: boom"));
        let _ = fs::remove_dir_all(&dir);
    }
}
