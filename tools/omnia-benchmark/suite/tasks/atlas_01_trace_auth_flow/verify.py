"""Verifier for atlas_01_trace_auth_flow (Axis 4: SWE-Atlas Codebase Q&A)."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any


TASK_ID = "atlas_01_trace_auth_flow"

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


def norm_path(p: Any) -> str:
    if not isinstance(p, str):
        return ""
    s = p.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return s


def norm_symbol(sym: Any) -> str:
    if not isinstance(sym, str):
        return ""
    return sym.strip()


def symbol_matches(actual: Any, accepted: set[str]) -> bool:
    s = norm_symbol(actual)
    if not s:
        return False
    if s in accepted:
        return True
    short = s.split(".")[-1]
    return short in {a.split(".")[-1] for a in accepted}


def get_file_line_count(ws: Path, rel_path: str) -> int | None:
    p = ws / rel_path
    if not p.is_file():
        return None
    return len(p.read_text(encoding="utf-8").splitlines())


def valid_line_range(
    ws: Path,
    rel_path: str,
    start: Any,
    end: Any,
    expected_start: int,
    expected_end: int,
    anchor_lines: list[int] | None = None,
    max_extra_span: int = 20,
) -> tuple[bool, str]:
    if not isinstance(start, int) or isinstance(start, bool):
        return False, f"line_start not int: {start!r}"
    if not isinstance(end, int) or isinstance(end, bool):
        return False, f"line_end not int: {end!r}"
    max_lines = get_file_line_count(ws, rel_path)
    if max_lines is None:
        return False, f"file missing: {rel_path}"
    if start < 1 or end < start or end > max_lines:
        return False, f"range [{start}, {end}] out of bounds [1, {max_lines}]"
    # Must overlap expected range
    if end < expected_start or start > expected_end:
        return False, f"range [{start}, {end}] does not overlap expected [{expected_start}, {expected_end}]"
    # Prevent full-file cheating
    expected_span = max(1, expected_end - expected_start + 1)
    cited_span = end - start + 1
    if cited_span > expected_span + max_extra_span:
        return False, f"range [{start}, {end}] too wide (span {cited_span} > {expected_span + max_extra_span})"
    if anchor_lines:
        missing = [ln for ln in anchor_lines if not (start <= ln <= end)]
        if missing:
            return False, f"range [{start}, {end}] misses key lines {missing}"
    return True, f"range [{start}, {end}] OK"


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


def verify(ws: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def add_check(name: str, passed: bool, group: str, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    # Pass-to-pass: repo integrity
    ok_repo, detail_repo = check_repo_integrity(ws)
    add_check("repo_files_unmodified", ok_repo, "pass_to_pass", detail_repo)

    ans_path = ws / "answer.json"
    if not ans_path.is_file():
        add_check("answer_json_exists", False, "fail_to_pass", "answer.json not found")
        for name in [
            "q1_gateway_middleware_order",
            "q2_token_refresh_race",
            "q3_redis_ttl_precedence",
            "q4_http_error_mapping",
            "q5_dlq_retry_backoff",
            "q6_subscription_state_mutators",
        ]:
            add_check(name, False, "fail_to_pass", "skipped: answer.json missing")
        return build_report(checks)

    try:
        data = json.loads(ans_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top-level JSON must be an object")
        add_check("answer_json_exists", True, "fail_to_pass", "valid JSON object loaded")
    except Exception as exc:
        add_check("answer_json_exists", False, "fail_to_pass", f"invalid JSON: {exc}")
        for name in [
            "q1_gateway_middleware_order",
            "q2_token_refresh_race",
            "q3_redis_ttl_precedence",
            "q4_http_error_mapping",
            "q5_dlq_retry_backoff",
            "q6_subscription_state_mutators",
        ]:
            add_check(name, False, "fail_to_pass", "skipped: invalid JSON")
        return build_report(checks)

    # --- Q1: gateway_middleware_order ---
    q1 = data.get("gateway_middleware_order")
    q1_errs: list[str] = []
    if not isinstance(q1, dict):
        q1_errs.append("missing object")
    else:
        ep = q1.get("registration_entrypoint")
        if not isinstance(ep, dict):
            q1_errs.append("missing registration_entrypoint")
        else:
            ep_file = norm_path(ep.get("file"))
            if ep_file != "services/gateway/src/server.ts":
                q1_errs.append(f"bad entrypoint file: {ep_file!r}")
            if not symbol_matches(ep.get("symbol"), {"registerMiddlewarePipeline", "createProductionGateway"}):
                q1_errs.append(f"bad entrypoint symbol: {ep.get('symbol')!r}")
            else:
                if norm_symbol(ep.get("symbol")).endswith("createProductionGateway"):
                    ok_r, msg_r = valid_line_range(ws, ep_file, ep.get("line_start"), ep.get("line_end"), 113, 131, [129])
                else:
                    ok_r, msg_r = valid_line_range(ws, ep_file, ep.get("line_start"), ep.get("line_end"), 75, 96, [83, 86, 92, 95])
                if not ok_r:
                    q1_errs.append(f"entrypoint lines: {msg_r}")

        mws = q1.get("middlewares")
        expected_mws = [
            ({"requestIdMiddleware"}, "services/gateway/src/middleware.ts", 33, 47, [33]),
            ({"hmacSignatureMiddleware", "createHmacSignatureMiddleware"}, "services/gateway/src/middleware.ts", 49, 96, [52, 60]),
            ({"jwtAuthMiddleware", "createJwtAuthMiddleware"}, "services/gateway/src/middleware.ts", 98, 151, [101, 121]),
            ({"tenantTierContextMiddleware"}, "services/gateway/src/middleware.ts", 153, 168, [153, 162]),
            ({"tierRateLimitMiddleware", "createTierRateLimitMiddleware"}, "services/gateway/src/rate_limiter.ts", 78, 101, [81, 88]),
            ({"upstreamProxyMiddleware", "createUpstreamProxyMiddleware"}, "services/gateway/src/error_mapper.ts", 126, 142, [129, 140]),
        ]
        if not isinstance(mws, list) or len(mws) != 6:
            q1_errs.append(f"expected 6 middlewares, got {len(mws) if isinstance(mws, list) else type(mws).__name__}")
        else:
            for idx, (item, (acc_names, exp_file, exp_s, exp_e, anchors)) in enumerate(zip(mws, expected_mws), 1):
                if not isinstance(item, dict):
                    q1_errs.append(f"mw[{idx}] not object")
                    continue
                if not symbol_matches(item.get("name"), acc_names):
                    q1_errs.append(f"mw[{idx}] name={item.get('name')!r}, expected one of {sorted(acc_names)}")
                f = norm_path(item.get("file"))
                if f != exp_file:
                    q1_errs.append(f"mw[{idx}] file={f!r}, expected {exp_file!r}")
                else:
                    ok_r, msg_r = valid_line_range(ws, f, item.get("line_start"), item.get("line_end"), exp_s, exp_e, anchors)
                    if not ok_r:
                        q1_errs.append(f"mw[{idx}] lines: {msg_r}")
    add_check("q1_gateway_middleware_order", not q1_errs, "fail_to_pass", "OK" if not q1_errs else "; ".join(q1_errs))

    # --- Q2: token_refresh_race ---
    q2 = data.get("token_refresh_race")
    q2_errs: list[str] = []
    if not isinstance(q2, dict):
        q2_errs.append("missing object")
    else:
        f = norm_path(q2.get("file"))
        if f != "services/auth/token_service.py":
            q2_errs.append(f"file={f!r}")
        if not symbol_matches(q2.get("symbol"), {"TokenService.refresh_access_token", "refresh_access_token"}):
            q2_errs.append(f"symbol={q2.get('symbol')!r}")
        ok_r, msg_r = valid_line_range(ws, "services/auth/token_service.py", q2.get("line_start"), q2.get("line_end"), 147, 168, [150, 167])
        if not ok_r:
            q2_errs.append(msg_r)
        if q2.get("redis_read_line") != 150:
            q2_errs.append(f"redis_read_line={q2.get('redis_read_line')!r}, expected 150")
        if q2.get("redis_mark_used_line") != 167:
            q2_errs.append(f"redis_mark_used_line={q2.get('redis_mark_used_line')!r}, expected 167")
        if q2.get("root_cause") != "non_atomic_check_then_act":
            q2_errs.append(f"root_cause={q2.get('root_cause')!r}")
    add_check("q2_token_refresh_race", not q2_errs, "fail_to_pass", "OK" if not q2_errs else "; ".join(q2_errs))

    # --- Q3: redis_ttl_precedence ---
    q3 = data.get("redis_ttl_precedence")
    q3_errs: list[str] = []
    if not isinstance(q3, dict):
        q3_errs.append("missing object")
    else:
        if q3.get("precedence_order") != ["defaults", "env", "tenant_override"]:
            q3_errs.append(f"precedence_order={q3.get('precedence_order')!r}")
        cfiles = q3.get("config_files")
        expected_cfiles = {
            "defaults": "config/defaults.yaml",
            "env_prod": "config/env_prod.yaml",
            "tenants": "config/tenants.json",
        }
        if not isinstance(cfiles, dict):
            q3_errs.append("config_files missing")
        else:
            for k, exp_p in expected_cfiles.items():
                if norm_path(cfiles.get(k)) != exp_p:
                    q3_errs.append(f"config_files.{k}={cfiles.get(k)!r}, expected {exp_p!r}")
        res = q3.get("resolver")
        if not isinstance(res, dict):
            q3_errs.append("resolver missing")
        else:
            rf = norm_path(res.get("file"))
            if rf != "services/auth/config_loader.py":
                q3_errs.append(f"resolver.file={rf!r}")
            if not symbol_matches(res.get("symbol"), {"AuthConfigLoader.resolve_session_redis_ttl", "resolve_session_redis_ttl"}):
                q3_errs.append(f"resolver.symbol={res.get('symbol')!r}")
            ok_r, msg_r = valid_line_range(ws, "services/auth/config_loader.py", res.get("line_start"), res.get("line_end"), 103, 122, [111, 118, 122])
            if not ok_r:
                q3_errs.append(f"resolver lines: {msg_r}")
        bounds = q3.get("prod_clamp_bounds")
        if bounds != {"min_ttl_sec": 300, "max_ttl_sec": 3600}:
            q3_errs.append(f"prod_clamp_bounds={bounds!r}, expected min=300 max=3600")
        eff = q3.get("effective_prod_ttl_sec")
        expected_eff = {
            "tnt_acme": 900,
            "tnt_globex": 3600,
            "tnt_initech": 1800,
            "tnt_umbrella": 300,
        }
        if eff != expected_eff:
            q3_errs.append(f"effective_prod_ttl_sec={eff!r}, expected {expected_eff!r}")
    add_check("q3_redis_ttl_precedence", not q3_errs, "fail_to_pass", "OK" if not q3_errs else "; ".join(q3_errs))

    # --- Q4: http_error_mapping ---
    q4 = data.get("http_error_mapping")
    q4_errs: list[str] = []
    if not isinstance(q4, dict):
        q4_errs.append("missing object")
    else:
        f = norm_path(q4.get("file"))
        if f != "services/gateway/src/error_mapper.ts":
            q4_errs.append(f"file={f!r}")
        if not symbol_matches(q4.get("symbol"), {"mapUpstreamErrorToHttp"}):
            q4_errs.append(f"symbol={q4.get('symbol')!r}")
        ok_r, msg_r = valid_line_range(ws, "services/gateway/src/error_mapper.ts", q4.get("line_start"), q4.get("line_end"), 80, 124, [86, 88, 101, 103])
        if not ok_r:
            q4_errs.append(msg_r)
        b429 = q4.get("branch_429")
        if not isinstance(b429, dict):
            q4_errs.append("branch_429 missing")
        else:
            ok_b, msg_b = valid_line_range(ws, "services/gateway/src/error_mapper.ts", b429.get("line_start"), b429.get("line_end"), 86, 99, [86, 88], max_extra_span=10)
            if not ok_b:
                q4_errs.append(f"branch_429: {msg_b}")
        b503 = q4.get("branch_503")
        if not isinstance(b503, dict):
            q4_errs.append("branch_503 missing")
        else:
            ok_b, msg_b = valid_line_range(ws, "services/gateway/src/error_mapper.ts", b503.get("line_start"), b503.get("line_end"), 101, 114, [101, 103], max_extra_span=10)
            if not ok_b:
                q4_errs.append(f"branch_503: {msg_b}")
        c429 = q4.get("codes_429")
        c503 = q4.get("codes_503")
        if not isinstance(c429, list) or set(c429) != {"TENANT_QUOTA_EXCEEDED", "BILLING_RATE_LIMITED"}:
            q4_errs.append(f"codes_429={c429!r}")
        if not isinstance(c503, list) or set(c503) != {"LIMITER_BACKEND_DOWN", "CIRCUIT_BREAKER_OPEN", "AUTH_UPSTREAM_TIMEOUT"}:
            q4_errs.append(f"codes_503={c503!r}")
    add_check("q4_http_error_mapping", not q4_errs, "fail_to_pass", "OK" if not q4_errs else "; ".join(q4_errs))

    # --- Q5: dlq_retry_backoff ---
    q5 = data.get("dlq_retry_backoff")
    q5_errs: list[str] = []
    if not isinstance(q5, dict):
        q5_errs.append("missing object")
    else:
        fl = q5.get("formula_location")
        if not isinstance(fl, dict):
            q5_errs.append("formula_location missing")
        else:
            ff = norm_path(fl.get("file"))
            if ff != "services/worker/dlq_processor.py":
                q5_errs.append(f"formula_location.file={ff!r}")
            if not symbol_matches(fl.get("symbol"), {"compute_retry_delay_sec"}):
                q5_errs.append(f"formula_location.symbol={fl.get('symbol')!r}")
            ok_r, msg_r = valid_line_range(ws, "services/worker/dlq_processor.py", fl.get("line_start"), fl.get("line_end"), 47, 71, [65, 66])
            if not ok_r:
                q5_errs.append(f"formula_location lines: {msg_r}")
        cfiles = q5.get("config_files")
        if not isinstance(cfiles, list) or {norm_path(x) for x in cfiles} != {"config/defaults.yaml", "config/env_prod.yaml"}:
            q5_errs.append(f"config_files={cfiles!r}")
        pp = q5.get("prod_params")
        if not isinstance(pp, dict):
            q5_errs.append("prod_params missing")
        else:
            expected_pp = {
                "base_delay_sec": 10,
                "backoff_multiplier": 2,
                "max_delay_sec": 600,
                "max_attempts": 5,
            }
            for k, v in expected_pp.items():
                if pp.get(k) != v:
                    q5_errs.append(f"prod_params.{k}={pp.get(k)!r}, expected {v!r}")
            jp = pp.get("jitter_pct")
            if not isinstance(jp, (int, float)) or abs(float(jp) - 0.15) > 1e-9:
                q5_errs.append(f"prod_params.jitter_pct={jp!r}, expected 0.15")
        delays = q5.get("retry_delays_before_dlq_sec")
        if not isinstance(delays, list) or [float(x) for x in delays if isinstance(x, (int, float))] != [10.0, 20.0, 40.0, 80.0] or len(delays) != 4:
            q5_errs.append(f"retry_delays_before_dlq_sec={delays!r}, expected [10, 20, 40, 80]")
        if q5.get("dlq_key") != "dlq:billing_events":
            q5_errs.append(f"dlq_key={q5.get('dlq_key')!r}")
    add_check("q5_dlq_retry_backoff", not q5_errs, "fail_to_pass", "OK" if not q5_errs else "; ".join(q5_errs))

    # --- Q6: subscription_state_mutators ---
    q6 = data.get("subscription_state_mutators")
    q6_errs: list[str] = []
    expected_mutators = {
        "services/billing/subscription_repo.py": {
            "create_subscription": (102, 131, [112, 113]),
            "transition_state": (133, 171, [152, 153]),
        },
        "services/billing/invoice_service.py": {
            "freeze_on_chargeback": (98, 122, [103, 104]),
        },
        "services/worker/dlq_processor.py": {
            "handle_exhausted_dunning_job": (122, 134, [129, 130]),
        },
        "services/worker/reconciler.py": {
            "expire_overdue_subscriptions": (47, 60, [52, 53]),
        },
    }
    if not isinstance(q6, list):
        q6_errs.append("missing list")
    else:
        by_file: dict[str, dict[str, Any]] = {}
        for entry in q6:
            if not isinstance(entry, dict):
                q6_errs.append("non-object entry")
                continue
            f = norm_path(entry.get("file"))
            if f in by_file:
                q6_errs.append(f"duplicate file entry: {f}")
            by_file[f] = entry

        actual_files = set(by_file.keys())
        expected_files = set(expected_mutators.keys())
        if actual_files != expected_files:
            missing_f = sorted(expected_files - actual_files)
            extra_f = sorted(actual_files - expected_files)
            q6_errs.append(f"file set mismatch: missing={missing_f}, extra={extra_f}")
        else:
            for f, exp_syms in expected_mutators.items():
                entry = by_file[f]
                syms = entry.get("symbols")
                if not isinstance(syms, list):
                    q6_errs.append(f"{f}: symbols not list")
                    continue
                short_syms = {norm_symbol(s).split(".")[-1] for s in syms if isinstance(s, str)}
                if short_syms != set(exp_syms.keys()):
                    q6_errs.append(f"{f}: symbols={sorted(short_syms)}, expected={sorted(exp_syms.keys())}")
                lrs = entry.get("line_ranges")
                if not isinstance(lrs, list):
                    q6_errs.append(f"{f}: line_ranges not list")
                    continue
                lr_by_short: dict[str, dict[str, Any]] = {}
                for lr in lrs:
                    if isinstance(lr, dict):
                        lr_by_short[norm_symbol(lr.get("symbol")).split(".")[-1]] = lr
                for sym_short, (es, ee, anchors) in exp_syms.items():
                    lr = lr_by_short.get(sym_short)
                    if not lr:
                        q6_errs.append(f"{f}: missing line_range for {sym_short}")
                    else:
                        ok_r, msg_r = valid_line_range(ws, f, lr.get("line_start"), lr.get("line_end"), es, ee, anchors)
                        if not ok_r:
                            q6_errs.append(f"{f}.{sym_short}: {msg_r}")
    add_check("q6_subscription_state_mutators", not q6_errs, "fail_to_pass", "OK" if not q6_errs else "; ".join(q6_errs))

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
