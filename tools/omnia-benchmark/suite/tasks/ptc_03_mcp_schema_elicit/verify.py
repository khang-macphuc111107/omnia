#!/usr/bin/env python3
"""Hidden verifier for ptc_03_mcp_schema_elicit."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

TASK_ID = "ptc_03_mcp_schema_elicit"
BATCHES = {
    101: (3500,), 102: (7000,), 103: (-200,), 104: (4000,),
}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    out_p = ws / "settlement_out.json"
    aud_p = ws / "settlement_audit.jsonl"
    aud = [json.loads(ln) for ln in aud_p.read_text(encoding="utf-8").splitlines() if ln.strip()] if aud_p.exists() else []
    called = {x["tool"] for x in aud}
    checks.append({"name": "mcp_workflow_executed", "passed": {"get_auth_challenge", "authenticate_session", "list_batches", "fetch_batch_items", "submit_settlement"}.issubset(called), "detail": repr(sorted(called))})

    if out_p.exists():
        got = json.loads(out_p.read_text(encoding="utf-8"))
        exp = [
            {"batch_id": bid, "net_cents": vals[0], "receipt": hashlib.sha256(f"settled:{bid}:{vals[0]}".encode()).hexdigest()[:16]}
            for bid, vals in sorted(BATCHES.items())
        ]
        checks.append({"name": "settlement_exact", "passed": got.get("authenticated") is True and got.get("batches") == exp, "detail": repr(got)})
    else:
        checks.append({"name": "settlement_exact", "passed": False, "detail": "missing settlement_out.json"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
