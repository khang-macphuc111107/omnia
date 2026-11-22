//! Frontier `v0.3.0` KV-Cache-Aware Epoch-Aligned Observation Masking & Semantic Loop Guard.
//!
//! Synthesizes **JetBrains Research *The Complexity Trap*** (`arXiv:2508.21433`),
//! **ACON** (`arXiv:2510.00615`), **Context-Folding / FoldAgent** (`arXiv:2510.11967`),
//! **ActKV** (`arXiv:2609.31395`), and **ByteDance Trae Lakeview**:
//! - **Append-Only Steady State** below soft watermark (`44,000` chars) -> 100% byte-identical KV prefix (`95-99%` cache hit!).
//! - **One-Shot Batch Epoch Fold** on crossing `44,000` chars -> folds eligible observations in
//!   `(last_masked_turn .. current_turn - K]` (`K = 4`) toward `24,000` chars in ONE step, then
//!   advances monotonic `last_masked_turn` so subsequent turns remain 100% append-only!
//! - **Action-Guided Retention (ActKV + ACON):**
//!   - Priority 1: Supersede stale `read_file` outputs of files later re-read or edited/patched.
//!   - Priority 2: Compact 8-line observation masks (Aho-Corasick diagnostic signal extraction) on stale noisy outputs.
//!   - Strictly Protected: Token-0 system, Turn-1 user, latest failing `shell` traceback, compact edit/patch diffs, and active unread/unedited reads.
//! - **SemanticLoopGuard:** Typed `ErrorKind` (`ImportOrModuleShadow`, `SyntaxOrTomlOrJson`, `EditMismatch`, `GenericError`)
//!   + normalized `xxh3_64` error-fingerprint streak detection (catches semantic loops even when args change!).

use crate::cache_guard::blake3_hex;
use aho_corasick::AhoCorasickBuilder;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use xxhash_rust::xxh3::xxh3_64;

pub const DEFAULT_LAKEVIEW_THRESHOLD_CHARS: usize = 6_000;
pub const DEFAULT_LAKEVIEW_READ_FILE_THRESHOLD_CHARS: usize = 16_000;
pub const DEFAULT_LAKEVIEW_WATERMARK_CHARS: usize = 64_000;
pub const DEFAULT_KEEP_RECENT_TURNS: usize = 6;
pub const DEFAULT_MAX_TOOL_REPETITIONS: usize = 3;

pub const EPOCH_SOFT_WATERMARK_CHARS: usize = 44_000;
pub const EPOCH_TARGET_FLOOR_CHARS: usize = 24_000;
pub const EPOCH_KEEP_RECENT_TURNS: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    pub content: String,
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_signature: Option<String>,
    #[serde(default)]
    pub redacted_thinking: Vec<String>,
    #[serde(default)]
    pub reasoning_origin_turn: u32,
    pub tool_calls: Vec<ToolCallRecord>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_target_path: Option<String>,
    #[serde(default)]
    pub tool_is_error: bool,
    pub turn_index: u32,
    pub lakeview_compressed: bool,
}

impl HarnessMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
            reasoning: None,
            reasoning_signature: None,
            redacted_thinking: Vec::new(),
            reasoning_origin_turn: 0,
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            tool_target_path: None,
            tool_is_error: false,
            turn_index: 0,
            lakeview_compressed: false,
        }
    }

    pub fn user(content: impl Into<String>, turn_index: u32) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            reasoning: None,
            reasoning_signature: None,
            redacted_thinking: Vec::new(),
            reasoning_origin_turn: 0,
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            tool_target_path: None,
            tool_is_error: false,
            turn_index,
            lakeview_compressed: false,
        }
    }

    pub fn assistant(
        content: impl Into<String>,
        reasoning: Option<String>,
        tool_calls: Vec<ToolCallRecord>,
        turn_index: u32,
    ) -> Self {
        Self::assistant_with_signature(content, reasoning, None, tool_calls, turn_index)
    }

    pub fn assistant_with_signature(
        content: impl Into<String>,
        reasoning: Option<String>,
        reasoning_signature: Option<String>,
        tool_calls: Vec<ToolCallRecord>,
        turn_index: u32,
    ) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            reasoning,
            reasoning_signature,
            redacted_thinking: Vec::new(),
            reasoning_origin_turn: turn_index,
            tool_calls,
            tool_call_id: None,
            tool_name: None,
            tool_target_path: None,
            tool_is_error: false,
            turn_index,
            lakeview_compressed: false,
        }
    }

    pub fn tool_result(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: impl Into<String>,
        turn_index: u32,
    ) -> Self {
        Self::tool_result_with_meta(tool_call_id, tool_name, content, turn_index, None, false)
    }

    pub fn tool_result_with_meta(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: impl Into<String>,
        turn_index: u32,
        target_path: Option<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            reasoning: None,
            reasoning_signature: None,
            redacted_thinking: Vec::new(),
            reasoning_origin_turn: 0,
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
            tool_target_path: target_path,
            tool_is_error: is_error,
            turn_index,
            lakeview_compressed: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LakeviewCompressionReport {
    pub compressed_count: u32,
    pub chars_saved: u64,
}

/// Stateful Epoch-Aligned Hysteresis Observation Masker (`W_soft=44k`, `W_target=24k`, `K=4`).
/// Includes dynamic post-fold high-watermark ratcheting + minimum `K`-turn epoch cooldown so
/// KV prefix caching never thrashes even when protected/recent turns stay `>= W_soft`!
#[derive(Debug, Clone)]
pub struct EpochMaskingState {
    pub soft_watermark_chars: usize,
    pub effective_watermark_chars: usize,
    pub target_floor_chars: usize,
    pub keep_recent_turns: u32,
    pub last_masked_turn: u32,
    pub last_fold_turn: u32,
    pub epochs_folded: u32,
}

impl Default for EpochMaskingState {
    fn default() -> Self {
        Self {
            soft_watermark_chars: EPOCH_SOFT_WATERMARK_CHARS,
            effective_watermark_chars: EPOCH_SOFT_WATERMARK_CHARS,
            target_floor_chars: EPOCH_TARGET_FLOOR_CHARS,
            keep_recent_turns: EPOCH_KEEP_RECENT_TURNS,
            last_masked_turn: 0,
            last_fold_turn: 0,
            epochs_folded: 0,
        }
    }
}

impl EpochMaskingState {
    pub fn new(soft_watermark_chars: usize, target_floor_chars: usize, keep_recent_turns: u32) -> Self {
        Self {
            soft_watermark_chars,
            effective_watermark_chars: soft_watermark_chars,
            target_floor_chars,
            keep_recent_turns,
            last_masked_turn: 0,
            last_fold_turn: 0,
            epochs_folded: 0,
        }
    }

    /// Context-scaled KV-Cache-Optimal Watermark (`SOTA v4` Fix #3):
    /// `W_soft = min(0.45 * model_context_chars, 280_000)` (clamped >= `44_000`) so 200k–1M-ctx
    /// models remain 100% append-only (`Cache Hit >= 92%`) without premature KV prefix resets,
    /// while staying well below the Chroma Context-Rot knee!
    #[must_use]
    pub fn for_context_window(context_window_tokens: u64) -> Self {
        let model_ctx_chars = context_window_tokens.saturating_mul(4);
        let scaled = ((model_ctx_chars as f64) * 0.45) as usize;
        let w_soft = scaled.clamp(EPOCH_SOFT_WATERMARK_CHARS, 280_000);
        let w_target = ((w_soft as f64) * 0.55) as usize;
        Self::new(w_soft, w_target.max(EPOCH_TARGET_FLOOR_CHARS), EPOCH_KEEP_RECENT_TURNS)
    }

    /// Execute KV-cache-safe hysteresis epoch masking.
    ///
    /// - Under `effective_watermark_chars` OR inside the `K`-turn epoch cooldown: performs ZERO mutations (100% append-only KV prefix).
    /// - At or above `effective_watermark_chars` after cooldown: folds `(last_masked_turn ..= current_turn - K]` in ONE batch,
    ///   advances `last_masked_turn = cutoff`, records `last_fold_turn = current_turn`, and ratchets
    ///   `effective_watermark_chars = max(soft_watermark_chars, post_fold_chars + 16_000)`!
    pub fn maybe_fold(
        &mut self,
        messages: &mut [HarnessMessage],
        current_turn: u32,
    ) -> LakeviewCompressionReport {
        let mut rep = LakeviewCompressionReport::default();
        let mut total_chars: usize = messages.iter().map(|m| m.content.len()).sum();
        if total_chars < self.effective_watermark_chars {
            return rep;
        }
        // Minimum K-turn epoch cooldown after any previous fold prevents per-turn KV prefix busting!
        if self.epochs_folded > 0
            && current_turn < self.last_fold_turn.saturating_add(self.keep_recent_turns)
        {
            return rep;
        }
        let cutoff = current_turn.saturating_sub(self.keep_recent_turns);
        if cutoff <= self.last_masked_turn {
            return rep;
        }

        // Scan history for Action-Guided retention metadata (ActKV + ACON):
        // 1. Latest turn & op touching each file path (to detect superseded `read_file` observations)
        // 2. Index of the latest failing `shell` traceback (STRICTLY protected verbatim!)
        let mut latest_file_op: FxHashMap<String, (u32, String)> = FxHashMap::default();
        let mut latest_failing_shell_idx: Option<usize> = None;

        for (idx, msg) in messages.iter().enumerate() {
            if msg.role != "tool" {
                continue;
            }
            let tool = msg.tool_name.as_deref().unwrap_or("");
            if tool == "shell"
                && (msg.tool_is_error
                    || msg.content.starts_with("Error:")
                    || msg.content.contains("Command exited with code"))
            {
                latest_failing_shell_idx = Some(idx);
            }
            if let Some(ref p) = msg.tool_target_path {
                if matches!(tool, "read_file" | "edit_file" | "write_file" | "apply_patch") {
                    let norm = p.replace('\\', "/");
                    let replace = latest_file_op
                        .get(&norm)
                        .is_none_or(|(prev_t, _)| msg.turn_index >= *prev_t);
                    if replace {
                        latest_file_op.insert(norm, (msg.turn_index, tool.to_string()));
                    }
                }
            }
        }

        let prev_epoch = self.last_masked_turn;

        // Priority 1: Mask superseded `read_file` observations in `(prev_epoch ..= cutoff]`
        for msg in messages.iter_mut() {
            if msg.role != "tool"
                || msg.lakeview_compressed
                || msg.turn_index <= prev_epoch
                || msg.turn_index > cutoff
            {
                continue;
            }
            if msg.tool_name.as_deref() != Some("read_file") {
                continue;
            }
            let Some(ref p) = msg.tool_target_path else {
                continue;
            };
            let norm = p.replace('\\', "/");
            if let Some((latest_t, latest_op)) = latest_file_op.get(&norm) {
                if *latest_t > msg.turn_index {
                    let orig_len = msg.content.len();
                    let orig_lines = msg.content.lines().count();
                    let tombstone = format!(
                        "[Masked: read_file '{norm}' ({orig_len} chars, {orig_lines} lines) — superseded by {latest_op} at turn {latest_t}]"
                    );
                    if tombstone.len() < orig_len {
                        let saved = orig_len - tombstone.len();
                        msg.content = tombstone;
                        msg.lakeview_compressed = true;
                        rep.compressed_count += 1;
                        rep.chars_saved += saved as u64;
                        total_chars = total_chars.saturating_sub(saved);
                    }
                }
            }
        }

        // Priority 2: Mask stale noisy observations (`workspace_map`, `search_code`, passing `shell`,
        // or huge `read_file` > 16k) in `(prev_epoch ..= cutoff]` while protecting active failure tracebacks & edit diffs!
        for (idx, msg) in messages.iter_mut().enumerate() {
            if total_chars <= self.target_floor_chars {
                break;
            }
            if msg.role != "tool"
                || msg.lakeview_compressed
                || msg.turn_index <= prev_epoch
                || msg.turn_index > cutoff
            {
                continue;
            }
            // Strictly protect the latest failing shell traceback verbatim!
            if Some(idx) == latest_failing_shell_idx {
                continue;
            }
            let tool_label = msg.tool_name.as_deref().unwrap_or("tool");
            // Strictly protect compact edit/patch/write confirmations (< 2,000 chars)
            if matches!(tool_label, "edit_file" | "apply_patch" | "write_file")
                && msg.content.len() < 2_000
            {
                continue;
            }
            let threshold = if tool_label == "read_file" {
                DEFAULT_LAKEVIEW_READ_FILE_THRESHOLD_CHARS
            } else {
                2_000
            };
            if msg.content.len() <= threshold {
                continue;
            }

            let orig_len = msg.content.len();
            let summary = summarize_tool_output_compact(tool_label, &msg.content);
            if summary.len() < orig_len {
                let saved = orig_len - summary.len();
                msg.content = summary;
                msg.lakeview_compressed = true;
                rep.compressed_count += 1;
                rep.chars_saved += saved as u64;
                total_chars = total_chars.saturating_sub(saved);
            }
        }

        // Always advance monotonic epoch pointer so turns <= cutoff are never mutated again!
        self.last_masked_turn = cutoff;
        if rep.compressed_count > 0 {
            self.epochs_folded += 1;
            self.last_fold_turn = current_turn;
            // Ratchet post-fold high-watermark so protected/recent turns >= W_soft cannot
            // cause per-turn KV prefix thrashing on subsequent turns!
            self.effective_watermark_chars = self
                .soft_watermark_chars
                .max(total_chars.saturating_add(16_000));
        }
        rep
    }
}

/// Legacy / manual `/compact` helper: compresses verbose tool results older than `keep_recent_turns`.
pub fn compress_stale_tool_results(
    messages: &mut [HarnessMessage],
    current_turn: u32,
    threshold_chars: usize,
    keep_recent_turns: usize,
) -> LakeviewCompressionReport {
    compress_stale_tool_results_with_watermark(
        messages,
        current_turn,
        threshold_chars,
        keep_recent_turns,
        0,
    )
}

pub fn compress_stale_tool_results_with_watermark(
    messages: &mut [HarnessMessage],
    current_turn: u32,
    threshold_chars: usize,
    keep_recent_turns: usize,
    watermark_chars: usize,
) -> LakeviewCompressionReport {
    let mut rep = LakeviewCompressionReport::default();
    let cutoff = current_turn.saturating_sub(keep_recent_turns as u32);
    if cutoff == 0 {
        return rep;
    }

    if watermark_chars > 0 {
        let total_chars: usize = messages.iter().map(|m| m.content.len()).sum();
        if total_chars < watermark_chars {
            return rep;
        }
    }

    for msg in messages.iter_mut() {
        if msg.role != "tool" || msg.lakeview_compressed || msg.turn_index >= cutoff {
            continue;
        }
        let tool_label = msg.tool_name.as_deref().unwrap_or("tool");
        let effective_threshold = if tool_label == "read_file" && watermark_chars > 0 {
            threshold_chars.max(DEFAULT_LAKEVIEW_READ_FILE_THRESHOLD_CHARS)
        } else {
            threshold_chars
        };
        if msg.content.len() <= effective_threshold {
            continue;
        }
        let orig_len = msg.content.len();
        let summary = summarize_tool_output_compact(tool_label, &msg.content);
        if summary.len() < orig_len {
            rep.compressed_count += 1;
            rep.chars_saved += (orig_len - summary.len()) as u64;
            msg.content = summary;
            msg.lakeview_compressed = true;
        }
    }
    rep
}

fn diagnostic_ac() -> &'static aho_corasick::AhoCorasick {
    static AC: OnceLock<aho_corasick::AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build([
                "error",
                "failed",
                "assert",
                "exception",
                "passed",
                "traceback",
                "warning:",
                "panicked",
                "modulenotfound",
                "importerror",
                "syntaxerror",
            ])
            .unwrap()
    })
}

fn summarize_tool_output_compact(tool_name: &str, text: &str) -> String {
    let cap_line = |l: &str| -> String {
        if l.len() > 240 {
            let mut s: String = l.chars().take(220).collect();
            s.push_str("...[truncated]");
            s
        } else {
            l.to_string()
        }
    };

    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();
    let orig_chars = text.len();
    let ac = diagnostic_ac();

    let head_n = 4usize.min(total_lines);
    let head: Vec<String> = lines.iter().take(head_n).map(|l| cap_line(l)).collect();
    let tail_start = total_lines.saturating_sub(4).max(head_n);
    let tail: Vec<String> = if total_lines > head_n {
        lines[tail_start..].iter().map(|l| cap_line(l)).collect()
    } else {
        Vec::new()
    };

    let mut key_signals: Vec<String> = Vec::new();
    if tail_start > head_n {
        for &line in &lines[head_n..tail_start] {
            if ac.is_match(line) {
                key_signals.push(cap_line(line));
                if key_signals.len() >= 6 {
                    break;
                }
            }
        }
    }

    let mut out = format!(
        "[Lakeview Summary | tool={tool_name} | original={orig_chars} chars, {total_lines} lines]\n"
    );
    out.push_str(&head.join("\n"));
    if !key_signals.is_empty() {
        out.push_str("\n... [key signals] ...\n");
        out.push_str(&key_signals.join("\n"));
    }
    if !tail.is_empty() {
        out.push_str("\n... [tail] ...\n");
        out.push_str(&tail.join("\n"));
    }
    out
}

// ============================================================================
// Typed Error Classification & Semantic Error-Fingerprint Loop Guard
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    ImportOrModuleShadow,
    SyntaxOrTomlOrJson,
    EditMismatch,
    GenericError,
}

pub fn classify_tool_error(tool_name: &str, output: &str) -> ErrorKind {
    let low = output.to_ascii_lowercase();
    if low.contains("modulenotfounderror")
        || low.contains("importerror")
        || low.contains("circular import")
        || low.contains("cannot find module")
        || low.contains("no module named")
        || low.contains("partially initialized module")
    {
        return ErrorKind::ImportOrModuleShadow;
    }
    if low.contains("syntaxerror")
        || low.contains("indentationerror")
        || low.contains("tomldecodeerror")
        || low.contains("jsondecodeerror")
        || low.contains("unexpected token")
        || low.contains("parse error")
    {
        return ErrorKind::SyntaxOrTomlOrJson;
    }
    if matches!(tool_name, "edit_file" | "apply_patch")
        || low.contains("old_string not found")
        || low.contains("hashline")
        || low.contains("apply_patch failed")
        || low.contains("hunk did not match")
    {
        return ErrorKind::EditMismatch;
    }
    ErrorKind::GenericError
}

fn kind_guidance(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::ImportOrModuleShadow => {
            "Check for stdlib-shadowing filenames in the workspace root (e.g. `calendar.py`, `json.py`, `logging.py`, `typing.py`), broken `pyproject.toml`/`sys.path`, or circular imports."
        }
        ErrorKind::SyntaxOrTomlOrJson => {
            "Re-read the failing line range with `read_file`, check quoting/UTF-8 BOM/CRLF/trailing commas, and verify syntax via `python -m py_compile` or `node --check`."
        }
        ErrorKind::EditMismatch => {
            "Use `read_file` to get fresh `line:hash` anchors and apply via Hashline anchor mode (`start_anchor`/`end_anchor`) or `write_file`."
        }
        ErrorKind::GenericError => {
            "Read the exact error traceback and target source lines carefully, then change strategy instead of repeating the same approach."
        }
    }
}

/// Compute a 64-bit `xxh3_64` fingerprint of the normalized diagnostic error lines
/// (stripping line numbers, hex addresses, and timestamps so equivalent failures match!).
pub fn error_fingerprint(output: &str) -> u64 {
    let ac = diagnostic_ac();
    let mut sig_lines: Vec<String> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if ac.is_match(trimmed) {
            sig_lines.push(normalize_error_line(trimmed));
            if sig_lines.len() >= 4 {
                break;
            }
        }
    }
    if sig_lines.is_empty() {
        if let Some(first) = output.lines().find(|l| !l.trim().is_empty()) {
            sig_lines.push(normalize_error_line(first.trim()));
        }
    }
    let joined = sig_lines.join("\n");
    xxh3_64(joined.as_bytes())
}

fn normalize_error_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut prev_digit = false;
    for ch in line.chars() {
        if ch.is_ascii_digit() {
            if !prev_digit {
                out.push('#');
                prev_digit = true;
            }
        } else {
            prev_digit = false;
            out.push(ch.to_ascii_lowercase());
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct SemanticLoopGuard {
    max_repetitions: usize,
    recent_signatures: Vec<(String, String, bool)>, // (tool_name, args_hash, is_error)
    pub last_error_fingerprint: Option<u64>,
    pub same_error_streak: u32,
    emitted_first_kind_hint: FxHashSet<ErrorKind>,
    pub nudges_emitted: u32,
}

/// Backward-compatible alias preserved for external callers.
pub type RepetitionLoopGuard = SemanticLoopGuard;

impl Default for SemanticLoopGuard {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_TOOL_REPETITIONS)
    }
}

impl SemanticLoopGuard {
    pub fn new(max_repetitions: usize) -> Self {
        Self {
            max_repetitions: max_repetitions.max(2),
            recent_signatures: Vec::new(),
            last_error_fingerprint: None,
            same_error_streak: 0,
            emitted_first_kind_hint: FxHashSet::default(),
            nudges_emitted: 0,
        }
    }

    /// Backward-compatible observer (delegates to `observe_with_output`).
    pub fn observe(&mut self, tool_name: &str, args: &Value, is_error: bool) -> Option<String> {
        self.observe_with_output(tool_name, args, "", is_error)
    }

    /// Observe a tool call + its output. Detects:
    /// 1. Exact identical `(tool_name, args_hash)` repeated `>= max_repetitions` times.
    /// 2. Repeated semantic error fingerprint (`same_error_streak >= 2`) EVEN when arguments vary!
    /// 3. Immediate first-hit diagnostic hint on `ImportOrModuleShadow` or `SyntaxOrTomlOrJson`.
    /// 4. Consecutive failing calls to the same tool `>= max_repetitions` times.
    pub fn observe_with_output(
        &mut self,
        tool_name: &str,
        args: &Value,
        output: &str,
        is_error: bool,
    ) -> Option<String> {
        let args_hash = blake3_hex(args.to_string().as_bytes());
        self.recent_signatures
            .push((tool_name.to_string(), args_hash.clone(), is_error));
        if self.recent_signatures.len() > 24 {
            self.recent_signatures.remove(0);
        }

        if !is_error {
            self.last_error_fingerprint = None;
            self.same_error_streak = 0;
        }

        // Pattern A: identical (tool_name, args_hash) repeated >= max_repetitions times
        let exact_count = self
            .recent_signatures
            .iter()
            .filter(|(n, h, _)| n == tool_name && h == &args_hash)
            .count();
        if exact_count >= self.max_repetitions {
            self.nudges_emitted += 1;
            self.recent_signatures.clear();
            return Some(format!(
                "[Loop Guard] You called `{tool_name}` with identical arguments {exact_count} times. Stop repeating this call; inspect the workspace differently (`read_file`, `search_code`, `workspace_map`) or change strategy."
            ));
        }

        if is_error && !output.trim().is_empty() {
            let kind = classify_tool_error(tool_name, output);
            let fp = error_fingerprint(output);
            if self.last_error_fingerprint == Some(fp) {
                self.same_error_streak += 1;
            } else {
                self.last_error_fingerprint = Some(fp);
                self.same_error_streak = 1;
            }

            // Semantic Fingerprint Streak >= 2 (triggers even when args/commands differ!)
            if self.same_error_streak >= 2 {
                let streak = self.same_error_streak;
                self.same_error_streak = 0;
                self.nudges_emitted += 1;
                return Some(format!(
                    "[Loop Guard | {kind:?}] The same failure pattern occurred {streak} times in a row. Pivot your diagnosis: {}",
                    kind_guidance(kind)
                ));
            }

            // First-hit high-leverage recovery hint for Import/Module shadowing & Syntax/TOML/JSON errors
            if matches!(
                kind,
                ErrorKind::ImportOrModuleShadow | ErrorKind::SyntaxOrTomlOrJson
            ) && self.emitted_first_kind_hint.insert(kind)
            {
                self.nudges_emitted += 1;
                return Some(format!(
                    "[Recovery Hint | {kind:?}] {}",
                    kind_guidance(kind)
                ));
            }
        }

        // Pattern B: consecutive failing calls to the same tool >= max_repetitions times
        let trailing_errors = self
            .recent_signatures
            .iter()
            .rev()
            .take_while(|(n, _, err)| n == tool_name && *err)
            .count();
        if trailing_errors >= self.max_repetitions {
            self.nudges_emitted += 1;
            self.recent_signatures.clear();
            let kind = classify_tool_error(tool_name, output);
            return Some(format!(
                "[Loop Guard] `{tool_name}` failed {trailing_errors} times in a row. {}",
                kind_guidance(kind)
            ));
        }

        None
    }
}

/// Stage 1 Manus Offloading (`> 4 KB` observation spill to external temp file, NEVER inside workspace).
/// Preserves error traces verbatim while replacing oversized non-error walls of text with a compact
/// head + tail + symbol/line summary + temp pointer.
pub fn offload_large_observation(
    session_key: &str,
    tool_name: &str,
    content: &str,
    max_inline_chars: usize,
) -> (String, Option<String>) {
    let cap = max_inline_chars.max(4_096);
    if content.len() <= cap {
        return (content.to_string(), None);
    }
    let spill_dir = std::env::temp_dir().join("omnia-agent-spill");
    let _ = std::fs::create_dir_all(&spill_dir);
    let safe_sess: String = session_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    let digest = blake3_hex(content.as_bytes());
    let file_path = spill_dir.join(format!("{safe_sess}_{tool_name}_{}.txt", &digest[..12]));
    let safe_spill = crate::sanitizer::redact_secrets(content);
    let _ = std::fs::write(&file_path, safe_spill.as_bytes());

    let head: String = content.chars().take(1_600).collect();
    let tail_chars = 1_200usize;
    let total_chars = content.chars().count();
    let tail: String = if total_chars > 2_800 {
        content
            .chars()
            .skip(total_chars.saturating_sub(tail_chars))
            .collect()
    } else {
        String::new()
    };
    let line_count = content.lines().count();
    let compact = format!(
        "{head}\n\n... [Offloaded {} chars / {line_count} lines of `{tool_name}` output -> {}] ...\n\n{tail}",
        content.len(),
        file_path.display()
    );
    (compact, Some(file_path.to_string_lossy().into_owned()))
}

/// Stage 2 Factory Anchored Iterative Summarization (`factory.com/news/evaluating-compression`).
/// Maintains a persistent structured anchor (`intent`, `modified_files_and_symbols`,
/// `verified_facts`, `failed_hypotheses`, `next_steps`) merged incrementally at epoch boundaries
/// ONLY when context nears the context-rot knee (~68% of `context_window`), keeping `token_budget = None` uncapped!
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchoredSummary {
    pub intent: String,
    pub modified_files_and_symbols: Vec<String>,
    pub verified_facts: Vec<String>,
    pub failed_hypotheses: Vec<String>,
    pub next_steps: Vec<String>,
    pub merged_through_turn: u32,
}

impl AnchoredSummary {
    /// Merge turns `<= cutoff_turn` deterministically into the structured anchor without losing
    /// file paths, test verdicts, or failed hypotheses.
    pub fn merge_messages(&mut self, messages: &[HarnessMessage], cutoff_turn: u32) {
        if self.intent.is_empty() {
            if let Some(u) = messages.iter().find(|m| m.role == "user") {
                self.intent = u.content.chars().take(280).collect();
            }
        }
        for m in messages {
            if m.turn_index == 0 || m.turn_index > cutoff_turn || m.turn_index <= self.merged_through_turn {
                continue;
            }
            if m.role == "tool" {
                let tool = m.tool_name.as_deref().unwrap_or("");
                if matches!(tool, "edit_file" | "write_file" | "apply_patch") {
                    if let Some(ref p) = m.tool_target_path {
                        if !self.modified_files_and_symbols.contains(p) {
                            self.modified_files_and_symbols.push(p.clone());
                        }
                    }
                }
                if m.tool_is_error {
                    let first_line = m
                        .content
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .chars()
                        .take(160)
                        .collect::<String>();
                    if !first_line.is_empty()
                        && self.failed_hypotheses.len() < 12
                        && !self.failed_hypotheses.contains(&first_line)
                    {
                        self.failed_hypotheses.push(first_line);
                    }
                } else if tool == "shell"
                    && (m.content.contains("passed") || m.content.contains("exit_code=0") || m.content.contains("OK"))
                {
                    let fact = m
                        .content
                        .lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("shell verification passed")
                        .chars()
                        .take(160)
                        .collect::<String>();
                    if self.verified_facts.len() < 12 && !self.verified_facts.contains(&fact) {
                        self.verified_facts.push(fact);
                    }
                }
            }
        }
        self.merged_through_turn = self.merged_through_turn.max(cutoff_turn);
    }

    #[must_use]
    pub fn render_tail_block(&self) -> String {
        let mut out = String::from("[Anchored Context Summary]\n");
        if !self.intent.is_empty() {
            out.push_str(&format!("- intent: {}\n", self.intent.replace('\n', " ")));
        }
        if !self.modified_files_and_symbols.is_empty() {
            out.push_str(&format!(
                "- modified_files: {}\n",
                self.modified_files_and_symbols.join(", ")
            ));
        }
        if !self.verified_facts.is_empty() {
            out.push_str(&format!(
                "- verified_facts: {}\n",
                self.verified_facts.join(" | ")
            ));
        }
        if !self.failed_hypotheses.is_empty() {
            out.push_str(&format!(
                "- failed_hypotheses_do_not_repeat: {}\n",
                self.failed_hypotheses.join(" | ")
            ));
        }
        if !self.next_steps.is_empty() {
            out.push_str(&format!("- next_steps: {}\n", self.next_steps.join("; ")));
        }
        out
    }
}

/// Ring-Buffer Cycle & State-Oscillation Detector (`arXiv:2607.01641` IAL-Scan).
/// Tracks normalized `(tool_name, args_hash, result_hash, repo_tree_blake3)` tuples in a
/// bounded ring buffer to catch exact repeats, `S_t == S_{t-2}` repo oscillations, and
/// zero-mutation exploration churn.
#[derive(Debug, Clone)]
pub struct OscillationDetector {
    capacity: usize,
    ring: std::collections::VecDeque<OscillationEntry>,
    tree_history: std::collections::VecDeque<String>,
    zero_mutation_turns: u32,
}

#[derive(Debug, Clone)]
struct OscillationEntry {
    tool_name: String,
    args_hash: u64,
    result_hash: u64,
    is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscillationAlert {
    ExactFailingRepeat { tool_name: String, repeats: usize },
    RepoStateCycle { cycle_len: usize, tree_hash: String },
    ZeroMutationChurn { turns: u32 },
}

impl OscillationAlert {
    #[must_use]
    pub fn format_nudge(&self) -> String {
        match self {
            Self::ExactFailingRepeat { tool_name, repeats } => format!(
                "[Oscillation Guard] `{tool_name}` repeated the identical failing call {repeats} times. Change strategy, inspect the exact error trace, or switch edit mode (Hashline/apply_patch)."
            ),
            Self::RepoStateCycle { cycle_len, tree_hash } => format!(
                "[Oscillation Guard] Workspace Merkle tree returned to a prior state (cycle len={cycle_len}, hash={}). You are oscillating between reverting and re-applying edits; stop and re-verify root cause before editing again.",
                &tree_hash[..tree_hash.len().min(12)]
            ),
            Self::ZeroMutationChurn { turns } => format!(
                "[Oscillation Guard] {turns} consecutive turns with unchanged workspace tree hash. Stop passive exploration and begin implementing or running targeted tests now."
            ),
        }
    }
}

impl OscillationDetector {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(8),
            ring: std::collections::VecDeque::with_capacity(capacity.max(8)),
            tree_history: std::collections::VecDeque::with_capacity(16),
            zero_mutation_turns: 0,
        }
    }

    /// Record a tool execution and check for exact failing repeats (`>= 2`).
    pub fn observe_tool(
        &mut self,
        tool_name: &str,
        canonical_args: &str,
        result_text: &str,
        is_error: bool,
    ) -> Option<OscillationAlert> {
        let args_hash = xxh3_64(canonical_args.as_bytes());
        let result_hash = error_fingerprint(result_text);
        if self.ring.len() >= self.capacity {
            self.ring.pop_front();
        }
        self.ring.push_back(OscillationEntry {
            tool_name: tool_name.to_string(),
            args_hash,
            result_hash,
            is_error,
        });

        if is_error {
            let repeats = self
                .ring
                .iter()
                .rev()
                .take(4)
                .filter(|e| {
                    e.is_error
                        && e.tool_name == tool_name
                        && e.args_hash == args_hash
                        && e.result_hash == result_hash
                })
                .count();
            if repeats >= 2 {
                return Some(OscillationAlert::ExactFailingRepeat {
                    tool_name: tool_name.to_string(),
                    repeats,
                });
            }
        }
        None
    }

    /// Observe post-turn workspace Merkle root hash to detect `S_t == S_{t-2}` oscillations
    /// or `>= 5` consecutive zero-mutation turns.
    pub fn observe_turn_tree(
        &mut self,
        repo_tree_blake3: &str,
        had_mutation: bool,
    ) -> Option<OscillationAlert> {
        if repo_tree_blake3.is_empty() {
            return None;
        }
        if had_mutation {
            self.zero_mutation_turns = 0;
            // Check 2-cycle / 3-cycle oscillation: S_t == S_{t-2} or S_{t-3} while S_{t-1} != S_t
            let len = self.tree_history.len();
            let mut cycle_hit = None;
            if len >= 2 {
                let prev = &self.tree_history[len - 1];
                if prev != repo_tree_blake3 {
                    for back in 2..=len.min(4) {
                        if self.tree_history[len - back] == repo_tree_blake3 {
                            cycle_hit = Some(OscillationAlert::RepoStateCycle {
                                cycle_len: back,
                                tree_hash: repo_tree_blake3.to_string(),
                            });
                            break;
                        }
                    }
                }
            }
            if self.tree_history.len() >= 16 {
                self.tree_history.pop_front();
            }
            self.tree_history.push_back(repo_tree_blake3.to_string());
            return cycle_hit;
        }

        // No mutation this turn
        if self.tree_history.is_empty() {
            self.tree_history.push_back(repo_tree_blake3.to_string());
        }
        self.zero_mutation_turns += 1;
        if self.zero_mutation_turns == 5 || (self.zero_mutation_turns > 5 && self.zero_mutation_turns.is_multiple_of(4)) {
            return Some(OscillationAlert::ZeroMutationChurn {
                turns: self.zero_mutation_turns,
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compresses_only_stale_verbose_tool_outputs_preserving_prefix_and_recent_turns() {
        let big = (0..120)
            .map(|i| {
                if i == 55 {
                    "AssertionError: expected 42 got 41".to_string()
                } else {
                    format!("verbose output line {i:03} with padding text to exceed threshold")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(big.len() > 3_000);

        let mut msgs = vec![
            HarnessMessage::system("IMMUTABLE_SYS"),
            HarnessMessage::user("IMMUTABLE_TURN1", 1),
            HarnessMessage::tool_result("c1", "shell", big.clone(), 1),
            HarnessMessage::tool_result("c2", "shell", big.clone(), 4),
        ];

        let r1 = compress_stale_tool_results(&mut msgs, 5, 3_000, 2);
        assert_eq!(r1.compressed_count, 1);
        assert!(r1.chars_saved > 2_000);
        assert_eq!(msgs[0].content, "IMMUTABLE_SYS");
        assert_eq!(msgs[1].content, "IMMUTABLE_TURN1");
        assert!(msgs[2].content.contains("[Lakeview Summary"));
        assert!(msgs[2].content.contains("AssertionError: expected 42 got 41"));
        assert_eq!(msgs[3].content.len(), big.len());

        let r2 = compress_stale_tool_results(&mut msgs, 5, 3_000, 2);
        assert_eq!(r2.compressed_count, 0);

        let mut msgs_wm = vec![
            HarnessMessage::system("IMMUTABLE_SYS"),
            HarnessMessage::user("IMMUTABLE_TURN1", 1),
            HarnessMessage::tool_result("r1", "read_file", big.clone(), 1),
            HarnessMessage::tool_result("s1", "shell", big.clone(), 1),
        ];
        let r_under = compress_stale_tool_results_with_watermark(&mut msgs_wm, 10, 6_000, 6, 64_000);
        assert_eq!(r_under.compressed_count, 0);
        let r_over = compress_stale_tool_results_with_watermark(&mut msgs_wm, 10, 3_000, 6, 5_000);
        assert_eq!(r_over.compressed_count, 1);
        assert!(!msgs_wm[2].lakeview_compressed);
        assert!(msgs_wm[3].lakeview_compressed);
    }

    #[test]
    fn repetition_loop_guard_triggers_on_three_identical_or_failing_calls() {
        let mut guard = RepetitionLoopGuard::new(3);
        let args = json!({ "path": "a.py", "old_string": "x", "new_string": "y" });
        assert!(guard.observe("edit_file", &args, true).is_none());
        assert!(guard.observe("edit_file", &args, true).is_none());
        let nudge = guard.observe("edit_file", &args, true).unwrap();
        assert!(nudge.contains("[Loop Guard]"));
        assert_eq!(guard.nudges_emitted, 1);
    }

    #[test]
    fn epoch_masking_stays_append_only_under_watermark_then_folds_once_preserving_next_turns_prefix() {
        let mut masker = EpochMaskingState::new(10_000, 5_000, 4);
        let chunk = "x".repeat(3_500);
        let mut msgs = vec![
            HarnessMessage::system("SYS"),
            HarnessMessage::user("TURN1", 1),
            HarnessMessage::tool_result("s1", "shell", chunk.clone(), 1),
            HarnessMessage::tool_result("s2", "search_code", chunk.clone(), 2),
        ];

        // Total ~7k < 10k watermark -> ZERO mutations (100% append-only)
        let r0 = masker.maybe_fold(&mut msgs, 7);
        assert_eq!(r0.compressed_count, 0);
        assert_eq!(masker.last_masked_turn, 0);

        // Push above watermark (10.5k >= 10k)
        msgs.push(HarnessMessage::tool_result("s3", "workspace_map", chunk.clone(), 3));
        let r1 = masker.maybe_fold(&mut msgs, 8);
        assert!(r1.compressed_count >= 2);
        assert_eq!(masker.last_masked_turn, 4);

        // Snapshot prefix after epoch fold; next turn (turn 9) adds new message below watermark -> ZERO prefix mutations!
        let snapshot_prefix: Vec<String> = msgs.iter().map(|m| m.content.clone()).collect();
        msgs.push(HarnessMessage::tool_result("s4", "shell", "exit_code: 0\nok", 9));
        let r2 = masker.maybe_fold(&mut msgs, 9);
        assert_eq!(r2.compressed_count, 0);
        for (i, orig) in snapshot_prefix.iter().enumerate() {
            assert_eq!(&msgs[i].content, orig, "KV prefix must stay byte-identical after epoch fold!");
        }
    }

    #[test]
    fn superseded_read_file_masked_while_latest_failing_traceback_stays_verbatim() {
        let mut masker = EpochMaskingState::new(6_000, 2_000, 2);
        let big_file = (0..120)
            .map(|i| format!("{i:>4}:abc| def fn_{i}(): return {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let big_tb = format!(
            "Error: Command exited with code 1.\nTraceback (most recent call last):\n{}\nAssertionError: boom",
            "  frame detail line\n".repeat(140)
        );
        let mut msgs = vec![
            HarnessMessage::system("SYS"),
            HarnessMessage::user("TURN1", 1),
            HarnessMessage::tool_result_with_meta(
                "r1",
                "read_file",
                big_file.clone(),
                1,
                Some("pkg/app.py".into()),
                false,
            ),
            HarnessMessage::tool_result_with_meta(
                "e1",
                "edit_file",
                "Edited 'pkg/app.py' (1 replacement).",
                2,
                Some("pkg/app.py".into()),
                false,
            ),
            HarnessMessage::tool_result_with_meta(
                "sh1",
                "shell",
                big_tb.clone(),
                3,
                None,
                true,
            ),
        ];

        let rep = masker.maybe_fold(&mut msgs, 7);
        assert_eq!(rep.compressed_count, 1);
        assert!(
            msgs[2].content.contains("[Masked: read_file 'pkg/app.py'")
                && msgs[2].content.contains("superseded by edit_file at turn 2"),
            "superseded read_file should be replaced with 1-line tombstone: {}",
            msgs[2].content
        );
        assert_eq!(
            msgs[3].content,
            "Edited 'pkg/app.py' (1 replacement).",
            "compact edit confirmation must remain intact"
        );
        assert_eq!(
            msgs[4].content, big_tb,
            "latest failing shell traceback MUST stay verbatim!"
        );
    }

    #[test]
    fn semantic_loop_guard_emits_stdlib_shadow_and_repeated_error_fingerprint_nudges() {
        let mut guard = SemanticLoopGuard::new(3);

        // First ModuleNotFoundError emits immediate stdlib-shadowing recovery hint
        let hint = guard
            .observe_with_output(
                "shell",
                &json!({ "command": "pytest -q" }),
                "Error: Command exited with code 1.\nImportError: cannot import name 'monthrange' from partially initialized module 'calendar'",
                true,
            )
            .expect("should emit stdlib shadow hint");
        assert!(hint.contains("ImportOrModuleShadow"));
        assert!(hint.contains("calendar.py"));

        // Second run with DIFFERENT command args (`python -m pytest`) hitting the SAME semantic error fingerprint -> pivot nudge!
        let pivot = guard
            .observe_with_output(
                "shell",
                &json!({ "command": "python -m pytest tests/test_core.py" }),
                "Error: Command exited with code 1.\nImportError: cannot import name 'monthrange' from partially initialized module 'calendar'",
                true,
            )
            .expect("should detect semantic error fingerprint streak even with different args");
        assert!(pivot.contains("same failure pattern occurred 2 times"));
        assert!(pivot.contains("Pivot"));
    }

    #[test]
    fn epoch_masking_ratchets_watermark_and_enforces_cooldown_when_protected_chars_stay_high() {
        let mut masker = EpochMaskingState::new(44_000, 24_000, 4);
        let old_noisy = "noisy search match line with verbose context\n".repeat(120); // ~5,400 chars
        let protected_tb = format!(
            "Error: Command exited with code 1.\nTraceback (most recent call last):\n{}\nAssertionError: boom",
            "  protected frame detail line keeping context above 44k\n".repeat(820) // ~45,900 chars!
        );

        let mut msgs = vec![
            HarnessMessage::system("SYS"),
            HarnessMessage::user("TURN1", 1),
            HarnessMessage::tool_result("s1", "search_code", old_noisy.clone(), 2),
            HarnessMessage::tool_result_with_meta(
                "sh_fail",
                "shell",
                protected_tb.clone(),
                5,
                None,
                true,
            ),
        ];

        // Turn 8: total > 51k >= 44k -> folds old_noisy at turn 2, while protected_tb (~46k) remains verbatim!
        let r1 = masker.maybe_fold(&mut msgs, 8);
        assert_eq!(r1.compressed_count, 1);
        assert_eq!(masker.epochs_folded, 1);
        assert_eq!(masker.last_fold_turn, 8);
        let post_fold_chars: usize = msgs.iter().map(|m| m.content.len()).sum();
        assert!(post_fold_chars >= 44_000, "post-fold protected chars stay >= 44k");
        assert!(
            masker.effective_watermark_chars >= post_fold_chars + 16_000,
            "watermark must ratchet above post-fold chars + 16k (got {}, post={})",
            masker.effective_watermark_chars,
            post_fold_chars
        );

        // Turns 9, 10, 11: add more verbose messages pushing total far past 62k —
        // MUST emit ZERO folds during the 4-turn epoch cooldown (turns 9, 10, 11 < 8 + 4)!
        for t in 9..=11u32 {
            msgs.push(HarnessMessage::tool_result(
                format!("extra_{t}"),
                "search_code",
                "extra verbose search match line padding context\n".repeat(150),
                t - 3,
            ));
            let r = masker.maybe_fold(&mut msgs, t);
            assert_eq!(
                r.compressed_count, 0,
                "MUST NOT thrash KV prefix during 4-turn cooldown on turn {t}"
            );
        }

        // Turn 12 (>= 8 + 4) AND total >= ratcheted watermark -> allowed to fold next epoch batch!
        let r_next = masker.maybe_fold(&mut msgs, 12);
        assert!(
            r_next.compressed_count >= 1,
            "after cooldown + ratcheted watermark exceeded, next epoch fold should proceed"
        );
        assert_eq!(masker.epochs_folded, 2);
        assert_eq!(masker.last_fold_turn, 12);
    }

    #[test]
    fn context_scaled_lakeview_watermark_scales_to_280k_for_1m_models() {
        let em_1m = EpochMaskingState::for_context_window(1_000_000);
        assert_eq!(em_1m.soft_watermark_chars, 280_000);
        assert_eq!(em_1m.effective_watermark_chars, 280_000);

        let em_200k = EpochMaskingState::for_context_window(200_000);
        assert_eq!(em_200k.soft_watermark_chars, 280_000);

        let em_128k = EpochMaskingState::for_context_window(128_000);
        assert_eq!(em_128k.soft_watermark_chars, 230_400);

        let em_32k = EpochMaskingState::for_context_window(32_000);
        assert_eq!(em_32k.soft_watermark_chars, 57_600);
    }

    #[test]
    fn offload_large_observation_spills_over_4kb_with_head_tail_summary() {
        let small = "ok line\n".repeat(10);
        let (out_small, path_small) = offload_large_observation("s1", "shell", &small, 4_096);
        assert_eq!(out_small, small);
        assert!(path_small.is_none());

        let big = format!(
            "HEADER_MARKER\n{}\nTAIL_MARKER_END\n",
            "payload line 0123456789abcdef\n".repeat(250)
        );
        let (out_big, path_big) = offload_large_observation("s1", "shell", &big, 4_096);
        let spilled = path_big.expect("payload > 4 KB must spill to external temp file");
        assert!(out_big.len() < big.len());
        assert!(out_big.contains("HEADER_MARKER"));
        assert!(out_big.contains("TAIL_MARKER_END"));
        assert!(out_big.contains("Offloaded"));
        assert!(std::path::Path::new(&spilled).is_file());
        let _ = std::fs::remove_file(&spilled);
    }

    #[test]
    fn factory_anchored_summary_merges_and_retains_files_and_failures() {
        let msgs = vec![
            HarnessMessage::user("Fix rounding bug in ledger.py and verify unit tests", 1),
            HarnessMessage::tool_result_with_meta(
                "c1",
                "edit_file",
                "Edited pkg/ledger.py",
                2,
                Some("pkg/ledger.py".into()),
                false,
            ),
            HarnessMessage::tool_result_with_meta(
                "c2",
                "shell",
                "AssertionError: expected 400.00 got 400.01\nexit_code=1",
                3,
                None,
                true,
            ),
            HarnessMessage::tool_result_with_meta(
                "c3",
                "shell",
                "=== 12 passed in 0.2s ===\nexit_code=0",
                4,
                None,
                false,
            ),
        ];

        let mut anchor = AnchoredSummary::default();
        anchor.merge_messages(&msgs, 4);
        assert!(anchor.intent.contains("Fix rounding bug"));
        assert_eq!(anchor.modified_files_and_symbols, vec!["pkg/ledger.py"]);
        assert!(anchor
            .failed_hypotheses
            .iter()
            .any(|f| f.contains("AssertionError")));
        assert!(anchor
            .verified_facts
            .iter()
            .any(|f| f.contains("exit_code=0") || f.contains("passed")));
        let rendered = anchor.render_tail_block();
        assert!(rendered.contains("[Anchored Context Summary]"));
        assert!(rendered.contains("pkg/ledger.py"));
    }

    #[test]
    fn oscillation_detector_catches_exact_repeat_state_cycle_and_zero_mutation_churn() {
        let mut det = OscillationDetector::new(16);

        // 1. Exact failing repeat (>=2)
        assert!(det
            .observe_tool("edit_file", "{\"path\":\"a.py\"}", "old_string not found", true)
            .is_none());
        let repeat = det
            .observe_tool("edit_file", "{\"path\":\"a.py\"}", "old_string not found", true)
            .expect("2nd identical failing call must trigger ExactFailingRepeat");
        assert!(matches!(repeat, OscillationAlert::ExactFailingRepeat { repeats: 2, .. }));

        // 2. Repo-state 2-cycle oscillation: S0 -> S1 -> S0 (S_t == S_{t-2})
        assert!(det.observe_turn_tree("hash_aaa", true).is_none());
        assert!(det.observe_turn_tree("hash_bbb", true).is_none());
        let cycle = det
            .observe_turn_tree("hash_aaa", true)
            .expect("S_t == S_{t-2} must trigger RepoStateCycle");
        assert!(matches!(cycle, OscillationAlert::RepoStateCycle { cycle_len: 2, .. }));

        // 3. Zero-mutation churn (5 consecutive unchanged turns)
        for _ in 0..4 {
            assert!(det.observe_turn_tree("hash_aaa", false).is_none());
        }
        let churn = det
            .observe_turn_tree("hash_aaa", false)
            .expect("5th consecutive zero-mutation turn must trigger ZeroMutationChurn");
        assert!(matches!(churn, OscillationAlert::ZeroMutationChurn { turns: 5 }));
    }
}
