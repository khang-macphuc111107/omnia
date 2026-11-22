"""Verifier for atlas_02_impact_analysis (Axis 4: SWE-Atlas Impact Analysis)."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any


TASK_ID = "atlas_02_impact_analysis"

EXPECTED_REPO_FILES = [
    "README.md",
    "config/defaults.yaml",
    "config/env_prod.yaml",
    "config/tenants.json",
    "services/auth/config_loader.py",
    "services/auth/token_service.py",
    "services/billing/db/schema.sql",
    "services/billing/invoice_service.py",
    "services/billing/subscription_repo.py",
    "services/gateway/src/error_mapper.ts",
    "services/gateway/src/middleware.ts",
    "services/gateway/src/rate_limiter.ts",
    "services/gateway/src/server.ts",
    "services/worker/dlq_processor.py",
    "services/worker/reconciler.py",
    "shared/protocol/models.py",
    "shared/protocol/schema.json",
    "shared/protocol/types.ts",
]

VALID_CHANGE_IDS = {
    "tenant_tier_rename",
    "invoice_amount_split",
    "webhook_hmac_header_rename",
}

VALID_BOUNDARY_TYPES = {
    "jwt",
    "http_header",
    "http_json",
    "queue_json",
    "db_sql",
    "wire_dict",
    "schema",
}

REQUIRED_AFFECTED_FILES: dict[str, set[str]] = {
    "tenant_tier_rename": {
        "shared/protocol/schema.json",
        "shared/protocol/types.ts",
        "shared/protocol/models.py",
        "config/defaults.yaml",
        "config/env_prod.yaml",
        "config/tenants.json",
        "services/billing/db/schema.sql",
        "services/billing/subscription_repo.py",
        "services/gateway/src/middleware.ts",
        "services/gateway/src/rate_limiter.ts",
    },
    "invoice_amount_split": {
        "shared/protocol/schema.json",
        "shared/protocol/types.ts",
        "shared/protocol/models.py",
        "services/billing/db/schema.sql",
        "services/billing/invoice_service.py",
        "services/worker/dlq_processor.py",
        "services/worker/reconciler.py",
    },
    "webhook_hmac_header_rename": {
        "shared/protocol/schema.json",
        "shared/protocol/types.ts",
        "shared/protocol/models.py",
        "config/defaults.yaml",
        "config/env_prod.yaml",
        "services/billing/db/schema.sql",
        "services/gateway/src/middleware.ts",
        "services/gateway/src/error_mapper.ts",
        "services/billing/invoice_service.py",
        "services/worker/dlq_processor.py",
        "services/worker/reconciler.py",
    },
}

ALLOWED_AFFECTED_FILES: dict[str, set[str]] = {
    "tenant_tier_rename": REQUIRED_AFFECTED_FILES["tenant_tier_rename"]
    | {
        "services/gateway/src/server.ts",
        "services/auth/config_loader.py",
        "services/auth/token_service.py",
        "services/billing/invoice_service.py",
    },
    "invoice_amount_split": REQUIRED_AFFECTED_FILES["invoice_amount_split"]
    | {
        "services/gateway/src/server.ts",
    },
    "webhook_hmac_header_rename": REQUIRED_AFFECTED_FILES["webhook_hmac_header_rename"]
    | {
        "services/gateway/src/server.ts",
    },
}

# (trap_id, change_id, file, accepted_short_symbols, expected_start, expected_end, core_anchor_line)
REQUIRED_SILENT_TRAPS = [
    (
        "trap_gateway_tier_downgrade",
        "tenant_tier_rename",
        "services/gateway/src/middleware.ts",
        {"tenantTierContextMiddleware"},
        153,
        168,
        162,
    ),
    (
        "trap_gateway_rpm_fallback",
        "tenant_tier_rename",
        "services/gateway/src/rate_limiter.ts",
        {"getLimitForTier"},
        42,
        44,
        43,
    ),
    (
        "trap_billing_ledger_zero",
        "invoice_amount_split",
        "services/billing/invoice_service.py",
        {"build_ledger_summary"},
        161,
        171,
        169,
    ),
    (
        "trap_worker_dunning_zero",
        "invoice_amount_split",
        "services/worker/dlq_processor.py",
        {"format_dunning_alert"},
        136,
        142,
        140,
    ),
    (
        "trap_worker_reconciler_zero",
        "invoice_amount_split",
        "services/worker/reconciler.py",
        {"reconcile_invoice_totals"},
        74,
        101,
        83,
    ),
    (
        "trap_worker_hmac_bypass",
        "webhook_hmac_header_rename",
        "services/worker/reconciler.py",
        {"verify_callback_signature"},
        103,
        121,
        115,
    ),
]

# Bonus genuine silent-fallback locations allowed without precision penalty
BONUS_VALID_SILENT_TRAPS = [
    ("tenant_tier_rename", "services/billing/invoice_service.py", {"build_ledger_summary"}, 161, 171),
    ("tenant_tier_rename", "services/gateway/src/rate_limiter.ts", {"tierRateLimitMiddleware", "createTierRateLimitMiddleware"}, 78, 101),
]

# Required core serialization boundaries
# (boundary_id, file, accepted_short_symbols, expected_start, expected_end, required_change_ids)
REQUIRED_BOUNDARIES = [
    (
        "boundary_py_jwt_claims",
        "shared/protocol/models.py",
        {"AuthTokenClaims", "to_jwt_payload", "from_jwt_payload"},
        32,
        62,
        {"tenant_tier_rename"},
    ),
    (
        "boundary_py_invoice_wire",
        "shared/protocol/models.py",
        {"InvoiceRecord", "to_wire_dict", "from_wire_dict"},
        66,
        99,
        {"tenant_tier_rename", "invoice_amount_split"},
    ),
    (
        "boundary_ts_invoice_wire",
        "shared/protocol/types.ts",
        {"formatInvoiceWireJson", "serializeInvoiceForwardHeaders"},
        83,
        108,
        {"invoice_amount_split"},
    ),
    (
        "boundary_auth_jwt_encode",
        "services/auth/token_service.py",
        {"_encode_jwt", "issue_token_pair"},
        70,
        145,
        {"tenant_tier_rename"},
    ),
    (
        "boundary_billing_queue_envelope",
        "services/billing/invoice_service.py",
        {"serialize_invoice_event"},
        28,
        37,
        {"invoice_amount_split"},
    ),
    (
        "boundary_worker_webhook_replay",
        "services/worker/dlq_processor.py",
        {"build_webhook_replay_headers", "schedule_retry_or_dlq"},
        88,
        155,
        {"webhook_hmac_header_rename"},
    ),
]

EXPECTED_ROLLOUT_ORDER = ["billing_db", "worker", "billing", "gateway", "auth"]


def norm_path(p: Any) -> str:
    if not isinstance(p, str):
        return ""
    s = p.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return s


def short_symbol(sym: Any) -> str:
    if not isinstance(sym, str):
        return ""
    return sym.strip().split(".")[-1]


def check_repo_integrity(ws: Path) -> tuple[bool, str]:
    ref_ws = Path(__file__).resolve().parent / "workspace"
    missing = []
    modified = []
    for rel in EXPECTED_REPO_FILES:
        cur = ws / rel
        ref = ref_ws / rel
        if not cur.is_file():
            missing.append(rel)
            continue
        if ref.is_file():
            h_cur = hashlib.sha256(cur.read_bytes()).hexdigest()
            h_ref = hashlib.sha256(ref.read_bytes()).hexdigest()
            if h_cur != h_ref:
                modified.append(rel)
    if missing or modified:
        return False, f"missing={missing}, modified={modified}"
    return True, f"all {len(EXPECTED_REPO_FILES)} repository files intact"


def validate_citation_grounding(
    ws: Path,
    file_cache: dict[str, list[str]],
    entry: dict[str, Any],
    context_label: str,
) -> list[str]:
    errs: list[str] = []
    rel = norm_path(entry.get("file"))
    if not rel or rel not in file_cache:
        errs.append(f"{context_label}: non-existent file {entry.get('file')!r}")
        return errs
    lines = file_cache[rel]
    n_lines = len(lines)
    ls = entry.get("line_start")
    le = entry.get("line_end")
    if not isinstance(ls, int) or isinstance(ls, bool) or not isinstance(le, int) or isinstance(le, bool):
        errs.append(f"{context_label} ({rel}): non-integer line range [{ls!r}, {le!r}]")
        return errs
    if ls < 1 or le < ls or le > n_lines:
        errs.append(f"{context_label} ({rel}): line range [{ls}, {le}] out of bounds [1, {n_lines}]")
        return errs

    sym = entry.get("symbol")
    if not isinstance(sym, str) or not sym.strip():
        errs.append(f"{context_label} ({rel}): empty symbol")
        return errs
    full_text = "\n".join(lines)
    # Check that at least one meaningful identifier token from symbol exists in the file
    leaf = sym.strip().split(".")[-1].split(":")[-1].strip()
    if leaf and leaf not in full_text:
        errs.append(f"{context_label} ({rel}): symbol {sym!r} not found in file")
    return errs


def verify(ws: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def add_check(name: str, passed: bool, group: str, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    ok_repo, detail_repo = check_repo_integrity(ws)
    add_check("repo_files_unmodified", ok_repo, "pass_to_pass", detail_repo)

    file_cache: dict[str, list[str]] = {}
    for rel in EXPECTED_REPO_FILES:
        p = ws / rel
        if p.is_file():
            file_cache[rel] = p.read_text(encoding="utf-8").splitlines()

    report_path = ws / "impact_report.json"
    check_names = [
        "impact_report_json_valid",
        "no_hallucinated_citations",
        "change_tenant_tier_coverage",
        "change_invoice_amount_coverage",
        "change_webhook_hmac_coverage",
        "silent_failure_traps_exact",
        "serialization_boundaries_coverage",
        "zero_downtime_rollout_order",
    ]
    if not report_path.is_file():
        for cn in check_names:
            add_check(cn, False, "fail_to_pass", "impact_report.json not found")
        return build_report(checks)

    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top-level JSON must be an object")
        add_check("impact_report_json_valid", True, "fail_to_pass", "valid JSON object loaded")
    except Exception as exc:
        add_check("impact_report_json_valid", False, "fail_to_pass", f"invalid JSON: {exc}")
        for cn in check_names[1:]:
            add_check(cn, False, "fail_to_pass", "skipped: invalid JSON")
        return build_report(checks)

    # --- 1. Grounding / anti-hallucination audit across all sections ---
    hallucinations: list[str] = []
    bc = data.get("breaking_changes")
    if isinstance(bc, dict):
        for cid, block in bc.items():
            if cid not in VALID_CHANGE_IDS:
                hallucinations.append(f"unknown change_id {cid!r}")
                continue
            locs = block.get("affected_locations") if isinstance(block, dict) else None
            if isinstance(locs, list):
                for i, loc in enumerate(locs):
                    if isinstance(loc, dict):
                        hallucinations.extend(
                            validate_citation_grounding(ws, file_cache, loc, f"breaking_changes.{cid}[{i}]")
                        )
                    else:
                        hallucinations.append(f"breaking_changes.{cid}[{i}]: not object")

    traps = data.get("silent_failure_traps")
    if isinstance(traps, list):
        for i, t in enumerate(traps):
            if isinstance(t, dict):
                hallucinations.extend(
                    validate_citation_grounding(ws, file_cache, t, f"silent_failure_traps[{i}]")
                )
            else:
                hallucinations.append(f"silent_failure_traps[{i}]: not object")

    boundaries = data.get("serialization_boundaries")
    if isinstance(boundaries, list):
        for i, b in enumerate(boundaries):
            if isinstance(b, dict):
                hallucinations.extend(
                    validate_citation_grounding(ws, file_cache, b, f"serialization_boundaries[{i}]")
                )
            else:
                hallucinations.append(f"serialization_boundaries[{i}]: not object")

    add_check(
        "no_hallucinated_citations",
        not hallucinations,
        "fail_to_pass",
        "zero hallucinations" if not hallucinations else "; ".join(hallucinations[:8]),
    )

    # --- 2. Coverage & precision per breaking change ---
    change_check_map = [
        ("tenant_tier_rename", "change_tenant_tier_coverage"),
        ("invoice_amount_split", "change_invoice_amount_coverage"),
        ("webhook_hmac_header_rename", "change_webhook_hmac_coverage"),
    ]
    for cid, check_name in change_check_map:
        errs: list[str] = []
        block = bc.get(cid) if isinstance(bc, dict) else None
        locs = block.get("affected_locations") if isinstance(block, dict) else None
        if not isinstance(locs, list) or not locs:
            errs.append(f"missing affected_locations for {cid}")
        else:
            cited_files = {norm_path(item.get("file")) for item in locs if isinstance(item, dict)}
            missing = sorted(REQUIRED_AFFECTED_FILES[cid] - cited_files)
            unrelated = sorted(cited_files - ALLOWED_AFFECTED_FILES[cid])
            if missing:
                errs.append(f"missing required files: {missing}")
            if unrelated:
                errs.append(f"unrelated/false-positive files: {unrelated}")
        add_check(check_name, not errs, "fail_to_pass", "OK" if not errs else "; ".join(errs))

    # --- 3. Silent-failure traps (exact recall + precision) ---
    trap_errs: list[str] = []
    if not isinstance(traps, list) or not traps:
        trap_errs.append("silent_failure_traps missing or empty")
    else:
        matched_required: set[str] = set()
        false_positives: list[str] = []
        for idx, t in enumerate(traps):
            if not isinstance(t, dict):
                trap_errs.append(f"trap[{idx}] not object")
                continue
            cid = t.get("change_id")
            f = norm_path(t.get("file"))
            sym = short_symbol(t.get("symbol"))
            ls = t.get("line_start")
            le = t.get("line_end")
            if cid not in VALID_CHANGE_IDS:
                false_positives.append(f"trap[{idx}] invalid change_id={cid!r}")
                continue
            if not isinstance(ls, int) or not isinstance(le, int):
                false_positives.append(f"trap[{idx}] bad line range")
                continue

            hit_any = False
            for tid, r_cid, r_file, r_syms, r_s, r_e, r_anchor in REQUIRED_SILENT_TRAPS:
                if (
                    cid == r_cid
                    and f == r_file
                    and sym in r_syms
                    and ls <= r_anchor <= le
                    and (le - ls + 1) <= (r_e - r_s + 1) + 15
                ):
                    matched_required.add(tid)
                    hit_any = True
                    break
            if not hit_any:
                for b_cid, b_file, b_syms, b_s, b_e in BONUS_VALID_SILENT_TRAPS:
                    if cid == b_cid and f == b_file and sym in b_syms and not (le < b_s or ls > b_e):
                        hit_any = True
                        break
            if not hit_any:
                false_positives.append(f"{cid}:{f}:{t.get('symbol')}@L{ls}-{le}")

        missing_traps = sorted({x[0] for x in REQUIRED_SILENT_TRAPS} - matched_required)
        if missing_traps:
            trap_errs.append(f"missing silent traps: {missing_traps}")
        if false_positives:
            trap_errs.append(f"false-positive/mis-cited traps: {false_positives}")
    add_check("silent_failure_traps_exact", not trap_errs, "fail_to_pass", "all 6 silent traps verified" if not trap_errs else "; ".join(trap_errs))

    # --- 4. Serialization boundaries ---
    b_errs: list[str] = []
    if not isinstance(boundaries, list) or not boundaries:
        b_errs.append("serialization_boundaries missing or empty")
    else:
        matched_boundaries: set[str] = set()
        for idx, b in enumerate(boundaries):
            if not isinstance(b, dict):
                b_errs.append(f"boundary[{idx}] not object")
                continue
            btype = b.get("boundary_type")
            if btype not in VALID_BOUNDARY_TYPES:
                b_errs.append(f"boundary[{idx}] invalid boundary_type={btype!r}")
            ac = b.get("affected_changes")
            if not isinstance(ac, list) or not ac or not set(ac).issubset(VALID_CHANGE_IDS):
                b_errs.append(f"boundary[{idx}] invalid affected_changes={ac!r}")
                continue
            f = norm_path(b.get("file"))
            sym = short_symbol(b.get("symbol"))
            ls = b.get("line_start")
            le = b.get("line_end")
            if not isinstance(ls, int) or not isinstance(le, int):
                continue
            for bid, r_file, r_syms, r_s, r_e, r_cids in REQUIRED_BOUNDARIES:
                if (
                    f == r_file
                    and sym in r_syms
                    and not (le < r_s or ls > r_e)
                    and r_cids.issubset(set(ac))
                ):
                    matched_boundaries.add(bid)
        missing_b = sorted({x[0] for x in REQUIRED_BOUNDARIES} - matched_boundaries)
        if missing_b:
            b_errs.append(f"missing required boundaries: {missing_b}")
    add_check("serialization_boundaries_coverage", not b_errs, "fail_to_pass", "all 6 core boundaries verified" if not b_errs else "; ".join(b_errs))

    # --- 5. Zero-downtime rollout order & rationale ---
    r_errs: list[str] = []
    order = data.get("zero_downtime_rollout_order")
    if order != EXPECTED_ROLLOUT_ORDER:
        r_errs.append(f"got {order!r}, expected {EXPECTED_ROLLOUT_ORDER!r}")
    rationale = data.get("rollout_rationale")
    if not isinstance(rationale, list) or len(rationale) < 4:
        r_errs.append("rollout_rationale must include at least 4 directed dependency edges")
    else:
        pos = {unit: i for i, unit in enumerate(EXPECTED_ROLLOUT_ORDER)}
        valid_edges: set[tuple[str, str]] = set()
        for idx, edge in enumerate(rationale):
            if not isinstance(edge, dict):
                r_errs.append(f"rationale[{idx}] not object")
                continue
            bef = edge.get("before")
            aft = edge.get("after")
            reason = edge.get("reason")
            if bef not in pos or aft not in pos:
                r_errs.append(f"rationale[{idx}] unknown unit ({bef!r} -> {aft!r})")
            elif pos[bef] >= pos[aft]:
                r_errs.append(f"rationale[{idx}] inverted edge ({bef!r} -> {aft!r})")
            elif not isinstance(reason, str) or len(reason.strip()) < 10:
                r_errs.append(f"rationale[{idx}] missing meaningful reason")
            else:
                valid_edges.add((bef, aft))
        required_chain = [
            ("billing_db", "worker"),
            ("worker", "billing"),
            ("billing", "gateway"),
            ("gateway", "auth"),
        ]
        missing_edges = [e for e in required_chain if e not in valid_edges]
        if missing_edges:
            r_errs.append(f"missing core dependency rationale edges: {missing_edges}")
    add_check("zero_downtime_rollout_order", not r_errs, "fail_to_pass", "OK" if not r_errs else "; ".join(r_errs))

    return build_report(checks)


def build_report(checks: list[dict[str, Any]], error: str | None = None) -> dict[str, Any]:
    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    passed_count = sum(1 for c in checks if c["passed"])
    all_passed = error is None and total > 0 and passed_count == total
    score = round(passed_count / total, 4) if total > 0 and error is None else 0.0
    return {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": score,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Workspace directory path")
    args = parser.parse_args()
    try:
        report = verify(Path(args.workspace).resolve())
    except Exception as exc:
        report = build_report([], error=f"verifier exception: {exc}")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
