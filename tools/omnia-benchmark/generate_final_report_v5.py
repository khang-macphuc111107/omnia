"""Generate canonical Wave 3 Suite v5 + 9 Public Suites Scoreboards (JSON & Markdown).

Produces:
  - D:\\OmniaData\\qa\\v5-bench\\final_scoreboard_v5.json
      Includes Studio `/api/benchmarks/scoreboard` schema keys (`suite`, `axes`,
      `pass_rate`, `tasks`, `recordedAtMs`, `summary`) and remains strictly < 2 MiB.
  - D:\\OmniaData\\qa\\v5-bench\\FINAL_SCOREBOARD_V5.md
      Full statistical tables (Pass@1 + Wilson 95% CI, McNemar p vs Omnia,
      Wire TTFT, Active/E2E TPS, Tokens/Solved, Cost/Solved, KV Hit %, Tool/Edit Err %,
      Peak RSS, Job Mem, CPU, Cold Start, Binary Size, 0 leaks, trace paths) plus
      all 9 Windows-runnable public suites & honest container blockers.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BENCH_DIR = Path(__file__).resolve().parent
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))

import scorer_v5

DEFAULT_SUITE_V5_DIR = Path(r"D:\OmniaData\qa\v5-bench\suite-v5")
DEFAULT_PUBLIC_DIR = Path(r"D:\OmniaData\qa\v5-bench\public_suites")
DEFAULT_MICROBENCH = Path(r"D:\OmniaData\qa\v5-bench\microbench_v5_all7.json")
DEFAULT_OMNIA_BIN = Path(r"D:\OmniaData\build\omnia-rust-native-release\omnia.exe")
DEFAULT_OUT_JSON = Path(r"D:\OmniaData\qa\v5-bench\final_scoreboard_v5.json")
DEFAULT_OUT_MD = Path(r"D:\OmniaData\qa\v5-bench\FINAL_SCOREBOARD_V5.md")

SKIP_JSON_NAMES = {
    "scoreboard.json",
    "summary.json",
    "audit_report.json",
    "public_suites_inventory.json",
    "final_scoreboard_v5.json",
}
REQUIRED_PUBLIC_SUITES = (
    "swe_atlas_qna_aa",
    "livecodebench",
    "bfcl_v4",
    "tau2_bench",
    "locomo",
    "longmemeval",
    "compaction_bench",
    "aider_polyglot",
    "aa_lcr",
)


def load_suite_v5_records(suite_v5_dir: Path) -> List[Dict[str, Any]]:
    """Load all active Suite v5 trial records matching `audit_bench_traces` traversal."""
    records: List[Dict[str, Any]] = []
    if not suite_v5_dir.is_dir():
        return records
    for fp in sorted(suite_v5_dir.rglob("*.json")):
        if (
            fp.name.endswith(".wire.jsonl")
            or fp.name in SKIP_JSON_NAMES
            or "_workspaces" in fp.parts
            or "archives" in fp.parts
            or fp.name.startswith("._")
        ):
            continue
        data = json.loads(fp.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "harness" in data and ("task_id" in data or "model" in data):
            records.append(data)
        elif isinstance(data, dict):
            for lk in ("cells", "records", "trials", "results", "rows"):
                arr = data.get(lk)
                if isinstance(arr, list):
                    for item in arr:
                        if isinstance(item, dict) and "harness" in item:
                            records.append(item)
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and "harness" in item:
                    records.append(item)
    return records


def load_public_suites_summaries(public_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Load `public_suites_inventory.json` and all completed public suite result files."""
    inv_path = public_dir / "public_suites_inventory.json"
    inventory = json.loads(inv_path.read_text(encoding="utf-8")) if inv_path.is_file() else {}
    suites: Dict[str, Any] = {}
    if not public_dir.is_dir():
        return suites, inventory
    for fp in sorted(public_dir.rglob("*.json")):
        if (
            fp.name == "public_suites_inventory.json"
            or fp.name.endswith("_smoke.json")
            or "_workspaces" in fp.parts
            or "archives" in fp.parts
        ):
            continue
        data = json.loads(fp.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
            continue
        summ = data.get("summary") or {}
        rows = data["rows"]
        sname = str(summ.get("suite") or (rows[0].get("suite") if rows else fp.parent.name) or fp.stem)
        suites[sname] = {
            "file": str(fp),
            "row_count": len(rows),
            "summary": summ,
        }
    return suites, inventory


def _compact_tasks(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_task: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for r in records:
        tid = str(r.get("task_id") or "")
        ax = int(r.get("axis") or 0)
        entry = by_task.setdefault(
            (ax, tid),
            {
                "task_id": tid,
                "axis": ax,
                "axis_name": str(r.get("axis_name") or scorer_v5.V5_AXIS_NAMES.get(ax, "")),
                "runs": {},
            },
        )
        key = f"{r.get('harness')}:{r.get('model')}:r{int(r.get('repeat') or 0)}"
        entry["runs"][key] = {
            "passed": bool(r.get("passed")),
            "score": round(float(r.get("score") or 0.0), 4),
            "wall_s": round(float(r.get("wall_s") or 0.0), 2),
            "ttft_ms": r.get("wire_first_ttft_ms"),
            "tokens": r.get("wire_total_tokens"),
            "kv_ge2": r.get("wire_kv_cache_hit_rate_ge2"),
            "wire_log": str(r.get("wire_log_path") or ""),
        }
    return [by_task[k] for k in sorted(by_task)]


def build_final_scoreboard(
    *,
    suite_v5_dir: Path = DEFAULT_SUITE_V5_DIR,
    public_dir: Path = DEFAULT_PUBLIC_DIR,
    microbench_path: Path = DEFAULT_MICROBENCH,
    omnia_bin: Path = DEFAULT_OMNIA_BIN,
    recorded_at_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Assemble compact `< 2 MiB` canonical JSON scoreboard matching Studio & audit schemas."""
    records = load_suite_v5_records(suite_v5_dir)
    if any(str(r.get("harness") or "").lower() == "agy" for r in records):
        raise ValueError("Disallowed harness 'agy' found in Suite v5 records")

    scored = scorer_v5.score_suite_v5(
        records,
        microbench_path=microbench_path if microbench_path.is_file() else None,
        omnia_bin=omnia_bin if omnia_bin.is_file() else None,
    )

    by_model: Dict[str, Any] = {}
    models = sorted({str(r.get("model") or "") for r in records if r.get("model")})
    for m in models:
        m_recs = [r for r in records if r.get("model") == m]
        by_model[m] = scorer_v5.score_suite_v5(
            m_recs,
            microbench_path=microbench_path if microbench_path.is_file() else None,
            omnia_bin=omnia_bin if omnia_bin.is_file() else None,
        )

    matched_subsets: Dict[str, Any] = {}
    for label, ax_set in (
        ("axes_1_11", {1, 2, 3, 4, 5, 6, 7, 11}),
        ("axes_12_14", {12, 13, 14}),
        ("all_33_tasks_r0", set(scorer_v5.V5_CAPABILITY_AXES)),
    ):
        sub_recs = [
            r for r in records
            if int(r.get("axis") or 0) in ax_set and (label != "all_33_tasks_r0" or int(r.get("repeat") or 0) == 0)
        ]
        if sub_recs:
            matched_subsets[label] = scorer_v5.score_suite_v5(
                sub_recs,
                microbench_path=microbench_path if microbench_path.is_file() else None,
                omnia_bin=omnia_bin if omnia_bin.is_file() else None,
            )

    public_suites, inventory = load_public_suites_summaries(public_dir)
    microbench = json.loads(microbench_path.read_text(encoding="utf-8")) if microbench_path.is_file() else {}

    omnia_stats = scored.get("harnesses", {}).get("omnia") or {}
    omnia_pass = float(omnia_stats.get("pass_at_1_pct") or 0.0)
    ts_ms = int(recorded_at_ms if recorded_at_ms is not None else time.time() * 1000)

    axes_map = {str(k): v for k, v in scorer_v5.V5_AXIS_NAMES.items()}
    compact_tasks = _compact_tasks(records)

    sb: Dict[str, Any] = {
        "schema_version": "5.0",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "recordedAtMs": ts_ms,
        "suite": "Omnia Suite v5 (11 Axes / 33 Tasks) + 9 AA/Frontier Public Suites",
        "axes": axes_map,
        "pass_rate": omnia_pass,
        "passRate": omnia_pass,
        "models": models,
        "ranking": scored.get("ranking") or [],
        "harnesses": scored.get("harnesses") or {},
        "mcnemar_vs_omnia": scored.get("mcnemar_vs_omnia") or {},
        "by_model": by_model,
        "matched_subsets": matched_subsets,
        "public_suites": public_suites,
        "public_suites_completed": [s for s in REQUIRED_PUBLIC_SUITES if s in public_suites],
        "public_suites_missing": [s for s in REQUIRED_PUBLIC_SUITES if s not in public_suites],
        "container_blockers": {
            "terminal_bench_41": (inventory.get("terminal_bench_41") or {}),
            "swe_bench_verified_pro": ((inventory.get("terminal_bench_41") or {}).get("container_runtime") or {}).get("swe_bench_verified_pro", {}),
        },
        "microbench": microbench.get("harnesses") or {},
        "tasks": compact_tasks,
        "summary": {
            "total_suite_v5_trials": len(records),
            "unique_suite_v5_tasks": len(compact_tasks),
            "harnesses_evaluated": len(scored.get("harnesses") or {}),
            "omnia_rank": (scored.get("ranking") or []).index("omnia") + 1 if "omnia" in (scored.get("ranking") or []) else None,
            "omnia_pass_at_1_pct": omnia_pass,
            "omnia_wilson_95ci": omnia_stats.get("pass_at_1_wilson_95ci"),
            "omnia_i14_composite": omnia_stats.get("i14_composite"),
            "omnia_binary_size_mb": omnia_stats.get("binary_size_mb"),
            "omnia_cold_start_ms": omnia_stats.get("cold_start_ms"),
            "zero_network_leaks": all(
                int(hs.get("network_leaks_total") or 0) == 0 for hs in (scored.get("harnesses") or {}).values()
            ),
            "public_suites_count": len(public_suites),
            "trace_roots": {
                "suite_v5": str(suite_v5_dir),
                "public_suites": str(public_dir),
                "microbench": str(microbench_path),
            },
        },
    }
    return sb


def _fmt(v: Any, suffix: str = "", fmt: str = ".2f") -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, int):
        return f"{v:,}{suffix}"
    if isinstance(v, float):
        return f"{v:{fmt}}{suffix}"
    return f"{v}{suffix}"


def _render_harness_table(scored_slice: Dict[str, Any]) -> List[str]:
    lines = [
        "| Rank | Harness | Runs | Solved | Pass@1 (95% Wilson CI) | Mean Score | C_cap_v5 | I14 | McNemar p vs Omnia | Wire TTFT | Active TPS | E2E TPS | Tok/Solved | Cost/Solved | KV Hit % | Tool/Edit Err % | Med RSS | Max JobMem | Med CPU | Cold Start | Size (MB) | Leaks |",
        "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    mc = scored_slice.get("mcnemar_vs_omnia") or {}
    for idx, h in enumerate(scored_slice.get("ranking") or [], 1):
        s = scored_slice["harnesses"][h]
        ci = s["pass_at_1_wilson_95ci"]
        mp = "ref" if h == "omnia" else f"{mc.get(h, {}).get('mcnemar_p', 1.0):.5f}"
        lines.append(
            f"| {idx} | **{h}** | {s['runs']} | {s['solved']} | "
            f"**{s['pass_at_1_pct']:.2f}%** [{ci[0]:.2f}, {ci[1]:.2f}] | "
            f"{s['mean_score']:.4f} | {s['c_cap_v5']:.2f} | **{s['i14_composite']:.2f}** | {mp} | "
            f"{_fmt(s.get('median_wire_ttft_ms'), 'ms', '.1f')} | "
            f"{_fmt(s.get('median_active_tps'), '', '.1f')} | "
            f"{_fmt(s.get('median_e2e_tps'), '', '.1f')} | "
            f"{_fmt(s.get('tokens_per_solved'), '', '.0f')} | "
            f"{'$' + format(s['cost_per_solved_usd'], '.4f') if s.get('cost_per_solved_usd') is not None else '—'} | "
            f"{s['pooled_kv_cache_hit_pct']:.2f}% | "
            f"{s['pooled_tool_error_rate_pct']:.2f}% / {s['pooled_edit_error_rate_pct']:.2f}% | "
            f"{_fmt(s.get('peak_rss_mb_median'), ' MB', '.1f')} | "
            f"{_fmt(s.get('peak_job_mem_mb_max'), ' MB', '.1f')} | "
            f"{_fmt(s.get('median_cpu_s'), 's', '.2f')} | "
            f"{_fmt(s.get('cold_start_ms'), 'ms', '.2f')} | "
            f"{_fmt(s.get('binary_size_mb'), '', '.2f')} | "
            f"{s['network_leaks_total']} |"
        )
    return lines


def format_final_scoreboard_markdown(sb: Dict[str, Any]) -> str:
    """Render comprehensive Markdown scoreboard covering Suite v5, Models, Public Suites & Blockers."""
    out: List[str] = [
        "# Omnia v5 vs 6 Clean-Room Competitors — Canonical Wave 3-4 Benchmark Scoreboard",
        "",
        f"- **Generated (UTC)**: `{sb['generated_at_utc']}`",
        f"- **Models**: `{', '.join(sb.get('models') or [])}` (`https://htmustc.id.vn` only; 0 Gemini calls, `agy` excluded)",
        f"- **Suite v5 Trials**: `{sb['summary']['total_suite_v5_trials']}` across `{sb['summary']['unique_suite_v5_tasks']}` tasks (11 axes)",
        f"- **Zero Network Leaks**: `{sb['summary']['zero_network_leaks']}`",
        f"- **Trace Roots**: `{sb['summary']['trace_roots']['suite_v5']}`, `{sb['summary']['trace_roots']['public_suites']}`",
        "",
        "## 1. Suite v5 Overall Pooled Leaderboard",
        "",
        *_render_harness_table(sb),
        "",
    ]

    for m, m_slice in sorted((sb.get("by_model") or {}).items()):
        out.extend([f"## 2. Suite v5 Model Slice — `{m}`", "", *_render_harness_table(m_slice), ""])

    for sub_name, sub_slice in (sb.get("matched_subsets") or {}).items():
        out.extend([f"### Matched Subset: `{sub_name}`", "", *_render_harness_table(sub_slice), ""])

    out.extend(["## 3. Windows-Runnable AA & Frontier Public Suites (9/9)", ""])
    pub = sb.get("public_suites") or {}
    if pub:
        out.extend([
            "| Public Suite | Group (`harness:model`) | Total | Passed | Pass@1 (95% Wilson CI) | Mean Score | McNemar p vs Omnia | Med Wall | Med TTFT | Tok/Solved | Cost/Solved | KV Hit % | Med RSS | Leaks | Artifact |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ])
        for sname in REQUIRED_PUBLIC_SUITES:
            if sname not in pub:
                continue
            info = pub[sname]
            summ = info.get("summary") or {}
            groups = summ.get("groups") or {}
            mc = summ.get("mcnemar_vs_omnia") or {}
            for gk, g in sorted(groups.items()):
                ci = g.get("wilson_95ci") or [0.0, 0.0]
                hname = g.get("harness", "")
                mp = "ref" if hname == "omnia" else (f"{mc[hname]['mcnemar_p']:.5f}" if hname in mc else "—")
                out.append(
                    f"| `{sname}` | `{gk}` | {g.get('total', 0)} | {g.get('passed', 0)} | "
                    f"**{g.get('pass_rate_pct', 0.0):.2f}%** [{ci[0]:.2f}, {ci[1]:.2f}] | "
                    f"{g.get('mean_score', 0.0):.4f} | {mp} | "
                    f"{_fmt(g.get('median_wall_s'), 's', '.1f')} | "
                    f"{_fmt(g.get('median_ttft_ms'), 'ms', '.1f')} | "
                    f"{_fmt(g.get('tokens_per_solved'), '', '.0f')} | "
                    f"{'$' + format(g['cost_per_solved_usd'], '.4f') if g.get('cost_per_solved_usd') is not None else '—'} | "
                    f"{_fmt(g.get('pooled_kv_cache_hit_pct'), '%', '.2f')} | "
                    f"{_fmt(g.get('peak_rss_mb_median'), ' MB', '.1f')} | "
                    f"{g.get('network_leaks', 0)} | `{Path(info['file']).name}` |"
                )
    out.append("")

    cb = sb.get("container_blockers") or {}
    tb = cb.get("terminal_bench_41") or {}
    crt = tb.get("container_runtime") or {}
    out.extend([
        "## 4. Honest Container Runtime Blockers (`Terminal-Bench 4.1` & `SWE-bench Verified/Pro`)",
        "",
        f"- **Container Runtime Available**: `{crt.get('container_runtime_available', False)}` (`docker={crt.get('docker_bin')}`, `podman={crt.get('podman_bin')}`, `wsl_installed={crt.get('wsl_installed')}`)",
        f"- **Terminal-Bench 4.1 Audit**: `{tb.get('total_task_dirs', 0)}` task dirs, `{tb.get('unmodified_windows_compatible', 0)}` unmodified Windows compatible, `{tb.get('no_linux_pkg_candidates_requiring_path_remap', 0)}` no-Linux-pkg path-remap candidates.",
        f"- **Exact Blocker**: {crt.get('exact_blocker') or 'Linux container runtime unavailable.'}",
        "",
    ])
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate canonical final_scoreboard_v5.{json,md}")
    ap.add_argument("--suite-v5-dir", type=Path, default=DEFAULT_SUITE_V5_DIR)
    ap.add_argument("--public-dir", type=Path, default=DEFAULT_PUBLIC_DIR)
    ap.add_argument("--microbench", type=Path, default=DEFAULT_MICROBENCH)
    ap.add_argument("--omnia-bin", type=Path, default=DEFAULT_OMNIA_BIN)
    ap.add_argument("--out-json", type=Path, default=DEFAULT_OUT_JSON)
    ap.add_argument("--out-md", type=Path, default=DEFAULT_OUT_MD)
    args = ap.parse_args()

    sb = build_final_scoreboard(
        suite_v5_dir=args.suite_v5_dir,
        public_dir=args.public_dir,
        microbench_path=args.microbench,
        omnia_bin=args.omnia_bin,
    )
    raw_json = json.dumps(sb, indent=2, ensure_ascii=False) + "\n"
    if len(raw_json.encode("utf-8")) > 2 * 1024 * 1024:
        raise RuntimeError(f"final_scoreboard_v5.json exceeds Studio 2 MiB limit: {len(raw_json.encode('utf-8'))} B")
    md = format_final_scoreboard_markdown(sb)

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_bytes(raw_json.encode("utf-8"))
    args.out_md.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.write_bytes(md.encode("utf-8"))
    print(f"Wrote {args.out_json} ({len(raw_json.encode('utf-8'))} B) and {args.out_md} ({len(md.encode('utf-8'))} B)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
