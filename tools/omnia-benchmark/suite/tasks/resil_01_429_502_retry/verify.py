#!/usr/bin/env python3
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
