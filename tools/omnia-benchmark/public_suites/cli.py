"""Unified CLI for all 9 AA & frontier public suites + TB4.1 / SWE-bench container audit."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

_BENCH_DIR = str(Path(__file__).resolve().parent.parent)
if _BENCH_DIR not in sys.path:
    sys.path.insert(0, _BENCH_DIR)
_VENV_SITE = Path(r"D:\omnia-bench\.venv\Lib\site-packages")
if _VENV_SITE.exists() and str(_VENV_SITE) not in sys.path:
    sys.path.append(str(_VENV_SITE))
if not __package__:
    __package__ = "public_suites"

import runner_v5

from . import (
    aa_lcr,
    aider_polyglot,
    bfcl_v4,
    compaction_bench,
    livecodebench,
    locomo,
    longmemeval,
    swe_atlas_qna,
    tau2_bench,
    terminal_bench_subset,
)
from .common import DEFAULT_PUBLIC_OUT, summarize_suite_results

ALL7_HARNESSES = list(runner_v5.V5_HARNESSES)


def build_inventory() -> Dict[str, Any]:
    """Enumerate exact task counts, host toolchains, and Windows/container readiness."""
    swe_n = len(swe_atlas_qna.load_tasks())
    lcb_n = len(livecodebench.load_tasks())
    bfcl_counts = {cat: len(bfcl_v4.load_category(cat)) for cat in bfcl_v4.CATEGORY_FILE_MAP}
    tau2_counts = {dom: len(tau2_bench.load_tasks(dom)) for dom in ("mock", "airline", "retail", "telecom")}
    loc_convs = locomo.load_tasks()
    loc_qas = sum(len(c.get("qa") or []) for c in loc_convs)
    lme_n = len(longmemeval.load_tasks())
    cb_n = len(compaction_bench.load_tasks("all"))
    aider_items = aider_polyglot.discover_exercises()
    aider_by_lang: Dict[str, Dict[str, int]] = {}
    for it in aider_items:
        d = aider_by_lang.setdefault(it["language"], {"total": 0, "runnable": 0, "blocked": 0})
        d["total"] += 1
        d["runnable" if it["runnable"] else "blocked"] += 1
    aalcr_n = len(aa_lcr.load_tasks())
    tb41 = terminal_bench_subset.audit_terminal_bench_41()

    return {
        "swe_atlas_qna_aa": {"tasks": swe_n, "windows_runnable": True},
        "livecodebench": {"tasks": lcb_n, "windows_runnable": True},
        "bfcl_v4": {"categories": len(bfcl_counts), "total_tasks": sum(bfcl_counts.values()), "by_category": bfcl_counts, "windows_runnable": True},
        "tau2_bench": {"total_tasks": sum(tau2_counts.values()), "by_domain": tau2_counts, "windows_runnable": True},
        "locomo": {"conversations": len(loc_convs), "qas": loc_qas, "windows_runnable": True},
        "longmemeval": {"qas": lme_n, "windows_runnable": True},
        "compaction_bench": {"cases": cb_n, "windows_runnable": True},
        "aider_polyglot": {"total": len(aider_items), "by_language": aider_by_lang, "toolchains": aider_polyglot.detect_toolchains()},
        "aa_lcr": {"tasks": aalcr_n, "windows_runnable": True},
        "terminal_bench_41": {
            "total_task_dirs": tb41.get("total_task_dirs", 0),
            "unmodified_windows_compatible": len(tb41.get("unmodified_windows_compatible") or []),
            "no_linux_pkg_candidates_requiring_path_remap": len(tb41.get("no_linux_pkg_candidates_requiring_path_remap") or []),
            "container_runtime": tb41.get("container_runtime"),
        },
    }


def _task_key(suite: str, row: Dict[str, Any]) -> str:
    return str(row.get("task_id") or row.get("id") or row.get("sample_id") or row.get("question_id") or row.get("case_id") or "")


def _load_existing_rows(out_p: Path) -> List[Dict[str, Any]]:
    if not out_p.exists():
        return []
    try:
        data = json.loads(out_p.read_text(encoding="utf-8"))
        return list(data.get("rows") or []) if isinstance(data, dict) else list(data or [])
    except Exception:
        return []


def _write_rows(suite: str, out_p: Path, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary = summarize_suite_results(suite, rows)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2) + "\n", encoding="utf-8", newline="\n")
    return summary


def _stratified_interleave(items: List[Tuple[str, Any]], key_fn: Any, limit: int | None) -> List[Tuple[str, Any]]:
    """Round-robin interleave items across strata so any `--limit` covers every bucket evenly."""
    buckets: Dict[str, List[Tuple[str, Any]]] = {}
    for pair in items:
        k = str(key_fn(pair) or "default")
        buckets.setdefault(k, []).append(pair)
    out: List[Tuple[str, Any]] = []
    idx = 0
    keys = list(buckets.keys())
    while len(out) < (limit if limit is not None else len(items)):
        progressed = False
        for k in keys:
            b = buckets[k]
            if idx < len(b):
                out.append(b[idx])
                progressed = True
                if limit is not None and len(out) >= limit:
                    break
        if not progressed:
            break
        idx += 1
    return out


def _select_tasks_for_suite(args: argparse.Namespace) -> List[Tuple[str, Any]]:
    """Return deterministic `(task_key, payload)` work items for any public suite."""
    strat = bool(getattr(args, "stratified", False))
    lim = None if strat else args.limit
    if args.suite == "swe_atlas_qna_aa":
        tasks = swe_atlas_qna.load_tasks(limit=lim, category=None if args.category in ("all", "simple_python") else args.category)
        items = [(str(t["task_id"]), t) for t in tasks]
        return _stratified_interleave(items, lambda p: p[1].get("repository_url"), args.limit) if strat else items
    if args.suite == "livecodebench":
        items = [(str(r["question_id"]), r) for r in livecodebench.load_tasks(limit=lim)]
        return _stratified_interleave(items, lambda p: p[1].get("difficulty"), args.limit) if strat else items
    if args.suite == "bfcl_v4":
        cats = list(bfcl_v4.CATEGORY_FILE_MAP.keys()) if args.category == "all" else [args.category]
        items: List[Tuple[str, Any]] = []
        for cat in cats:
            for e in bfcl_v4.load_category(cat, limit=lim):
                items.append((str(e["id"]), e))
        return _stratified_interleave(items, lambda p: p[1].get("category"), args.limit) if strat else items
    if args.suite == "tau2_bench":
        doms = ["mock", "airline", "retail", "telecom"] if args.domain == "all" else [args.domain]
        items = []
        for dom in doms:
            for t in tau2_bench.load_tasks(dom, limit=lim):
                items.append((f"{dom}:{t.id}", (dom, t)))
        return _stratified_interleave(items, lambda p: p[1][0], args.limit) if strat else items
    if args.suite == "locomo":
        return [(str(c.get("sample_id") or i), c) for i, c in enumerate(locomo.load_tasks(limit=args.limit))]
    if args.suite == "longmemeval":
        items = [(str(e["question_id"]), e) for e in longmemeval.load_tasks(limit=lim)]
        return _stratified_interleave(items, lambda p: p[1].get("question_type"), args.limit) if strat else items
    if args.suite == "compaction_bench":
        items = [(str(c["case_id"]), c) for c in compaction_bench.load_tasks(limit=lim)]
        return _stratified_interleave(items, lambda p: f"{p[1].get('family')}:{p[1].get('difficulty')}", args.limit) if strat else items
    if args.suite == "aider_polyglot":
        langs = ["python", "javascript", "rust"] if args.lang in ("all", "all_runnable") else [args.lang]
        exs = [x for x in aider_polyglot.discover_exercises(langs) if x["runnable"]]
        items = [(str(it["id"]), it) for it in exs]
        return _stratified_interleave(items, lambda p: p[1].get("language"), args.limit) if strat else items[:args.limit]
    if args.suite == "aa_lcr":
        items = [(str(t["task_id"]), t) for t in aa_lcr.load_tasks(limit=lim)]
        return _stratified_interleave(items, lambda p: p[1].get("document_category"), args.limit) if strat else items
    raise ValueError(f"Unknown suite: {args.suite}")


def _run_one_item(args: argparse.Namespace, harness: str, model: str, payload: Any, omnia_bin: Path | None) -> Dict[str, Any]:
    if args.suite == "swe_atlas_qna_aa":
        return swe_atlas_qna.run_task(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "livecodebench":
        return livecodebench.run_task(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "bfcl_v4":
        return bfcl_v4.run_harness_single_turn(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "tau2_bench":
        dom, task = payload
        return tau2_bench.run_task_api(dom, model, task)
    if args.suite == "locomo":
        return locomo.run_conversation(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "longmemeval":
        return longmemeval.run_task(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "compaction_bench":
        return compaction_bench.run_case_harness(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "aider_polyglot":
        return aider_polyglot.run_exercise(harness, model, payload, omnia_bin=omnia_bin)
    if args.suite == "aa_lcr":
        return aa_lcr.run_task(harness, model, payload, omnia_bin=omnia_bin)
    raise ValueError(f"Unknown suite: {args.suite}")


def main() -> int:
    ap = argparse.ArgumentParser(description="AA & frontier public suite inventory and Windows runner")
    sub = ap.add_subparsers(dest="cmd", required=True)

    inv_p = sub.add_parser("inventory", help="Print complete public suite + container blocker inventory")
    inv_p.add_argument("--out", default=str(DEFAULT_PUBLIC_OUT / "public_suites_inventory.json"))

    run_p = sub.add_parser("run", help="Run a suite slice cleanly through loopback proxy")
    run_p.add_argument("--suite", required=True, choices=[
        "swe_atlas_qna_aa", "livecodebench", "bfcl_v4", "tau2_bench",
        "locomo", "longmemeval", "compaction_bench", "aider_polyglot", "aa_lcr",
    ])
    run_p.add_argument("--harness", default=None, help="Single harness (legacy alias)")
    run_p.add_argument("--harnesses", nargs="+", default=None, help="One or more clean-room harnesses (no agy)")
    run_p.add_argument("--model", default=None, help="Single model (legacy alias)")
    run_p.add_argument("--models", nargs="+", default=None, help="GPT/Claude models ONLY (no Gemini)")
    run_p.add_argument("--limit", type=int, default=5)
    run_p.add_argument("--category", default="simple_python")
    run_p.add_argument("--domain", default="mock")
    run_p.add_argument("--lang", default="python")
    run_p.add_argument("--cooldown-s", type=float, default=1.5)
    run_p.add_argument("--stratified", action="store_true", help="Interleave across repos/categories/difficulties before applying --limit")
    run_p.add_argument("--no-resume", action="store_true")
    run_p.add_argument("--omnia-bin", default=None)
    run_p.add_argument("--out", default=None)

    args = ap.parse_args()
    if args.cmd == "inventory":
        inv = build_inventory()
        out_p = Path(args.out)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(json.dumps(inv, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps(inv, indent=2))
        return 0

    harnesses = args.harnesses or ([args.harness] if args.harness else ["omnia"])
    models = args.models or ([args.model] if args.model else ["gpt-6.2-sol"])
    for h in harnesses:
        for m in models:
            runner_v5.validate_harness_and_model(h, m)

    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None
    out_p = Path(args.out) if args.out else (DEFAULT_PUBLIC_OUT / args.suite / f"{'_'.join(harnesses)}_{'_'.join(models)}_results.json")
    rows: List[Dict[str, Any]] = [] if args.no_resume else _load_existing_rows(out_p)
    done_keys = {
        ("api" if args.suite == "tau2_bench" else str(r.get("harness")), str(r.get("model")), _task_key(args.suite, r))
        for r in rows
    }

    work_items = _select_tasks_for_suite(args)
    run_harnesses = ["api"] if args.suite == "tau2_bench" else harnesses

    for m in models:
        for h in run_harnesses:
            for tkey, payload in work_items:
                sig = (h, m, tkey)
                if sig in done_keys:
                    continue
                row = _run_one_item(args, h, m, payload, omnia_bin)
                rows.append(row)
                done_keys.add(sig)
                _write_rows(args.suite, out_p, rows)
                print(
                    f"[{args.suite}] {h:8s} {m:18s} {tkey:28s} ... {'PASS' if row.get('passed') else 'FAIL'} "
                    f"s={row.get('score')} wall={row.get('wall_s')}s leaks={len(row.get('non_loopback_sockets') or [])}",
                    flush=True,
                )
                if args.cooldown_s > 0:
                    time.sleep(args.cooldown_s)

    summary = _write_rows(args.suite, out_p, rows)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
