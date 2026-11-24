"""CompactionBench (`starter` 16 + `drills` 16 = 32 multi-cycle compaction cases).

Stages multi-cycle conversation turns + compaction checkpoints and deterministically
grades `multi`, `single`, and `text` probes against `answer`, `stale`, and `traps`.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, call_htmustc_chat, make_temp_workspace, run_harness_in_workspace

COMPACT_DIR = DATASET_ROOT / "compactbench"


def load_tasks(split: str = "all", limit: Optional[int] = None) -> List[Dict[str, Any]]:
    files = []
    if split in ("all", "starter"):
        files.append(COMPACT_DIR / "starter-00000-of-00001.jsonl")
    if split in ("all", "drills"):
        files.append(COMPACT_DIR / "drills-00000-of-00001.jsonl")
    rows: List[Dict[str, Any]] = []
    for fp in files:
        with fp.open("r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s:
                    rows.append(json.loads(s))
                    if limit is not None and len(rows) >= limit:
                        return rows
    return rows


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s./:-]+", "", str(s or "").lower())).strip()


def grade_probe(response_text: str, probe: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministically grade one CompactionBench probe (`multi`, `single`, or `text`)."""
    fmt = str(probe.get("format") or "text")
    ans = probe.get("answer")
    stale = [str(x) for x in (probe.get("stale") or [])]
    traps = [str(x) for x in (probe.get("traps") or [])]
    resp_norm = _norm(response_text)

    if fmt == "multi":
        exp_set = {_norm(x) for x in (ans or [])}
        options = [str(o) for o in (probe.get("options") or [])]
        selected: set[str] = set()
        # Try JSON array extraction first, else substring option match
        try:
            m = re.search(r"\[.*\]", response_text or "", flags=re.DOTALL)
            if m:
                arr = json.loads(m.group(0))
                if isinstance(arr, list):
                    selected = {_norm(x) for x in arr}
        except Exception:
            selected = set()
        if not selected and options:
            for opt in options:
                if _norm(opt) in resp_norm:
                    selected.add(_norm(opt))
        stale_hits = sum(1 for x in stale + traps if _norm(x) in selected or (_norm(x) and _norm(x) in resp_norm and not selected))
        tp = len(selected & exp_set)
        fp = len(selected - exp_set)
        fn = len(exp_set - selected)
        f1 = (2 * tp / (2 * tp + fp + fn)) if (2 * tp + fp + fn) > 0 else 0.0
        exact = selected == exp_set
        return {"key": probe.get("key"), "passed": exact and stale_hits == 0, "score": round(f1, 4), "stale_leak": stale_hits > 0}

    exp_vals = [str(x) for x in ans] if isinstance(ans, list) else [str(ans)]
    matched = any(_norm(v) in resp_norm for v in exp_vals if _norm(v))
    leaked_stale = any(_norm(s) in resp_norm and _norm(s) not in {_norm(v) for v in exp_vals} for s in stale + traps if _norm(s))
    passed = matched and not leaked_stale
    return {"key": probe.get("key"), "passed": passed, "score": 1.0 if passed else 0.0, "stale_leak": leaked_stale}


def run_case_api(model: str, case: Dict[str, Any]) -> Dict[str, Any]:
    """Run multi-cycle compaction simulation via `htmustc.id.vn` model keeping compacted summary state."""
    summary_memory = ""
    probe_results: List[Dict[str, Any]] = []
    for cyc in case.get("cycles") or []:
        turns_text = "\n".join(f"[{t.get('role')}]: {t.get('content')}" for t in cyc.get("turns") or [])
        comp_prompt = (
            "You are compacting long-running project state cleanly so superseded values are discarded and active rules/decisions remain exact.\n"
            f"Prior compacted state:\n{summary_memory or '(none)'}\n\n"
            f"New conversation cycle:\n{turns_text}\n\n"
            "Produce an updated lossless compacted state retaining every current requirement, file/constraint, decision, and superseding obsolete values."
        )
        comp_res = call_htmustc_chat(model, [{"role": "user", "content": comp_prompt}], max_tokens=2048, run_id=f"cb-comp-{case['case_id']}")
        summary_memory = comp_res["text"]

        for probe in cyc.get("probes") or []:
            opts = "\n".join(f"- {o}" for o in (probe.get("options") or []))
            q_prompt = (
                f"Based ONLY on this compacted memory state:\n{summary_memory}\n\n"
                f"Question: {probe['question']}\n"
                + (f"Options:\n{opts}\nReply with ONLY a JSON array of matching option strings." if probe.get("format") == "multi" else "Reply concisely with ONLY the current valid answer.")
            )
            ans_res = call_htmustc_chat(model, [{"role": "user", "content": q_prompt}], max_tokens=512, run_id=f"cb-probe-{case['case_id']}")
            probe_results.append(grade_probe(ans_res["text"], probe))

    passed_n = sum(1 for p in probe_results if p["passed"])
    total_n = len(probe_results)
    return {
        "suite": "compaction_bench",
        "task_id": case["case_id"],
        "family": case.get("family"),
        "difficulty": case.get("difficulty"),
        "harness": "api",
        "model": model,
        "probes_passed": passed_n,
        "probes_total": total_n,
        "score": round(passed_n / total_n, 4) if total_n else 0.0,
        "passed": total_n > 0 and passed_n == total_n,
        "stale_leaks": sum(1 for p in probe_results if p["stale_leak"]),
    }


def run_case_harness(
    harness: str,
    model: str,
    case: Dict[str, Any],
    *,
    timeout_s: int = 300,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    """Run CompactionBench case via isolated workspace staged cycle-by-cycle for full harness comparison."""
    ws = make_temp_workspace("cb", "compaction_bench")
    try:
        all_probes = []
        cycles_dir = ws / "cycles"
        cycles_dir.mkdir(parents=True, exist_ok=True)
        for cyc in case.get("cycles") or []:
            cidx = cyc.get("cycle")
            lines = [f"# Cycle {cidx}", ""]
            for t in cyc.get("turns") or []:
                lines.append(f"- **{t.get('role')}**: {t.get('content')}")
            (cycles_dir / f"cycle_{int(cidx):02d}.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            for p in cyc.get("probes") or []:
                all_probes.append({
                    "cycle": cidx,
                    "key": p.get("key"),
                    "format": p.get("format"),
                    "question": p.get("question"),
                    "options": p.get("options"),
                    "_probe": p,
                })
        final_c = max((int(c.get("cycle") or 0) for c in case.get("cycles") or []), default=0)
        final_probes = [
            {k: v for k, v in p.items() if k != "_probe"}
            for p in all_probes if int(p["cycle"]) == final_c
        ]
        (ws / "probes.json").write_text(json.dumps(final_probes, indent=2) + "\n", encoding="utf-8", newline="\n")
        prompt = (
            "Read `cycles/*.md` in chronological cycle order (`cycle_00.md` .. latest). Earlier rules/numbers/decisions can be superseded or retracted in later cycles. "
            "Answer EVERY probe in `probes.json` reflecting ONLY the state valid at the END of the final cycle, and write `answers.json` mapping `{probe_key: answer_string_or_list}`."
        )
        run_res = run_harness_in_workspace("compaction_bench", str(case["case_id"]), harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        ans_map = {}
        if (ws / "answers.json").exists():
            try:
                ans_map = json.loads((ws / "answers.json").read_text(encoding="utf-8"))
            except Exception:
                ans_map = {}
        graded = []
        for p in all_probes:
            if int(p["cycle"]) != final_c:
                continue
            val = ans_map.get(p["key"], "")
            txt = json.dumps(val) if isinstance(val, list) else str(val)
            graded.append(grade_probe(txt, p["_probe"]))
        passed_n = sum(1 for g in graded if g["passed"])
        total_n = len(graded)
        return {
            **run_res,
            "task_id": case["case_id"],
            "probes_passed": passed_n,
            "probes_total": total_n,
            "score": round(passed_n / total_n, 4) if total_n else 0.0,
            "passed": total_n > 0 and passed_n == total_n,
            "stale_leaks": sum(1 for g in graded if g["stale_leak"]),
        }
    finally:
        shutil.rmtree(ws, ignore_errors=True)
