"""LongMemEval (`longmemeval_oracle.json`, 500 multi-session memory questions) runner & grader."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, make_temp_workspace, run_harness_in_workspace
from .locomo import ABSTAIN_MARKERS, _normalize_text, token_f1

LME_PATH = DATASET_ROOT / "longmemeval" / "longmemeval_oracle.json"


def load_tasks(limit: Optional[int] = None, question_type: Optional[str] = None) -> List[Dict[str, Any]]:
    data = json.loads(LME_PATH.read_text(encoding="utf-8"))
    if question_type:
        data = [x for x in data if str(x.get("question_type") or "") == question_type]
    return data[:limit] if limit is not None else data


def grade_prediction(pred: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    qid = str(entry.get("question_id") or "")
    qtype = str(entry.get("question_type") or "")
    gold = str(entry.get("answer") or "")
    is_abstention = qid.endswith("_abs") or "not enough information" in gold.lower()
    low_p = (pred or "").lower()
    if is_abstention:
        ok = any(m in low_p for m in ABSTAIN_MARKERS) or "insufficient" in low_p
        return {"question_id": qid, "question_type": qtype, "passed": ok, "score": 1.0 if ok else 0.0}
    f1 = token_f1(pred, gold)
    g_norm = " ".join(_normalize_text(gold))
    p_norm = " ".join(_normalize_text(pred))
    ok = (g_norm == p_norm) or (bool(g_norm) and g_norm in p_norm) or f1 >= 0.55
    return {"question_id": qid, "question_type": qtype, "passed": ok, "score": round(max(f1, 1.0 if ok else f1), 4)}


def stage_workspace(entry: Dict[str, Any], ws: Path) -> None:
    sess_dir = ws / "sessions"
    sess_dir.mkdir(parents=True, exist_ok=True)
    dates = entry.get("haystack_dates") or []
    sids = entry.get("haystack_session_ids") or []
    sessions = entry.get("haystack_sessions") or []
    for idx, sess in enumerate(sessions):
        dt = dates[idx] if idx < len(dates) else ""
        sid = sids[idx] if idx < len(sids) else f"s{idx}"
        lines = [f"# Session {idx+1} (id={sid}, date={dt})", ""]
        for msg in sess or []:
            lines.append(f"**{msg.get('role', 'user')}**: {msg.get('content', '')}")
            lines.append("")
        (sess_dir / f"session_{idx+1:03d}_{sid}.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")
    (ws / "question.json").write_text(json.dumps({
        "question_id": entry.get("question_id"),
        "question_type": entry.get("question_type"),
        "question_date": entry.get("question_date"),
        "question": entry.get("question"),
    }, indent=2) + "\n", encoding="utf-8", newline="\n")


def run_task(
    harness: str,
    model: str,
    entry: Dict[str, Any],
    *,
    timeout_s: int = 240,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    qid = str(entry["question_id"])
    ws = make_temp_workspace("lme", "longmemeval")
    try:
        stage_workspace(entry, ws)
        prompt = (
            f"Question Date: {entry.get('question_date', '')}\n"
            f"Question: {entry.get('question', '')}\n\n"
            "Inspect `sessions/*.md` (paying strict attention to chronological timestamps, preference updates, and abstention when evidence is missing) "
            "and write ONLY your concise final answer string into `answer.txt` (or `'not mentioned'` if unanswerable)."
        )
        run_res = run_harness_in_workspace("longmemeval", qid, harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        ans = (ws / "answer.txt").read_text(encoding="utf-8", errors="replace").strip() if (ws / "answer.txt").exists() else (run_res.get("final_assistant_text") or "")
        ev = grade_prediction(ans, entry)
        return {**run_res, **ev}
    finally:
        shutil.rmtree(ws, ignore_errors=True)
