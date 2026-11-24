"""AA-LCR (Artificial Analysis Long Context Reasoning — 100 tasks, 30 document sets)."""
from __future__ import annotations

import csv
import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, call_htmustc_chat, make_temp_workspace, run_harness_in_workspace

AA_LCR_CSV = DATASET_ROOT / "aa_lcr" / "AA-LCR_Dataset.csv"
AA_LCR_ZIP = DATASET_ROOT / "aa_lcr" / "AA-LCR_extracted-text.zip"


def load_tasks(limit: Optional[int] = None, category: Optional[str] = None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with AA_LCR_CSV.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if category and str(row.get("document_category") or "").lower() != category.lower():
                continue
            rows.append({
                "task_id": f"{row['document_set_id']}_{row['question_id']}",
                "document_category": row["document_category"],
                "document_set_id": row["document_set_id"],
                "question_id": row["question_id"],
                "question": row["question"],
                "answer": row["answer"],
                "data_source_filenames": [x.strip() for x in (row.get("data_source_filenames") or "").split(";") if x.strip()],
                "input_tokens": int(row.get("input_tokens") or 0),
            })
            if limit is not None and len(rows) >= limit:
                break
    return rows


def extract_document_set(document_set_id: str, dest_dir: Path) -> List[Path]:
    """Extract all `.txt` files belonging to `document_set_id` from `AA-LCR_extracted-text.zip`."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    extracted: List[Path] = []
    with zipfile.ZipFile(AA_LCR_ZIP, "r") as zf:
        for member in zf.namelist():
            if member.endswith("/"):
                continue
            parts = member.split("/")
            if len(parts) >= 3 and parts[-2] == document_set_id:
                out_file = dest_dir / Path(member).name
                out_file.write_bytes(zf.read(member))
                extracted.append(out_file)
    return extracted


def grade_answer(pred: str, gold: str, *, question: str = "", use_llm_judge: bool = False, judge_model: str = "gpt-6-luna") -> Dict[str, Any]:
    def norm(s: str) -> str:
        t = (s or "").replace("\\n", " ").lower()
        return re.sub(r"\s+", " ", re.sub(r"[^\w\s.%$-]+", " ", t)).strip()

    np = norm(pred)
    ng = norm(gold)
    exact = bool(ng) and (np == ng or ng in np)
    if not exact and use_llm_judge:
        res = call_htmustc_chat(
            judge_model,
            [{
                "role": "user",
                "content": (
                    f"Question: {question}\nExpected Reference Answer: {gold}\nCandidate Answer: {pred}\n"
                    'Respond with ONLY JSON: {"correct": true|false, "reason": "..."}'
                ),
            }],
            response_format={"type": "json_object"},
            max_tokens=200,
            run_id="aa-lcr-judge",
        )
        try:
            ver = bool(json.loads(res["text"]).get("correct"))
        except Exception:
            ver = False
        return {"passed": ver, "score": 1.0 if ver else 0.0, "method": "llm_judge"}
    return {"passed": exact, "score": 1.0 if exact else 0.0, "method": "deterministic"}


def run_task(
    harness: str,
    model: str,
    task: Dict[str, Any],
    *,
    judge_model: str = "gpt-6-luna",
    timeout_s: int = 360,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    ws = make_temp_workspace("aalcr", "aa_lcr")
    try:
        docs_dir = ws / "docs"
        files = extract_document_set(task["document_set_id"], docs_dir)
        prompt = (
            f"Analyze the {len(files)} extracted source documents in `./docs/` carefully and answer this multi-document reasoning question:\n\n"
            f"{task['question']}\n\n"
            "Write a clear, exact answer referencing exact figures/facts from the documents into `answer.txt`."
        )
        run_res = run_harness_in_workspace("aa_lcr", str(task["task_id"]), harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        ans = (ws / "answer.txt").read_text(encoding="utf-8", errors="replace").strip() if (ws / "answer.txt").exists() else (run_res.get("final_assistant_text") or "")
        ev = grade_answer(ans, task["answer"], question=task["question"], use_llm_judge=True, judge_model=judge_model)
        return {**run_res, **ev, "document_set_id": task["document_set_id"], "doc_files": len(files)}
    finally:
        shutil.rmtree(ws, ignore_errors=True)
