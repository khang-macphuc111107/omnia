#!/usr/bin/env python3
"""Hidden verifier for mem_02_compaction_drift."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "mem_02_compaction_drift"

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
        if m == "router" or m.startswith("router."):
            del sys.modules[m]
    try:
        from router import DispatchPipeline
        p = DispatchPipeline()
        orig_events = [
            {"event_id": "e1", "tenant_id": " ACME ", "idempotency_key": "k1", "priority": "normal", "retry_count": 5, "payload": {"email": "a@b.test", "phone": "555-0100", "ok": 1}},
            {"event_id": "e2", "tenant_id": "acme", "idempotency_key": "k1", "priority": "urgent", "retry_count": 0, "payload": {"ok": 2}},  # dup of (acme, k1)
            {"event_id": "e3", "tenant_id": "beta", "idempotency_key": "k2", "priority": "urgent", "retry_count": 4, "payload": {"email": "x@y.test"}},
            {"event_id": "e4", "tenant_id": "   ", "idempotency_key": "k3", "priority": "urgent", "retry_count": 0, "payload": {}},
            {"event_id": "e5", "tenant_id": "beta", "idempotency_key": "k4", "priority": "normal", "retry_count": 6, "payload": {}},
            {"event_id": "e6", "tenant_id": "beta", "idempotency_key": "k5", "priority": "normal", "retry_count": 0, "payload": {"blob": "x" * 5000}},
        ]
        res = p.process_batch(orig_events)
        acc_ids = [e["event_id"] for e in res["accepted"]]
        checks.append({"name": "priority_dedup_retry_errata", "passed": acc_ids == ["e3", "e1"] and res["deduped_count"] == 1, "detail": repr((acc_ids, res["deduped_count"]))})
        checks.append({"name": "pii_masked_non_mutating", "passed": res["accepted"][1]["payload"]["email"] == "***" and res["accepted"][1]["payload"]["phone"] == "***" and orig_events[0]["payload"]["email"] == "a@b.test", "detail": repr(res["accepted"][1]["payload"])})
        rej_reasons = {r["event_id"]: r["reason"] for r in res["rejected"]}
        checks.append({"name": "reject_reasons", "passed": rej_reasons == {"e4": "empty_tenant", "e5": "retry_exhausted", "e6": "payload_too_large"}, "detail": repr(rej_reasons)})
        exp_digest = hashlib.sha256(json.dumps(acc_ids, separators=(",", ":")).encode()).hexdigest()
        checks.append({"name": "digest_match", "passed": res["digest"] == exp_digest, "detail": repr(res["digest"])})
        checks.append({"name": "backoff_cap", "passed": p.backoff_ms(0) == 100 and p.backoff_ms(10) == 5000, "detail": repr((p.backoff_ms(0), p.backoff_ms(10)))})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
