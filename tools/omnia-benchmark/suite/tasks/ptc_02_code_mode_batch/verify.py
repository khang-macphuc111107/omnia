#!/usr/bin/env python3
"""Hidden verifier for ptc_02_code_mode_batch."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "ptc_02_code_mode_batch"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    pub = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_tests", "passed": pub.returncode == 0, "detail": "ok" if pub.returncode == 0 else pub.stderr[-300:]})

    all_ok = True
    bad = []
    exp_checksums = {}
    for i in range(64):
        sid = f"svc_{i:02d}"
        d = json.loads((ws / "services" / f"{sid}.json").read_text(encoding="utf-8"))
        exp_ep = f"/api/v2/{sid}/invoke"
        exp_sha = hashlib.sha256(f"{sid}:{exp_ep}:{d['tier']}".encode()).hexdigest()
        exp_checksums[sid] = exp_sha
        if d.get("api_version") != "v2" or d.get("endpoint") != exp_ep or d.get("spec_sha256") != exp_sha:
            all_ok = False
            bad.append(sid)
    checks.append({"name": "all_64_migrated_and_hashed", "passed": all_ok, "detail": f"bad={bad[:5]}"})

    idx = json.loads((ws / "registry" / "index.json").read_text(encoding="utf-8"))
    exp_mig = sum(1 for i in range(64) if i % 3 != 0)
    checks.append({"name": "index_fields_exact", "passed": (
        idx.get("total_services") == 64
        and idx.get("migrated_from_v1") == exp_mig
        and sorted(idx.get("cycle_nodes", [])) == ["svc_12", "svc_13", "svc_14", "svc_40", "svc_41"]
        and idx.get("by_tier") == {"critical": 16, "standard": 48}
        and idx.get("checksums") == exp_checksums
    ), "detail": repr({k: idx.get(k) for k in ("total_services", "migrated_from_v1", "cycle_nodes", "by_tier")})})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
