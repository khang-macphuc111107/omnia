#!/usr/bin/env python3
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
