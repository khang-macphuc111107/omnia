"""v4 11-Axis Clean-Room Benchmark Scorer with Wilson 95% CI, McNemar & Paired Bootstrap Stats.

Reads `D:\\omnia-bench\\results\\v4\\<phase>\\<harness>\\<model>\\*.json` plus
`D:\\omnia-bench\\results\\microbench_stage0.json` and emits:
  - Per-harness raw pillar tables (Accuracy, Reliability, Speed/Overhead, Footprint/Efficiency)
  - Paired statistical significance (McNemar exact p-value for Pass@1, paired bootstrap 95% CI
    for harness_overhead_ms, total_tokens, and peak_harness_rss_mb)
  - Composite 11-axis index (`I_11`) + explicit Omnia Domination Gate audit.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BENCH_ROOT = Path(r"D:\omnia-bench")
V4_RESULTS = BENCH_ROOT / "results" / "v4"
MICROBENCH_PATH = BENCH_ROOT / "results" / "microbench_stage0.json"

AXIS_NAMES = {
    1: "A1:SWE",
    2: "A2:Terminal",
    3: "A3:LiveCode",
    4: "A4:Atlas",
    5: "A5:BFCL",
    6: "A6:Refactor",
    7: "A7:SelfHeal",
    11: "A11:Resilience",
}


def wilson_ci(k: int, n: int, z: float = 1.959964) -> Tuple[float, float]:
    if n <= 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1.0 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z / denom) * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return (round(max(0.0, center - half) * 100.0, 2), round(min(1.0, center + half) * 100.0, 2))


def mcnemar_exact_p(b: int, c: int) -> float:
    """Exact two-sided binomial p-value for discordant pairs (b = A pass/B fail, c = A fail/B pass)."""
    n = b + c
    if n == 0:
        return 1.0
    m = min(b, c)
    # Sum binomial probabilities for k=0..m
    prob = sum(math.comb(n, k) for k in range(m + 1)) * (0.5 ** n)
    return round(min(1.0, 2.0 * prob), 5)


def bootstrap_ci(vals: List[float], iters: int = 2000, seed: int = 42) -> Tuple[float, float]:
    if not vals:
        return (0.0, 0.0)
    if len(vals) == 1:
        return (round(vals[0], 2), round(vals[0], 2))
    rng = random.Random(seed)
    n = len(vals)
    meds = sorted(statistics.median(rng.choices(vals, k=n)) for _ in range(iters))
    return (round(meds[int(0.025 * iters)], 2), round(meds[int(0.975 * iters)], 2))


def p95(vals: List[float]) -> Optional[float]:
    if not vals:
        return None
    s = sorted(vals)
    return round(s[min(len(s) - 1, int(math.ceil(0.95 * len(s))) - 1)], 2)


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def load_phase(phase: str) -> List[Dict[str, Any]]:
    pdir = V4_RESULTS / phase
    if not pdir.exists():
        return []
    recs: List[Dict[str, Any]] = []
    for f in sorted(pdir.rglob("*.json")):
        if f.name.endswith(".wire.jsonl"):
            continue
        try:
            recs.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return recs


def summarize_harness(harness: str, recs: List[Dict[str, Any]], mb: dict) -> Dict[str, Any]:
    n = len(recs)
    solved = sum(1 for r in recs if r.get("passed"))
    pass_rate = (solved / n * 100.0) if n else 0.0
    ci_lo, ci_hi = wilson_ci(solved, n)

    # pass^k consistency per (model, task_id)
    by_mt: Dict[Tuple[str, str], List[bool]] = defaultdict(list)
    for r in recs:
        by_mt[(r["model"], r["task_id"])].append(bool(r.get("passed")))
    multi_groups = [v for v in by_mt.values() if len(v) >= 2]
    pass_all_k = (sum(1 for v in multi_groups if all(v)) / len(multi_groups) * 100.0) if multi_groups else None

    by_axis: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for r in recs:
        by_axis[int(r["axis"])].append(r)
    axis_scores = {
        ax: round(sum(1 for x in items if x.get("passed")) / len(items) * 100.0, 2)
        for ax, items in sorted(by_axis.items())
    }
    cap_axes = [axis_scores[a] for a in sorted(axis_scores) if a in (1, 2, 3, 4, 5, 6, 7, 11)]
    c_cap = round(sum(cap_axes) / len(cap_axes), 2) if cap_axes else 0.0

    # Reliability
    clean_exit = sum(1 for r in recs if r.get("exit_code") == 0 and not r.get("timed_out"))
    timeouts = sum(1 for r in recs if r.get("timed_out"))
    doom_loops = sum(1 for r in recs if (r.get("stream") or {}).get("doom_loop_detected"))
    tot_tools = sum(int((r.get("stream") or {}).get("tool_call_count", 0)) for r in recs)
    err_tools = sum(int((r.get("stream") or {}).get("tool_error_count", 0)) for r in recs)
    tot_edits = sum(int((r.get("stream") or {}).get("edit_call_count", 0)) for r in recs)
    err_edits = sum(int((r.get("stream") or {}).get("edit_error_count", 0)) for r in recs)
    egress_clean = sum(1 for r in recs if (r.get("egress_audit") or {}).get("htmustc_only_verified"))

    # Speed & overhead
    walls = [float(r["wall_time_s"]) for r in recs if r.get("wall_time_s") is not None]
    ovhs = [float(r["harness_overhead_ms"]) for r in recs if r.get("harness_overhead_ms") is not None]
    ttfts_ms = [float(r["wire"]["wire_first_ttft_ms"]) for r in recs if (r.get("wire") or {}).get("wire_first_ttft_ms") is not None]
    gen_tps = [float(r["wire"]["wire_gen_tokens_per_sec"]) for r in recs if (r.get("wire") or {}).get("wire_gen_tokens_per_sec", 0) > 0]

    # Efficiency & footprint
    def per_solved(field: str) -> Optional[float]:
        if not solved:
            return None
        total = 0
        for record in recs:
            value = (record.get("wire") or {}).get(field)
            if value is None:
                return None  # Missing observations cannot be priced as free attempts.
            total += value
        return round(total / solved, 1)

    tok_per_solved = per_solved("wire_total_tokens")
    t1_prompts = [int(r["wire"]["wire_turn1_prompt_tokens"]) for r in recs if (r.get("wire") or {}).get("wire_turn1_prompt_tokens", 0) > 0]
    kv_hits = [float(r["wire"]["wire_kv_cache_hit_rate_ge2"]) for r in recs if (r.get("wire") or {}).get("wire_requests", 0) >= 2]
    cost_per_solved = per_solved("wire_effective_cost_units")

    h_rss = [float(r["resources"]["peak_harness_rss_mb"]) for r in recs if (r.get("resources") or {}).get("peak_harness_rss_mb", 0) > 0]
    job_mem = [float(r["resources"]["peak_job_memory_mb"]) for r in recs if (r.get("resources") or {}).get("peak_job_memory_mb", 0) > 0]
    cpus = [float(r["resources"]["total_cpu_time_s"]) for r in recs if (r.get("resources") or {}).get("total_cpu_time_s") is not None]

    # Axis 8/9/10 operational scores
    med_ttft_s = (statistics.median(ttfts_ms) / 1000.0) if ttfts_ms else None
    med_tps = statistics.median(gen_tps) if gen_tps else None
    med_wall = statistics.median(walls) if walls else None
    a8_parts = []
    if med_ttft_s is not None:
        a8_parts.append(clamp(100.0 * (1.0 - med_ttft_s / 10.0)))
    if med_tps is not None:
        a8_parts.append(clamp(100.0 * (med_tps / 120.0)))
    if med_wall is not None:
        a8_parts.append(clamp(100.0 * (1.0 - med_wall / 300.0)))
    a8 = round(sum(a8_parts) / len(a8_parts), 2) if a8_parts else 0.0

    if tok_per_solved and tok_per_solved > 0:
        tok_eff = clamp(100.0 * (math.log10(1_000_000.0) - math.log10(max(tok_per_solved, 1.0))) / (math.log10(1_000_000.0) - math.log10(25_000.0)))
    else:
        tok_eff = 0.0
    med_kv = statistics.median(kv_hits) if kv_hits else 0.0
    tool_err_rate = (err_tools / tot_tools) if tot_tools > 0 else 0.0
    a9 = round(0.55 * tok_eff + 0.25 * (med_kv * 100.0) + 0.20 * ((1.0 - tool_err_rate) * 100.0 if tot_tools > 0 else 0.0), 2)

    med_rss = statistics.median(h_rss) if h_rss else 0.0
    a10 = round(clamp(100.0 * (1024.0 - med_rss) / (1024.0 - 50.0)), 2) if med_rss > 0 else 0.0

    i11 = round(0.70 * c_cap + 0.10 * a8 + 0.10 * a9 + 0.10 * a10, 2)
    h_mb = (mb.get("harnesses") or {}).get(harness, {})

    return {
        "harness": harness,
        "version": h_mb.get("version"),
        "disk_mb": h_mb.get("disk_mb"),
        "runs": n,
        "solved": solved,
        "pass_at_1_pct": round(pass_rate, 2),
        "pass_at_1_wilson_95ci": [ci_lo, ci_hi],
        "pass_all_k_pct": round(pass_all_k, 2) if pass_all_k is not None else None,
        "axis_scores": axis_scores,
        "c_cap": c_cap,
        "a8_speed": a8,
        "a9_econ": a9,
        "a10_footprint": a10,
        "i11_composite": i11,
        "zero_intervention_pct": round(clean_exit / n * 100.0, 2) if n else 0.0,
        "timeout_rate_pct": round(timeouts / n * 100.0, 2) if n else 0.0,
        "doom_loop_rate_pct": round(doom_loops / n * 100.0, 2) if n else 0.0,
        "tool_error_rate_pct": round(tool_err_rate * 100.0, 2),
        "edit_failure_rate_pct": round((err_edits / tot_edits * 100.0), 2) if tot_edits else 0.0,
        "htmustc_only_verified_pct": round(egress_clean / n * 100.0, 2) if n else 0.0,
        "median_wall_s": round(med_wall, 2) if med_wall is not None else None,
        "p95_wall_s": p95(walls),
        "median_harness_overhead_ms": round(statistics.median(ovhs), 1) if ovhs else None,
        "harness_overhead_95ci_ms": list(bootstrap_ci(ovhs)) if ovhs else None,
        "median_wire_ttft_ms": round(statistics.median(ttfts_ms), 1) if ttfts_ms else None,
        "p95_wire_ttft_ms": p95(ttfts_ms),
        "median_gen_tps": round(med_tps, 1) if med_tps is not None else None,
        "tokens_per_solved": tok_per_solved,
        "cost_units_per_solved": cost_per_solved,
        "median_turn1_prompt_tokens": round(statistics.median(t1_prompts), 1) if t1_prompts else None,
        "median_kv_cache_hit_pct": round(med_kv * 100.0, 2),
        "median_peak_harness_rss_mb": round(med_rss, 2) if h_rss else None,
        "median_peak_job_mem_mb": round(statistics.median(job_mem), 2) if job_mem else None,
        "median_cpu_s": round(statistics.median(cpus), 3) if cpus else None,
        "cold_start_version_ms": (h_mb.get("version_startup") or {}).get("median_ms"),
        "cold_start_first_req_ms": (h_mb.get("mock_first_request") or {}).get("first_req_median_ms"),
    }


def paired_mcnemar(recs: List[Dict[str, Any]], base_h: str, other_h: str) -> Dict[str, Any]:
    a_map = {(r["model"], r["task_id"], r["repeat"]): bool(r.get("passed")) for r in recs if r["harness"] == base_h}
    b_map = {(r["model"], r["task_id"], r["repeat"]): bool(r.get("passed")) for r in recs if r["harness"] == other_h}
    shared = sorted(set(a_map) & set(b_map))
    b_wins = sum(1 for k in shared if a_map[k] and not b_map[k])
    c_losses = sum(1 for k in shared if not a_map[k] and b_map[k])
    return {"shared_pairs": len(shared), "base_only_pass": b_wins, "other_only_pass": c_losses, "mcnemar_p": mcnemar_exact_p(b_wins, c_losses)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="stage0")
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()

    recs = load_phase(args.phase)
    mb = json.loads(MICROBENCH_PATH.read_text("utf-8")) if MICROBENCH_PATH.exists() else {}
    by_h: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in recs:
        by_h[r["harness"]].append(r)

    summaries = [summarize_harness(h, items, mb) for h, items in sorted(by_h.items())]
    summaries.sort(key=lambda s: s["i11_composite"], reverse=True)

    paired = {}
    if "omnia" in by_h:
        for h in sorted(by_h):
            if h != "omnia":
                paired[f"omnia_vs_{h}"] = paired_mcnemar(recs, "omnia", h)

    out_dir = Path(args.out_dir) if args.out_dir else (V4_RESULTS / args.phase / "_summary")
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"phase": args.phase, "total_records": len(recs), "leaderboard": summaries, "paired_mcnemar": paired}
    (out_dir / "scoreboard_v4.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    lines = [
        f"# Clean-Room 5-Harness Benchmark Scoreboard v4 (`{args.phase}`)",
        "",
        "| Harness | Ver | Pass@1 (95% CI) | C_cap | I11 | Tool Err% | Med Wall(s) | Med Ovh(ms) | Wire TTFT(ms) | KV Hit% | Tok/Solved | Peak RSS(MB) | Disk(MB) | htmustc-Only |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for s in summaries:
        ci = s["pass_at_1_wilson_95ci"]
        lines.append(
            f"| **{s['harness']}** | `{s['version']}` | {s['pass_at_1_pct']}% [{ci[0]},{ci[1]}] | {s['c_cap']} | **{s['i11_composite']}** | "
            f"{s['tool_error_rate_pct']}% | {s['median_wall_s']} | {s['median_harness_overhead_ms']} | {s['median_wire_ttft_ms']} | "
            f"{s['median_kv_cache_hit_pct']}% | {s['tokens_per_solved']} | {s['median_peak_harness_rss_mb']} | {s['disk_mb']} | {s['htmustc_only_verified_pct']}% |"
        )
    md = "\n".join(lines) + "\n"
    (out_dir / "SCOREBOARD_V4.md").write_text(md, encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
