#!/usr/bin/env python3
"""Hidden verifier for worktree_01_parallel_services."""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path

TASK_ID = "worktree_01_parallel_services"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    pub = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_tests", "passed": pub.returncode == 0, "detail": "ok" if pub.returncode == 0 else pub.stderr[-300:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m in ("contracts", "packages") or m.startswith(("contracts.", "packages.")):
            del sys.modules[m]
    try:
        from packages.billing.service import create_invoice
        from packages.auth.service import verify_session
        from packages.notify.service import Notifier
        e = create_invoice("tr-x", "beta", 5000, 150)  # 150 * 107 = 16050 -> +50 = 16100 // 100 = 161
        checks.append({"name": "hidden_billing_rounding", "passed": isinstance(e.payload["total_cents"], int) and e.payload["total_cents"] == 161 and e.tenant_id == "beta" and e.issued_at_ms == 5000, "detail": repr(e)})
        ok_auth = verify_session("tok_12345", 1000, 61000, ttl_ms=60000)["ok"] is True
        exp_blk = False
        try:
            verify_session("tok_12345", 1000, 61001, ttl_ms=60000)
        except ValueError as exc:
            exp_blk = "tok_12345" not in str(exc)
        checks.append({"name": "hidden_auth_boundary", "passed": ok_auth and exp_blk, "detail": repr((ok_auth, exp_blk))})
        n = Notifier()
        checks.append({"name": "hidden_notify_dedup", "passed": n.send(e) is True and n.send(e) is False and len(n.sent) == 1 and n.sent[0]["trace_id"] == "tr-x", "detail": repr(n.sent)})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": str(exc)})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
