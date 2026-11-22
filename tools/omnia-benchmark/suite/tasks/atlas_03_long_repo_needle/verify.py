#!/usr/bin/env python3
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
