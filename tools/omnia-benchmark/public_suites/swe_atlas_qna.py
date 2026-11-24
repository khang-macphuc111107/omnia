"""SWE-Atlas-QnA-AA (124 codebase Q&A tasks + 5-vote majority rubric grader).

Reads `D:\\OmniaData\\qa\\omp-20261124-harness-a\\swe-atlas-qna-aa\\test-00000-of-00001.parquet`.
Matches `rubric_evaluation_config.yaml`:
  - Strips numeric prefix like `"1.3: "` from rubric `title`.
  - Detects `"negative hli verifier"` annotations -> criterion is met when majority verdict is `"NO"`.
  - Runs 5 strict-JSON judge votes (`{"reason", "evidence", "verdict"}`) with majority decision (`>=3`).
  - Stages pinned Git repo checkouts cleanly at `repository_base_commit` before launching harness.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .common import SWE_ATLAS_PARQUET, call_htmustc_chat, make_temp_workspace, run_harness_in_workspace

REPO_CACHE_DIR = Path(r"D:\OmniaData\qa\v5-bench\repo_cache\swe_atlas")
DEFAULT_JUDGE_MODEL = "gpt-6-luna"

CriterionJudge = Callable[[str, str, Dict[str, Any]], Dict[str, Any]]


def load_tasks(limit: Optional[int] = None, category: Optional[str] = None) -> List[Dict[str, Any]]:
    import pyarrow.parquet as pq  # type: ignore

    tbl = pq.read_table(str(SWE_ATLAS_PARQUET))
    rows: List[Dict[str, Any]] = []
    cols = tbl.column_names
    for idx in range(tbl.num_rows):
        row = {c: tbl[c][idx].as_py() for c in cols}
        if category and str(row.get("category") or "").lower() != category.lower():
            continue
        if isinstance(row.get("rubric"), str):
            row["rubric_items"] = json.loads(row["rubric"])
        else:
            row["rubric_items"] = list(row.get("rubric") or [])
        rows.append(row)
        if limit is not None and len(rows) >= limit:
            break
    return rows


def strip_rubric_prefix(title: str) -> str:
    return re.sub(r"^\s*\d+(?:\.\d+)*\s*:\s*", "", title or "").strip()


def is_negative_criterion(item: Dict[str, Any]) -> bool:
    anns = item.get("annotations")
    if not anns:
        return False
    raw = json.dumps(anns).lower() if not isinstance(anns, str) else anns.lower()
    return "negative hli verifier" in raw


def _parse_judge_json(raw: str) -> Dict[str, Any]:
    s = (raw or "").strip()
    m = re.search(r"\{.*\}", s, flags=re.DOTALL)
    if m:
        s = m.group(0)
    try:
        parsed = json.loads(s)
        v = str(parsed.get("verdict") or "").strip().upper()
        if v not in ("YES", "NO"):
            v = "YES" if v.startswith("Y") else "NO"
        return {
            "reason": str(parsed.get("reason") or ""),
            "evidence": list(parsed.get("evidence") or []),
            "verdict": v,
        }
    except Exception:
        upper = raw.upper()
        return {"reason": raw[:300], "evidence": [], "verdict": "YES" if '"YES"' in upper or "VERDICT: YES" in upper else "NO"}


def default_htmustc_judge(prompt_text: str, answer_text: str, criterion: Dict[str, Any], judge_model: str = DEFAULT_JUDGE_MODEL) -> Dict[str, Any]:
    clean_title = strip_rubric_prefix(str(criterion.get("title") or ""))
    sys_msg = (
        "You are a strict software engineering rubric evaluator. Respond with ONLY a JSON object "
        'having keys {"reason": string, "evidence": [string], "verdict": "YES" | "NO"}. '
        'Output "YES" ONLY if the candidate answer explicitly and accurately satisfies the criterion.'
    )
    user_msg = (
        f"## Original Question\n{prompt_text}\n\n"
        f"## Rubric Criterion\n{clean_title}\n\n"
        f"## Candidate Answer\n{answer_text}\n"
    )
    res = call_htmustc_chat(
        judge_model,
        [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
        response_format={"type": "json_object"},
        temperature=0.2,
        max_tokens=512,
        run_id="swe-atlas-judge",
    )
    return _parse_judge_json(res["text"])


def grade_answer(
    task: Dict[str, Any],
    answer_text: str,
    *,
    votes_per_criterion: int = 5,
    judge_fn: Optional[CriterionJudge] = None,
    judge_model: str = DEFAULT_JUDGE_MODEL,
) -> Dict[str, Any]:
    """Grade one answer against all task rubric criteria using 5-vote majority + negative polarity."""
    items = task.get("rubric_items") or []
    fn = judge_fn or (lambda p, a, c: default_htmustc_judge(p, a, c, judge_model=judge_model))
    prompt_text = str(task.get("prompt") or "")

    criterion_results: List[Dict[str, Any]] = []
    met_count = 0
    for crit in items:
        neg = is_negative_criterion(crit)
        votes: List[Dict[str, Any]] = []
        verdicts: List[str] = []
        for _ in range(votes_per_criterion):
            v = fn(prompt_text, answer_text, crit)
            verdict = "YES" if str(v.get("verdict") or "").upper() == "YES" else "NO"
            votes.append({**v, "verdict": verdict})
            verdicts.append(verdict)
        yes_n = Counter(verdicts)["YES"]
        no_n = Counter(verdicts)["NO"]
        majority_verdict = "YES" if yes_n > no_n else "NO"
        criterion_met = (majority_verdict == "NO") if neg else (majority_verdict == "YES")
        if criterion_met:
            met_count += 1
        criterion_results.append({
            "id": crit.get("id"),
            "title": strip_rubric_prefix(str(crit.get("title") or "")),
            "negative_polarity": neg,
            "yes_votes": yes_n,
            "no_votes": no_n,
            "majority_verdict": majority_verdict,
            "met": criterion_met,
        })

    total = len(items)
    score = round(met_count / total, 4) if total else 0.0
    return {
        "task_id": task.get("task_id"),
        "passed": total > 0 and met_count == total,
        "score": score,
        "criteria_met": met_count,
        "criteria_total": total,
        "criteria": criterion_results,
    }


def prepare_repo_workspace(task: Dict[str, Any], workspace: Path) -> Path:
    """Shallow-cache one exact `repository_base_commit` cleanly before launching harness."""
    slug = str(task["repository_url"]).strip()
    commit = str(task["repository_base_commit"]).strip()
    REPO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_dir = REPO_CACHE_DIR / f"{slug.replace('/', '__')}__{commit[:12]}.git"
    if not (cache_dir / "HEAD").exists():
        shutil.rmtree(cache_dir, ignore_errors=True)
        tmp_cache = REPO_CACHE_DIR / f".tmp_{slug.replace('/', '__')}_{commit[:12]}"
        shutil.rmtree(tmp_cache, ignore_errors=True)
        url = f"https://github.com/{slug}.git"
        subprocess.run(["git", "init", "--bare", str(tmp_cache)], check=True, capture_output=True, text=True)
        fetch = subprocess.run(
            ["git", "--git-dir", str(tmp_cache), "fetch", "--depth", "1", url, commit],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if fetch.returncode != 0:
            shutil.rmtree(tmp_cache, ignore_errors=True)
            subprocess.run(
                ["git", "clone", "--filter=blob:none", "--bare", url, str(tmp_cache)],
                check=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
        subprocess.run(
            ["git", "--git-dir", str(tmp_cache), "update-ref", "refs/heads/bench_base", commit],
            check=True,
            capture_output=True,
            text=True,
        )
        tmp_cache.replace(cache_dir)
    repo_dir = workspace / "repo"
    subprocess.run(
        ["git", "clone", "-c", "core.longpaths=true", "--local", "--no-checkout", str(cache_dir), str(repo_dir)],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    subprocess.run(
        ["git", "-C", str(repo_dir), "-c", "core.longpaths=true", "checkout", "--force", commit],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return repo_dir


def extract_final_answer(text: str) -> str:
    m = re.search(r"<<FINAL_ANSWER>>\s*(.*?)\s*<<FINAL_ANSWER>>", text or "", flags=re.DOTALL)
    return m.group(1).strip() if m else (text or "").strip()


def run_task(
    harness: str,
    model: str,
    task: Dict[str, Any],
    *,
    judge_model: str = DEFAULT_JUDGE_MODEL,
    timeout_s: int = 360,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    ws = make_temp_workspace("swe_atlas", "swe_atlas_qna_aa")
    try:
        repo_dir = prepare_repo_workspace(task, ws)
        prompt = (
            f"{task['prompt']}\n\n"
            "Do NOT modify any files in the repository. Inspect the repository in the current working directory directly to ground every claim in exact files, symbols, and code paths. "
            "Wrap your complete final answer in `<<FINAL_ANSWER>>` tags when finished."
        )
        run_res = run_harness_in_workspace(
            "swe_atlas_qna_aa",
            str(task["task_id"]),
            harness,
            model,
            prompt,
            repo_dir,
            timeout_s=timeout_s,
            omnia_bin=omnia_bin,
        )
        ans_text = extract_final_answer(run_res.get("final_assistant_text") or "")
        grade = grade_answer(task, ans_text, judge_model=judge_model)
        return {**run_res, **grade, "repository_url": task["repository_url"], "category": task.get("category")}
    finally:
        shutil.rmtree(ws, ignore_errors=True)
