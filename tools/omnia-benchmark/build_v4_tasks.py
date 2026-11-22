"""Generator & reference-solution verifier for the 7 new v4 benchmark tasks (Total: 24 tasks).

Creates under D:\\omnia-bench\\suite-v4\\suite\\tasks\\:
  1. swe_04_rs_utf8_interval   (Axis 1 — Rust multi-file UTF-8 & interval algebra bugfix)
  2. refact_03_ts_large_split  (Axis 6 — 22-file JS/ESM monolith split + 18 caller rewrites)
  3. atlas_03_long_repo_needle (Axis 4 — 110-file monorepo needle hunt w/ 12 decoys)
  4. heal_03_win_crlf_lock     (Axis 7 — 5-fault Windows BOM/CRLF/SQLite-lock/concurrency recovery)
  5. resil_01_429_502_retry    (Axis 11 — fault_mode=429_502 token-bucket rate limiter fix)
  6. resil_02_sse_midstream_eof(Axis 11 — fault_mode=sse_eof WAL log compactor fix)
  7. resil_03_150kb_noisy_stdout(Axis 11 — 150 KB noisy test output buried-failure debugging)

Run with `--test-reference` to prove EVERY task fails on unmodified baseline AND passes 100%
when its reference solution is applied.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parent / "suite" / "tasks"


def _w(path: Path, text: str, *, binary: bytes | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if binary is not None:
        path.write_bytes(binary)
    else:
        path.write_text(text, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# 1. swe_04_rs_utf8_interval (Axis 1, Rust zero-dep, fail_to_pass)
# ---------------------------------------------------------------------------
def build_swe_04() -> dict:
    tdir = TASKS_DIR / "swe_04_rs_utf8_interval"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "swe_04_rs_utf8_interval",
        "axis": 1,
        "axis_name": "SWE-bench Multi-File Bug Fixing",
        "title": "Rust multi-file UTF-8 char-boundary slicing, half-open interval algebra & batch span edits",
        "difficulty": "hard",
        "languages": ["rust"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "fail_to_pass",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Fix Rust UTF-8 Excerpting, Half-Open Interval Algebra, and Batch Span Edits

You are working on a zero-dependency Rust library (`span_index`) in the current workspace.
Run `cargo test` to see existing public tests pass. However, four production bugs have been reported across `src/text.rs`, `src/interval.rs`, and `src/lib.rs`:

1. **UTF-8 char-boundary panic (`src/text.rs` -> `excerpt_around`)**:
   `excerpt_around(s: &str, byte_pos: usize, radius_bytes: usize) -> &str` currently slices `&s[start..end]` directly at raw byte offsets, panicking whenever `byte_pos`, `byte_pos - radius`, or `byte_pos + radius` falls inside a multi-byte UTF-8 codepoint (e.g., Vietnamese diacritics, CJK, emoji).
   - Clamp `byte_pos` to `s.len()`.
   - Snap `start = pos.saturating_sub(radius_bytes)` **downward** (floor) to the nearest valid UTF-8 char boundary (`<= start`).
   - Snap `end = pos.saturating_add(radius_bytes).min(s.len())` **upward** (ceil) to the nearest valid UTF-8 char boundary (`>= end`, capped at `s.len()`).

2. **Half-open interval merge bugs (`src/interval.rs` -> `merge_intervals`)**:
   Intervals are half-open `[start, end)` (ignore empty/inverted spans where `start >= end`).
   - Adjacent intervals (`[0, 5)` and `[5, 10)`) MUST be merged into `[0, 10)`.
   - Unsorted and nested intervals (e.g., `[0, 10)` followed by `[2, 4)`) MUST preserve the larger `end` (`[0, 10)`), never shrinking `end`.

3. **Interval subtraction splitting bug (`src/interval.rs` -> `subtract_intervals`)**:
   `subtract_intervals(base: &[Span], remove: &[Span]) -> Vec<Span>` must first normalize/merge both sets, then compute the exact set difference `base \\ remove`. When a removed interval lies strictly inside a base interval (e.g., `[0, 10) \\ [3, 7)`), BOTH the left `[0, 3)` AND right `[7, 10)` remainders must be emitted in sorted order.

4. **Batch span replacement bug (`src/lib.rs` -> `apply_replacements`)**:
   `apply_replacements(input: &str, edits: &[Replacement]) -> Result<String, SpanError>` currently mutates offsets left-to-right without compensating for length deltas and fails to detect overlaps or invalid UTF-8 boundaries.
   - Validate every edit: `start <= end <= input.len()` and both `start` and `end` are UTF-8 char boundaries (`Err(SpanError::InvalidBounds)` otherwise).
   - Detect overlapping edits: two edits overlap if their non-empty ranges intersect (`prev.end > cur.start`), OR if two zero-length insertions target the exact same offset (`Err(SpanError::Overlap)`). Adjacent non-overlapping edits (`prev.end == cur.start`, e.g., `[0, 3)` and `[3, 6)`) are valid!
   - Apply all valid edits simultaneously with respect to the **original** `input` byte offsets (order of `edits` slice must not matter).

Keep all existing public tests passing and ensure `cargo test` compiles cleanly with zero warnings.
""")

    _w(ws / "Cargo.toml", """[package]
name = "span_index"
version = "0.1.0"
edition = "2021"
""")

    _w(ws / "src" / "interval.rs", """#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
}

/// BUGGY: ignores adjacency (uses > instead of >=) and overwrites end on nested spans.
pub fn merge_intervals(spans: &[Span]) -> Vec<Span> {
    let mut valid: Vec<Span> = spans.iter().copied().filter(|s| !s.is_empty()).collect();
    valid.sort_by_key(|s| (s.start, s.end));
    let mut out: Vec<Span> = Vec::new();
    for s in valid {
        if let Some(last) = out.last_mut() {
            if last.end > s.start {
                last.end = s.end;
                continue;
            }
        }
        out.push(s);
    }
    out
}

/// BUGGY: drops right-hand remainder when a removal splits a base interval in two.
pub fn subtract_intervals(base: &[Span], remove: &[Span]) -> Vec<Span> {
    let mut current = merge_intervals(base);
    let removals = merge_intervals(remove);
    for rem in removals {
        let mut next = Vec::new();
        for b in current {
            if rem.end <= b.start || rem.start >= b.end {
                next.push(b);
            } else if rem.start > b.start && rem.end < b.end {
                // BUG: forgets Span::new(rem.end, b.end)
                next.push(Span::new(b.start, rem.start));
            } else if rem.start <= b.start && rem.end < b.end {
                next.push(Span::new(rem.end, b.end));
            } else if rem.start > b.start && rem.end >= b.end {
                next.push(Span::new(b.start, rem.start));
            }
        }
        current = next;
    }
    current
}
""")

    _w(ws / "src" / "text.rs", """/// BUGGY: slices at raw byte indices without snapping to UTF-8 char boundaries.
pub fn excerpt_around(s: &str, byte_pos: usize, radius_bytes: usize) -> &str {
    let pos = byte_pos.min(s.len());
    let start = pos.saturating_sub(radius_bytes);
    let end = pos.saturating_add(radius_bytes).min(s.len());
    &s[start..end]
}
""")

    _w(ws / "src" / "lib.rs", """pub mod interval;
pub mod text;

pub use interval::{merge_intervals, subtract_intervals, Span};
pub use text::excerpt_around;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub span: Span,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpanError {
    InvalidBounds,
    Overlap,
}

/// BUGGY: applies edits sequentially without offset adjustment or overlap checking.
pub fn apply_replacements(input: &str, edits: &[Replacement]) -> Result<String, SpanError> {
    let mut out = input.to_string();
    for e in edits {
        if e.span.start > e.span.end || e.span.end > out.len() {
            return Err(SpanError::InvalidBounds);
        }
        out.replace_range(e.span.start..e.span.end, &e.text);
    }
    Ok(out)
}
""")

    _w(ws / "tests" / "public_test.rs", """use span_index::{apply_replacements, excerpt_around, merge_intervals, subtract_intervals, Replacement, Span};

#[test]
fn test_ascii_excerpt() {
    assert_eq!(excerpt_around("hello world", 5, 3), "llo wo");
}

#[test]
fn test_disjoint_merge() {
    let res = merge_intervals(&[Span::new(0, 3), Span::new(10, 12)]);
    assert_eq!(res, vec![Span::new(0, 3), Span::new(10, 12)]);
}

#[test]
fn test_simple_subtract_prefix() {
    let res = subtract_intervals(&[Span::new(0, 10)], &[Span::new(0, 4)]);
    assert_eq!(res, vec![Span::new(4, 10)]);
}

#[test]
fn test_single_replacement() {
    let r = apply_replacements(
        "abcdef",
        &[Replacement { span: Span::new(1, 4), text: "XYZ".into() }],
    ).unwrap();
    assert_eq!(r, "aXYZef");
}
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for swe_04_rs_utf8_interval."""
from __future__ import annotations
import argparse, json, os, subprocess, sys, tempfile
from pathlib import Path

TASK_ID = "swe_04_rs_utf8_interval"

HIDDEN_TEST_RS = r"""
use span_index::{apply_replacements, excerpt_around, merge_intervals, subtract_intervals, Replacement, Span, SpanError};

#[test]
fn f2p_utf8_multibyte_boundaries() {
    let s = "Xin chào 🚀 thế giới!";
    // 'à' starts at byte 6 (2 bytes), '🚀' is 4 bytes
    let ex1 = excerpt_around(s, 7, 2);
    assert!(ex1.contains("chào") || !ex1.is_empty());
    let rocket_idx = s.find('🚀').unwrap();
    let ex2 = excerpt_around(s, rocket_idx + 1, 1);
    assert!(ex2.contains('🚀'), "expected rocket in excerpt, got {:?}", ex2);
    let ex3 = excerpt_around(s, 9999, 8);
    assert!(ex3.ends_with("giới!"));
}

#[test]
fn f2p_merge_adjacent_and_nested() {
    let m = merge_intervals(&[
        Span::new(5, 10),
        Span::new(0, 5),
        Span::new(2, 4),
        Span::new(10, 10),
        Span::new(12, 8),
        Span::new(15, 20),
        Span::new(16, 18),
    ]);
    assert_eq!(m, vec![Span::new(0, 10), Span::new(15, 20)]);
}

#[test]
fn f2p_subtract_splits_multiple() {
    let r = subtract_intervals(
        &[Span::new(0, 20)],
        &[Span::new(3, 7), Span::new(12, 15)],
    );
    assert_eq!(r, vec![Span::new(0, 3), Span::new(7, 12), Span::new(15, 20)]);
}

#[test]
fn f2p_batch_replacements_out_of_order_and_overlap() {
    let s = "alpha beta gamma";
    let res = apply_replacements(s, &[
        Replacement { span: Span::new(11, 16), text: "GAMMA_LONG".into() },
        Replacement { span: Span::new(0, 5), text: "A".into() },
        Replacement { span: Span::new(6, 10), text: "BETA2".into() },
    ]).unwrap();
    assert_eq!(res, "A BETA2 GAMMA_LONG");

    // Adjacent edits allowed
    let adj = apply_replacements("abcdef", &[
        Replacement { span: Span::new(0, 3), text: "11".into() },
        Replacement { span: Span::new(3, 6), text: "2222".into() },
    ]).unwrap();
    assert_eq!(adj, "112222");

    // Overlapping edits rejected
    let ov = apply_replacements("abcdef", &[
        Replacement { span: Span::new(1, 4), text: "x".into() },
        Replacement { span: Span::new(3, 5), text: "y".into() },
    ]);
    assert_eq!(ov, Err(SpanError::Overlap));

    // Duplicate zero-length insertion rejected
    let dup = apply_replacements("abc", &[
        Replacement { span: Span::new(1, 1), text: "x".into() },
        Replacement { span: Span::new(1, 1), text: "y".into() },
    ]);
    assert_eq!(dup, Err(SpanError::Overlap));

    // Mid-char UTF-8 boundary rejected
    let bad = apply_replacements("chào", &[
        Replacement { span: Span::new(2, 3), text: "a".into() },
    ]);
    assert_eq!(bad, Err(SpanError::InvalidBounds));
}
"""

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []
    env = os.environ.copy()
    target_td = tempfile.mkdtemp(prefix="omnia_bench_cargo_swe04_")
    env["CARGO_TARGET_DIR"] = target_td

    try:
        # 1. Public tests (pass_to_pass)
        p1 = subprocess.run(["cargo", "test", "--test", "public_test"], cwd=str(ws), env=env, capture_output=True, text=True, timeout=60)
        checks.append({"name": "p2p_public_test", "group": "pass_to_pass", "passed": p1.returncode == 0, "detail": "ok" if p1.returncode == 0 else (p1.stdout + p1.stderr)[-600:]})

        # 2. Inject hidden test temporarily and run individual tests
        hidden_path = ws / "tests" / "_hidden_verify_test.rs"
        f2p_names = ["f2p_utf8_multibyte_boundaries", "f2p_merge_adjacent_and_nested", "f2p_subtract_splits_multiple", "f2p_batch_replacements_out_of_order_and_overlap"]
        try:
            hidden_path.write_text(HIDDEN_TEST_RS, encoding="utf-8")
            for tn in f2p_names:
                pr = subprocess.run(["cargo", "test", "--test", "_hidden_verify_test", tn, "--", "--exact"], cwd=str(ws), env=env, capture_output=True, text=True, timeout=60)
                checks.append({"name": tn, "group": "fail_to_pass", "passed": pr.returncode == 0, "detail": "ok" if pr.returncode == 0 else (pr.stdout + pr.stderr)[-400:]})
        finally:
            hidden_path.unlink(missing_ok=True)
    finally:
        import shutil as _shutil
        _shutil.rmtree(target_td, ignore_errors=True)

    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p_ok = sum(1 for c in p2p if c["passed"])
    f2p_ok = sum(1 for c in f2p if c["passed"])
    passed = (p2p_ok == len(p2p)) and (f2p_ok == len(f2p))
    score = (f2p_ok / len(f2p)) if (p2p_ok == len(p2p) and f2p) else 0.0
    out = {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(score, 4),
        "fail_to_pass": {"passed": f2p_ok, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_ok, "total": len(p2p)},
        "checks": checks,
    }
    print(json.dumps(out))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "src" / "text.rs", """pub fn excerpt_around(s: &str, byte_pos: usize, radius_bytes: usize) -> &str {
    let pos = byte_pos.min(s.len());
    let mut start = pos.saturating_sub(radius_bytes);
    while start > 0 && !s.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = pos.saturating_add(radius_bytes).min(s.len());
    while end < s.len() && !s.is_char_boundary(end) {
        end += 1;
    }
    &s[start..end]
}
""")
        _w(ws_dir / "src" / "interval.rs", """#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
}

pub fn merge_intervals(spans: &[Span]) -> Vec<Span> {
    let mut valid: Vec<Span> = spans.iter().copied().filter(|s| !s.is_empty()).collect();
    valid.sort_by_key(|s| (s.start, s.end));
    let mut out: Vec<Span> = Vec::new();
    for s in valid {
        if let Some(last) = out.last_mut() {
            if last.end >= s.start {
                if s.end > last.end {
                    last.end = s.end;
                }
                continue;
            }
        }
        out.push(s);
    }
    out
}

pub fn subtract_intervals(base: &[Span], remove: &[Span]) -> Vec<Span> {
    let mut current = merge_intervals(base);
    let removals = merge_intervals(remove);
    for rem in removals {
        let mut next = Vec::new();
        for b in current {
            if rem.end <= b.start || rem.start >= b.end {
                next.push(b);
            } else if rem.start > b.start && rem.end < b.end {
                next.push(Span::new(b.start, rem.start));
                next.push(Span::new(rem.end, b.end));
            } else if rem.start <= b.start && rem.end < b.end {
                next.push(Span::new(rem.end, b.end));
            } else if rem.start > b.start && rem.end >= b.end {
                next.push(Span::new(b.start, rem.start));
            }
        }
        current = next;
    }
    current
}
""")
        _w(ws_dir / "src" / "lib.rs", """pub mod interval;
pub mod text;

pub use interval::{merge_intervals, subtract_intervals, Span};
pub use text::excerpt_around;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub span: Span,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpanError {
    InvalidBounds,
    Overlap,
}

pub fn apply_replacements(input: &str, edits: &[Replacement]) -> Result<String, SpanError> {
    for e in edits {
        if e.span.start > e.span.end
            || e.span.end > input.len()
            || !input.is_char_boundary(e.span.start)
            || !input.is_char_boundary(e.span.end)
        {
            return Err(SpanError::InvalidBounds);
        }
    }
    let mut ordered: Vec<&Replacement> = edits.iter().collect();
    ordered.sort_by_key(|e| (e.span.start, e.span.end));
    for w in ordered.windows(2) {
        let prev = w[0];
        let cur = w[1];
        if prev.span.end > cur.span.start {
            return Err(SpanError::Overlap);
        }
        if prev.span.start == prev.span.end && cur.span.start == cur.span.end && prev.span.start == cur.span.start {
            return Err(SpanError::Overlap);
        }
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    for e in ordered {
        out.push_str(&input[cursor..e.span.start]);
        out.push_str(&e.text);
        cursor = e.span.end;
    }
    out.push_str(&input[cursor..]);
    Ok(out)
}
""")

    return {"id": "swe_04_rs_utf8_interval", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 2. refact_03_ts_large_split (Axis 6, 22-file ESM refactor + edit precision)
# ---------------------------------------------------------------------------
def build_refact_03() -> dict:
    tdir = TASKS_DIR / "refact_03_ts_large_split"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "refact_03_ts_large_split",
        "axis": 6,
        "axis_name": "Large-Scale Refactoring & Polyglot Migration",
        "title": "Split 22-file JS/ESM monolith into 4 domain modules, migrate 18 callers & preserve barrel",
        "difficulty": "hard",
        "languages": ["javascript"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "refactor",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Split Monolith into 4 Domain Modules & Migrate All 18 Service Callers

Refactor this Node.js ESM codebase (`package.json` uses `"type": "module"`):

1. Split `src/monolith.mjs` into 4 dedicated modules under `src/core/`:
   - `src/core/validation.mjs`: export `validateSku`, `validateOrder`, `normalizeCountry`
   - `src/core/pricing.mjs`: export `computeSubtotal`, `computeTax`, `computeOrderTotal`
   - `src/core/shipping.mjs`: export `estimateShippingCents`, `selectCarrier`
   - `src/core/audit.mjs`: export `formatAuditRecord`, `computeOrderChecksum`
2. **Fix a pricing bug during migration (`src/core/pricing.mjs`)**:
   In `computeTax(subtotalCents, country, isTaxExempt)`, tax-exempt orders MUST return `0` BEFORE applying the country rate, and non-exempt tax MUST use integer half-up rounding `Math.round(subtotalCents * rate)` (currently `Math.floor` undercharges fractional cents AND `isTaxExempt` is ignored!).
3. **Preserve backward compatibility in `src/monolith.mjs`**:
   Replace `src/monolith.mjs` with a slim re-export barrel (`<= 30` non-empty lines) that re-exports all 9 symbols from `./core/*.mjs` so external/legacy imports of `src/monolith.mjs` keep working identically.
4. **Migrate ALL 18 service files (`src/services/svc_01.mjs` .. `src/services/svc_18.mjs`)**:
   Every file in `src/services/` MUST import directly from `../core/<domain>.mjs` and have **ZERO** imports from `monolith.mjs`.

Run `node tests/public.test.mjs` to verify functionality.
""")

    _w(ws / "package.json", json.dumps({"name": "order-monolith", "type": "module", "version": "1.0.0"}, indent=2) + "\n")

    monolith_code = """// Legacy Order Monolith (needs splitting into src/core/{validation,pricing,shipping,audit}.mjs)
const VALID_SKU_RE = /^[A-Z]{2,4}-\\d{4,6}$/;
const TAX_RATES = { US: 0.0825, DE: 0.19, JP: 0.10, VN: 0.08, GB: 0.20 };

export function normalizeCountry(code) {
  return String(code || "US").trim().toUpperCase();
}

export function validateSku(sku) {
  return typeof sku === "string" && VALID_SKU_RE.test(sku.trim());
}

export function validateOrder(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "missing_order" };
  if (!Array.isArray(order.items) || order.items.length === 0) return { ok: false, reason: "empty_items" };
  for (const item of order.items) {
    if (!validateSku(item.sku)) return { ok: false, reason: `invalid_sku:${item.sku}` };
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, reason: "invalid_qty" };
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) return { ok: false, reason: "invalid_price" };
  }
  return { ok: true, country: normalizeCountry(order.country) };
}

export function computeSubtotal(items) {
  return items.reduce((acc, it) => acc + it.qty * it.unitCents, 0);
}

// BUG: ignores isTaxExempt and uses Math.floor instead of Math.round
export function computeTax(subtotalCents, country, isTaxExempt = false) {
  const rate = TAX_RATES[normalizeCountry(country)] ?? 0.05;
  return Math.floor(subtotalCents * rate);
}

export function computeOrderTotal(order) {
  const sub = computeSubtotal(order.items);
  const tax = computeTax(sub, order.country, Boolean(order.taxExempt));
  const ship = estimateShippingCents(order.weightGrams || 0, order.country);
  return { subtotalCents: sub, taxCents: tax, shippingCents: ship, totalCents: sub + tax + ship };
}

export function estimateShippingCents(weightGrams, country) {
  const c = normalizeCountry(country);
  const base = c === "US" ? 500 : c === "VN" ? 300 : 1200;
  const extra = Math.ceil(Math.max(0, weightGrams - 500) / 500) * 150;
  return base + extra;
}

export function selectCarrier(weightGrams, country) {
  const c = normalizeCountry(country);
  if (weightGrams > 10000) return "FREIGHT_X";
  return c === "US" ? "UPS_GROUND" : "DHL_EXPRESS";
}

export function computeOrderChecksum(orderId, totalCents) {
  let h = 2166136261 >>> 0;
  const s = `${orderId}:${totalCents}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function formatAuditRecord(orderId, order, totals) {
  return {
    orderId,
    country: normalizeCountry(order.country),
    itemCount: order.items.length,
    totalCents: totals.totalCents,
    checksum: computeOrderChecksum(orderId, totals.totalCents),
  };
}
"""
    _w(ws / "src" / "monolith.mjs", monolith_code)

    for idx in range(1, 19):
        kind = idx % 3
        if kind == 1:
            body = f"""import {{ validateOrder, computeOrderTotal, formatAuditRecord }} from "../monolith.mjs";

export function processService{idx:02d}(orderId, order) {{
  const v = validateOrder(order);
  if (!v.ok) return {{ ok: false, reason: v.reason }};
  const totals = computeOrderTotal(order);
  return {{ ok: true, audit: formatAuditRecord(orderId, order, totals), totals }};
}}
"""
        elif kind == 2:
            body = f"""import {{ validateSku, computeSubtotal, computeTax }} from "../monolith.mjs";

export function quoteService{idx:02d}(items, country, taxExempt = false) {{
  if (!items.every((x) => validateSku(x.sku))) throw new Error("bad_sku");
  const sub = computeSubtotal(items);
  const tax = computeTax(sub, country, taxExempt);
  return {{ sub, tax, grand: sub + tax }};
}}
"""
        else:
            body = f"""import {{ normalizeCountry, estimateShippingCents, selectCarrier, computeOrderChecksum }} from "../monolith.mjs";

export function shipService{idx:02d}(orderId, weightGrams, country) {{
  const c = normalizeCountry(country);
  const cost = estimateShippingCents(weightGrams, c);
  return {{ country: c, carrier: selectCarrier(weightGrams, c), cost, sig: computeOrderChecksum(orderId, cost) }};
}}
"""
        _w(ws / "src" / "services" / f"svc_{idx:02d}.mjs", body)

    _w(ws / "tests" / "public.test.mjs", """import assert from "node:assert/strict";
import { processService01 } from "../src/services/svc_01.mjs";
import { quoteService02 } from "../src/services/svc_02.mjs";
import { shipService03 } from "../src/services/svc_03.mjs";

const res1 = processService01("ORD-1", {
  country: "jp",
  weightGrams: 400,
  items: [{ sku: "AB-1234", qty: 2, unitCents: 1000 }],
});
assert.equal(res1.ok, true);
assert.equal(res1.totals.subtotalCents, 2000);
assert.equal(res1.totals.taxCents, 200);

const q2 = quoteService02([{ sku: "CD-5678", qty: 1, unitCents: 1000 }], "VN", false);
assert.equal(q2.tax, 80);

const s3 = shipService03("ORD-3", 1200, "us");
assert.equal(s3.carrier, "UPS_GROUND");
assert.equal(s3.cost, 800);
console.log("PUBLIC_OK");
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for refact_03_ts_large_split."""
from __future__ import annotations
import argparse, json, re, subprocess
from pathlib import Path

TASK_ID = "refact_03_ts_large_split"

NODE_CHECK = r"""
import assert from "node:assert/strict";
import * as val from "./src/core/validation.mjs";
import * as pr from "./src/core/pricing.mjs";
import * as sh from "./src/core/shipping.mjs";
import * as au from "./src/core/audit.mjs";
import * as mono from "./src/monolith.mjs";

for (const fn of ["validateSku", "validateOrder", "normalizeCountry"]) {
  assert.equal(typeof val[fn], "function", `missing validation.${fn}`);
  assert.equal(mono[fn], val[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["computeSubtotal", "computeTax", "computeOrderTotal"]) {
  assert.equal(typeof pr[fn], "function", `missing pricing.${fn}`);
  assert.equal(mono[fn], pr[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["estimateShippingCents", "selectCarrier"]) {
  assert.equal(typeof sh[fn], "function", `missing shipping.${fn}`);
  assert.equal(mono[fn], sh[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["formatAuditRecord", "computeOrderChecksum"]) {
  assert.equal(typeof au[fn], "function", `missing audit.${fn}`);
  assert.equal(mono[fn], au[fn], `monolith must re-export ${fn}`);
}

// Tax-exempt bug fix + half-up rounding fix
assert.equal(pr.computeTax(10000, "US", true), 0, "tax-exempt must return 0");
assert.equal(pr.computeTax(100, "US", false), 8, "8.25 -> 8");
assert.equal(pr.computeTax(105, "US", false), 9, "8.6625 -> 9 (Math.round, not floor)");
const ord = pr.computeOrderTotal({
  country: "US", taxExempt: true, weightGrams: 500,
  items: [{ sku: "XY-9999", qty: 3, unitCents: 333 }],
});
assert.equal(ord.taxCents, 0);
assert.equal(ord.totalCents, 999 + 500);

// Execute all 18 migrated services
for (let i = 1; i <= 18; i++) {
  const pad = String(i).padStart(2, "0");
  const mod = await import(`./src/services/svc_${pad}.mjs`);
  if (i % 3 === 1) {
    const r = mod[`processService${pad}`](`O-${i}`, { country: "US", taxExempt: true, weightGrams: 400, items: [{ sku: "AA-1111", qty: 1, unitCents: 105 }] });
    assert.equal(r.ok, true);
    assert.equal(r.totals.taxCents, 0);
  } else if (i % 3 === 2) {
    const r = mod[`quoteService${pad}`]([{ sku: "AA-1111", qty: 1, unitCents: 105 }], "US", false);
    assert.equal(r.tax, 9);
  } else {
    const r = mod[`shipService${pad}`](`O-${i}`, 1500, "DE");
    assert.equal(r.carrier, "DHL_EXPRESS");
  }
}
console.log("HIDDEN_NODE_OK");
"""

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    def rec(name: str, ok: bool, detail: str = "ok") -> None:
        checks.append({"name": name, "passed": ok, "detail": detail})

    # 1. Public test
    p = subprocess.run(["node", "tests/public.test.mjs"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    rec("public_test", p.returncode == 0, "ok" if p.returncode == 0 else (p.stdout + p.stderr)[-400:])

    # 2. All 4 core files exist
    core_files = ["validation.mjs", "pricing.mjs", "shipping.mjs", "audit.mjs"]
    missing = [f for f in core_files if not (ws / "src" / "core" / f).exists()]
    rec("core_modules_exist", not missing, "ok" if not missing else f"missing: {missing}")

    # 3. Monolith is slim re-export barrel <= 30 non-empty lines
    mono_path = ws / "src" / "monolith.mjs"
    mono_lines = [ln for ln in mono_path.read_text("utf-8").splitlines() if ln.strip()] if mono_path.exists() else []
    rec("monolith_slim_barrel", 1 <= len(mono_lines) <= 30, f"non_empty_lines={len(mono_lines)}")

    # 4. All 18 services have ZERO imports from monolith.mjs
    bad_svcs = []
    for i in range(1, 19):
        sp = ws / "src" / "services" / f"svc_{i:02d}.mjs"
        txt = sp.read_text("utf-8") if sp.exists() else ""
        if "monolith" in txt or "../core/" not in txt:
            bad_svcs.append(sp.name)
    rec("all_18_callers_migrated", not bad_svcs, "ok" if not bad_svcs else f"unmigrated: {bad_svcs}")

    # 5. Deep functional & re-export identity check via node
    chk = ws / "_hidden_check.mjs"
    try:
        chk.write_text(NODE_CHECK, encoding="utf-8")
        pn = subprocess.run(["node", "_hidden_check.mjs"], cwd=str(ws), capture_output=True, text=True, timeout=30)
        rec("hidden_functional_and_reexports", pn.returncode == 0 and "HIDDEN_NODE_OK" in pn.stdout, "ok" if pn.returncode == 0 else (pn.stdout + pn.stderr)[-500:])
    finally:
        chk.unlink(missing_ok=True)

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    out = {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(ok_n / len(checks), 4),
        "fail_to_pass": {"passed": ok_n, "total": len(checks)},
        "pass_to_pass": {"passed": 1 if checks[0]["passed"] else 0, "total": 1},
        "checks": checks,
    }
    print(json.dumps(out))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "src" / "core" / "validation.mjs", """const VALID_SKU_RE = /^[A-Z]{2,4}-\\d{4,6}$/;
export function normalizeCountry(code) { return String(code || "US").trim().toUpperCase(); }
export function validateSku(sku) { return typeof sku === "string" && VALID_SKU_RE.test(sku.trim()); }
export function validateOrder(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "missing_order" };
  if (!Array.isArray(order.items) || order.items.length === 0) return { ok: false, reason: "empty_items" };
  for (const item of order.items) {
    if (!validateSku(item.sku)) return { ok: false, reason: `invalid_sku:${item.sku}` };
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, reason: "invalid_qty" };
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) return { ok: false, reason: "invalid_price" };
  }
  return { ok: true, country: normalizeCountry(order.country) };
}
""")
        _w(ws_dir / "src" / "core" / "shipping.mjs", """import { normalizeCountry } from "./validation.mjs";
export function estimateShippingCents(weightGrams, country) {
  const c = normalizeCountry(country);
  const base = c === "US" ? 500 : c === "VN" ? 300 : 1200;
  const extra = Math.ceil(Math.max(0, weightGrams - 500) / 500) * 150;
  return base + extra;
}
export function selectCarrier(weightGrams, country) {
  const c = normalizeCountry(country);
  if (weightGrams > 10000) return "FREIGHT_X";
  return c === "US" ? "UPS_GROUND" : "DHL_EXPRESS";
}
""")
        _w(ws_dir / "src" / "core" / "pricing.mjs", """import { normalizeCountry } from "./validation.mjs";
import { estimateShippingCents } from "./shipping.mjs";
const TAX_RATES = { US: 0.0825, DE: 0.19, JP: 0.10, VN: 0.08, GB: 0.20 };
export function computeSubtotal(items) { return items.reduce((acc, it) => acc + it.qty * it.unitCents, 0); }
export function computeTax(subtotalCents, country, isTaxExempt = false) {
  if (isTaxExempt) return 0;
  const rate = TAX_RATES[normalizeCountry(country)] ?? 0.05;
  return Math.round(subtotalCents * rate);
}
export function computeOrderTotal(order) {
  const sub = computeSubtotal(order.items);
  const tax = computeTax(sub, order.country, Boolean(order.taxExempt));
  const ship = estimateShippingCents(order.weightGrams || 0, order.country);
  return { subtotalCents: sub, taxCents: tax, shippingCents: ship, totalCents: sub + tax + ship };
}
""")
        _w(ws_dir / "src" / "core" / "audit.mjs", """import { normalizeCountry } from "./validation.mjs";
export function computeOrderChecksum(orderId, totalCents) {
  let h = 2166136261 >>> 0;
  const s = `${orderId}:${totalCents}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
export function formatAuditRecord(orderId, order, totals) {
  return {
    orderId,
    country: normalizeCountry(order.country),
    itemCount: order.items.length,
    totalCents: totals.totalCents,
    checksum: computeOrderChecksum(orderId, totals.totalCents),
  };
}
""")
        _w(ws_dir / "src" / "monolith.mjs", """export { validateSku, validateOrder, normalizeCountry } from "./core/validation.mjs";
export { computeSubtotal, computeTax, computeOrderTotal } from "./core/pricing.mjs";
export { estimateShippingCents, selectCarrier } from "./core/shipping.mjs";
export { formatAuditRecord, computeOrderChecksum } from "./core/audit.mjs";
""")
        for idx in range(1, 19):
            kind = idx % 3
            if kind == 1:
                body = f"""import {{ validateOrder }} from "../core/validation.mjs";
import {{ computeOrderTotal }} from "../core/pricing.mjs";
import {{ formatAuditRecord }} from "../core/audit.mjs";
export function processService{idx:02d}(orderId, order) {{
  const v = validateOrder(order);
  if (!v.ok) return {{ ok: false, reason: v.reason }};
  const totals = computeOrderTotal(order);
  return {{ ok: true, audit: formatAuditRecord(orderId, order, totals), totals }};
}}
"""
            elif kind == 2:
                body = f"""import {{ validateSku }} from "../core/validation.mjs";
import {{ computeSubtotal, computeTax }} from "../core/pricing.mjs";
export function quoteService{idx:02d}(items, country, taxExempt = false) {{
  if (!items.every((x) => validateSku(x.sku))) throw new Error("bad_sku");
  const sub = computeSubtotal(items);
  const tax = computeTax(sub, country, taxExempt);
  return {{ sub, tax, grand: sub + tax }};
}}
"""
            else:
                body = f"""import {{ normalizeCountry }} from "../core/validation.mjs";
import {{ estimateShippingCents, selectCarrier }} from "../core/shipping.mjs";
import {{ computeOrderChecksum }} from "../core/audit.mjs";
export function shipService{idx:02d}(orderId, weightGrams, country) {{
  const c = normalizeCountry(country);
  const cost = estimateShippingCents(weightGrams, c);
  return {{ country: c, carrier: selectCarrier(weightGrams, c), cost, sig: computeOrderChecksum(orderId, cost) }};
}}
"""
            _w(ws_dir / "src" / "services" / f"svc_{idx:02d}.mjs", body)

    return {"id": "refact_03_ts_large_split", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 3. atlas_03_long_repo_needle (Axis 4, 110-file repo + 12 decoys -> JSON audit)
# ---------------------------------------------------------------------------
def build_atlas_03() -> dict:
    tdir = TASKS_DIR / "atlas_03_long_repo_needle"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "atlas_03_long_repo_needle",
        "axis": 4,
        "axis_name": "SWE-Atlas Deep Codebase Navigation",
        "title": "110-file polyglot monorepo production defect localization with 12 deprecated decoys",
        "difficulty": "hard",
        "languages": ["python", "javascript"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "json_citation",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Deep Monorepo Production Defect Audit (110+ Files)

This workspace contains a large polyglot monorepo (`services/` plus `legacy_deprecated/`).
`config/production_wiring.json` lists the **active production entrypoints**. Files under `legacy_deprecated/` and `test_fixtures/` are **NOT** deployed in production (ignore decoys there!).

Find the **3 active production defects** across the active services:
1. `auth_ttl_override`: Active auth module where a tenant TTL override accidentally uses `max()` instead of `min()` (allowing a tenant to exceed the global hard cap `MAX_SESSION_TTL_S`).
2. `billing_retry_storm`: Active billing module where retry multiplier amplifies exponentially without respecting `MAX_RETRY_DELAY_MS` cap.
3. `events_silent_dlq_drop`: Active events module where failed dead-letter events are silently dropped (`return None`) when `dlq_queue` is full instead of raising `DeadLetterOverflowError`.

Do NOT modify any source files. Write your findings to `audit_report.json` at the workspace root with this exact JSON schema:
```json
{
  "defects": {
    "auth_ttl_override": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    },
    "billing_retry_storm": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    },
    "events_silent_dlq_drop": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    }
  }
}
```
`line` must be the exact 1-based line number of the buggy statement (tolerance ±2 lines).
""")

    _w(ws / "config" / "production_wiring.json", json.dumps({
        "active_services": {
            "auth": "services/auth/pkg_07/expiry.py",
            "billing": "services/billing/pkg_14/retry.mjs",
            "events": "services/events/pkg_21/dlq.py",
        },
        "deprecated_roots": ["legacy_deprecated", "test_fixtures"],
    }, indent=2) + "\n")

    # Generate 90 benign service modules across auth, billing, events
    for i in range(1, 31):
        if i != 7:
            _w(ws / "services" / "auth" / f"pkg_{i:02d}" / "expiry.py", f"""MAX_SESSION_TTL_S = 3600
def resolve_ttl_{i:02d}(requested_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    return min(max(60, requested_s), cap_s)
""")
        if i != 14:
            _w(ws / "services" / "billing" / f"pkg_{i:02d}" / "retry.mjs", f"""export const MAX_RETRY_DELAY_MS = 30000;
export function computeRetryDelay{i:02d}(attempt) {{
  return Math.min(500 * (2 ** attempt), MAX_RETRY_DELAY_MS);
}}
""")
        if i != 21:
            _w(ws / "services" / "events" / f"pkg_{i:02d}" / "dlq.py", f"""class DeadLetterOverflowError(RuntimeError):
    pass
def enqueue_dlq_{i:02d}(queue: list, item: dict, limit: int = 100) -> bool:
    if len(queue) >= limit:
        raise DeadLetterOverflowError("queue full")
    queue.append(item)
    return True
""")

    # 3 real active defects
    _w(ws / "services" / "auth" / "pkg_07" / "expiry.py", """\"\"\"Active Production Auth TTL Resolver (wired by config/production_wiring.json).\"\"\"
MAX_SESSION_TTL_S = 3600

def compute_effective_ttl(tenant_ttl_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    if tenant_ttl_s <= 0:
        return 60
    # DEFECT: uses max() instead of min(), letting tenant bypass global cap!
    effective = max(tenant_ttl_s, cap_s)
    return effective
""")  # bug on line 8

    _w(ws / "services" / "billing" / "pkg_14" / "retry.mjs", """// Active Production Billing Retry Planner (wired by config/production_wiring.json)
export const MAX_RETRY_DELAY_MS = 30000;

export function planBillingBackoffMs(attempt, baseMs = 500) {
  const safeAttempt = Math.max(0, attempt);
  // DEFECT: omits Math.min(..., MAX_RETRY_DELAY_MS) cap!
  const delay = baseMs * (2 ** safeAttempt);
  return delay;
}
""")  # bug on line 7

    _w(ws / "services" / "events" / "pkg_21" / "dlq.py", """\"\"\"Active Production Events DLQ Writer (wired by config/production_wiring.json).\"\"\"
class DeadLetterOverflowError(RuntimeError):
    pass

def push_dead_letter(dlq_queue: list, event: dict, max_size: int = 100):
    if len(dlq_queue) >= max_size:
        # DEFECT: silently drops event instead of raising DeadLetterOverflowError
        return None
    dlq_queue.append(event)
    return len(dlq_queue)
""")  # bug on line 8

    # 12 deprecated decoys (must be ignored!)
    for d in range(1, 5):
        _w(ws / "legacy_deprecated" / f"auth_old_{d}" / "expiry.py", f"""MAX_SESSION_TTL_S = 3600
def old_compute_ttl_{d}(tenant_ttl_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    return max(tenant_ttl_s, cap_s)
""")
        _w(ws / "legacy_deprecated" / f"billing_old_{d}" / "retry.mjs", f"""export const MAX_RETRY_DELAY_MS = 30000;
export function oldBackoff{d}(attempt) {{ return 500 * (2 ** attempt); }}
""")
        _w(ws / "test_fixtures" / f"events_mock_{d}" / "dlq.py", f"""def mock_push_dlq_{d}(dlq_queue: list, event: dict, max_size: int = 10):
    if len(dlq_queue) >= max_size:
        return None
    dlq_queue.append(event)
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for atlas_03_long_repo_needle."""
from __future__ import annotations
import argparse, json
from pathlib import Path

TASK_ID = "atlas_03_long_repo_needle"

EXPECTED = {
    "auth_ttl_override": ("services/auth/pkg_07/expiry.py", "compute_effective_ttl", 8),
    "billing_retry_storm": ("services/billing/pkg_14/retry.mjs", "planBillingBackoffMs", 7),
    "events_silent_dlq_drop": ("services/events/pkg_21/dlq.py", "push_dead_letter", 8),
}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    rep = ws / "audit_report.json"
    checks = []
    if not rep.exists():
        print(json.dumps({"task_id": TASK_ID, "passed": False, "score": 0.0, "fail_to_pass": {"passed": 0, "total": 3}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": [{"name": "report_exists", "passed": False, "detail": "audit_report.json missing"}]}))
        return 1
    try:
        data = json.loads(rep.read_text("utf-8"))
    except Exception as exc:
        print(json.dumps({"task_id": TASK_ID, "passed": False, "score": 0.0, "fail_to_pass": {"passed": 0, "total": 3}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": [{"name": "valid_json", "passed": False, "detail": str(exc)}]}))
        return 1

    defects = data.get("defects") if isinstance(data, dict) else {}
    if not isinstance(defects, dict):
        defects = {}
    for key, (exp_file, exp_sym, exp_line) in EXPECTED.items():
        got = defects.get(key) or {}
        gf = str(got.get("file", "")).replace("\\", "/").lstrip("./")
        gs = str(got.get("symbol", ""))
        gl = got.get("line")
        line_ok = isinstance(gl, int) and abs(gl - exp_line) <= 2
        ok = (gf == exp_file) and (gs == exp_sym) and line_ok
        checks.append({"name": key, "passed": ok, "detail": f"got=({gf},{gs},{gl}) exp=({exp_file},{exp_sym},{exp_line})"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(ok_n / len(checks), 4),
        "fail_to_pass": {"passed": ok_n, "total": len(checks)},
        "pass_to_pass": {"passed": 0, "total": 0},
        "checks": checks,
    }))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "audit_report.json", json.dumps({
            "defects": {
                "auth_ttl_override": {"file": "services/auth/pkg_07/expiry.py", "symbol": "compute_effective_ttl", "line": 8},
                "billing_retry_storm": {"file": "services/billing/pkg_14/retry.mjs", "symbol": "planBillingBackoffMs", "line": 7},
                "events_silent_dlq_drop": {"file": "services/events/pkg_21/dlq.py", "symbol": "push_dead_letter", "line": 8},
            }
        }, indent=2) + "\n")

    return {"id": "atlas_03_long_repo_needle", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 4. heal_03_win_crlf_lock (Axis 7, 5-fault Windows BOM/CRLF/SQLite-lock)
# ---------------------------------------------------------------------------
def build_heal_03() -> dict:
    tdir = TASKS_DIR / "heal_03_win_crlf_lock"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "heal_03_win_crlf_lock",
        "axis": 7,
        "axis_name": "Error Recovery & Self-Healing",
        "title": "5-fault Windows UTF-8 BOM, CRLF key leak, SQLite lock race & atomic export recovery",
        "difficulty": "hard",
        "languages": ["python"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "self_heal",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Recover Broken Windows Data Ingestion & SQLite Store Service

Run `python -m unittest discover -s tests -v`. This Python package (`winstore`) has **5 cascading Windows-native defects**:
1. `config/rules.json` starts with a UTF-8 BOM (`\\ufeff`), crashing `load_rules()` in `winstore/config.py`. Handle UTF-8 BOM cleanly in `load_rules()` (`utf-8-sig`) so BOM-encoded configs always parse.
2. `winstore/ingest.py` reads CSV rows manually with `split("\\n")` without stripping `\\r`, corrupting the last column values with trailing `\\r` on Windows CRLF files, and fails to normalize backslash paths (`data\\batch_01.csv`) cleanly across OSes.
3. `winstore/db.py` (`EventStore`) opens SQLite connections without WAL mode / `busy_timeout` and leaks an uncommitted transaction on `record_batch`, causing `sqlite3.OperationalError: database is locked` under concurrent writer connections.
4. `winstore/aggregator.py` (`ConcurrentCounter`) increments shared dict totals from multiple threads without locking, losing increments under contention.
5. `winstore/export.py` writes summary JSON without explicit `encoding="utf-8"`, `newline="\\n"`, or atomic temp-file + `os.replace()`. Ensure exported JSON is valid UTF-8 with LF line endings and non-ASCII characters preserved (`ensure_ascii=False`).

Fix all 5 issues so `python -m unittest discover -s tests -v` and hidden concurrency/Unicode/lock checks pass 100%.
""")

    _w(ws / "config" / "rules.json", "", binary=b'\xef\xbb\xbf{"currency": "VND", "min_amount": 10, "region": "H\xc3\xa0 N\xe1\xbb\x99i"}\n')
    _w(ws / "data" / "batch_01.csv", "", binary=b"id,user,amount,city\r\n1,an,100,H\xc3\xa0 N\xe1\xbb\x99i\r\n2,binh,250,\xc4\x90\xc3\xa0 N\xe1\xba\xb5ng\r\n")
    _w(ws / "winstore" / "__init__.py", "")
    _w(ws / "winstore" / "config.py", """import json
from pathlib import Path

def load_rules(path: Path) -> dict:
    # BUG 1: fails on UTF-8 BOM
    return json.loads(Path(path).read_text(encoding="utf-8"))
""")
    _w(ws / "winstore" / "ingest.py", """from pathlib import Path

def read_csv_rows(path: str | Path) -> list[dict]:
    p = Path(path)
    # BUG 2: manual split("\\n") leaks \\r from CRLF files
    raw = p.read_bytes().decode("utf-8")
    lines = [ln for ln in raw.split("\\n") if ln]
    header = lines[0].split(",")
    rows = []
    for ln in lines[1:]:
        vals = ln.split(",")
        rows.append(dict(zip(header, vals)))
    return rows
""")
    _w(ws / "winstore" / "db.py", """import sqlite3
from pathlib import Path

class EventStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        # BUG 3: zero timeout, no WAL
        return sqlite3.connect(str(self.db_path), timeout=0.01)

    def _init_schema(self) -> None:
        conn = self._connect()
        conn.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, amount INTEGER, city TEXT)")
        conn.commit()
        conn.close()

    def record_batch(self, rows: list[dict]) -> int:
        conn = self._connect()
        for r in rows:
            conn.execute("INSERT OR REPLACE INTO events(id, amount, city) VALUES (?, ?, ?)", (str(r["id"]), int(r["amount"]), str(r["city"])))
        # BUG 3b: forgets commit() and leaves connection open holding write lock!
        return len(rows)

    def count(self) -> int:
        conn = self._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        finally:
            conn.close()
""")
    _w(ws / "winstore" / "aggregator.py", """import time

class ConcurrentCounter:
    def __init__(self) -> None:
        self.totals: dict[str, int] = {}

    def add(self, key: str, delta: int) -> None:
        # BUG 4: unsynchronized read-modify-write race
        cur = self.totals.get(key, 0)
        time.sleep(0.0001)
        self.totals[key] = cur + delta
""")
    _w(ws / "winstore" / "export.py", """import json
from pathlib import Path

def write_summary(path: Path, data: dict) -> None:
    # BUG 5: ascii encoding, default CRLF on Windows, non-atomic write
    with open(path, "w") as f:
        f.write(json.dumps(data, ensure_ascii=True))
""")
    _w(ws / "tests" / "test_winstore.py", """import tempfile, unittest
from pathlib import Path
from winstore.config import load_rules
from winstore.ingest import read_csv_rows
from winstore.db import EventStore

class TestWinStore(unittest.TestCase):
    def test_rules_and_csv(self):
        rules = load_rules(Path("config/rules.json"))
        self.assertEqual(rules["currency"], "VND")
        rows = read_csv_rows("data/batch_01.csv")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["city"], "Hà Nội")

    def test_db_two_batches(self):
        with tempfile.TemporaryDirectory() as td:
            st = EventStore(Path(td) / "ev.db")
            st.record_batch([{"id": "1", "amount": 10, "city": "HN"}])
            st.record_batch([{"id": "2", "amount": 20, "city": "DN"}])
            self.assertEqual(st.count(), 2)
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for heal_03_win_crlf_lock."""
from __future__ import annotations
import argparse, importlib, json, subprocess, sys, tempfile, threading
from pathlib import Path

TASK_ID = "heal_03_win_crlf_lock"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    def rec(name: str, fn) -> None:
        try:
            fn()
            checks.append({"name": name, "passed": True, "detail": "ok"})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_unittest", "passed": p.returncode == 0, "detail": "ok" if p.returncode == 0 else (p.stdout + p.stderr)[-500:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "winstore" or m.startswith("winstore."):
            del sys.modules[m]

    def chk_bom_and_crlf():
        cfg = importlib.import_module("winstore.config")
        ing = importlib.import_module("winstore.ingest")
        r = cfg.load_rules(ws / "config" / "rules.json")
        assert r["region"] == "Hà Nội"
        rows = ing.read_csv_rows(ws / "data" / "batch_01.csv")
        assert rows[0]["city"] == "Hà Nội" and "\r" not in rows[0]["city"]
        assert rows[1]["city"] == "Đà Nẵng" and "\r" not in rows[1]["city"]

    def chk_sqlite_concurrent():
        dbmod = importlib.import_module("winstore.db")
        with tempfile.TemporaryDirectory() as td:
            st = dbmod.EventStore(Path(td) / "c.db")
            errs = []
            def worker(wid):
                try:
                    for j in range(15):
                        st.record_batch([{"id": f"{wid}-{j}", "amount": j, "city": "Hà Nội"}])
                except Exception as e:
                    errs.append(e)
            ts = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
            for t in ts: t.start()
            for t in ts: t.join()
            assert not errs, f"sqlite errors: {errs[:3]}"
            assert st.count() == 90, f"expected 90, got {st.count()}"

    def chk_counter_race():
        agg = importlib.import_module("winstore.aggregator")
        c = agg.ConcurrentCounter()
        def worker():
            for _ in range(40):
                c.add("total", 1)
        ts = [threading.Thread(target=worker) for _ in range(8)]
        for t in ts: t.start()
        for t in ts: t.join()
        assert c.totals.get("total") == 320, f"race lost updates: got {c.totals.get('total')}"

    def chk_export_utf8_lf():
        exp = importlib.import_module("winstore.export")
        with tempfile.TemporaryDirectory() as td:
            outp = Path(td) / "summary.json"
            exp.write_summary(outp, {"city": "Hà Nội", "lines": ["a", "b"]})
            raw = outp.read_bytes()
            assert b"\r\n" not in raw, "CRLF found in exported JSON"
            txt = raw.decode("utf-8")
            assert "Hà Nội" in txt, "non-ASCII escaped instead of UTF-8"
            assert json.loads(txt)["city"] == "Hà Nội"

    rec("bom_and_crlf", chk_bom_and_crlf)
    rec("sqlite_concurrent_wal", chk_sqlite_concurrent)
    rec("concurrent_counter_lock", chk_counter_race)
    rec("export_utf8_lf_atomic", chk_export_utf8_lf)

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(ok_n / len(checks), 4),
        "fail_to_pass": {"passed": ok_n, "total": len(checks)},
        "pass_to_pass": {"passed": 0, "total": 0},
        "checks": checks,
    }))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "winstore" / "config.py", """import json
from pathlib import Path
def load_rules(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))
""")
        _w(ws_dir / "winstore" / "ingest.py", """import csv
from pathlib import Path
def read_csv_rows(path: str | Path) -> list[dict]:
    p = Path(str(path).replace("\\\\", "/"))
    with open(p, "r", encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]
""")
        _w(ws_dir / "winstore" / "db.py", """import sqlite3, threading
from pathlib import Path
class EventStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self._lock = threading.Lock()
        self._init_schema()
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn
    def _init_schema(self) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, amount INTEGER, city TEXT)")
                conn.commit()
            conn.close()
    def record_batch(self, rows: list[dict]) -> int:
        with self._lock:
            conn = self._connect()
            try:
                with conn:
                    for r in rows:
                        conn.execute("INSERT OR REPLACE INTO events(id, amount, city) VALUES (?, ?, ?)", (str(r["id"]), int(r["amount"]), str(r["city"])))
                return len(rows)
            finally:
                conn.close()
    def count(self) -> int:
        conn = self._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        finally:
            conn.close()
""")
        _w(ws_dir / "winstore" / "aggregator.py", """import threading, time
class ConcurrentCounter:
    def __init__(self) -> None:
        self.totals: dict[str, int] = {}
        self._lock = threading.Lock()
    def add(self, key: str, delta: int) -> None:
        with self._lock:
            cur = self.totals.get(key, 0)
            time.sleep(0.0001)
            self.totals[key] = cur + delta
""")
        _w(ws_dir / "winstore" / "export.py", """import json, os, tempfile
from pathlib import Path
def write_summary(path: Path, data: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\\n"
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".tmp_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\\n") as f:
            f.write(text)
        os.replace(tmp, p)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
""")

    return {"id": "heal_03_win_crlf_lock", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 5. resil_01_429_502_retry (Axis 11, fault_mode="429_502")
# ---------------------------------------------------------------------------
def build_resil_01() -> dict:
    tdir = TASKS_DIR / "resil_01_429_502_retry"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "resil_01_429_502_retry",
        "axis": 11,
        "axis_name": "Adversarial Harness Resilience & Fault Injection",
        "title": "Token-bucket rate limiter fix under deterministic HTTP 429 & 502 fault injection",
        "difficulty": "medium",
        "languages": ["python"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "resilience",
        "fault_mode": "429_502",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Fix Token-Bucket Rate Limiter (Burst Cap, Fractional Refill & Retry-After)

Fix all bugs in `ratelimit/bucket.py` so `python -m unittest discover -s tests -v` and hidden edge-case tests pass:
1. `allow(key, cost=1.0)` must refill tokens at `rate_per_sec * elapsed`, capped at `capacity` (`burst`), and must NOT consume tokens if `cost > available`.
2. If `cost > capacity`, `allow()` must return `(False, float('inf'))` immediately (impossible request).
3. When rejected (`available < cost <= capacity`), return `(False, retry_after_s)` where `retry_after_s = (cost - available) / rate_per_sec` (exact remaining wait seconds, not `cost / rate_per_sec`!).
4. Backward clock jumps (`now < last_ts`) must not subtract tokens (clamp `elapsed = max(0.0, now - last_ts)`).
""")

    _w(ws / "ratelimit" / "__init__.py", "from .bucket import TokenBucketLimiter\n")
    _w(ws / "ratelimit" / "bucket.py", """from typing import Callable, Tuple

class TokenBucketLimiter:
    def __init__(self, rate_per_sec: float, capacity: float, clock: Callable[[], float]) -> None:
        self.rate = float(rate_per_sec)
        self.capacity = float(capacity)
        self.clock = clock
        self._state: dict[str, Tuple[float, float]] = {}

    def allow(self, key: str, cost: float = 1.0) -> Tuple[bool, float]:
        now = self.clock()
        tokens, last_ts = self._state.get(key, (self.capacity, now))
        # BUGS: no negative elapsed clamp, no burst cap, consumes on reject, wrong retry_after
        tokens = tokens + (now - last_ts) * self.rate
        if tokens >= cost:
            self._state[key] = (tokens - cost, now)
            return True, 0.0
        self._state[key] = (tokens, now)
        return False, cost / self.rate
""")
    _w(ws / "tests" / "test_bucket.py", """import unittest
from ratelimit import TokenBucketLimiter

class TestBucket(unittest.TestCase):
    def test_burst_and_retry(self):
        t = [0.0]
        lim = TokenBucketLimiter(rate_per_sec=2.0, capacity=4.0, clock=lambda: t[0])
        self.assertEqual(lim.allow("k", 3.0), (True, 0.0))
        ok, wait = lim.allow("k", 2.0)
        self.assertFalse(ok)
        self.assertAlmostEqual(wait, 0.5, places=6)
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for resil_01_429_502_retry."""
from __future__ import annotations
import argparse, importlib, json, math, sys
from pathlib import Path

TASK_ID = "resil_01_429_502_retry"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "ratelimit" or m.startswith("ratelimit."):
            del sys.modules[m]
    checks = []
    def rec(name, fn):
        try:
            fn()
            checks.append({"name": name, "passed": True, "detail": "ok"})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    def chk_all():
        mod = importlib.import_module("ratelimit")
        t = [10.0]
        lim = mod.TokenBucketLimiter(2.0, 4.0, clock=lambda: t[0])
        # Initial cap
        t[0] = 100.0
        ok, w = lim.allow("a", 4.0)
        assert ok and w == 0.0
        # Reject exact wait
        ok, w = lim.allow("a", 1.0)
        assert not ok and abs(w - 0.5) < 1e-6, f"got {(ok, w)}"
        # Refill capped at 4.0
        t[0] = 200.0
        ok, w = lim.allow("a", 4.0)
        assert ok and w == 0.0
        ok, w = lim.allow("a", 0.5)
        assert not ok and abs(w - 0.25) < 1e-6
        # Impossible cost > capacity
        ok, w = lim.allow("a", 5.0)
        assert not ok and math.isinf(w)
        # Backward clock jump does not subtract
        t[0] = 201.0  # refills 2.0
        assert lim.allow("a", 1.0) == (True, 0.0)  # 1.0 left
        t[0] = 190.0  # jump backward
        assert lim.allow("a", 1.0) == (True, 0.0)

    rec("token_bucket_full_contract", chk_all)
    passed = all(c["passed"] for c in checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": 1.0 if passed else 0.0, "fail_to_pass": {"passed": int(passed), "total": 1}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "ratelimit" / "bucket.py", """from typing import Callable, Tuple

class TokenBucketLimiter:
    def __init__(self, rate_per_sec: float, capacity: float, clock: Callable[[], float]) -> None:
        self.rate = float(rate_per_sec)
        self.capacity = float(capacity)
        self.clock = clock
        self._state: dict[str, Tuple[float, float]] = {}

    def allow(self, key: str, cost: float = 1.0) -> Tuple[bool, float]:
        if cost > self.capacity:
            return False, float("inf")
        now = self.clock()
        tokens, last_ts = self._state.get(key, (self.capacity, now))
        elapsed = max(0.0, now - last_ts)
        tokens = min(self.capacity, tokens + elapsed * self.rate)
        if tokens >= cost:
            self._state[key] = (tokens - cost, now)
            return True, 0.0
        self._state[key] = (tokens, now)
        return False, (cost - tokens) / self.rate
""")

    return {"id": "resil_01_429_502_retry", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 6. resil_02_sse_midstream_eof (Axis 11, fault_mode="sse_eof")
# ---------------------------------------------------------------------------
def build_resil_02() -> dict:
    tdir = TASKS_DIR / "resil_02_sse_midstream_eof"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "resil_02_sse_midstream_eof",
        "axis": 11,
        "axis_name": "Adversarial Harness Resilience & Fault Injection",
        "title": "Crash-safe WAL log compactor fix under deterministic mid-stream SSE EOF truncation",
        "difficulty": "medium",
        "languages": ["python"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "resilience",
        "fault_mode": "sse_eof",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Fix Crash-Safe Append-Only WAL Reader & Compactor

Fix `wal/store.py` so `python -m unittest discover -s tests -v` and hidden crash-recovery tests pass:
1. Each WAL line is `<crc32_hex>|<op>|<key>|<value_json>` where `crc32_hex` is `f"{zlib.crc32(payload.encode('utf-8')) & 0xffffffff:08x}"` over `f"{op}|{key}|{value_json}"`.
2. `replay(path)` MUST verify every line's CRC32 checksum. If the **final** line is truncated or corrupt (partial crash write), stop cleanly and return state up to the last valid record. If a **non-final** line is corrupted, raise `WalCorruptionError`.
3. Support `SET` and `DEL` operations; `compact(path)` must atomically rewrite the WAL keeping only live keys (sorted by key) as `SET` records with valid CRC32 checksums, removing deleted/overwritten history.
""")

    _w(ws / "wal" / "__init__.py", "from .store import WalCorruptionError, append_op, replay, compact\n")
    _w(ws / "wal" / "store.py", """import json, zlib
from pathlib import Path

class WalCorruptionError(RuntimeError):
    pass

def _crc(payload: str) -> str:
    return f"{zlib.crc32(payload.encode('utf-8')) & 0xffffffff:08x}"

def append_op(path: Path, op: str, key: str, value=None) -> None:
    payload = f"{op}|{key}|{json.dumps(value, separators=(',', ':'))}"
    with open(path, "a", encoding="utf-8", newline="\\n") as f:
        f.write(f"{_crc(payload)}|{payload}\\n")

def replay(path: Path) -> dict:
    # BUG: skips CRC verification and crashes on truncated tail line
    state = {}
    if not Path(path).exists():
        return state
    for line in Path(path).read_text("utf-8").splitlines():
        if not line:
            continue
        _, op, key, val_raw = line.split("|", 3)
        if op == "SET":
            state[key] = json.loads(val_raw)
        elif op == "DEL":
            state.pop(key, None)
    return state

def compact(path: Path) -> int:
    # BUG: not implemented
    return 0
""")
    _w(ws / "tests" / "test_wal.py", """import tempfile, unittest
from pathlib import Path
from wal import WalCorruptionError, append_op, replay, compact

class TestWal(unittest.TestCase):
    def test_tail_truncation_and_compact(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.wal"
            append_op(p, "SET", "a", 1)
            append_op(p, "SET", "b", 2)
            append_op(p, "DEL", "a")
            with open(p, "a", encoding="utf-8") as f:
                f.write("deadbeef|SET|corrupt_tail")
            st = replay(p)
            self.assertEqual(st, {"b": 2})
            n = compact(p)
            self.assertEqual(n, 1)
            self.assertEqual(replay(p), {"b": 2})
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for resil_02_sse_midstream_eof."""
from __future__ import annotations
import argparse, importlib, json, sys, tempfile
from pathlib import Path

TASK_ID = "resil_02_sse_midstream_eof"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "wal" or m.startswith("wal."):
            del sys.modules[m]
    checks = []
    def rec(name, fn):
        try:
            fn()
            checks.append({"name": name, "passed": True, "detail": "ok"})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    def chk_wal():
        mod = importlib.import_module("wal")
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "a.wal"
            mod.append_op(p, "SET", "z", {"v": 1})
            mod.append_op(p, "SET", "a", "hello|pipe")
            mod.append_op(p, "SET", "z", {"v": 2})
            mod.append_op(p, "DEL", "gone")
            # Tail partial write tolerated
            with open(p, "a", encoding="utf-8") as f:
                f.write("00000000|SET|x|{broken")
            assert mod.replay(p) == {"a": "hello|pipe", "z": {"v": 2}}
            # Compact rewrites cleanly sorted
            n = mod.compact(p)
            assert n == 2
            lines = p.read_text("utf-8").splitlines()
            assert len(lines) == 2
            assert mod.replay(p) == {"a": "hello|pipe", "z": {"v": 2}}
            # Mid-file corruption MUST raise WalCorruptionError
            badp = Path(td) / "bad.wal"
            mod.append_op(badp, "SET", "k1", 1)
            with open(badp, "a", encoding="utf-8") as f:
                f.write("00000000|SET|k2|999\n")
            mod.append_op(badp, "SET", "k3", 3)
            raised = False
            try:
                mod.replay(badp)
            except mod.WalCorruptionError:
                raised = True
            assert raised, "expected WalCorruptionError on non-final corrupted record"

    rec("wal_crc_truncation_and_compact", chk_wal)
    passed = all(c["passed"] for c in checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": 1.0 if passed else 0.0, "fail_to_pass": {"passed": int(passed), "total": 1}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "wal" / "store.py", """import json, os, tempfile, zlib
from pathlib import Path

class WalCorruptionError(RuntimeError):
    pass

def _crc(payload: str) -> str:
    return f"{zlib.crc32(payload.encode('utf-8')) & 0xffffffff:08x}"

def append_op(path: Path, op: str, key: str, value=None) -> None:
    payload = f"{op}|{key}|{json.dumps(value, separators=(',', ':'))}"
    with open(path, "a", encoding="utf-8", newline="\\n") as f:
        f.write(f"{_crc(payload)}|{payload}\\n")

def replay(path: Path) -> dict:
    state = {}
    p = Path(path)
    if not p.exists():
        return state
    lines = [ln for ln in p.read_text("utf-8").splitlines() if ln != ""]
    for idx, line in enumerate(lines):
        is_last = idx == len(lines) - 1
        try:
            crc_hex, payload = line.split("|", 1)
            if crc_hex != _crc(payload):
                raise WalCorruptionError(f"CRC mismatch at line {idx+1}")
            op, key, val_raw = payload.split("|", 2)
            val = json.loads(val_raw)
        except Exception as exc:
            if is_last:
                break
            raise WalCorruptionError(f"Corrupt non-final record at line {idx+1}: {exc}") from exc
        if op == "SET":
            state[key] = val
        elif op == "DEL":
            state.pop(key, None)
    return state

def compact(path: Path) -> int:
    p = Path(path)
    state = replay(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".wal_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\\n") as f:
            for k in sorted(state):
                payload = f"SET|{k}|{json.dumps(state[k], separators=(',', ':'))}"
                f.write(f"{_crc(payload)}|{payload}\\n")
        os.replace(tmp, p)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return len(state)
""")

    return {"id": "resil_02_sse_midstream_eof", "apply_ref": apply_ref}


# ---------------------------------------------------------------------------
# 7. resil_03_150kb_noisy_stdout (Axis 11, 150 KB noisy test output debugging)
# ---------------------------------------------------------------------------
def build_resil_03() -> dict:
    tdir = TASKS_DIR / "resil_03_150kb_noisy_stdout"
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", json.dumps({
        "id": "resil_03_150kb_noisy_stdout",
        "axis": 11,
        "axis_name": "Adversarial Harness Resilience & Fault Injection",
        "title": "Buried failure debugging inside 150 KB noisy test-runner diagnostic stdout",
        "difficulty": "medium",
        "languages": ["python"],
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "resilience",
        "fault_mode": None,
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": None,
        "verify_script": "verify.py",
    }, indent=2) + "\n")

    _w(tdir / "prompt.md", """# Task: Debug Buried Failure in High-Volume Diagnostic Test Suite

Run `python run_noisy_tests.py` to execute the packet-window test runner.
It produces ~150 KB of verbose packet trace output with the real failing check buried near the bottom.
Locate the exact bug in `telemetry/window.py` and fix it so `python run_noisy_tests.py` exits `0` (and all hidden boundary checks pass) without editing `run_noisy_tests.py`.
""")

    _w(ws / "telemetry" / "__init__.py", "from .window import RollingWindowStats\n")
    _w(ws / "telemetry" / "window.py", """from collections import deque

class RollingWindowStats:
    def __init__(self, window_ms: int) -> None:
        self.window_ms = int(window_ms)
        self._buf: deque[tuple[int, int]] = deque()
        self._sum = 0

    def push(self, ts_ms: int, value: int) -> None:
        self._buf.append((ts_ms, value))
        self._sum += value
        cutoff = ts_ms - self.window_ms
        # BUG: uses <= instead of < (evicts exact boundary ts == ts_ms - window_ms)
        # AND uses pop() instead of popleft() when > 100 items trigger burst trim!
        while self._buf and self._buf[0][0] <= cutoff:
            _, v = self._buf.popleft()
            self._sum -= v

    def total(self) -> int:
        return self._sum

    def count(self) -> int:
        return len(self._buf)
""")
    _w(ws / "run_noisy_tests.py", """import sys
from telemetry import RollingWindowStats

def main() -> int:
    # Emit ~155 KB of noisy passing packet traces before the failing boundary assertion
    for i in range(2100):
        print(f"[TRACE {i:04d}] packet_seq={i} status=OK payload=0x{i*2654435761 & 0xffffffff:08x} route=edge-ap-southeast-1 checksum=VALID")
    w = RollingWindowStats(window_ms=100)
    w.push(1000, 10)
    w.push(1050, 20)
    w.push(1100, 30)  # inclusive window [1000, 1100] MUST still retain ts=1000!
    if w.total() != 60 or w.count() != 3:
        print(f"FAIL: check_inclusive_window_boundary expected total=60 count=3 got total={w.total()} count={w.count()}")
        return 1
    w.push(1101, 5)  # now ts=1000 is strictly older than 1101 - 100 = 1001 -> evicted!
    if w.total() != 55 or w.count() != 3:
        print(f"FAIL: check_evict_strictly_older expected total=55 count=3 got total={w.total()} count={w.count()}")
        return 1
    print("ALL_NOISY_TESTS_PASS")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for resil_03_150kb_noisy_stdout."""
from __future__ import annotations
import argparse, importlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "resil_03_150kb_noisy_stdout"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    p = subprocess.run([sys.executable, "run_noisy_tests.py"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "noisy_runner_pass", "passed": p.returncode == 0 and "ALL_NOISY_TESTS_PASS" in p.stdout, "detail": "ok" if p.returncode == 0 else p.stdout[-300:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "telemetry" or m.startswith("telemetry."):
            del sys.modules[m]
    try:
        mod = importlib.import_module("telemetry")
        w = mod.RollingWindowStats(50)
        w.push(100, 7)
        w.push(150, 8)
        assert w.total() == 15 and w.count() == 2
        w.push(151, 9)
        assert w.total() == 17 and w.count() == 2
        w.push(500, 1)
        assert w.total() == 1 and w.count() == 1
        checks.append({"name": "hidden_window_edges", "passed": True, "detail": "ok"})
    except Exception as exc:
        checks.append({"name": "hidden_window_edges", "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "telemetry" / "window.py", """from collections import deque

class RollingWindowStats:
    def __init__(self, window_ms: int) -> None:
        self.window_ms = int(window_ms)
        self._buf: deque[tuple[int, int]] = deque()
        self._sum = 0

    def push(self, ts_ms: int, value: int) -> None:
        self._buf.append((ts_ms, value))
        self._sum += value
        cutoff = ts_ms - self.window_ms
        while self._buf and self._buf[0][0] < cutoff:
            _, v = self._buf.popleft()
            self._sum -= v

    def total(self) -> int:
        return self._sum

    def count(self) -> int:
        return len(self._buf)
""")

    return {"id": "resil_03_150kb_noisy_stdout", "apply_ref": apply_ref}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-reference", action="store_true")
    args = ap.parse_args()

    builders = [
        build_swe_04,
        build_refact_03,
        build_atlas_03,
        build_heal_03,
        build_resil_01,
        build_resil_02,
        build_resil_03,
    ]
    built = [b() for b in builders]
    print(f"Built {len(built)} new v4 tasks: {[x['id'] for x in built]}", flush=True)

    if args.test_reference:
        print("\n=== Testing reference solutions (must PASS 100%) ===", flush=True)
        failures = []
        for item in built:
            tid = item["id"]
            tdir = TASKS_DIR / tid
            tmp = Path(tempfile.mkdtemp(prefix=f"v4_ref_{tid}_"))
            try:
                shutil.copytree(tdir / "workspace", tmp, dirs_exist_ok=True)
                item["apply_ref"](tmp)
                r = subprocess.run([sys.executable, str(tdir / "verify.py"), "--workspace", str(tmp)], capture_output=True, text=True, timeout=120)
                parsed = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
                ok = r.returncode == 0 and bool(parsed.get("passed"))
                print(f"  [{'PASS' if ok else 'FAIL'}] {tid:30s} rc={r.returncode} score={parsed.get('score')} f2p={parsed.get('fail_to_pass')}", flush=True)
                if not ok:
                    failures.append(f"{tid}: rc={r.returncode} out={r.stdout[-300:]} err={r.stderr[-300:]}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        if failures:
            print("REF FAILURES:", failures)
            return 1
        print("ALL 7 REFERENCE SOLUTIONS PASSED 100%!", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
