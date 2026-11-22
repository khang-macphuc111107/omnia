"""Publication-grade 10-Axis Benchmark Scorer & Report Generator.

Computes Artificial Analysis-style normalized multi-axis scores across:
  - Axes 1-7: Coding & Agentic Capability (equal-weight composite C_cap)
  - Axis 8  : Speed, TTFT & Generation Throughput (median/p95 latencies, tok/s)
  - Axis 9  : Token Economics & Tool Discipline (tokens-per-success, cache hit rate)
  - Axis 10 : System & Desktop Resource Footprint (live RSS/CPU + baseline profiling)

Generates:
  - `results/summary/<phase>/scoreboard.json`
  - `results/summary/<phase>/SCOREBOARD.md`
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BENCH_ROOT = Path(__file__).resolve().parent
RESULTS_RAW_DIR = BENCH_ROOT / "results" / "raw"
RESULTS_SUMMARY_DIR = BENCH_ROOT / "results" / "summary"
RESOURCE_BASELINE_PATH = BENCH_ROOT / "results" / "resource_baseline.json"
DESKTOP_PREMERGE_PATH = BENCH_ROOT / "results" / "desktop_baselines_premerge.json"
DESKTOP_POSTMERGE_PATH = BENCH_ROOT / "results" / "desktop_postmerge_omp_omni.json"
DESKTOP_POSTMERGE_V2_PATH = BENCH_ROOT / "results" / "desktop_postmerge_v2_omp_omni.json"
DESKTOP_POSTMERGE_V3_PATH = BENCH_ROOT / "results" / "desktop_postmerge_v3_omp_omni.json"

AXIS_LABELS = {
    1: "A1:SWE-bench",
    2: "A2:Terminal",
    3: "A3:LiveCode",
    4: "A4:SWE-Atlas",
    5: "A5:BFCL",
    6: "A6:Refactor",
    7: "A7:Self-Heal",
}


def percentile(values: List[float], p: float) -> Optional[float]:
    """Nearest-rank / linear-interpolated percentile on non-empty float list."""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * (p / 100.0)
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def load_raw_records(phase: Optional[str] = None) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    if not RESULTS_RAW_DIR.exists():
        return records

    phase_dirs = [RESULTS_RAW_DIR / phase] if phase else sorted(RESULTS_RAW_DIR.iterdir())
    for pdir in phase_dirs:
        if not pdir.is_dir():
            continue
        for hdir in sorted(pdir.iterdir()):
            if not hdir.is_dir():
                continue
            for mdir in sorted(hdir.iterdir()):
                if not mdir.is_dir():
                    continue
                for f in sorted(mdir.glob("*.json")):
                    try:
                        rec = json.loads(f.read_text(encoding="utf-8"))
                        rec["_path"] = str(f)
                        records.append(rec)
                    except Exception as exc:
                        print(f"[warn] skipping corrupt record {f}: {exc}")
    return records


def _load_json_optional(path: Path) -> Optional[Dict[str, Any]]:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def load_resource_baseline() -> Optional[Dict[str, Any]]:
    return _load_json_optional(RESOURCE_BASELINE_PATH)


def load_desktop_profiles() -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    return (
        _load_json_optional(DESKTOP_PREMERGE_PATH),
        _load_json_optional(DESKTOP_POSTMERGE_PATH),
    )


def load_desktop_postmerge_v2() -> Optional[Dict[str, Any]]:
    return _load_json_optional(DESKTOP_POSTMERGE_V2_PATH)


def load_desktop_postmerge_v3() -> Optional[Dict[str, Any]]:
    return _load_json_optional(DESKTOP_POSTMERGE_V3_PATH)


def compute_axis8_speed(
    median_ttft: Optional[float],
    median_gen_tps: Optional[float],
    median_wall: Optional[float],
) -> float:
    # Anchors: TTFT 0s=100, >=10s=0; Gen TPS 120+=100, 0=0; Wall 0s=100, >=300s=0 (matches 300s task timeout)
    parts: List[float] = []
    if median_ttft is not None:
        parts.append(clamp(100.0 * (1.0 - median_ttft / 10.0)))
    if median_gen_tps is not None and median_gen_tps > 0:
        parts.append(clamp(100.0 * (median_gen_tps / 120.0)))
    if median_wall is not None:
        parts.append(clamp(100.0 * (1.0 - median_wall / 300.0)))
    return round(sum(parts) / len(parts), 2) if parts else 0.0


def compute_axis9_economics(
    tokens_per_success: Optional[float],
    cache_hit_rate: float,
    tool_error_rate: float,
    total_tool_calls: int = 0,
) -> float:
    # Log-scaled efficiency anchor: <=25k tok/resolved -> 100, >=1M tok/resolved -> 0; None -> 0
    if tokens_per_success is None or tokens_per_success <= 0:
        tok_eff = 0.0
    else:
        lo = math.log10(25_000.0)
        hi = math.log10(1_000_000.0)
        val = math.log10(max(tokens_per_success, 1.0))
        tok_eff = clamp(100.0 * (hi - val) / (hi - lo))
    cache_score = clamp(cache_hit_rate * 100.0)
    # Prevent crashed/zero-tool runs from receiving free +20 reliability points
    tool_rel = clamp((1.0 - tool_error_rate) * 100.0) if total_tool_calls > 0 else 0.0
    return round(0.55 * tok_eff + 0.25 * cache_score + 0.20 * tool_rel, 2)


def compute_axis10_resources(
    median_peak_rss_mb: Optional[float],
    mean_cpu_pct: Optional[float],
) -> float:
    # Anchors: Peak RSS <=50 MB -> 100, >=1024 MB -> 0; CPU <=10% -> 100, >=200% -> 0
    parts: List[float] = []
    if median_peak_rss_mb is not None and median_peak_rss_mb > 0:
        parts.append(clamp(100.0 * (1024.0 - median_peak_rss_mb) / (1024.0 - 50.0)))
    if mean_cpu_pct is not None:
        parts.append(clamp(100.0 * (200.0 - mean_cpu_pct) / 190.0))
    return round(sum(parts) / len(parts), 2) if parts else 0.0


def aggregate_group(
    phase: str,
    harness: str,
    model: str,
    recs: List[Dict[str, Any]],
) -> Dict[str, Any]:
    total_tasks = len(recs)
    resolved = sum(1 for r in recs if r.get("passed"))
    timeouts = sum(1 for r in recs if r.get("timed_out"))
    errors = sum(1 for r in recs if r.get("status") in ("error", "runner_error"))
    pass_at_1 = (resolved / total_tasks * 100.0) if total_tasks else 0.0
    mean_partial = (sum(float(r.get("score", 0.0)) for r in recs) / total_tasks * 100.0) if total_tasks else 0.0

    by_axis: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for r in recs:
        by_axis[int(r["axis"])].append(r)

    axis_scores: Dict[str, Dict[str, Any]] = {}
    strict_axis_vals: List[float] = []
    partial_axis_vals: List[float] = []
    for ax in range(1, 8):
        ax_recs = by_axis.get(ax, [])
        if not ax_recs:
            axis_scores[str(ax)] = {
                "label": AXIS_LABELS[ax],
                "evaluated": 0,
                "passed": 0,
                "pass_at_1": None,
                "partial_score": None,
            }
            continue
        ax_passed = sum(1 for r in ax_recs if r.get("passed"))
        ax_p1 = ax_passed / len(ax_recs) * 100.0
        ax_part = sum(float(r.get("score", 0.0)) for r in ax_recs) / len(ax_recs) * 100.0
        strict_axis_vals.append(ax_p1)
        partial_axis_vals.append(ax_part)
        axis_scores[str(ax)] = {
            "label": AXIS_LABELS[ax],
            "evaluated": len(ax_recs),
            "passed": ax_passed,
            "pass_at_1": round(ax_p1, 2),
            "partial_score": round(ax_part, 2),
        }

    cap_index = round(sum(strict_axis_vals) / len(strict_axis_vals), 2) if strict_axis_vals else 0.0
    cap_partial_index = round(sum(partial_axis_vals) / len(partial_axis_vals), 2) if partial_axis_vals else 0.0

    # Axis 8: Speed & Latencies
    ttfts = [float(r["telemetry"]["ttft_s"]) for r in recs if r.get("telemetry", {}).get("ttft_s") is not None]
    llm_ttfts = [
        float(r["telemetry"]["llm_ttft_s"])
        for r in recs
        if r.get("telemetry", {}).get("llm_ttft_s") is not None
    ]
    gen_tps = [
        float(r["telemetry"]["gen_tokens_per_sec"])
        for r in recs
        if (r.get("telemetry", {}).get("gen_tokens_per_sec") or 0) > 0
    ]
    e2e_tps = [
        float(r["telemetry"]["e2e_tokens_per_sec"])
        for r in recs
        if (r.get("telemetry", {}).get("e2e_tokens_per_sec") or 0) > 0
    ]
    walls = [float(r["wall_time_s"]) for r in recs if r.get("wall_time_s") is not None]

    med_ttft = percentile(ttfts, 50)
    p95_ttft = percentile(ttfts, 95)
    med_llm_ttft = percentile(llm_ttfts, 50)
    med_gen_tps = percentile(gen_tps, 50)
    p95_gen_tps = percentile(gen_tps, 95)
    med_e2e_tps = percentile(e2e_tps, 50)
    med_wall = percentile(walls, 50)
    p95_wall = percentile(walls, 95)
    axis8_score = compute_axis8_speed(med_ttft, med_gen_tps, med_wall)

    # Axis 9: Token Economics
    tok_complete_recs = [
        r for r in recs
        if r.get("telemetry", {}).get("token_telemetry_complete", (r.get("telemetry", {}).get("total_tokens") or 0) > 0)
    ]
    incomplete_tok_runs = total_tasks - len(tok_complete_recs)
    sum_input = sum(int(r.get("telemetry", {}).get("input_tokens") or 0) for r in tok_complete_recs)
    sum_uncached = sum(int(r.get("telemetry", {}).get("uncached_input_tokens") or 0) for r in tok_complete_recs)
    sum_cache_read = sum(int(r.get("telemetry", {}).get("cache_read_tokens") or 0) for r in tok_complete_recs)
    sum_cache_write = sum(int(r.get("telemetry", {}).get("cache_write_tokens") or 0) for r in tok_complete_recs)
    sum_output = sum(int(r.get("telemetry", {}).get("output_tokens") or 0) for r in tok_complete_recs)
    reasoning_vals = [
        int(r["telemetry"]["reasoning_tokens"])
        for r in tok_complete_recs
        if r.get("telemetry", {}).get("reasoning_tokens") is not None
    ]
    sum_reasoning = sum(reasoning_vals) if reasoning_vals else None
    sum_total = sum(int(r.get("telemetry", {}).get("total_tokens") or 0) for r in tok_complete_recs)
    sum_turns = sum(int(r.get("telemetry", {}).get("turn_count") or 0) for r in recs)
    sum_tools = sum(int(r.get("telemetry", {}).get("tool_call_count") or 0) for r in recs)
    sum_tool_errs = sum(int(r.get("telemetry", {}).get("tool_error_count") or 0) for r in recs)

    resolved_with_tok = sum(1 for r in tok_complete_recs if r.get("passed"))
    tokens_per_success = round(sum_total / resolved_with_tok, 1) if resolved_with_tok > 0 else None
    cache_hit_rate = (sum_cache_read / sum_input) if sum_input > 0 else 0.0
    tool_error_rate = (sum_tool_errs / sum_tools) if sum_tools > 0 else 0.0
    axis9_score = compute_axis9_economics(tokens_per_success, cache_hit_rate, tool_error_rate, sum_tools)

    # Axis 10: System & Resource Footprint
    peak_rss = [
        float(r["resources"]["peak_rss_mb"])
        for r in recs
        if (r.get("resources") or {}).get("peak_rss_mb", 0) > 0
    ]
    mean_rss = [
        float(r["resources"]["mean_rss_mb"])
        for r in recs
        if (r.get("resources") or {}).get("mean_rss_mb", 0) > 0
    ]
    cpu_times = [float((r.get("resources") or {}).get("total_cpu_time_s") or 0.0) for r in recs]
    cpu_pcts = [
        float(r["resources"]["mean_cpu_pct"])
        for r in recs
        if (r.get("resources") or {}).get("mean_cpu_pct") is not None
    ]

    med_peak_rss = percentile(peak_rss, 50)
    max_peak_rss = max(peak_rss) if peak_rss else None
    avg_mean_rss = statistics.mean(mean_rss) if mean_rss else None
    avg_cpu_pct = statistics.mean(cpu_pcts) if cpu_pcts else None
    axis10_score = compute_axis10_resources(med_peak_rss, avg_cpu_pct)

    composite_10 = round(0.70 * cap_index + 0.10 * axis8_score + 0.10 * axis9_score + 0.10 * axis10_score, 2)

    return {
        "phase": phase,
        "harness": harness,
        "model": model,
        "tasks_evaluated": total_tasks,
        "axes_evaluated": len(strict_axis_vals),
        "resolved": resolved,
        "timeouts": timeouts,
        "errors": errors,
        "pass_at_1": round(pass_at_1, 2),
        "mean_partial_score": round(mean_partial, 2),
        "capability_index_c7": cap_index,
        "capability_partial_c7": cap_partial_index,
        "composite_index_i10": composite_10,
        "axes": axis_scores,
        "axis8_speed": {
            "score": axis8_score,
            "median_ttft_s": round(med_ttft, 3) if med_ttft is not None else None,
            "p95_ttft_s": round(p95_ttft, 3) if p95_ttft is not None else None,
            "median_llm_ttft_s": round(med_llm_ttft, 3) if med_llm_ttft is not None else None,
            "median_gen_tps": round(med_gen_tps, 2) if med_gen_tps is not None else None,
            "p95_gen_tps": round(p95_gen_tps, 2) if p95_gen_tps is not None else None,
            "median_e2e_tps": round(med_e2e_tps, 2) if med_e2e_tps is not None else None,
            "median_wall_s": round(med_wall, 2) if med_wall is not None else None,
            "p95_wall_s": round(p95_wall, 2) if p95_wall is not None else None,
        },
        "axis9_economics": {
            "score": axis9_score,
            "total_tokens": sum_total,
            "input_tokens": sum_input,
            "uncached_input_tokens": sum_uncached,
            "cache_read_tokens": sum_cache_read,
            "cache_write_tokens": sum_cache_write,
            "output_tokens": sum_output,
            "reasoning_tokens": sum_reasoning,
            "mean_tokens_per_task": round(sum_total / len(tok_complete_recs), 1) if tok_complete_recs else 0.0,
            "incomplete_token_runs": incomplete_tok_runs,
            "tokens_per_success": tokens_per_success,
            "cache_hit_rate_pct": round(cache_hit_rate * 100.0, 2),
            "mean_turns": round(sum_turns / total_tasks, 2) if total_tasks else 0.0,
            "mean_tool_calls": round(sum_tools / total_tasks, 2) if total_tasks else 0.0,
            "tool_error_rate_pct": round(tool_error_rate * 100.0, 2),
        },
        "axis10_resources": {
            "score": axis10_score,
            "median_peak_rss_mb": round(med_peak_rss, 2) if med_peak_rss is not None else None,
            "max_peak_rss_mb": round(max_peak_rss, 2) if max_peak_rss is not None else None,
            "mean_rss_mb": round(avg_mean_rss, 2) if avg_mean_rss is not None else None,
            "total_cpu_time_s": round(sum(cpu_times), 3),
            "mean_cpu_pct": round(avg_cpu_pct, 2) if avg_cpu_pct is not None else None,
        },
    }


def _fmt(val: Any, suffix: str = "", fmt: str = ".2f", na: str = "—") -> str:
    if val is None:
        return na
    if isinstance(val, int):
        return f"{val:,}{suffix}"
    if isinstance(val, float):
        return f"{val:{fmt}}{suffix}"
    return f"{val}{suffix}"


def render_markdown(
    summary: Dict[str, Any],
    records: List[Dict[str, Any]],
    baseline: Optional[Dict[str, Any]],
    desktop_premerge: Optional[Dict[str, Any]] = None,
    desktop_postmerge: Optional[Dict[str, Any]] = None,
    desktop_postmerge_v2: Optional[Dict[str, Any]] = None,
    desktop_postmerge_v3: Optional[Dict[str, Any]] = None,
) -> str:
    rows = summary["leaderboard"]
    lines: List[str] = []
    lines.append(f"# 10-Axis Coding Agent & Harness Benchmark Scoreboard")
    lines.append("")
    lines.append(
        f"- **Generated (UTC):** `{summary['generated_at']}`  "
        f"\n- **Phase Filter:** `{summary['phase_filter'] or 'ALL'}`  "
        f"\n- **Total Evaluated Runs:** `{summary['total_runs']}`"
    )
    lines.append("")

    # 1. Executive Leaderboard
    lines.append("## 1. Executive 10-Axis Leaderboard")
    lines.append("")
    lines.append(
        "| Rank | Phase | Harness | Model | **I10 Index** | **C7 Cap** | Pass@1 | Resolved | "
        "A8 Speed | A9 Econ | A10 Res | Tok/Success | Med Wall | Peak RSS |"
    )
    lines.append(
        "|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    )
    for idx, r in enumerate(rows, 1):
        tps_succ = (
            f"{int(r['axis9_economics']['tokens_per_success']):,}"
            if r["axis9_economics"]["tokens_per_success"] is not None
            else "N/A"
        )
        lines.append(
            f"| {idx} | `{r['phase']}` | **{r['harness']}** | `{r['model']}` | "
            f"**{r['composite_index_i10']:.2f}** | {r['capability_index_c7']:.2f} | "
            f"{r['pass_at_1']:.1f}% | {r['resolved']}/{r['tasks_evaluated']} | "
            f"{r['axis8_speed']['score']:.1f} | {r['axis9_economics']['score']:.1f} | "
            f"{r['axis10_resources']['score']:.1f} | {tps_succ} | "
            f"{_fmt(r['axis8_speed']['median_wall_s'], 's', '.1f')} | "
            f"{_fmt(r['axis10_resources']['median_peak_rss_mb'], ' MB', '.1f')} |"
        )
    lines.append("")

    # 2. 7-Axis Capability Matrix
    lines.append("## 2. 7-Axis Capability Breakdown (Strict pass@1 %)")
    lines.append("")
    lines.append(
        "| Harness | Model | A1:SWE | A2:Term | A3:Algo | A4:Atlas | A5:BFCL | A6:Refact | A7:Heal | **C7 Avg** | Partial Avg |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        cells = []
        for ax in range(1, 8):
            a = r["axes"][str(ax)]
            cells.append(f"{a['pass_at_1']:.0f}% ({a['passed']}/{a['evaluated']})" if a["pass_at_1"] is not None else "—")
        lines.append(
            f"| **{r['harness']}** | `{r['model']}` | " + " | ".join(cells) +
            f" | **{r['capability_index_c7']:.1f}** | {r['capability_partial_c7']:.1f} |"
        )
    lines.append("")

    # 3. Axis 8 Speed & Latency
    lines.append("## 3. Axis 8: Speed, TTFT & Throughput")
    lines.append("")
    lines.append(
        "| Harness | Model | Med TTFT | p95 TTFT | Med LLM TTFT | Med Gen tok/s | p95 Gen tok/s | Med E2E tok/s | Med Wall | p95 Wall | **A8 Score** |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        s = r["axis8_speed"]
        lines.append(
            f"| **{r['harness']}** | `{r['model']}` | {_fmt(s['median_ttft_s'], 's', '.2f')} | "
            f"{_fmt(s['p95_ttft_s'], 's', '.2f')} | {_fmt(s['median_llm_ttft_s'], 's', '.2f')} | "
            f"{_fmt(s['median_gen_tps'], '', '.1f')} | {_fmt(s['p95_gen_tps'], '', '.1f')} | "
            f"{_fmt(s['median_e2e_tps'], '', '.1f')} | {_fmt(s['median_wall_s'], 's', '.1f')} | "
            f"{_fmt(s['p95_wall_s'], 's', '.1f')} | **{s['score']:.1f}** |"
        )
    lines.append("")

    # 4. Axis 9 Token Economics
    lines.append("## 4. Axis 9: Token Economics & Tool Discipline")
    lines.append("")
    lines.append(
        "| Harness | Model | Total Tokens | Input (Uncached / Cache) | Output | Cache Hit | Tok/Success | Avg Turns | Avg Tools | Tool Err | **A9 Score** |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        e = r["axis9_economics"]
        tps_succ = f"{int(e['tokens_per_success']):,}" if e["tokens_per_success"] is not None else "N/A"
        lines.append(
            f"| **{r['harness']}** | `{r['model']}` | {e['total_tokens']:,} | "
            f"{e['input_tokens']:,} ({e['uncached_input_tokens']:,} / {e['cache_read_tokens']:,}) | "
            f"{e['output_tokens']:,} | {e['cache_hit_rate_pct']:.1f}% | {tps_succ} | "
            f"{e['mean_turns']:.2f} | {e['mean_tool_calls']:.2f} | {e['tool_error_rate_pct']:.1f}% | "
            f"**{e['score']:.1f}** |"
        )
    lines.append("")

    # 5. Axis 10 System & Resource Footprint
    lines.append("## 5. Axis 10: Live Execution & System Resource Footprint")
    lines.append("")
    lines.append(
        "| Harness | Model | Med Peak RSS | Max Peak RSS | Mean RSS | Total CPU Time | Mean CPU% | **A10 Score** |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        res = r["axis10_resources"]
        lines.append(
            f"| **{r['harness']}** | `{r['model']}` | {_fmt(res['median_peak_rss_mb'], ' MB', '.1f')} | "
            f"{_fmt(res['max_peak_rss_mb'], ' MB', '.1f')} | {_fmt(res['mean_rss_mb'], ' MB', '.1f')} | "
            f"{res['total_cpu_time_s']:.2f}s | {_fmt(res['mean_cpu_pct'], '%', '.1f')} | **{res['score']:.1f}** |"
        )
    lines.append("")

    # 6. Head-to-Head Harness Comparison (paired on same phase & model)
    by_pm: Dict[Tuple[str, str], Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for r in rows:
        by_pm[(r["phase"], r["model"])][r["harness"]] = r
    h2h_rows = []
    for (ph, mod), hmap in sorted(by_pm.items()):
        if "goose" in hmap and "omp" in hmap:
            g, o = hmap["goose"], hmap["omp"]
            h2h_rows.append((ph, mod, "omp vs goose", o, g))
        if "goose" in hmap and "omp-omni" in hmap:
            g, o = hmap["goose"], hmap["omp-omni"]
            h2h_rows.append((ph, mod, "omp-omni vs goose", o, g))
        if "omp" in hmap and "omp-omni" in hmap:
            g, o = hmap["omp"], hmap["omp-omni"]
            h2h_rows.append((ph, mod, "omp-omni vs omp", o, g))
        if "goose" in hmap and "omni-super" in hmap:
            g, o = hmap["goose"], hmap["omni-super"]
            h2h_rows.append((ph, mod, "omni-super vs goose", o, g))
        if "omp" in hmap and "omni-super" in hmap:
            g, o = hmap["omp"], hmap["omni-super"]
            h2h_rows.append((ph, mod, "omni-super vs omp", o, g))
        if "omp-omni" in hmap and "omni-super" in hmap:
            g, o = hmap["omp-omni"], hmap["omni-super"]
            h2h_rows.append((ph, mod, "omni-super vs omp-omni", o, g))

    if h2h_rows:
        lines.append("## 6. Head-to-Head Harness Deltas (Same Model)")
        lines.append("")
        lines.append("| Phase | Model | Comparison | Δ I10 | Δ Pass@1 | Δ Med Wall | Δ Total Tokens | Δ Peak RSS |")
        lines.append("|---|---|---|---:|---:|---:|---:|---:|")
        for ph, mod, label, a, b in h2h_rows:
            d_i10 = a["composite_index_i10"] - b["composite_index_i10"]
            d_p1 = a["pass_at_1"] - b["pass_at_1"]
            aw = a["axis8_speed"]["median_wall_s"] or 0.0
            bw = b["axis8_speed"]["median_wall_s"] or 0.0
            d_wall = aw - bw
            d_tok = a["axis9_economics"]["total_tokens"] - b["axis9_economics"]["total_tokens"]
            ar = a["axis10_resources"]["median_peak_rss_mb"] or 0.0
            br = b["axis10_resources"]["median_peak_rss_mb"] or 0.0
            d_rss = ar - br
            lines.append(
                f"| `{ph}` | `{mod}` | **{label}** | {d_i10:+.2f} | {d_p1:+.1f}% | "
                f"{d_wall:+.2f}s | {d_tok:+,} | {d_rss:+.1f} MB |"
            )
        lines.append("")

    # 7. Per-Task Result Matrix
    all_tasks = sorted({(int(r["axis"]), r["task_id"]) for r in records})
    cols = [(r["phase"], r["harness"], r["model"]) for r in rows]
    lookup = {(r["phase"], r["harness"], r["model"], r["task_id"]): r for r in records}
    if all_tasks and cols:
        lines.append("## 7. Per-Task Pass/Fail Matrix")
        lines.append("")
        multi_phase = len({ph for ph, _, _ in cols}) > 1
        col_labels = [
            f"{h}<br>`{m}`<br>(`{ph}`)" if multi_phase else f"{h}<br>`{m}`"
            for ph, h, m in cols
        ]
        header = "| Axis | Task ID | " + " | ".join(col_labels) + " |"
        sep = "|---:|---|" + "|".join(":---:" for _ in cols) + "|"
        lines.append(header)
        lines.append(sep)
        for ax, tid in all_tasks:
            row_cells = []
            for ph, h, m in cols:
                rec = lookup.get((ph, h, m, tid))
                if rec is None:
                    row_cells.append("—")
                elif rec.get("passed"):
                    row_cells.append(f"PASS ({rec['wall_time_s']:.1f}s)")
                elif rec.get("timed_out"):
                    row_cells.append(f"TIMEOUT ({rec['score']*100:.0f}%)")
                else:
                    row_cells.append(f"FAIL ({rec['score']*100:.0f}%)")
            lines.append(f"| A{ax} | `{tid}` | " + " | ".join(row_cells) + " |")
        lines.append("")

    if baseline is not None:
        lines.append("## 8. System & Desktop Resource Baseline (`results/resource_baseline.json`)")
        lines.append("")
        harnesses_b = baseline.get("harnesses") or {}
        if harnesses_b:
            lines.append("| Target | Version | Disk Footprint | Cold Start p50 / p95 | Steady Idle RSS | Idle CPU |")
            lines.append("|---|---|---:|---:|---:|---:|")
            gc = harnesses_b.get("goose_cli")
            if gc:
                cs = gc.get("cold_start_latency_ms") or {}
                df = (gc.get("disk_footprint") or {}).get("binary_only") or {}
                lines.append(
                    f"| **Goose CLI** | `{gc.get('version', '?')}` | {_fmt(df.get('mb_decimal'), ' MB', '.2f')} | "
                    f"{_fmt(cs.get('p50_ms'), ' ms', '.1f')} / {_fmt(cs.get('p95_ms'), ' ms', '.1f')} | — | — |"
                )
            oc = harnesses_b.get("omp_cli")
            if oc:
                cs = oc.get("cold_start_latency_ms") or {}
                df = (oc.get("disk_footprint") or {}).get("combined_total") or {}
                lines.append(
                    f"| **OMP CLI (Bun)** | `{oc.get('version', '?')}` | {_fmt(df.get('mb_decimal'), ' MB', '.2f')} | "
                    f"{_fmt(cs.get('p50_ms'), ' ms', '.1f')} / {_fmt(cs.get('p95_ms'), ' ms', '.1f')} | — | — |"
                )
            gd = harnesses_b.get("goose_desktop")
            if gd:
                vi = gd.get("version_info") or {}
                df = (gd.get("disk_footprint") or {}).get("install_dir_total") or {}
                im = gd.get("idle_measurement") or {}
                lines.append(
                    f"| **Goose Desktop** | `{vi.get('product_version', '?')}` (Electron `{vi.get('electron_version', '?')}`) | "
                    f"{_fmt(df.get('mb_decimal'), ' MB', '.2f')} | — | "
                    f"{_fmt(im.get('total_rss_working_set_at_8s_mib'), ' MiB', '.1f')} ({im.get('process_count_at_8s', '?')} procs) | "
                    f"{_fmt(im.get('idle_cpu_pct_system_total'), '%', '.2f')} |"
                )
            lines.append("")
        else:
            lines.append("```json")
            lines.append(json.dumps(baseline, indent=2)[:4000])
            lines.append("```")
            lines.append("")

        # Also add omp-omni CLI core startup to Section 8 table when post-merge profiles are available
        for label_sfx, dp in [("v0.3 SOTA", desktop_postmerge_v3), ("v0.2 Super-Harness", desktop_postmerge_v2), ("v0.1 RPC", desktop_postmerge)]:
            if dp is not None and harnesses_b:
                omni = dp.get("omp_omni") or dp
                ps = (omni.get("profile_startup_10_runs") or {}).get("wall_clock_latency_ms") or {}
                df_exe = (omni.get("disk_footprint") or {}).get("release_exe") or {}
                gs = omni.get("gui_desktop_summary_3_runs") or {}
                if ps:
                    lines.insert(
                        len(lines) - 1,
                        f"| **`omp-omni` {label_sfx}** | `{omni.get('version', '?')}` (Tauri 2 + SolidJS) | "
                        f"**{_fmt(df_exe.get('mb_decimal'), ' MB', '.2f')}** | "
                        f"**{_fmt(ps.get('p50_ms'), ' ms', '.1f')} / {_fmt(ps.get('p95_ms'), ' ms', '.1f')}** | "
                        f"**{_fmt(gs.get('steady_idle_rss_median_mib'), ' MiB', '.1f')} ({gs.get('process_count', 8)} procs)** | "
                        f"**{_fmt(gs.get('idle_cpu_pct_system_median'), '%', '.3f')}** |",
                    )

    if desktop_premerge is not None or desktop_postmerge is not None or desktop_postmerge_v2 is not None or desktop_postmerge_v3 is not None:
        lines.append("## 9. Axis 10 Desktop App Comparison: Pre-Merge Baselines vs Post-Merge `omp-omni`")
        lines.append("")
        lines.append(
            "| App / Harness | Phase | Stack | Disk (MB) | Cold Start (ms) | Procs | Steady Idle RSS (MiB) | Private (MiB) | Idle CPU | Orphans |"
        )
        lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")

        # Post-merge omp-omni rows first (v0.3 then v0.2 then v0.1)
        for phase_label, dp in [("Super-Harness v3 SOTA", desktop_postmerge_v3), ("Super-Harness v2", desktop_postmerge_v2), ("Post-Merge v1", desktop_postmerge)]:
            if dp is not None:
                omni = dp.get("omp_omni") or dp
                gs = omni.get("gui_desktop_summary_3_runs") or {}
                df = omni.get("disk_footprint") or {}
                exe_mb = (
                    gs.get("disk_mb_decimal")
                    or (df.get("release_exe") or {}).get("mb_decimal")
                    or (df.get("primary_exe") or {}).get("mb_decimal")
                )
                cs_ms = (
                    gs.get("cold_start_window_median_ms")
                    or (omni.get("gui_desktop_representative_run") or {}).get("cold_start", {}).get("cold_start_ms")
                )
                rss_mib = (
                    gs.get("steady_idle_rss_median_mib")
                    or (omni.get("gui_desktop_representative_run") or {}).get("idle_measurement", {}).get("total_rss_working_set_at_8s_mib")
                )
                priv_mib = (
                    gs.get("steady_idle_private_median_mib")
                    or (omni.get("gui_desktop_representative_run") or {}).get("idle_measurement", {}).get("total_private_memory_at_8s_mib")
                )
                procs = gs.get("process_count") or (omni.get("gui_desktop_representative_run") or {}).get("idle_measurement", {}).get("process_count_at_8s")
                cpu = gs.get("idle_cpu_pct_system_median")
                orphans = gs.get("total_orphan_processes_across_runs", 0)
                ver = omni.get("version") or "0.1.0"
                stack = omni.get("stack") or "Rust + Tauri 2 + SolidJS + WV2"
                lines.append(
                    f"| **`omp-omni`** (`v{ver}`) | **{phase_label}** | {stack} | "
                    f"**{_fmt(exe_mb, '', '.2f')}** | **{_fmt(cs_ms, '', '.1f')}** | {_fmt(procs, '', 'd')} | "
                    f"**{_fmt(rss_mib, '', '.2f')}** | **{_fmt(priv_mib, '', '.2f')}** | **{_fmt(cpu, '%', '.3f')}** | **{orphans}** |"
                )

        if desktop_premerge is not None:
            ref_gd = desktop_premerge.get("reference_goose_desktop_from_resource_baseline")
            if ref_gd:
                ver_gd = (ref_gd.get("version") or {}).get("product_version", "1.60.2")
                lines.append(
                    f"| **Goose Desktop** (`v{ver_gd}`) | Baseline | Electron + bundled `goose.exe` | "
                    f"{_fmt(ref_gd.get('disk_footprint_mb_decimal'), '', '.2f')} | — | "
                    f"{_fmt(ref_gd.get('process_count'), '', 'd')} | {_fmt(ref_gd.get('steady_idle_rss_mib'), '', '.2f')} | "
                    f"{_fmt(ref_gd.get('steady_idle_private_mib'), '', '.2f')} | "
                    f"{_fmt(ref_gd.get('idle_cpu_pct_system_total'), '%', '.2f')} | 0 |"
                )
            for b in desktop_premerge.get("baselines") or []:
                df = (b.get("disk_footprint") or {}).get("unpacked_or_portable_dir") or {}
                cs = b.get("cold_start") or {}
                im = b.get("idle_measurement") or {}
                cl = b.get("cleanup") or {}
                cs_val = cs.get("cold_start_ms")
                detail_str = str(cs.get("ready_detail") or "")
                if isinstance(cs_val, (int, float)):
                    cs_str = _fmt(cs_val, "", ".1f")
                elif "hidden" in detail_str.lower() or "45" in detail_str:
                    cs_str = "hidden (>45s)"
                else:
                    cs_str = detail_str[:22] or "—"
                lines.append(
                    f"| `{b.get('repo', b.get('id', '?'))}` (`{b.get('version', '?')}`) | Pre-Merge | {b.get('stack', '?')} | "
                    f"{_fmt(df.get('mb_decimal'), '', '.2f')} | {cs_str} | "
                    f"{_fmt(im.get('process_count_at_8s'), '', 'd')} | {_fmt(im.get('total_rss_working_set_at_8s_mib'), '', '.2f')} | "
                    f"{_fmt(im.get('total_private_memory_at_8s_mib'), '', '.2f')} | "
                    f"{_fmt(im.get('idle_cpu_pct_system_total'), '%', '.2f')} | {cl.get('remaining_orphan_processes', 0)} |"
                )
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="10-Axis Benchmark Scorer")
    parser.add_argument("--phase", default=None, help="Filter to a single phase (default: all phases)")
    parser.add_argument("--out-dir", default=None, help="Override summary output directory")
    args = parser.parse_args()

    records = load_raw_records(phase=args.phase)
    baseline = load_resource_baseline()
    desktop_premerge, desktop_postmerge = load_desktop_profiles()
    desktop_postmerge_v2 = load_desktop_postmerge_v2()
    desktop_postmerge_v3 = load_desktop_postmerge_v3()
    if not records and baseline is None and desktop_premerge is None and desktop_postmerge is None and desktop_postmerge_v2 is None and desktop_postmerge_v3 is None:
        print(f"No raw records or baseline profiles found in {RESULTS_RAW_DIR} (phase={args.phase}).")
        return 1

    grouped: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)
    for r in records:
        grouped[(r["phase"], r["harness"], r["model"])].append(r)

    leaderboard = [
        aggregate_group(ph, h, m, recs)
        for (ph, h, m), recs in sorted(grouped.items())
    ]
    leaderboard.sort(
        key=lambda x: (x["composite_index_i10"], x["capability_index_c7"], x["pass_at_1"]),
        reverse=True,
    )

    summary = {
        "schema_version": "1.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "phase_filter": args.phase,
        "total_runs": len(records),
        "leaderboard": leaderboard,
        "resource_baseline_included": baseline is not None,
        "desktop_premerge_included": desktop_premerge is not None,
        "desktop_postmerge_included": desktop_postmerge is not None,
        "desktop_postmerge_v2_included": desktop_postmerge_v2 is not None,
        "desktop_postmerge_v3_included": desktop_postmerge_v3 is not None,
        "desktop_premerge_summary": desktop_premerge,
        "desktop_postmerge_summary": desktop_postmerge,
        "desktop_postmerge_v2_summary": desktop_postmerge_v2,
        "desktop_postmerge_v3_summary": desktop_postmerge_v3,
    }

    out_dir = Path(args.out_dir) if args.out_dir else (RESULTS_SUMMARY_DIR / (args.phase or "all"))
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "scoreboard.json"
    md_path = out_dir / "SCOREBOARD.md"
    json_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    md_path.write_text(
        render_markdown(summary, records, baseline, desktop_premerge, desktop_postmerge, desktop_postmerge_v2, desktop_postmerge_v3),
        encoding="utf-8",
    )

    print(f"Scored {len(records)} runs across {len(leaderboard)} (phase, harness, model) configurations.")
    print(f"JSON: {json_path}")
    print(f"MD  : {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
