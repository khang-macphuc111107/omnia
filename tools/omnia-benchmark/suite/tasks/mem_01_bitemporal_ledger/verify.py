#!/usr/bin/env python3
"""Hidden verifier for mem_01_bitemporal_ledger."""
from __future__ import annotations
import argparse, importlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "mem_01_bitemporal_ledger"

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
        if m == "policy_engine" or m.startswith("policy_engine."):
            del sys.modules[m]
    try:
        from policy_engine import evaluate_order

        # 1. rev-1 (2026-10-03): limit=50000, min=500, fee=150bps, gold=-50bps -> 100bps, blocked=[KP,IR], hold=24
        r1 = evaluate_order({"amount_cents": 10000, "tier": "gold", "region": "US"}, "2026-10-03T12:00:00Z")
        checks.append({"name": "rev1_gold_approve", "passed": r1 == {"decision": "APPROVE", "reason": "ok", "fee_cents": 100, "hold_hours": 0, "active_policy_rev": "rev-1"}, "detail": repr(r1)})

        # 2. retracted rev-2-draft on 2026-10-07 MUST NOT apply; rev-1 still active (60000 > 50000 -> hold)
        r_ret = evaluate_order({"amount_cents": 60000, "tier": "standard", "region": "SY"}, "2026-10-07T00:00:00Z")
        checks.append({"name": "retracted_draft_ignored", "passed": r_ret["decision"] == "MANUAL_HOLD" and r_ret["hold_hours"] == 24 and r_ret["active_policy_rev"] == "rev-1", "detail": repr(r_ret)})

        # 3. rev-2 (2026-10-12): SY now blocked!
        r2 = evaluate_order({"amount_cents": 60000, "tier": "standard", "region": "SY"}, "2026-10-12T00:00:00Z")
        checks.append({"name": "rev2_sy_blocked", "passed": r2["decision"] == "REJECT" and r2["reason"] == "blocked_region" and r2["active_policy_rev"] == "rev-2", "detail": repr(r2)})

        # 4. rev-3 (2026-10-22): fee=110bps, platinum=-60bps -> 50bps, limit=500000, hold=12
        r3 = evaluate_order({"amount_cents": 400000, "tier": "platinum", "region": "SG"}, "2026-10-22T00:00:00Z")
        checks.append({"name": "rev3_platinum_multiplier", "passed": r3 == {"decision": "APPROVE", "reason": "ok", "fee_cents": 2000, "hold_hours": 0, "active_policy_rev": "rev-3"}, "detail": repr(r3)})

        # 5. rev-3.1 (2026-10-26): fee=100bps, gold=-40bps -> 60bps, hold=6, min=1000
        r31 = evaluate_order({"amount_cents": 300000, "tier": "gold", "region": "SG"}, "2026-10-26T00:00:00Z")
        checks.append({"name": "rev31_gold_hold_and_fee", "passed": r31 == {"decision": "MANUAL_HOLD", "reason": "above_auto_limit", "fee_cents": 1800, "hold_hours": 6, "active_policy_rev": "rev-3.1"}, "detail": repr(r31)})

        # 6. below min_amount
        rmin = evaluate_order({"amount_cents": 999, "tier": "standard", "region": "US"}, "2026-10-26T00:00:00Z")
        checks.append({"name": "below_min_reject", "passed": rmin["decision"] == "REJECT" and rmin["reason"] == "below_min_amount" and rmin["active_policy_rev"] == "rev-3.1", "detail": repr(rmin)})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
