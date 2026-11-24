"""Suite v5 Axis 12 (Long-Horizon Memory & Context Compaction) task builders.

Creates 3 deterministic, realistic tasks under D:\\Omnia\\tools\\omnia-benchmark\\suite\\tasks\\:
  1. mem_01_bitemporal_ledger  — 6-session JSONL history w/ bi-temporal valid/superseded policy rules
  2. mem_02_compaction_drift   — 110 KB noisy spec changelog w/ 8 invariants & explicit amendments
  3. mem_03_cross_session_prefs— 3 cross-session transcripts + incident log enforcing tenant/retry/PII rules
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path


def _w(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _task_meta(tid: str, title: str, langs: list[str], setup_script: str | None = None) -> str:
    return json.dumps({
        "id": tid,
        "axis": 12,
        "axis_name": "Long-Horizon Memory & Context Compaction",
        "title": title,
        "difficulty": "hard",
        "languages": langs,
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "memory_state",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": setup_script,
        "verify_script": "verify.py",
    }, indent=2) + "\n"


def build_mem_01(tasks_dir: Path) -> dict:
    tid = "mem_01_bitemporal_ledger"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Bi-temporal policy reconstruction across 6 noisy session transcripts",
        ["python", "json"],
    ))
    _w(tdir / "prompt.md", """# Task: Reconstruct Bi-Temporal Policy Rules Across Multi-Session History

Inspect the chronological session transcripts in `logs/` (`session_01.jsonl` .. `session_06.jsonl`).
Across these 6 sessions (~95 KB of interleaved engineering chatter, dead-end proposals, and policy updates), authorization thresholds, tier multipliers, region exclusions, and hold periods changed over time — some rules were **retracted** or **superseded** with explicit `effective_from` / `invalid_at` timestamps.

Implement `evaluate_order(order: dict, as_of_utc: str) -> dict` in `policy_engine/validator.py` so it evaluates orders using ONLY the policy rules valid at `as_of_utc` (inclusive `effective_from <= as_of_utc < invalid_at`, ignoring retracted proposals):

Required return schema:
```python
{
    "decision": "APPROVE" | "MANUAL_HOLD" | "REJECT",
    "reason": str,          # short machine tag e.g. "ok", "blocked_region", "above_auto_limit", "below_min_amount"
    "fee_cents": int,       # integer fee rounded half-up
    "hold_hours": int,      # 0 for APPROVE/REJECT, configured hold window for MANUAL_HOLD
    "active_policy_rev": str,
}
```
Run `python -m unittest discover -s tests` to confirm baseline public tests, and make sure both historical time-travel queries (`as_of_utc` in early vs mid vs latest dates) and current rules work cleanly without editing `tests/`.
""")

    # Build 6 chronological session transcripts (~95 KB total with noise + buried bi-temporal rules)
    noise_line = lambda s, k: json.dumps({
        "ts": f"2026-10-{10+s:02d}T{10 + (k%10):02d}:{k%60:02d}:00Z",
        "speaker": "eng" if k % 2 == 0 else "bot",
        "note": f"Trace heartbeat seq={k} pool=ap-south-1 cpu=0.{12+(k%70):02d} rss_mb={42+(k%19)} ok",
    })
    sessions = [
        ("session_01.jsonl", [
            json.dumps({"ts": "2026-10-01T09:00:00Z", "event": "POLICY_PROPOSAL", "rev": "rev-1",
                        "effective_from": "2026-10-01T00:00:00Z",
                        "rules": {"auto_limit_cents": 50000, "min_amount_cents": 500, "fee_bps": 150,
                                  "tier_discount_bps": {"gold": 50, "silver": 20, "standard": 0},
                                  "blocked_regions": ["KP", "IR"], "hold_hours": 24}}),
            json.dumps({"ts": "2026-10-01T09:15:00Z", "event": "DECISION_RATIFIED", "rev": "rev-1",
                        "note": "rev-1 active starting 2026-10-01T00:00:00Z."}),
        ]),
        ("session_02.jsonl", [
            json.dumps({"ts": "2026-10-05T11:00:00Z", "event": "POLICY_PROPOSAL", "rev": "rev-2-draft",
                        "effective_from": "2026-10-05T00:00:00Z",
                        "rules": {"auto_limit_cents": 999999, "fee_bps": 10}}),
            json.dumps({"ts": "2026-10-05T11:45:00Z", "event": "PROPOSAL_RETRACTED", "rev": "rev-2-draft",
                        "reason": "Security rejected uncapped auto_limit; NEVER activate rev-2-draft."}),
        ]),
        ("session_03.jsonl", [
            json.dumps({"ts": "2026-10-10T08:00:00Z", "event": "POLICY_SUPERSEDE", "replaces": "rev-1",
                        "invalid_at_for_old": "2026-10-10T00:00:00Z", "rev": "rev-2",
                        "effective_from": "2026-10-10T00:00:00Z",
                        "rules": {"auto_limit_cents": 120000, "min_amount_cents": 1000, "fee_bps": 125,
                                  "tier_discount_bps": {"gold": 45, "silver": 15, "standard": 0},
                                  "blocked_regions": ["KP", "IR", "SY"], "hold_hours": 48}}),
        ]),
        ("session_04.jsonl", [
            json.dumps({"ts": "2026-10-14T14:00:00Z", "event": "CHAT_DISTRACTOR",
                        "text": "Someone asked if fee_bps should become 500; finance said NO, ignore that."}),
        ]),
        ("session_05.jsonl", [
            json.dumps({"ts": "2026-10-20T00:00:00Z", "event": "POLICY_SUPERSEDE", "replaces": "rev-2",
                        "invalid_at_for_old": "2026-10-20T00:00:00Z", "rev": "rev-3",
                        "effective_from": "2026-10-20T00:00:00Z",
                        "rules": {"auto_limit_cents": 250000, "min_amount_cents": 1000, "fee_bps": 110,
                                  "tier_discount_bps": {"platinum": 60, "gold": 40, "silver": 15, "standard": 0},
                                  "blocked_regions": ["KP", "IR", "SY", "CU"], "hold_hours": 12,
                                  "platinum_auto_multiplier": 2}}),
        ]),
        ("session_06.jsonl", [
            json.dumps({"ts": "2026-10-25T16:30:00Z", "event": "ERRATA_PATCH", "target_rev": "rev-3",
                        "effective_from": "2026-10-25T00:00:00Z", "rev": "rev-3.1",
                        "invalid_at_for_old": "2026-10-25T00:00:00Z",
                        "changes": {"fee_bps": 100, "hold_hours": 6,
                                    "note": "All other rev-3 fields inherited unchanged; platinum auto limit = 2x auto_limit_cents = 500000."}}),
        ]),
    ]
    for s_idx, (fname, key_events) in enumerate(sessions):
        lines = [noise_line(s_idx, k) for k in range(45)]
        lines.insert(12, key_events[0])
        if len(key_events) > 1:
            lines.insert(31, key_events[1])
        lines.extend(noise_line(s_idx, k) for k in range(45, 95))
        _w(ws / "logs" / fname, "\n".join(lines) + "\n")

    _w(ws / "policy_engine" / "__init__.py", "from .validator import evaluate_order\n")
    _w(ws / "policy_engine" / "validator.py", """def evaluate_order(order: dict, as_of_utc: str) -> dict:
    # BUG: hardcoded stale placeholder ignoring bi-temporal history in logs/
    return {
        "decision": "MANUAL_HOLD",
        "reason": "unimplemented",
        "fee_cents": 0,
        "hold_hours": 99,
        "active_policy_rev": "rev-0",
    }
""")
    _w(ws / "tests" / "test_public.py", """import unittest
from policy_engine import evaluate_order

class PublicPolicyTests(unittest.TestCase):
    def test_schema_keys(self):
        out = evaluate_order({"amount_cents": 2000, "tier": "standard", "region": "US"}, "2026-10-26T00:00:00Z")
        for k in ("decision", "reason", "fee_cents", "hold_hours", "active_policy_rev"):
            self.assertIn(k, out)
        self.assertEqual(out["active_policy_rev"], "rev-3.1")
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
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
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "policy_engine" / "validator.py", '''"""Bi-temporal policy evaluator."""
from __future__ import annotations

REVISIONS = [
    ("2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z", {
        "rev": "rev-1", "auto_limit_cents": 50000, "min_amount_cents": 500, "fee_bps": 150,
        "tier_discount_bps": {"gold": 50, "silver": 20, "standard": 0},
        "blocked_regions": {"KP", "IR"}, "hold_hours": 24, "platinum_mult": 1,
    }),
    ("2026-10-10T00:00:00Z", "2026-10-20T00:00:00Z", {
        "rev": "rev-2", "auto_limit_cents": 120000, "min_amount_cents": 1000, "fee_bps": 125,
        "tier_discount_bps": {"gold": 45, "silver": 15, "standard": 0},
        "blocked_regions": {"KP", "IR", "SY"}, "hold_hours": 48, "platinum_mult": 1,
    }),
    ("2026-10-20T00:00:00Z", "2026-10-25T00:00:00Z", {
        "rev": "rev-3", "auto_limit_cents": 250000, "min_amount_cents": 1000, "fee_bps": 110,
        "tier_discount_bps": {"platinum": 60, "gold": 40, "silver": 15, "standard": 0},
        "blocked_regions": {"KP", "IR", "SY", "CU"}, "hold_hours": 12, "platinum_mult": 2,
    }),
    ("2026-10-25T00:00:00Z", "9999-12-31T23:59:59Z", {
        "rev": "rev-3.1", "auto_limit_cents": 250000, "min_amount_cents": 1000, "fee_bps": 100,
        "tier_discount_bps": {"platinum": 60, "gold": 40, "silver": 15, "standard": 0},
        "blocked_regions": {"KP", "IR", "SY", "CU"}, "hold_hours": 6, "platinum_mult": 2,
    }),
]

def evaluate_order(order: dict, as_of_utc: str) -> dict:
    pol = REVISIONS[-1][2]
    for start, end, cfg in REVISIONS:
        if start <= as_of_utc < end:
            pol = cfg
            break
    amt = int(order["amount_cents"])
    tier = str(order.get("tier", "standard")).lower()
    region = str(order.get("region", "")).upper()
    disc = pol["tier_discount_bps"].get(tier, 0)
    eff_bps = max(0, pol["fee_bps"] - disc)
    fee = (amt * eff_bps + 5000) // 10000
    if region in pol["blocked_regions"]:
        return {"decision": "REJECT", "reason": "blocked_region", "fee_cents": fee, "hold_hours": 0, "active_policy_rev": pol["rev"]}
    if amt < pol["min_amount_cents"]:
        return {"decision": "REJECT", "reason": "below_min_amount", "fee_cents": fee, "hold_hours": 0, "active_policy_rev": pol["rev"]}
    limit = pol["auto_limit_cents"] * (pol["platinum_mult"] if tier == "platinum" else 1)
    if amt > limit:
        return {"decision": "MANUAL_HOLD", "reason": "above_auto_limit", "fee_cents": fee, "hold_hours": pol["hold_hours"], "active_policy_rev": pol["rev"]}
    return {"decision": "APPROVE", "reason": "ok", "fee_cents": fee, "hold_hours": 0, "active_policy_rev": pol["rev"]}
''')

    return {"id": tid, "apply_ref": apply_ref}


def build_mem_02(tasks_dir: Path) -> dict:
    tid = "mem_02_compaction_drift"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Preserve 8 architectural invariants across 110 KB noisy spec evolution without drift",
        ["python"],
    ))
    _w(tdir / "prompt.md", """# Task: Implement Pipeline Satisfying All Active Invariants Without Compaction Drift

Read `docs/SPEC_HISTORY.md` and `docs/archive_*.log` (~110 KB combined).
Eight architectural invariants (`INV-01` through `INV-08`) were specified across early sections and later amended in two explicit errata entries (while unapproved brainstorm comments must be ignored).

Fix `router/pipeline.py` (`DispatchPipeline.process_batch(events: list[dict]) -> dict`) so it satisfies ALL 8 effective invariants simultaneously and passes `python -m unittest discover -s tests` (do not edit `tests/`).
""")

    filler = "\n".join(
        f"[2026-11-01T12:{i%60:02d}:00Z] DEBUG worker_pool shard={i%16} queue_depth={i%9} ack=true checksum=0x{i*0x9e3779b1 & 0xffffffff:08x}"
        for i in range(950)
    )
    _w(ws / "docs" / "archive_build.log", filler + "\n")
    _w(ws / "docs" / "SPEC_HISTORY.md", """# Dispatch Pipeline Specification Evolution

## Section 1 — Core Invariants (Initial)
- **INV-01 (Deduplication):** Deduplicate events by `(tenant_id, idempotency_key)` keeping the FIRST occurrence in input order; drop subsequent duplicates and record `"deduped_count"`.
- **INV-02 (Tenant Normalization):** Normalize `tenant_id` via `.strip().lower()`; reject empty tenant IDs into `"rejected"` with reason `"empty_tenant"`.
- **INV-03 (Original Retry Cap):** Initial draft set `max_retries = 3`. *(Check later errata!)*
- **INV-04 (Payload Ceiling):** Events with JSON-serialized `payload` > `4096` bytes go to `"rejected"` with reason `"payload_too_large"`.
- **INV-05 (Priority Routing):** Priority `"urgent"` events MUST sort ahead of `"normal"`, preserving relative FIFO order within each priority tier.
- **INV-06 (Deterministic Backoff):** `backoff_ms(attempt)` = `min(cap_ms, 100 * (2 ** attempt))` where `attempt` starts at `0`, with deterministic jitter `0` when `seed is None` and `hash_offset % 25` when `seed` string is provided (`cap_ms = 5000`).
- **INV-07 (Original PII Field):** Initial draft masked `"email"` only. *(Check later errata!)*
- **INV-08 (Checksum Seal):** Return `"digest"` = SHA-256 hex of `json.dumps(accepted_ids, separators=(",", ":"))` where `accepted_ids` is the ordered list of accepted `event_id` strings.

## Section 2 — Unapproved Brainstorm (DO NOT IMPLEMENT)
> Brainstorm note: Someone suggested changing `cap_ms` to 99999 or dropping `"urgent"` sorting. Rejected in architecture review.

## Section 3 — Approved Errata (EFFECTIVE NOW)
- **ERRATA INV-03:** Effective immediately, `max_retries` is raised from `3` to **`5`** (events with `retry_count > 5` go to `"rejected"` with reason `"retry_exhausted"`).
- **ERRATA INV-07:** In `accepted` event copies, mask BOTH `"email"` (`"***"`) AND `"phone"` (`"***"`) inside `payload` (non-mutating copy of input dicts!).
""" + "\n" + "\n".join(f"<!-- filler-spec-line-{i}: noop telemetry retention policy ok -->" for i in range(400)) + "\n")

    _w(ws / "router" / "__init__.py", "from .pipeline import DispatchPipeline\n")
    _w(ws / "router" / "pipeline.py", """class DispatchPipeline:
    def process_batch(self, events: list[dict], seed: str | None = None) -> dict:
        return {"accepted": [], "rejected": [], "deduped_count": 0, "digest": ""}

    def backoff_ms(self, attempt: int, seed: str | None = None) -> int:
        return 0
""")
    _w(ws / "tests" / "test_public.py", """import unittest
from router import DispatchPipeline

class PublicPipelineTests(unittest.TestCase):
    def test_basic_accept(self):
        p = DispatchPipeline()
        res = p.process_batch([{"event_id": "e1", "tenant_id": "Acme", "idempotency_key": "k1", "priority": "normal", "retry_count": 0, "payload": {"msg": "hi"}}])
        self.assertEqual(len(res["accepted"]), 1)
        self.assertEqual(res["accepted"][0]["tenant_id"], "acme")
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
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
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "router" / "pipeline.py", '''import copy, hashlib, json

class DispatchPipeline:
    def backoff_ms(self, attempt: int, seed: str | None = None) -> int:
        base = min(5000, 100 * (2 ** max(0, int(attempt))))
        if seed is None:
            return base
        off = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:4], "big") % 25
        return min(5000, base + off)

    def process_batch(self, events: list[dict], seed: str | None = None) -> dict:
        seen = set()
        accepted_urgent = []
        accepted_normal = []
        rejected = []
        deduped = 0
        for ev in events:
            tid = str(ev.get("tenant_id", "")).strip().lower()
            if not tid:
                rejected.append({"event_id": ev.get("event_id"), "reason": "empty_tenant"})
                continue
            key = (tid, str(ev.get("idempotency_key", "")))
            if key in seen:
                deduped += 1
                continue
            seen.add(key)
            if int(ev.get("retry_count", 0)) > 5:
                rejected.append({"event_id": ev.get("event_id"), "reason": "retry_exhausted"})
                continue
            payload = copy.deepcopy(ev.get("payload") or {})
            if len(json.dumps(payload, separators=(",", ":")).encode("utf-8")) > 4096:
                rejected.append({"event_id": ev.get("event_id"), "reason": "payload_too_large"})
                continue
            for pkey in ("email", "phone"):
                if pkey in payload:
                    payload[pkey] = "***"
            item = copy.deepcopy(ev)
            item["tenant_id"] = tid
            item["payload"] = payload
            if str(item.get("priority", "normal")).lower() == "urgent":
                accepted_urgent.append(item)
            else:
                accepted_normal.append(item)
        accepted = accepted_urgent + accepted_normal
        digest = hashlib.sha256(json.dumps([e["event_id"] for e in accepted], separators=(",", ":")).encode("utf-8")).hexdigest()
        return {"accepted": accepted, "rejected": rejected, "deduped_count": deduped, "digest": digest}
''')

    return {"id": tid, "apply_ref": apply_ref}


def build_mem_03(tasks_dir: Path) -> dict:
    tid = "mem_03_cross_session_prefs"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Cross-session memory synthesis & incident constraint enforcement",
        ["python", "csv"],
    ))
    _w(tdir / "prompt.md", """# Task: Enforce Cross-Session Engineering Decisions & Incident Postmortems

Inspect `memory_archive/` (`prior_session_1.jsonl`, `prior_session_2.jsonl`, `prior_session_3.jsonl`, and `incidents.csv`).
Three prior sessions and an incident postmortem define mandatory security and operational constraints across `service/auth.py`, `service/audit.py`, and `service/handler.py` (including forbidden legacy fallbacks, key-rotation precedence, tenant header normalization, PII scrubbing, and idempotent retry budget).

Fix `service/auth.py`, `service/audit.py`, and `service/handler.py` so every constraint from `memory_archive/` is satisfied and `python -m unittest discover -s tests` passes cleanly (do not edit `tests/`).
""")

    _w(ws / "memory_archive" / "prior_session_1.jsonl", "\n".join([
        json.dumps({"session": "s1", "role": "user", "text": "Never allow MD5 or unsigned tokens in service/auth.py; always enforce HMAC-SHA256 with constant-time compare_digest."}),
        json.dumps({"session": "s1", "role": "assistant", "text": "Noted: disallow MD5 legacy fallback and require HMAC-SHA256."}),
    ] + [json.dumps({"session": "s1", "role": "user", "text": f"bg trace {i}"}) for i in range(120)]) + "\n")
    _w(ws / "memory_archive" / "prior_session_2.jsonl", "\n".join([
        json.dumps({"session": "s2", "role": "user", "text": "Update: tenant header X-Tenant-Id must be lowercased and stripped; reject missing/empty tenant with ValueError('missing_tenant')."}),
        json.dumps({"session": "s2", "role": "user", "text": "Also support key rotation list ACTIVE_KEYS=[primary, secondary] where primary signs new tokens and both verify, rejecting keys marked REVOKED."}),
    ] + [json.dumps({"session": "s2", "role": "assistant", "text": f"telemetry ack {i}"}) for i in range(120)]) + "\n")
    _w(ws / "memory_archive" / "prior_session_3.jsonl", "\n".join([
        json.dumps({"session": "s3", "role": "user", "text": "In service/audit.py, scrub any key named 'token', 'secret', or 'authorization' (case-insensitive) to '[REDACTED]' before returning or writing records."}),
        json.dumps({"session": "s3", "role": "user", "text": "In service/handler.py, idempotent_post retry_budget is 4 (not 1), and only retry status 429 or 503."}),
    ]) + "\n")
    _w(ws / "memory_archive" / "incidents.csv",
       "incident_id,date,root_cause,mandatory_fix\n"
       "INC-104,2026-10-18,legacy md5 accepted forged token,reject alg=md5 and require sha256\n"
       "INC-119,2026-10-29,secondary rotated key failed verification,verify against all non-revoked keys\n")

    _w(ws / "service" / "__init__.py", "")
    _w(ws / "service" / "auth.py", """import hashlib, hmac

def sign_token(payload: str, primary_key: str) -> str:
    return "v2:" + hmac.new(primary_key.encode(), payload.encode(), hashlib.sha256).hexdigest()

def verify_token(payload: str, signature: str, keys: list[dict]) -> bool:
    # BUG 1: accepts legacy md5: prefix!
    if signature.startswith("md5:"):
        return signature[4:] == hashlib.md5(payload.encode()).hexdigest()
    # BUG 2: only checks first key, ignores non-revoked secondary key AND fails to skip revoked keys!
    if not keys:
        return False
    expected = "v2:" + hmac.new(keys[0]["secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
    return signature == expected
""")
    _w(ws / "service" / "audit.py", """def format_audit_record(tenant_id: str, event: dict) -> dict:
    # BUG: forgets tenant normalization and leaks token/secret/authorization keys
    return {"tenant_id": tenant_id, "event": dict(event)}
""")
    _w(ws / "service" / "handler.py", """def normalize_tenant(headers: dict) -> str:
    for k, v in headers.items():
        if k.lower() == "x-tenant-id":
            return v
    return ""

def execute_idempotent_post(client_fn) -> dict:
    # BUG: only tries once instead of retry_budget=4 on 429/503
    return client_fn()
""")
    _w(ws / "tests" / "test_public.py", """import unittest
from service.auth import sign_token, verify_token

class PublicServiceTests(unittest.TestCase):
    def test_sign_and_verify_primary(self):
        keys = [{"id": "k1", "secret": "s1", "revoked": False}]
        sig = sign_token("abc", "s1")
        self.assertTrue(verify_token("abc", sig, keys))
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
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
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "service" / "auth.py", """import hashlib, hmac

def sign_token(payload: str, primary_key: str) -> str:
    return "v2:" + hmac.new(primary_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()

def verify_token(payload: str, signature: str, keys: list[dict]) -> bool:
    if not signature.startswith("v2:"):
        return False
    for k in keys:
        if k.get("revoked"):
            continue
        expected = sign_token(payload, str(k["secret"]))
        if hmac.compare_digest(signature, expected):
            return True
    return False
""")
        _w(ws_dir / "service" / "audit.py", """def format_audit_record(tenant_id: str, event: dict) -> dict:
    tid = str(tenant_id or "").strip().lower()
    if not tid:
        raise ValueError("missing_tenant")
    clean = {}
    for k, v in event.items():
        if k.lower() in ("token", "secret", "authorization"):
            clean[k] = "[REDACTED]"
        else:
            clean[k] = v
    return {"tenant_id": tid, "event": clean}
""")
        _w(ws_dir / "service" / "handler.py", """def normalize_tenant(headers: dict) -> str:
    for k, v in headers.items():
        if k.lower() == "x-tenant-id":
            tid = str(v).strip().lower()
            if tid:
                return tid
    raise ValueError("missing_tenant")

def execute_idempotent_post(client_fn) -> dict:
    res = {}
    for _ in range(4):
        res = client_fn()
        if res.get("status") not in (429, 503):
            return res
    return res
""")

    return {"id": tid, "apply_ref": apply_ref}
