"""LoCoMo (10 multi-session conversations, 1,986 QA items) runner & grader."""
from __future__ import annotations

import json
import re
import shutil
import string
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, make_temp_workspace, run_harness_in_workspace

LOCOMO_PATH = DATASET_ROOT / "locomo" / "locomo10.json"

ABSTAIN_MARKERS = (
    "not mentioned",
    "no information",
    "cannot be determined",
    "can't be determined",
    "not provided",
    "unanswerable",
    "does not mention",
    "doesn't mention",
    "no record",
    "not specified",
    "unknown",
)


def load_tasks(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    data = json.loads(LOCOMO_PATH.read_text(encoding="utf-8"))
    return data[:limit] if limit is not None else data


def _normalize_text(text: str) -> List[str]:
    s = (text or "").lower()
    s = "".join(ch for ch in s if ch not in string.punctuation)
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    return s.split()


def token_f1(pred: str, gold: str) -> float:
    p_toks = _normalize_text(pred)
    g_toks = _normalize_text(gold)
    if not p_toks and not g_toks:
        return 1.0
    if not p_toks or not g_toks:
        return 0.0
    common = sum((Counter(p_toks) & Counter(g_toks)).values())
    if common == 0:
        return 0.0
    prec = common / len(p_toks)
    rec = common / len(g_toks)
    return round(2 * prec * rec / (prec + rec), 4)


def grade_qa(pred: str, qa_item: Dict[str, Any]) -> Dict[str, Any]:
    cat = int(qa_item.get("category") or 0)
    gold = str(qa_item.get("answer") or qa_item.get("adversarial_answer") or "")
    low_p = (pred or "").lower()
    if cat == 5:
        abstained = any(m in low_p for m in ABSTAIN_MARKERS) or not low_p.strip()
        return {"category": cat, "f1": 1.0 if abstained else 0.0, "passed": abstained}
    f1 = token_f1(pred, gold)
    em = " ".join(_normalize_text(pred)) == " ".join(_normalize_text(gold))
    contains = bool(gold.strip()) and " ".join(_normalize_text(gold)) in " ".join(_normalize_text(pred))
    passed = em or contains or f1 >= 0.5
    return {"category": cat, "f1": max(f1, 1.0 if contains else f1), "exact": em, "passed": passed}


def stage_workspace(conv: Dict[str, Any], ws: Path) -> List[Dict[str, Any]]:
    cobj = conv.get("conversation") or {}
    sess_dir = ws / "sessions"
    sess_dir.mkdir(parents=True, exist_ok=True)
    nums = sorted({int(k.split("_")[1]) for k in cobj if re.match(r"^session_\d+$", k)})
    for idx in nums:
        dt = cobj.get(f"session_{idx}_date_time", "")
        turns = cobj.get(f"session_{idx}") or []
        lines = [f"# Session {idx} ({dt})", ""]
        for t in turns:
            lines.append(f"- [{t.get('dia_id', '')}] **{t.get('speaker', '?')}**: {t.get('text', '')}")
        (sess_dir / f"session_{idx:02d}.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    questions = [{"idx": i, "question": q["question"], "category": q.get("category")} for i, q in enumerate(conv.get("qa") or [])]
    (ws / "questions.json").write_text(json.dumps(questions, indent=2) + "\n", encoding="utf-8", newline="\n")
    return questions


def run_conversation(
    harness: str,
    model: str,
    conv: Dict[str, Any],
    *,
    max_questions: Optional[int] = 50,
    timeout_s: int = 360,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    sid = str(conv.get("sample_id") or "conv")
    ws = make_temp_workspace("locomo", "locomo")
    try:
        questions = stage_workspace(conv, ws)
        qa_all = list(conv.get("qa") or [])
        if max_questions is not None:
            questions = questions[:max_questions]
            qa_all = qa_all[:max_questions]
            (ws / "questions.json").write_text(json.dumps(questions, indent=2) + "\n", encoding="utf-8", newline="\n")

        prompt = (
            "Read `sessions/*.md` and answer EVERY question in `questions.json` accurately based ONLY on the conversation history "
            "(if a question asks about something never mentioned or contradictory, explicitly answer `'not mentioned'`). "
            'Write `answers.json` as a JSON list of `{"idx": int, "answer": str}` sorted by `idx`.'
        )
        run_res = run_harness_in_workspace("locomo", sid, harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        ans_path = ws / "answers.json"
        by_idx: Dict[int, str] = {}
        if ans_path.exists():
            try:
                for row in json.loads(ans_path.read_text(encoding="utf-8")):
                    by_idx[int(row["idx"])] = str(row.get("answer") or "")
            except Exception:
                pass
        grades = [grade_qa(by_idx.get(i, ""), qa) for i, qa in enumerate(qa_all)]
        avg_f1 = round(sum(g["f1"] for g in grades) / len(grades), 4) if grades else 0.0
        pass_cnt = sum(1 for g in grades if g["passed"])
        return {
            **run_res,
            "task_id": sid,
            "qa_total": len(grades),
            "qa_passed": pass_cnt,
            "score": avg_f1,
            "passed": avg_f1 >= 0.65 and bool(grades),
        }
    finally:
        shutil.rmtree(ws, ignore_errors=True)
