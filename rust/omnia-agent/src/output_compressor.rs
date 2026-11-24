//! RTK-grade pure-Rust stdout/stderr & tool-output filter (`arXiv:2604.04979` / `rtk-ai/rtk`).
//!
//! Designed for zero-dependency, zero-ReDoS, O(n) single-pass filtering of noisy build,
//! test, git-diff, package-install, and diagnostic shell/tool streams:
//! - Strips ANSI CSI/OSC escape sequences and collapses `\r` progress-bar overwrites.
//! - Drops passing-test boilerplate, progress bars, crate compile chatter, and lockfile hunks.
//! - Retains 100% of errors, panics, assertions, `file:line` locations, test summaries, and exit codes.
//! - Redacts secrets and spills full raw logs `> 20 KiB` to an external spill directory (never in workspace).
//! - Caps final compressed context strictly at `5,000` tokens while preserving traceback/exit-code anchors.

use crate::cache_guard::estimate_tokens;
use crate::sanitizer::redact_secrets;
use aho_corasick::{AhoCorasick, AhoCorasickBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// Raw byte threshold (`> 20 KiB`) above which the redacted raw output is spilled externally.
pub const DEFAULT_SPILL_THRESHOLD_BYTES: usize = 20 * 1024;
/// Minimum byte length before heuristic noise compression activates (short outputs stay clean).
pub const DEFAULT_MIN_COMPRESS_BYTES: usize = 1_800;
/// Maximum estimated tokens allowed in the returned compressed output (`5k` tokens).
pub const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 5_000;
/// Maximum byte ceiling corresponding to ~5k tokens (`<= 20,000` bytes).
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 19_000;

static SPILL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputCompressorConfig {
    pub min_compress_bytes: usize,
    pub spill_threshold_bytes: usize,
    pub max_output_tokens: u64,
    pub max_output_bytes: usize,
    pub dedupe_repeat_threshold: usize,
    pub redact_spills: bool,
}

impl Default for OutputCompressorConfig {
    fn default() -> Self {
        Self {
            min_compress_bytes: DEFAULT_MIN_COMPRESS_BYTES,
            spill_threshold_bytes: DEFAULT_SPILL_THRESHOLD_BYTES,
            max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            dedupe_repeat_threshold: 4,
            redact_spills: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionStats {
    pub ansi_sequences_stripped: usize,
    pub cr_frames_collapsed: usize,
    pub pass_lines_dropped: usize,
    pub build_lines_dropped: usize,
    pub lockfile_lines_dropped: usize,
    pub progress_lines_dropped: usize,
    pub repeated_runs_collapsed: usize,
    pub diagnostic_lines_preserved: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressedOutput {
    pub content: String,
    pub original_bytes: usize,
    pub compressed_bytes: usize,
    pub original_tokens_est: u64,
    pub compressed_tokens_est: u64,
    pub profile: String,
    pub was_compressed: bool,
    pub spilled: bool,
    pub spill_path: Option<PathBuf>,
    pub stats: CompressionStats,
}

/// Stateful-configurable RTK output compressor.
#[derive(Debug, Clone, Default)]
pub struct OutputCompressor {
    pub config: OutputCompressorConfig,
}

impl OutputCompressor {
    #[must_use]
    pub fn new(config: OutputCompressorConfig) -> Self {
        Self { config }
    }

    /// Compress tool/command stdout + stderr into a high-signal payload bounded at `max_output_tokens`,
    /// spilling the redacted full raw log externally whenever `original_bytes > spill_threshold_bytes`.
    #[must_use]
    pub fn compress(
        &self,
        command_or_tool: &str,
        stdout: &str,
        stderr: &str,
        exit_code: Option<i32>,
        spill_dir: Option<&Path>,
    ) -> CompressedOutput {
        let raw_combined = merge_streams(stdout, stderr);
        let original_bytes = raw_combined.len();
        let original_tokens_est = estimate_tokens(&raw_combined);

        let mut stats = CompressionStats::default();
        let scrubbed = scrub_ansi_and_progress_with_stats(
            &raw_combined,
            self.config.dedupe_repeat_threshold,
            &mut stats,
        );

        let mut spill_path: Option<PathBuf> = None;
        let mut spilled = false;
        if original_bytes > self.config.spill_threshold_bytes {
            let target_dir = spill_dir
                .map(Path::to_path_buf)
                .unwrap_or_else(|| std::env::temp_dir().join("omnia_tool_spills"));
            if let Ok(path) = write_external_spill(&target_dir, &raw_combined, self.config.redact_spills)
            {
                spilled = true;
                spill_path = Some(path);
            }
        }

        let cmd_low = command_or_tool.to_ascii_lowercase();
        let (profile, filtered) = if scrubbed.len() <= self.config.min_compress_bytes
            && estimate_tokens(&scrubbed) <= self.config.max_output_tokens
        {
            ("verbatim", scrubbed)
        } else if is_cargo_command(&cmd_low) {
            ("cargo", filter_cargo(&scrubbed, &mut stats))
        } else if is_git_diff_command(&cmd_low) {
            ("git_diff", filter_git_diff(&scrubbed, &mut stats))
        } else if is_test_command(&cmd_low) {
            ("test_runner", filter_test_runner(&scrubbed, &mut stats))
        } else if is_pkg_command(&cmd_low) {
            ("pkg_install", filter_pkg_install(&scrubbed, &mut stats))
        } else {
            ("generic_noisy", filter_generic_noisy(&scrubbed, &mut stats))
        };

        let mut body = if let Some(code) = exit_code {
            ensure_exit_code_present(filtered, code)
        } else {
            filtered
        };

        if estimate_tokens(&body) > self.config.max_output_tokens
            || body.len() > self.config.max_output_bytes
        {
            body = cap_preserving_diagnostics(
                &body,
                self.config.max_output_tokens,
                self.config.max_output_bytes,
                spill_path.as_deref(),
            );
        }

        if let Some(ref sp) = spill_path {
            let marker = sp.to_string_lossy();
            if !body.contains(marker.as_ref()) {
                let note = format!(
                    "\n[rtk: raw log spilled -> {} ({} bytes)]",
                    sp.display(),
                    original_bytes
                );
                let budget_chars = self.config.max_output_bytes.saturating_sub(note.len());
                if body.len() > budget_chars {
                    body = cap_preserving_diagnostics(
                        &body,
                        self.config.max_output_tokens.saturating_sub(40),
                        budget_chars,
                        Some(sp),
                    );
                }
                if !body.contains(marker.as_ref()) {
                    body.push_str(&note);
                }
            }
        }

        // Guarantee final 5k token cap even with spill footer appended.
        if estimate_tokens(&body) > self.config.max_output_tokens {
            body = cap_preserving_diagnostics(
                &body,
                self.config.max_output_tokens,
                self.config.max_output_bytes,
                spill_path.as_deref(),
            );
        }

        let compressed_bytes = body.len();
        let compressed_tokens_est = estimate_tokens(&body);
        let was_compressed = compressed_bytes < original_bytes
            || stats.ansi_sequences_stripped > 0
            || stats.cr_frames_collapsed > 0
            || stats.pass_lines_dropped > 0
            || stats.build_lines_dropped > 0
            || stats.lockfile_lines_dropped > 0
            || stats.progress_lines_dropped > 0
            || stats.repeated_runs_collapsed > 0;

        CompressedOutput {
            content: body,
            original_bytes,
            compressed_bytes,
            original_tokens_est,
            compressed_tokens_est,
            profile: profile.to_string(),
            was_compressed,
            spilled,
            spill_path,
            stats,
        }
    }
}

/// Convenience entrypoint mirroring `OutputCompressor::default().compress(...)`.
#[must_use]
pub fn compress_tool_output(
    command_or_tool: &str,
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
    spill_dir: Option<&Path>,
) -> CompressedOutput {
    OutputCompressor::default().compress(command_or_tool, stdout, stderr, exit_code, spill_dir)
}

/// Convenience entrypoint for compressing an already-merged text stream.
#[must_use]
pub fn compress_text_output(
    command_or_tool: &str,
    raw: &str,
    exit_code: Option<i32>,
    spill_dir: Option<&Path>,
) -> CompressedOutput {
    OutputCompressor::default().compress(command_or_tool, raw, "", exit_code, spill_dir)
}

/// Strip ANSI CSI/OSC/single-char escapes and collapse `\r` progress overwrites + repeated runs.
#[must_use]
pub fn strip_ansi_and_progress(raw: &str) -> String {
    let mut stats = CompressionStats::default();
    scrub_ansi_and_progress_with_stats(raw, 4, &mut stats)
}

fn merge_streams(stdout: &str, stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return stdout.to_string();
    }
    if stdout.trim().is_empty() {
        return stderr.to_string();
    }
    let mut out = String::with_capacity(stdout.len() + stderr.len() + 12);
    out.push_str(stdout);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("[stderr]\n");
    out.push_str(stderr);
    out
}

fn scrub_ansi_and_progress_with_stats(
    raw: &str,
    repeat_threshold: usize,
    stats: &mut CompressionStats,
) -> String {
    let mut clean = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
                // CSI: ESC [ params intermediate final (0x40..=0x7E)
                i += 2;
                while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
                stats.ansi_sequences_stripped += 1;
                continue;
            } else if i + 1 < bytes.len() && bytes[i + 1] == b']' {
                // OSC: ESC ] ... (BEL or ESC \)
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                stats.ansi_sequences_stripped += 1;
                continue;
            } else if i + 1 < bytes.len() {
                // Two-byte ESC sequence (e.g. ESC =, ESC >, ESC c)
                i += 2;
                stats.ansi_sequences_stripped += 1;
                continue;
            }
        }
        let ch = raw[i..].chars().next().unwrap_or('\u{FFFD}');
        clean.push(ch);
        i += ch.len_utf8();
    }

    let lf = clean.replace("\r\n", "\n");
    let mut collapsed_lines: Vec<&str> = Vec::new();
    for line in lf.split('\n') {
        if memchr::memchr(b'\r', line.as_bytes()).is_some() {
            let final_seg = line.split('\r').rev().find(|s| !s.is_empty()).unwrap_or("");
            collapsed_lines.push(final_seg);
            stats.cr_frames_collapsed += 1;
        } else {
            collapsed_lines.push(line);
        }
    }

    let threshold = repeat_threshold.max(2);
    let mut out = String::with_capacity(lf.len());
    let mut idx = 0usize;
    while idx < collapsed_lines.len() {
        let cur = collapsed_lines[idx];
        let mut run = 1usize;
        while idx + run < collapsed_lines.len() && collapsed_lines[idx + run] == cur {
            run += 1;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        if run >= threshold && !cur.trim().is_empty() && !is_high_signal_line(cur) {
            out.push_str(cur);
            out.push_str(&format!("\n... [repeated {run}×]"));
            stats.repeated_runs_collapsed += 1;
        } else {
            for k in 0..run {
                if k > 0 {
                    out.push('\n');
                }
                out.push_str(collapsed_lines[idx + k]);
            }
        }
        idx += run;
    }
    out
}

fn write_external_spill(dir: &Path, raw: &str, redact: bool) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let seq = SPILL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let path = dir.join(format!("omnia_rtk_spill_{pid}_{seq}.log"));
    let body = if redact {
        redact_secrets(raw)
    } else {
        raw.to_string()
    };
    fs::write(&path, body.as_bytes())?;
    Ok(path)
}

fn diag_matcher() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build([
                "error:",
                "error[e",
                "fatal:",
                "panic",
                "panicked at",
                "traceback",
                "exception",
                "assertionerror",
                "assertion `",
                "assert ",
                "failed",
                "fail:",
                "failures:",
                "warning:",
                "exit_code:",
                "command exited with code",
                "process exited",
                "test result:",
                "short test summary info",
                "stderr",
                "syntaxerror",
                "typeerror",
                "importerror",
                "modulenotfounderror",
                "undefined reference",
                "segmentation fault",
            ])
            .expect("valid aho-corasick diagnostic matcher")
    })
}

/// Detect whether a line carries an error, assertion, warning, summary, exit code, or `file:line` location.
#[must_use]
pub fn is_high_signal_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    if diag_matcher().is_match(t) {
        return true;
    }
    if t.starts_with("FAILED ")
        || t.starts_with("ERROR ")
        || t.starts_with("E   ")
        || t.starts_with("--> ")
        || t.starts_with("^^^")
        || t.starts_with("File \"")
        || (t.starts_with("---- ") && t.ends_with(" ----"))
    {
        return true;
    }
    has_file_line_ref(t)
}

fn has_file_line_ref(line: &str) -> bool {
    const EXTS: &[&str] = &[
        ".rs:", ".py:", ".ts:", ".tsx:", ".js:", ".jsx:", ".go:", ".c:", ".h:", ".cpp:", ".hpp:",
        ".java:", ".cs:", ".kt:", ".swift:", ".rb:", ".php:", ".json:", ".toml:", ".yaml:", ".yml:",
    ];
    for ext in EXTS {
        if let Some(pos) = line.find(ext) {
            let after = &line[pos + ext.len()..];
            if after.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                return true;
            }
        }
    }
    false
}

fn is_progress_or_spinner_line(trimmed: &str) -> bool {
    if trimmed.is_empty() {
        return false;
    }
    if is_high_signal_line(trimmed) {
        return false;
    }
    if trimmed.contains("%|") || trimmed.contains("% |") || trimmed.contains("━━━") {
        return true;
    }
    if (trimmed.starts_with('[') || trimmed.contains(" ["))
        && (trimmed.contains("=>") || trimmed.contains("===") || trimmed.contains("###"))
        && trimmed.contains('%')
    {
        return true;
    }
    let b = trimmed.as_bytes();
    if b.len() <= 2 && matches!(trimmed, "-" | "\\" | "|" | "/" | "⠋" | "⠙" | "⠹" | "⠸" | "⠼" | "⠴" | "⠦" | "⠧" | "⠇" | "⠏") {
        return true;
    }
    false
}

fn is_pass_noise_line(trimmed: &str) -> bool {
    if trimmed.is_empty() || is_high_signal_line(trimmed) {
        return false;
    }
    if trimmed.starts_with("test ") && trimmed.ends_with(" ... ok") {
        return true;
    }
    if trimmed.ends_with(" PASSED")
        || trimmed.contains(" PASSED [")
        || trimmed.starts_with("PASSED ")
        || trimmed.starts_with("✓ ")
        || trimmed.starts_with("PASS ")
        || trimmed.starts_with("--- PASS:")
        || trimmed.starts_with("ok \t")
        || trimmed.starts_with("ok   ")
    {
        return true;
    }
    false
}

fn is_cargo_command(cmd_low: &str) -> bool {
    cmd_low.contains("cargo ")
        && (cmd_low.contains("test")
            || cmd_low.contains("check")
            || cmd_low.contains("build")
            || cmd_low.contains("clippy")
            || cmd_low.contains("run"))
}

fn is_test_command(cmd_low: &str) -> bool {
    cmd_low.contains("pytest")
        || cmd_low.contains("unittest")
        || cmd_low.contains("jest")
        || cmd_low.contains("vitest")
        || cmd_low.contains("bun test")
        || cmd_low.contains("go test")
        || cmd_low.contains("npm test")
}

fn is_git_diff_command(cmd_low: &str) -> bool {
    cmd_low.contains("git diff") || cmd_low.contains("git show")
}

fn is_pkg_command(cmd_low: &str) -> bool {
    (cmd_low.contains("pip ")
        || cmd_low.contains("uv ")
        || cmd_low.contains("npm ")
        || cmd_low.contains("pnpm ")
        || cmd_low.contains("yarn ")
        || cmd_low.contains("bun "))
        && (cmd_low.contains("install") || cmd_low.contains("add") || cmd_low.contains("sync"))
}

fn filter_cargo(text: &str, stats: &mut CompressionStats) -> String {
    let mut out = Vec::new();
    let mut in_failure_block = false;
    let mut dropped_compile = 0usize;
    let mut dropped_pass = 0usize;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("failures:") || (t.starts_with("---- ") && t.ends_with(" ----")) {
            in_failure_block = true;
        } else if t.starts_with("test result:") {
            in_failure_block = false;
        }
        if is_high_signal_line(line) {
            stats.diagnostic_lines_preserved += 1;
            out.push(line.to_string());
            continue;
        }
        if !in_failure_block {
            if t.starts_with("Compiling ")
                || t.starts_with("Downloading ")
                || t.starts_with("Downloaded ")
                || t.starts_with("Updating ")
                || t.starts_with("Fresh ")
                || t.starts_with("Locking ")
                || t.starts_with("Checking ")
            {
                dropped_compile += 1;
                stats.build_lines_dropped += 1;
                continue;
            }
            if is_pass_noise_line(t) {
                dropped_pass += 1;
                stats.pass_lines_dropped += 1;
                continue;
            }
            if is_progress_or_spinner_line(t) {
                stats.progress_lines_dropped += 1;
                continue;
            }
        }
        out.push(line.to_string());
    }
    append_compaction_summary(&mut out, dropped_pass, dropped_compile, 0);
    out.join("\n")
}

fn filter_test_runner(text: &str, stats: &mut CompressionStats) -> String {
    let mut out = Vec::new();
    let mut in_failure = false;
    let mut dropped_pass = 0usize;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("=== FAILURES ===")
            || t.starts_with("=== ERRORS ===")
            || t.starts_with("FAIL:")
            || t.starts_with("ERROR:")
            || t.starts_with("Traceback ")
            || t.starts_with("FAIL ")
        {
            in_failure = true;
        } else if t.starts_with("=== short test summary info ===")
            || t.starts_with("Ran ")
            || t.starts_with("Test Files ")
            || t.starts_with("Tests ")
        {
            in_failure = false;
        }

        if is_high_signal_line(line) {
            stats.diagnostic_lines_preserved += 1;
            out.push(line.to_string());
            continue;
        }
        if !in_failure {
            if is_pass_noise_line(t) {
                dropped_pass += 1;
                stats.pass_lines_dropped += 1;
                continue;
            }
            if is_progress_or_spinner_line(t) {
                stats.progress_lines_dropped += 1;
                continue;
            }
        }
        out.push(line.to_string());
    }
    append_compaction_summary(&mut out, dropped_pass, 0, 0);
    out.join("\n")
}

fn filter_git_diff(text: &str, stats: &mut CompressionStats) -> String {
    const LOCKFILES: &[&str] = &[
        "Cargo.lock",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "poetry.lock",
        "uv.lock",
    ];
    let mut out = Vec::new();
    let mut skipping_lockfile = false;
    let mut skipped_lines = 0usize;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if skipping_lockfile && skipped_lines > 0 {
                out.push(format!("... [rtk: lockfile hunk elided ({skipped_lines} lines)]"));
                skipped_lines = 0;
            }
            let is_lock = LOCKFILES.iter().any(|lf| rest.contains(lf));
            skipping_lockfile = is_lock;
            out.push(line.to_string());
            continue;
        }
        if skipping_lockfile {
            if line.starts_with("index ") || line.starts_with("--- ") || line.starts_with("+++ ") {
                out.push(line.to_string());
            } else {
                skipped_lines += 1;
                stats.lockfile_lines_dropped += 1;
            }
            continue;
        }
        if is_high_signal_line(line) {
            stats.diagnostic_lines_preserved += 1;
        }
        out.push(line.to_string());
    }
    if skipping_lockfile && skipped_lines > 0 {
        out.push(format!("... [rtk: lockfile hunk elided ({skipped_lines} lines)]"));
    }
    out.join("\n")
}

fn filter_pkg_install(text: &str, stats: &mut CompressionStats) -> String {
    let mut out = Vec::new();
    let mut dropped = 0usize;
    for line in text.lines() {
        let t = line.trim();
        if is_high_signal_line(line) {
            stats.diagnostic_lines_preserved += 1;
            out.push(line.to_string());
            continue;
        }
        if t.starts_with("Collecting ")
            || t.starts_with("Using cached ")
            || t.starts_with("Downloading ")
            || t.starts_with("Requirement already satisfied:")
            || t.starts_with("Preparing metadata")
            || is_progress_or_spinner_line(t)
        {
            dropped += 1;
            stats.progress_lines_dropped += 1;
            continue;
        }
        out.push(line.to_string());
    }
    append_compaction_summary(&mut out, 0, dropped, 0);
    out.join("\n")
}

fn filter_generic_noisy(text: &str, stats: &mut CompressionStats) -> String {
    let mut out = Vec::new();
    let mut dropped_pass = 0usize;
    let mut dropped_progress = 0usize;

    for line in text.lines() {
        let t = line.trim();
        if is_high_signal_line(line) {
            stats.diagnostic_lines_preserved += 1;
            out.push(line.to_string());
            continue;
        }
        if is_progress_or_spinner_line(t) {
            dropped_progress += 1;
            stats.progress_lines_dropped += 1;
            continue;
        }
        if is_pass_noise_line(t) {
            dropped_pass += 1;
            stats.pass_lines_dropped += 1;
            continue;
        }
        out.push(line.to_string());
    }
    append_compaction_summary(&mut out, dropped_pass, 0, dropped_progress);
    out.join("\n")
}

fn append_compaction_summary(
    out: &mut Vec<String>,
    dropped_pass: usize,
    dropped_build: usize,
    dropped_progress: usize,
) {
    let mut parts = Vec::new();
    if dropped_pass > 0 {
        parts.push(format!("{dropped_pass} passing lines omitted"));
    }
    if dropped_build > 0 {
        parts.push(format!("{dropped_build} build/progress lines omitted"));
    }
    if dropped_progress > 0 {
        parts.push(format!("{dropped_progress} progress ticks stripped"));
    }
    if !parts.is_empty() {
        out.push(format!("[rtk: {}]", parts.join(", ")));
    }
}

fn ensure_exit_code_present(mut text: String, exit_code: i32) -> String {
    if text.contains("exit_code:") || text.contains("Command exited with code") {
        return text;
    }
    if text.trim().is_empty() {
        return format!("exit_code: {exit_code}");
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("exit_code: {exit_code}"));
    text
}

/// Cap text at `max_tokens` / `max_bytes` while retaining head, ALL diagnostic islands (up to budget), and tail.
fn cap_preserving_diagnostics(
    text: &str,
    max_tokens: u64,
    max_bytes: usize,
    spill_path: Option<&Path>,
) -> String {
    let byte_cap = ((max_tokens as usize).saturating_mul(3) + (max_tokens as usize) / 2)
        .min(max_bytes)
        .max(512);
    if text.len() <= byte_cap && estimate_tokens(text) <= max_tokens {
        return text.to_string();
    }

    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    // Reserve bytes per region: 25% head, 45% diagnostic islands + surrounding context, 30% tail.
    let head_budget = byte_cap / 4;
    let diag_budget = (byte_cap * 45) / 100;
    let tail_budget = byte_cap.saturating_sub(head_budget + diag_budget).saturating_sub(180);

    let mut head_idx_end = 0usize;
    let mut head_bytes = 0usize;
    while head_idx_end < lines.len() {
        let next_len = lines[head_idx_end].len() + 1;
        if head_bytes + next_len > head_budget && head_idx_end > 0 {
            break;
        }
        head_bytes += next_len;
        head_idx_end += 1;
    }

    let mut tail_idx_start = lines.len();
    let mut tail_bytes = 0usize;
    while tail_idx_start > head_idx_end {
        let candidate = lines[tail_idx_start - 1].len() + 1;
        if tail_bytes + candidate > tail_budget && tail_idx_start < lines.len() {
            break;
        }
        tail_bytes += candidate;
        tail_idx_start -= 1;
    }

    // Collect high-signal diagnostic lines in the middle range [head_idx_end..tail_idx_start].
    let mut diag_lines: Vec<String> = Vec::new();
    let mut diag_bytes = 0usize;
    let mut last_kept: Option<usize> = None;
    for idx in head_idx_end..tail_idx_start {
        if is_high_signal_line(lines[idx]) {
            let ctx_start = idx.saturating_sub(1).max(head_idx_end);
            let ctx_end = (idx + 2).min(tail_idx_start);
            for k in ctx_start..ctx_end {
                if last_kept.is_some_and(|prev| k <= prev) {
                    continue;
                }
                let line = truncate_line_utf8(lines[k], 480);
                if diag_bytes + line.len() + 1 > diag_budget {
                    break;
                }
                diag_bytes += line.len() + 1;
                diag_lines.push(line);
                last_kept = Some(k);
            }
            if diag_bytes >= diag_budget {
                break;
            }
        }
    }

    let mut out = String::with_capacity(byte_cap.min(text.len()));
    for line in &lines[..head_idx_end] {
        out.push_str(&truncate_line_utf8(line, 480));
        out.push('\n');
    }

    let elided_count = tail_idx_start.saturating_sub(head_idx_end);
    if elided_count > 0 {
        let spill_suffix = spill_path
            .map(|p| format!("; full raw log: {}", p.display()))
            .unwrap_or_default();
        out.push_str(&format!(
            "\n... [rtk: {elided_count} middle lines compacted{spill_suffix}] ...\n"
        ));
        for dl in diag_lines {
            out.push_str(&dl);
            out.push('\n');
        }
        out.push_str("... [end diagnostic excerpts] ...\n\n");
    }

    for (pos, line) in lines[tail_idx_start..].iter().enumerate() {
        if pos > 0 {
            out.push('\n');
        }
        out.push_str(&truncate_line_utf8(line, 480));
    }

    if estimate_tokens(&out) > max_tokens {
        // Hard byte-safe fallback keeping tail + exit_code intact if head+diag had dense tokens.
        let keep_bytes = ((max_tokens as usize) * 3).min(out.len());
        let suffix_start = floor_char_boundary(&out, out.len().saturating_sub(keep_bytes));
        return format!("... [rtk: capped at {max_tokens} tokens]\n{}", &out[suffix_start..]);
    }
    out
}

fn truncate_line_utf8(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let end = floor_char_boundary(line, max_bytes);
    format!("{} ... [line truncated]", &line[..end])
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_and_collapses_progress_cr_frames() {
        let raw = "\x1b[32mDownloading\x1b[0m\rFetching 10%\rFetching 100%\n\x1b]0;title\x07Done\n";
        let clean = strip_ansi_and_progress(raw);
        assert!(!clean.contains("\x1b"));
        assert!(clean.contains("Fetching 100%"));
        assert!(!clean.contains("Fetching 10%"));
        assert!(clean.contains("Done"));
    }

    #[test]
    fn preserves_errors_assertions_file_line_and_exit_code_while_dropping_pass_noise() {
        let mut lines = Vec::new();
        for i in 0..80 {
            lines.push(format!("tests/test_ok_{i}.py::test_case PASSED [ 10%]"));
        }
        lines.push("FAILED tests/test_core.py::test_math - AssertionError: expected 4".into());
        lines.push("src/lib.rs:42:5: error[E0308]: mismatched types".into());
        lines.push("tests/test_ok_81.py::test_case PASSED [ 99%]".into());
        lines.push("== 1 failed, 81 passed in 0.42s ==".into());
        let raw = lines.join("\n");

        let res = compress_tool_output("pytest -q", &raw, "", Some(1), None);
        assert!(res.was_compressed);
        assert_eq!(res.profile, "test_runner");
        assert!(res.stats.pass_lines_dropped >= 80);
        assert!(res.content.contains("FAILED tests/test_core.py::test_math"));
        assert!(res.content.contains("AssertionError: expected 4"));
        assert!(res.content.contains("src/lib.rs:42:5: error[E0308]"));
        assert!(res.content.contains("1 failed, 81 passed"));
        assert!(res.content.contains("exit_code: 1"));
    }

    #[test]
    fn spills_over_20kb_logs_externally_and_redacts_secrets_under_5k_token_cap() {
        let tmp = std::env::temp_dir().join(format!("omni_rtk_spill_test_{}", uuid::Uuid::new_v4()));
        let mut raw = String::from("INFO boot ok\n");
        for i in 0..700 {
            raw.push_str(&format!(
                "DEBUG [step={i}] verbose telemetry trace line noise without errors padding_token_{i}\n"
            ));
        }
        raw.push_str("Authorization: Bearer sk-dummy-not-real-1234567890abcdef\n");
        raw.push_str("src/solver.py:118: AssertionError: balance drift detected\n");
        for i in 0..400 {
            raw.push_str(&format!("INFO trailing progress {i} ... ok\n"));
        }
        assert!(raw.len() > DEFAULT_SPILL_THRESHOLD_BYTES);

        let res = compress_tool_output("cargo test", &raw, "", Some(101), Some(&tmp));
        assert!(res.spilled);
        let sp = res.spill_path.as_ref().expect("spill path");
        assert!(sp.exists());
        assert!(res.compressed_tokens_est <= DEFAULT_MAX_OUTPUT_TOKENS);
        assert!(res.content.contains("AssertionError: balance drift detected"));
        assert!(res.content.contains("exit_code: 101"));
        let spilled_disk = fs::read_to_string(sp).unwrap();
        assert!(!spilled_disk.contains("sk-dummy-not-real-1234567890abcdef"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn git_diff_elides_lockfile_hunks_and_keeps_source_hunks() {
        let mut raw = String::from("diff --git a/Cargo.lock b/Cargo.lock\nindex 111..222 100644\n--- a/Cargo.lock\n+++ b/Cargo.lock\n");
        for i in 0..90 {
            raw.push_str(&format!("+version = \"0.1.{i}\"\n"));
        }
        raw.push_str("diff --git a/src/main.rs b/src/main.rs\n@@ -1,2 +1,2 @@\n-let x = 1;\n+let x = 2;\n");
        let res = compress_tool_output("git diff", &raw, "", Some(0), None);
        assert_eq!(res.profile, "git_diff");
        assert!(res.stats.lockfile_lines_dropped > 50);
        assert!(res.content.contains("+let x = 2;"));
        assert!(res.content.contains("lockfile hunk elided"));
    }
}
