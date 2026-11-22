#!/usr/bin/env python3
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
