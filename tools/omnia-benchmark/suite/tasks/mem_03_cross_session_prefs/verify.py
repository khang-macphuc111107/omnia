#!/usr/bin/env python3
"""Hidden verifier for mem_03_cross_session_prefs."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "mem_03_cross_session_prefs"

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
        if m == "service" or m.startswith("service."):
            del sys.modules[m]
    try:
        from service.auth import sign_token, verify_token
        from service.audit import format_audit_record
        from service.handler import normalize_tenant, execute_idempotent_post

        # 1. MD5 rejected
        md5_sig = "md5:" + hashlib.md5(b"hello").hexdigest()
        keys = [{"id": "k1", "secret": "sec1", "revoked": False}, {"id": "k2", "secret": "sec2", "revoked": False}, {"id": "k3", "secret": "sec3", "revoked": True}]
        checks.append({"name": "md5_rejected", "passed": verify_token("hello", md5_sig, keys) is False, "detail": "ok"})
        # 2. Secondary non-revoked accepted, revoked rejected
        s2 = sign_token("hello", "sec2")
        s3 = sign_token("hello", "sec3")
        checks.append({"name": "rotation_and_revoked", "passed": verify_token("hello", s2, keys) is True and verify_token("hello", s3, keys) is False, "detail": "ok"})
        # 3. Audit PII scrub + tenant norm
        rec = format_audit_record("  ACME-Co ", {"user": "u1", "Token": "abc", "Authorization": "xyz", "secret": "zzz"})
        checks.append({"name": "audit_scrub_and_tenant", "passed": rec["tenant_id"] == "acme-co" and rec["event"]["Token"] == "[REDACTED]" and rec["event"]["Authorization"] == "[REDACTED]" and rec["event"]["secret"] == "[REDACTED]", "detail": repr(rec)})
        # 4. Tenant header & retry budget 4
        t_ok = normalize_tenant({"x-tenant-Id": " Beta "}) == "beta"
        t_err = False
        try:
            normalize_tenant({"x-tenant-id": "   "})
        except ValueError:
            t_err = True
        calls = {"n": 0}
        def flaky():
            calls["n"] += 1
            if calls["n"] <= 3:
                return {"status": 503 if calls["n"] % 2 else 429}
            return {"status": 200, "ok": True}
        out = execute_idempotent_post(flaky)
        checks.append({"name": "tenant_and_retry_budget_4", "passed": t_ok and t_err and out.get("status") == 200 and calls["n"] == 4, "detail": repr((t_ok, t_err, calls["n"], out))})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
