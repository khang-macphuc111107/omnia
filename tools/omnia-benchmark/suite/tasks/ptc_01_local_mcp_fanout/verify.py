#!/usr/bin/env python3
"""Hidden verifier for ptc_01_local_mcp_fanout."""
from __future__ import annotations
import argparse, hashlib, hmac, json, sqlite3
from pathlib import Path

TASK_ID = "ptc_01_local_mcp_fanout"
HMAC_KEY = b"dummy_fixture_mcp_hmac_key_v5"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    rep_path = ws / "breach_report.json"
    audit_path = ws / "data" / "mcp_audit.jsonl"
    checks.append({"name": "report_exists", "passed": rep_path.exists(), "detail": "exists" if rep_path.exists() else "missing breach_report.json"})
    audit_lines = audit_path.read_text(encoding="utf-8").splitlines() if audit_path.exists() else []
    tools_called = {json.loads(ln)["tool"] for ln in audit_lines if ln.strip()}
    checks.append({"name": "mcp_server_queried", "passed": {"list_regions", "list_shards_page", "get_shard_metrics", "verify_alert_hmac"}.issubset(tools_called) and len(audit_lines) >= 20, "detail": f"calls={len(audit_lines)} tools={sorted(tools_called)}"})

    if rep_path.exists():
        try:
            got = json.loads(rep_path.read_text(encoding="utf-8"))
            con = sqlite3.connect(str(ws / "data" / "inventory.db"))
            con.row_factory = sqlite3.Row
            owners = dict(con.execute("SELECT service, owner_team FROM owners").fetchall())
            shards = [dict(r) for r in con.execute("SELECT * FROM shards ORDER BY shard_id")]
            con.close()
            exp_breaches = []
            for s in shards:
                tok_ok = hmac.compare_digest(s["alert_token"], hmac.new(HMAC_KEY, s["shard_id"].encode(), hashlib.sha256).hexdigest()[:16])
                if tok_ok and s["status"] != "maintenance" and (s["p99_ms"] > 250 or s["error_rate_pct"] >= 2.5):
                    exp_breaches.append({
                        "shard_id": s["shard_id"], "region": s["region"], "service": s["service"],
                        "owner_team": owners[s["service"]], "p99_ms": s["p99_ms"], "error_rate_pct": s["error_rate_pct"],
                    })
            checks.append({"name": "counts_exact", "passed": got.get("total_regions") == 4 and got.get("total_shards_scanned") == 24, "detail": repr((got.get("total_regions"), got.get("total_shards_scanned")))})
            checks.append({"name": "breaches_exact", "passed": got.get("breaches") == exp_breaches, "detail": f"got={len(got.get('breaches') or [])} exp={len(exp_breaches)}"})
        except Exception as exc:
            checks.append({"name": "report_parse", "passed": False, "detail": str(exc)})
    else:
        checks.append({"name": "counts_exact", "passed": False, "detail": "no report"})
        checks.append({"name": "breaches_exact", "passed": False, "detail": "no report"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
