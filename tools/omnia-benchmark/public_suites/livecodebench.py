"""LiveCodeBench (`test6.jsonl`, 175 problems) Windows-native executor & harness runner.

Decodes `public_test_cases` and `private_test_cases` (`zlib` + `base64` + `pickle`/`json`),
extracts Python solutions, and evaluates BOTH `stdin` and LeetCode `functional` tests
inside isolated zero-network `python -B` subprocesses.
"""
from __future__ import annotations

import base64
import json
import pickle
import re
import shutil
import subprocess
import tempfile
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, clean_host_env, make_temp_workspace, python_exe, run_harness_in_workspace

LCB_PATH = DATASET_ROOT / "livecodebench" / "test6.jsonl"


def load_tasks(limit: Optional[int] = None, difficulty: Optional[str] = None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with LCB_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            d = json.loads(s)
            if difficulty and str(d.get("difficulty") or "").lower() != difficulty.lower():
                continue
            rows.append(d)
            if limit is not None and len(rows) >= limit:
                break
    return rows


def decode_test_cases(row: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    pub = json.loads(row["public_test_cases"]) if isinstance(row.get("public_test_cases"), str) else list(row.get("public_test_cases") or [])
    raw_priv = row.get("private_test_cases") or "[]"
    if isinstance(raw_priv, str):
        if raw_priv.lstrip().startswith("["):
            priv = json.loads(raw_priv)
        else:
            blob = zlib.decompress(base64.b64decode(raw_priv))
            try:
                loaded = pickle.loads(blob)
                priv = json.loads(loaded) if isinstance(loaded, str) else list(loaded)
            except Exception:
                priv = json.loads(blob.decode("utf-8"))
    else:
        priv = list(raw_priv)
    return {"public": pub, "private": priv}


def extract_python_code(text: str) -> str:
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text or "", flags=re.DOTALL | re.IGNORECASE)
    if blocks:
        return max(blocks, key=len).strip() + "\n"
    return (text or "").strip() + "\n"


def _norm_output(s: str) -> List[str]:
    return [ln.strip() for ln in (s or "").strip().splitlines() if ln.strip()]


def _run_one_stdin(py: str, sol_path: Path, tc: Dict[str, Any], timeout_s: float) -> bool:
    try:
        r = subprocess.run(
            [py, "-B", str(sol_path)],
            input=str(tc["input"]),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=clean_host_env(),
            timeout=timeout_s,
        )
        return r.returncode == 0 and _norm_output(r.stdout) == _norm_output(str(tc["output"]))
    except subprocess.TimeoutExpired:
        return False


def _run_one_functional(py: str, sol_path: Path, func_name: str, tc: Dict[str, Any], timeout_s: float) -> bool:
    driver = (
        "import json, sys, typing\n"
        "from typing import *\n"
        f"sys.path.insert(0, {json.dumps(str(sol_path.parent))})\n"
        "import solution\n"
        f"args = [json.loads(line) for line in {json.dumps(str(tc['input']))}.splitlines() if line.strip()]\n"
        f"expected = json.loads({json.dumps(str(tc['output']))})\n"
        f"fn = getattr(solution.Solution(), {json.dumps(func_name)}) if hasattr(solution, 'Solution') else getattr(solution, {json.dumps(func_name)})\n"
        "got = fn(*args)\n"
        "assert got == expected, f'{got!r} != {expected!r}'\n"
    )
    try:
        r = subprocess.run(
            [py, "-B", "-c", driver],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=clean_host_env(),
            timeout=timeout_s,
        )
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def evaluate_solution(row: Dict[str, Any], code: str, *, timeout_per_test_s: float = 3.0) -> Dict[str, Any]:
    cases = decode_test_cases(row)
    all_cases = cases["public"] + cases["private"]
    meta = row.get("metadata") or {}
    if isinstance(meta, str):
        meta = json.loads(meta) if meta.strip() else {}
    func_name = meta.get("func_name")

    py = python_exe()
    tmp = Path(tempfile.mkdtemp(prefix="lcb_eval_"))
    try:
        sol_path = tmp / "solution.py"
        sol_body = "from typing import *\nimport math, collections, heapq, bisect, itertools, functools\n\n" + code
        sol_path.write_text(sol_body, encoding="utf-8", newline="\n")
        passed_cnt = 0
        for tc in all_cases:
            ttype = tc.get("testtype") or ("functional" if func_name else "stdin")
            ok = (
                _run_one_functional(py, sol_path, str(func_name), tc, timeout_per_test_s)
                if ttype == "functional" and func_name
                else _run_one_stdin(py, sol_path, tc, timeout_per_test_s)
            )
            if ok:
                passed_cnt += 1
            else:
                # Fail fast? Keep counting partial score across cases up to cap 40
                pass
        total = len(all_cases)
        return {
            "task_id": str(row.get("question_id")),
            "passed": total > 0 and passed_cnt == total,
            "score": round(passed_cnt / total, 4) if total else 0.0,
            "tests_passed": passed_cnt,
            "tests_total": total,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_task(
    harness: str,
    model: str,
    row: Dict[str, Any],
    *,
    timeout_s: int = 240,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    qid = str(row["question_id"])
    ws = make_temp_workspace("lcb", "livecodebench")
    try:
        cases = decode_test_cases(row)
        starter = row.get("starter_code") or ""
        (ws / "solution.py").write_text(starter, encoding="utf-8", newline="\n")
        (ws / "PROBLEM.md").write_text(
            f"# {row.get('question_title', qid)}\n\n{row.get('question_content', '')}\n\n"
            f"## Public Examples\n```json\n{json.dumps(cases['public'], indent=2)}\n```\n",
            encoding="utf-8",
            newline="\n",
        )
        prompt = (
            f"Solve `{row.get('question_title', qid)}` described in `PROBLEM.md`. "
            "Write a complete, efficient Python 3 solution into `solution.py` (preserving exact class/function signature if `solution.py` already has starter code, otherwise reading stdin and writing stdout) "
            "and test it against all public examples."
        )
        run_res = run_harness_in_workspace("livecodebench", qid, harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        sol_text = (ws / "solution.py").read_text(encoding="utf-8", errors="replace")
        if sol_text.strip() == starter.strip():
            sol_text = extract_python_code(run_res.get("final_assistant_text") or "")
        ev = evaluate_solution(row, sol_text)
        return {**run_res, **ev, "difficulty": row.get("difficulty")}
    finally:
        shutil.rmtree(ws, ignore_errors=True)
