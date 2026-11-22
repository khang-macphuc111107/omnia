#!/usr/bin/env python3
"""Hidden verifier for refact_03_ts_large_split."""
from __future__ import annotations
import argparse, json, re, subprocess
from pathlib import Path

TASK_ID = "refact_03_ts_large_split"

NODE_CHECK = r"""
import assert from "node:assert/strict";
import * as val from "./src/core/validation.mjs";
import * as pr from "./src/core/pricing.mjs";
import * as sh from "./src/core/shipping.mjs";
import * as au from "./src/core/audit.mjs";
import * as mono from "./src/monolith.mjs";

for (const fn of ["validateSku", "validateOrder", "normalizeCountry"]) {
  assert.equal(typeof val[fn], "function", `missing validation.${fn}`);
  assert.equal(mono[fn], val[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["computeSubtotal", "computeTax", "computeOrderTotal"]) {
  assert.equal(typeof pr[fn], "function", `missing pricing.${fn}`);
  assert.equal(mono[fn], pr[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["estimateShippingCents", "selectCarrier"]) {
  assert.equal(typeof sh[fn], "function", `missing shipping.${fn}`);
  assert.equal(mono[fn], sh[fn], `monolith must re-export ${fn}`);
}
for (const fn of ["formatAuditRecord", "computeOrderChecksum"]) {
  assert.equal(typeof au[fn], "function", `missing audit.${fn}`);
  assert.equal(mono[fn], au[fn], `monolith must re-export ${fn}`);
}

// Tax-exempt bug fix + half-up rounding fix
assert.equal(pr.computeTax(10000, "US", true), 0, "tax-exempt must return 0");
assert.equal(pr.computeTax(100, "US", false), 8, "8.25 -> 8");
assert.equal(pr.computeTax(105, "US", false), 9, "8.6625 -> 9 (Math.round, not floor)");
const ord = pr.computeOrderTotal({
  country: "US", taxExempt: true, weightGrams: 500,
  items: [{ sku: "XY-9999", qty: 3, unitCents: 333 }],
});
assert.equal(ord.taxCents, 0);
assert.equal(ord.totalCents, 999 + 500);

// Execute all 18 migrated services
for (let i = 1; i <= 18; i++) {
  const pad = String(i).padStart(2, "0");
  const mod = await import(`./src/services/svc_${pad}.mjs`);
  if (i % 3 === 1) {
    const r = mod[`processService${pad}`](`O-${i}`, { country: "US", taxExempt: true, weightGrams: 400, items: [{ sku: "AA-1111", qty: 1, unitCents: 105 }] });
    assert.equal(r.ok, true);
    assert.equal(r.totals.taxCents, 0);
  } else if (i % 3 === 2) {
    const r = mod[`quoteService${pad}`]([{ sku: "AA-1111", qty: 1, unitCents: 105 }], "US", false);
    assert.equal(r.tax, 9);
  } else {
    const r = mod[`shipService${pad}`](`O-${i}`, 1500, "DE");
    assert.equal(r.carrier, "DHL_EXPRESS");
  }
}
console.log("HIDDEN_NODE_OK");
"""

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    def rec(name: str, ok: bool, detail: str = "ok") -> None:
        checks.append({"name": name, "passed": ok, "detail": detail})

    # 1. Public test
    p = subprocess.run(["node", "tests/public.test.mjs"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    rec("public_test", p.returncode == 0, "ok" if p.returncode == 0 else (p.stdout + p.stderr)[-400:])

    # 2. All 4 core files exist
    core_files = ["validation.mjs", "pricing.mjs", "shipping.mjs", "audit.mjs"]
    missing = [f for f in core_files if not (ws / "src" / "core" / f).exists()]
    rec("core_modules_exist", not missing, "ok" if not missing else f"missing: {missing}")

    # 3. Monolith is slim re-export barrel <= 30 non-empty lines
    mono_path = ws / "src" / "monolith.mjs"
    mono_lines = [ln for ln in mono_path.read_text("utf-8").splitlines() if ln.strip()] if mono_path.exists() else []
    rec("monolith_slim_barrel", 1 <= len(mono_lines) <= 30, f"non_empty_lines={len(mono_lines)}")

    # 4. All 18 services have ZERO imports from monolith.mjs
    bad_svcs = []
    for i in range(1, 19):
        sp = ws / "src" / "services" / f"svc_{i:02d}.mjs"
        txt = sp.read_text("utf-8") if sp.exists() else ""
        if "monolith" in txt or "../core/" not in txt:
            bad_svcs.append(sp.name)
    rec("all_18_callers_migrated", not bad_svcs, "ok" if not bad_svcs else f"unmigrated: {bad_svcs}")

    # 5. Deep functional & re-export identity check via node
    chk = ws / "_hidden_check.mjs"
    try:
        chk.write_text(NODE_CHECK, encoding="utf-8")
        pn = subprocess.run(["node", "_hidden_check.mjs"], cwd=str(ws), capture_output=True, text=True, timeout=30)
        rec("hidden_functional_and_reexports", pn.returncode == 0 and "HIDDEN_NODE_OK" in pn.stdout, "ok" if pn.returncode == 0 else (pn.stdout + pn.stderr)[-500:])
    finally:
        chk.unlink(missing_ok=True)

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    out = {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(ok_n / len(checks), 4),
        "fail_to_pass": {"passed": ok_n, "total": len(checks)},
        "pass_to_pass": {"passed": 1 if checks[0]["passed"] else 0, "total": 1},
        "checks": checks,
    }
    print(json.dumps(out))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
