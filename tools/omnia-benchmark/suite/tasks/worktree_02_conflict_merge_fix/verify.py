#!/usr/bin/env python3
"""Hidden verifier for worktree_02_conflict_merge_fix."""
from __future__ import annotations
import argparse, hashlib, hmac, json, subprocess, sys
from pathlib import Path

TASK_ID = "worktree_02_conflict_merge_fix"

def _is_anc(ws: Path, branch: str) -> bool:
    r = subprocess.run(["git", "merge-base", "--is-ancestor", branch, "HEAD"], cwd=str(ws), capture_output=True)
    return r.returncode == 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    head_branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(ws), capture_output=True, text=True).stdout.strip()
    checks.append({"name": "git_ancestry_both_branches", "passed": head_branch == "main" and _is_anc(ws, "feat/rate-limiter") and _is_anc(ws, "feat/audit-hmac"), "detail": f"head={head_branch}"})
    st = subprocess.run(["git", "status", "--porcelain"], cwd=str(ws), capture_output=True, text=True).stdout.strip()
    checks.append({"name": "git_clean", "passed": st == "", "detail": repr(st[:200])})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "gateway" or m.startswith("gateway."):
            del sys.modules[m]
    try:
        from gateway.config import GatewayConfig
        from gateway.server import Gateway
        cfg = GatewayConfig(service_name="prod", rate_limit=2, window_ms=1000, audit_hmac_key="dummy_secret_k")
        gw = Gateway(cfg)
        r1 = gw.handle({"req_id": "1", "client": "c1", "ts_ms": 100})
        r2 = gw.handle({"req_id": "2", "client": "c1", "ts_ms": 200})
        r3 = gw.handle({"req_id": "3", "client": "c1", "ts_ms": 300})
        # After 1000ms window slides past 100 (at 1105), c1 MUST be ALLOWED again (r3 did not pollute window!)
        r4 = gw.handle({"req_id": "4", "client": "c1", "ts_ms": 1105})
        exp3 = hmac.new(b"dummy_secret_k", b'{"decision":"DENIED","req_id":"3"}', hashlib.sha256).hexdigest()
        checks.append({"name": "limiter_audit_interaction", "passed": (
            r1["decision"] == "ALLOWED" and r2["decision"] == "ALLOWED" and r3["decision"] == "DENIED" and r4["decision"] == "ALLOWED"
            and r3["audit"]["sig"] == exp3 and len(gw.audit.entries) == 4
        ), "detail": repr((r1["decision"], r2["decision"], r3, r4["decision"]))})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": str(exc)})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
