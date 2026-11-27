"""Suite v5 Multi-Metric Statistical Scorer (11 capability axes / 33 tasks + 7 harnesses).

Computes all required Wave 3 leaderboard metrics from runner_v5 records:
  - Pass@1 + Wilson 95% CI, Mean Score + Bootstrap 95% CI, Exact McNemar p vs Omnia
  - Wire TTFT (median/p95), Active Decode TPS (median), E2E TPS (median)
  - Tokens / Solved, Normalized USD Cost / Solved, KV Cache Hit %
  - Tool Error Rate %, Edit Error Rate %, Doom-Loop %, Zero-Intervention %
  - Peak RSS (median/max MB), Peak Job Memory (max MB), CPU Time (median s)
  - Cold Start ms, Binary Size MB (from installed_manifest / microbench / stat), Leaks (must be 0)
  - Composite Capability `C_cap_v5` (Axes 1..7, 11, 12, 13, 14) & `I_14` composite
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from cleanroom import load_installed_manifest
import scorer_v4

wilson_ci = scorer_v4.wilson_ci
mcnemar_exact_p = scorer_v4.mcnemar_exact_p

V5_AXIS_NAMES: Dict[int, str] = {
    **scorer_v4.AXIS_NAMES,
    12: "Long-Horizon Memory & Context Compaction",
    13: "MCP & PTC Code Mode Multi-Tool Composition",
    14: "Multi-Agent Worktree Refactoring",
}
V5_CAPABILITY_AXES: Tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14)

# Normalized reference pricing in USD per 1M tokens for apples-to-apples harness cost/solved
MODEL_USD_PER_1M: Dict[str, Dict[str, float]] = {
    "gpt-6.2-sol": {"input": 2.50, "cache_read": 0.25, "output": 10.00},
    "gpt-6.1-terra": {"input": 3.00, "cache_read": 0.30, "output": 12.00},
    "gpt-6-luna": {"input": 0.40, "cache_read": 0.04, "output": 1.60},
    "claude-sonnet-5-5": {"input": 3.00, "cache_read": 0.30, "output": 15.00},
    "claude-opus-5-5": {"input": 15.00, "cache_read": 1.50, "output": 75.00},
    "default": {"input": 3.00, "cache_read": 0.30, "output": 15.00},
}


def estimate_record_cost_usd(rec: Dict[str, Any]) -> Optional[float]:
    """Compute normalized USD spend from canonical wire uncached/cache_read/output tokens."""
    if rec.get("wire_requests_missing_usage"):
        return None
    uncached = rec.get("wire_uncached_input")
    out_tok = rec.get("wire_output_tokens")
    if uncached is None or out_tok is None:
        return None
    cache_read = rec.get("wire_cache_read") or 0
    cache_write = rec.get("wire_cache_write") or 0
    rates = MODEL_USD_PER_1M.get(str(rec.get("model") or ""), MODEL_USD_PER_1M["default"])
    in_billable = max(0, int(uncached)) + max(0, int(cache_write)) * 1.25
    cost = (in_billable * rates["input"] + max(0, int(cache_read)) * rates["cache_read"] + max(0, int(out_tok)) * rates["output"]) / 1_000_000.0
    return round(cost, 6)


def _median(vals: Iterable[float]) -> Optional[float]:
    clean = [float(v) for v in vals if v is not None and not math.isnan(float(v))]
    return round(statistics.median(clean), 3) if clean else None


def summarize_harness_v5(
    harness: str,
    recs: List[Dict[str, Any]],
    mb: Optional[Dict[str, Any]] = None,
    installed: Optional[Dict[str, Any]] = None,
    *,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    """Summarize one harness across all 11 Suite v5 axes and every telemetry dimension."""
    if harness == "agy":
        raise ValueError("Harness 'agy' is strictly excluded from Suite v5 scoring")
    mb = mb or {}
    installed = installed or {}
    norm_recs: List[Dict[str, Any]] = []
    for r in recs:
        nr = dict(r)
        if "htmustc_only_ok" not in nr:
            nr["htmustc_only_ok"] = bool(nr.get("htmustc_only_verified")) or (
                not nr.get("non_loopback_sockets") and (nr.get("wire_requests") or 0) >= 1
            )
        norm_recs.append(nr)
    base = scorer_v4.summarize_harness(harness, norm_recs, mb)

    n = len(recs)
    scores = [float(r.get("score") or 0.0) for r in recs]
    mean_score = round(sum(scores) / n, 4) if n else 0.0
    score_ci = scorer_v4.bootstrap_ci(scores) if scores else [0.0, 0.0]

    # Axis scores across all 11 capability axes (pass/score average per axis)
    by_axis: Dict[int, List[float]] = defaultdict(list)
    for r in recs:
        ax = int(r.get("axis") or 0)
        if ax in V5_CAPABILITY_AXES:
            by_axis[ax].append(100.0 if r.get("passed") else 0.0)
    axis_pass_v5 = {ax: round(sum(vals) / len(vals), 2) for ax, vals in sorted(by_axis.items()) if vals}
    c_cap_v5 = round(sum(axis_pass_v5.values()) / len(axis_pass_v5), 2) if axis_pass_v5 else 0.0
    i14_composite = round(
        0.70 * c_cap_v5 + 0.10 * float(base["a8_speed"]) + 0.10 * float(base["a9_econ"]) + 0.10 * float(base["a10_footprint"]),
        2,
    )

    solved = sum(1 for r in recs if r.get("passed"))
    solved_recs = [r for r in recs if r.get("passed")]
    cost_vals = [estimate_record_cost_usd(r) for r in recs]
    all_costs_known = bool(recs) and all(c is not None for c in cost_vals)
    total_cost_usd = sum(c for c in cost_vals if c is not None)
    cost_per_solved_usd = round(total_cost_usd / solved, 5) if (solved > 0 and all_costs_known) else None

    e2e_tps_vals = [
        (r.get("e2e_tokens_per_sec") if r.get("e2e_tokens_per_sec") is not None else ((r.get("wire_output_tokens") or 0) / r["wall_s"]))
        for r in recs if (r.get("wall_s") or 0) > 0 and (r.get("wire_output_tokens") or 0) > 0
    ]
    active_tps_vals = [r.get("wire_gen_tokens_per_sec") for r in recs if r.get("wire_gen_tokens_per_sec") is not None]
    rss_vals = [r.get("peak_rss_mb") if r.get("peak_rss_mb") is not None else r.get("peak_harness_rss_mb") for r in recs]
    job_vals = [r.get("peak_job_memory_mb") for r in recs]
    cpu_vals = [r.get("total_cpu_time_s") for r in recs]
    tot_tc = sum(int(r.get("tool_call_count") or 0) for r in recs)
    tot_te = sum(int(r.get("tool_error_count") or 0) for r in recs)
    tot_ec = sum(int(r.get("edit_call_count") or 0) for r in recs)
    tot_ee = sum(int(r.get("edit_error_count") or 0) for r in recs)
    tot_in = sum(int(r.get("wire_prompt_total") or 0) for r in recs)
    tot_cr = sum(int(r.get("wire_cache_read") or 0) for r in recs)
    leaks_total = sum(len(r.get("non_loopback_sockets") or []) for r in recs)

    inst_entry = ((installed.get("harnesses") or {}).get(harness) or {})
    bin_size_mb = inst_entry.get("size_mb")
    if harness == "omnia" and omnia_bin is not None and omnia_bin.exists():
        bin_size_mb = round(omnia_bin.stat().st_size / (1024 * 1024), 2)

    mb_entry = ((mb.get("harnesses") or {}).get(harness) or {})
    cold_start_ms = None
    ver_samples = (mb_entry.get("version_startup") or mb_entry.get("version_ms")) if isinstance(mb_entry, dict) else None
    if isinstance(ver_samples, dict) and ver_samples.get("median_ms") is not None:
        cold_start_ms = round(float(ver_samples["median_ms"]), 2)
    elif base.get("cold_start_version_ms") is not None:
        cold_start_ms = base["cold_start_version_ms"]

    wire_ttft_vals = [r.get("wire_first_ttft_ms") for r in norm_recs if r.get("wire_first_ttft_ms") is not None]
    wire_ttft_med = _median(wire_ttft_vals) if base.get("median_wire_ttft_ms") is None else base.get("median_wire_ttft_ms")

    all_tok_known = bool(norm_recs) and all(
        r.get("wire_total_tokens") is not None and not r.get("wire_requests_missing_usage") for r in norm_recs
    )
    tok_per_solved = base.get("tokens_per_solved")
    if tok_per_solved is None and solved > 0 and all_tok_known:
        tok_per_solved = round(sum(int(r.get("wire_total_tokens") or 0) for r in norm_recs) / solved, 1)

    return {
        **base,
        "median_wire_ttft_ms": wire_ttft_med,
        "tokens_per_solved": tok_per_solved,
        "axis_scores_v5": axis_pass_v5,
        "axes_covered": len(axis_pass_v5),
        "c_cap_v5": c_cap_v5,
        "i14_composite": i14_composite,
        "mean_score": mean_score,
        "mean_score_bootstrap_95ci": [round(score_ci[0], 4), round(score_ci[1], 4)],
        "solved_count": solved,
        "median_active_tps": _median(active_tps_vals),
        "median_e2e_tps": _median(e2e_tps_vals),
        "cost_per_solved_usd": cost_per_solved_usd,
        "total_cost_usd": round(total_cost_usd, 5) if all_costs_known else None,
        "pooled_kv_cache_hit_pct": round(100.0 * tot_cr / tot_in, 2) if tot_in > 0 else 0.0,
        "pooled_tool_error_rate_pct": round(100.0 * tot_te / tot_tc, 2) if tot_tc > 0 else 0.0,
        "pooled_edit_error_rate_pct": round(100.0 * tot_ee / tot_ec, 2) if tot_ec > 0 else 0.0,
        "peak_rss_mb_median": _median(rss_vals),
        "peak_rss_mb_max": round(max(float(v) for v in rss_vals if v is not None), 2) if any(v is not None for v in rss_vals) else None,
        "peak_job_mem_mb_max": round(max(float(v) for v in job_vals if v is not None), 2) if any(v is not None for v in job_vals) else None,
        "median_cpu_s": _median(cpu_vals),
        "cold_start_ms": cold_start_ms,
        "binary_size_mb": round(float(bin_size_mb), 2) if bin_size_mb is not None else base.get("disk_mb"),
        "network_leaks_total": leaks_total,
        "zero_leaks_ok": leaks_total == 0,
        "solved_median_wall_s": _median(r.get("wall_s") for r in solved_recs),
    }


def score_suite_v5(
    records: List[Dict[str, Any]],
    *,
    microbench_path: Optional[Path] = None,
    installed_manifest_path: Optional[Path] = None,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    """Score a complete Suite v5 records list across all present harnesses + McNemar vs omnia."""
    mb = json.loads(microbench_path.read_text(encoding="utf-8")) if (microbench_path and microbench_path.exists()) else {}
    if installed_manifest_path and installed_manifest_path.exists():
        installed = json.loads(installed_manifest_path.read_text(encoding="utf-8"))
    else:
        try:
            installed = load_installed_manifest()
        except Exception:
            installed = {}

    by_h: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in records:
        h = str(r.get("harness") or "")
        if h == "agy":
            continue
        by_h[h].append(r)

    summaries: Dict[str, Dict[str, Any]] = {}
    for h, h_recs in sorted(by_h.items()):
        summaries[h] = summarize_harness_v5(h, h_recs, mb, installed, omnia_bin=omnia_bin)

    mcnemar: Dict[str, Dict[str, Any]] = {}
    if "omnia" in by_h:
        valid_recs = [r for r in records if str(r.get("harness") or "") != "agy"]
        for h in sorted(by_h):
            if h == "omnia":
                continue
            mcnemar[h] = scorer_v4.paired_mcnemar(valid_recs, "omnia", h)

    ranked = sorted(summaries.values(), key=lambda s: (-s["pass_at_1_pct"], -s["mean_score"], -s["i14_composite"]))
    return {
        "schema_version": "5.0",
        "axes": V5_AXIS_NAMES,
        "harnesses": summaries,
        "ranking": [r["harness"] for r in ranked],
        "mcnemar_vs_omnia": mcnemar,
    }


def format_scoreboard_markdown(report: Dict[str, Any]) -> str:
    """Format Wave 3 verified Suite v5 scoreboard as a crisp Markdown table."""
    lines = [
        "# Omnia v5 vs 6 Clean-Room Competitors — Suite v5 Scoreboard",
        "",
        "| Harness | Runs | Pass@1 (95% Wilson CI) | Mean Score | I14 | McNemar p vs Omnia | Wire TTFT (ms) | Active TPS | E2E TPS | Tok/Solved | Cost/Solved (USD) | KV Hit % | Tool/Edit Err % | Peak RSS (MB) | Job Mem (MB) | Cold Start (ms) | Size (MB) | Leaks |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    mc = report.get("mcnemar_vs_omnia") or {}
    for h in report.get("ranking") or []:
        s = report["harnesses"][h]
        ci = s["pass_at_1_wilson_95ci"]
        mp = "ref" if h == "omnia" else f"{mc.get(h, {}).get('mcnemar_p', 1.0):.4f}"
        lines.append(
            f"| {h} | {s['runs']} | {s['pass_at_1_pct']:.1f}% [{ci[0]:.1f},{ci[1]:.1f}] | "
            f"{s['mean_score']:.3f} | {s['i14_composite']:.1f} | {mp} | "
            f"{s['median_wire_ttft_ms']} | {s['median_active_tps']} | {s['median_e2e_tps']} | "
            f"{s['tokens_per_solved']} | {s['cost_per_solved_usd']} | {s['pooled_kv_cache_hit_pct']:.1f}% | "
            f"{s['pooled_tool_error_rate_pct']:.1f}%/{s['pooled_edit_error_rate_pct']:.1f}% | "
            f"{s['peak_rss_mb_median']} | {s['peak_job_mem_mb_max']} | {s['cold_start_ms']} | {s['binary_size_mb']} | {s['network_leaks_total']} |"
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Score Suite v5 runner records into JSON & Markdown scoreboard")
    ap.add_argument("--records", required=True)
    ap.add_argument("--microbench", default=r"D:\OmniaData\qa\v5-bench\microbench_v5_all7.json")
    ap.add_argument("--omnia-bin", default=None)
    ap.add_argument("--out-json", default=None)
    ap.add_argument("--out-md", default=None)
    args = ap.parse_args()

    payload = json.loads(Path(args.records).read_text(encoding="utf-8"))
    records = payload.get("records") if isinstance(payload, dict) else payload
    report = score_suite_v5(
        list(records or []),
        microbench_path=Path(args.microbench) if args.microbench else None,
        omnia_bin=Path(args.omnia_bin) if args.omnia_bin else None,
    )
    md = format_scoreboard_markdown(report)
    if args.out_json:
        Path(args.out_json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    if args.out_md:
        Path(args.out_md).write_text(md, encoding="utf-8", newline="\n")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
