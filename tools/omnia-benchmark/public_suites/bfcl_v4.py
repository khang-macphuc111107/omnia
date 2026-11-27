"""BFCL v4 official AST, Multi-Turn, Memory & Agentic evaluator + harness runner.

Uses extracted official `bfcl_eval` checkers (`D:\\OmniaData\\qa\\v5-bench\\ext_libs\\bfcl_eval`)
over JSON data under `D:\\OmniaData\\qa\\v5-bench\\datasets\\bfcl_v4\\data`.
"""
from __future__ import annotations

import json
import shutil
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, EXT_LIBS_ROOT, call_htmustc_chat, make_temp_workspace, run_harness_in_workspace

BFCL_DATA_DIR = DATASET_ROOT / "bfcl_v4" / "data"
BFCL_PA_DIR = BFCL_DATA_DIR / "possible_answer"
BFCL_FUNC_DOC_DIR = BFCL_DATA_DIR / "multi_turn_func_doc"

CATEGORY_FILE_MAP: Dict[str, str] = {
    "simple_python": "BFCL_v4_simple_python.json",
    "simple_java": "BFCL_v4_simple_java.json",
    "simple_javascript": "BFCL_v4_simple_javascript.json",
    "multiple": "BFCL_v4_multiple.json",
    "parallel": "BFCL_v4_parallel.json",
    "parallel_multiple": "BFCL_v4_parallel_multiple.json",
    "irrelevance": "BFCL_v4_irrelevance.json",
    "live_simple": "BFCL_v4_live_simple.json",
    "live_multiple": "BFCL_v4_live_multiple.json",
    "live_parallel": "BFCL_v4_live_parallel.json",
    "live_parallel_multiple": "BFCL_v4_live_parallel_multiple.json",
    "live_relevance": "BFCL_v4_live_relevance.json",
    "live_irrelevance": "BFCL_v4_live_irrelevance.json",
    "multi_turn_base": "BFCL_v4_multi_turn_base.json",
    "multi_turn_miss_func": "BFCL_v4_multi_turn_miss_func.json",
    "multi_turn_miss_param": "BFCL_v4_multi_turn_miss_param.json",
    "multi_turn_long_context": "BFCL_v4_multi_turn_long_context.json",
    "memory": "BFCL_v4_memory.json",
    "web_search": "BFCL_v4_web_search.json",
}


def load_format_sensitivity_ids() -> Dict[str, List[str]]:
    p = BFCL_DATA_DIR / "BFCL_v4_format_sensitivity.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _ensure_bfcl_eval() -> Any:
    if str(EXT_LIBS_ROOT) not in sys.path:
        sys.path.insert(0, str(EXT_LIBS_ROOT))
    if "bfcl_eval.constants.model_config" not in sys.modules:
        @dataclass
        class _MC:
            underscore_to_dot: bool = False

        class _Map(dict):
            def __missing__(self, k: str) -> _MC:
                # Both `run_single_turn_api` (via `name_map`) and `run_harness_single_turn`
                # (via `task.json`) pass original dotted BFCL function names to `ast_checker`,
                # so ground truth must keep dotted names rather than rewriting `.` -> `_`.
                return _MC(underscore_to_dot=False)

        mc = types.ModuleType("bfcl_eval.constants.model_config")
        mc.MODEL_CONFIG_MAPPING = _Map()
        sys.modules["bfcl_eval.constants.model_config"] = mc
    from bfcl_eval.constants.enums import Language
    from bfcl_eval.eval_checker.agentic_eval.agentic_checker import agentic_checker
    from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker
    from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker
    from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
    return {
        "Language": Language,
        "ast_checker": ast_checker,
        "multi_turn_checker": multi_turn_checker,
        "agentic_checker": agentic_checker,
        "execute_multi_turn_func_call": execute_multi_turn_func_call,
    }


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s:
                out.append(json.loads(s))
    return out


def load_category(category: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    fname = CATEGORY_FILE_MAP[category]
    entries = _read_jsonl(BFCL_DATA_DIR / fname)
    pa_file = BFCL_PA_DIR / fname
    pa_map: Dict[str, Any] = {}
    if pa_file.exists():
        for row in _read_jsonl(pa_file):
            pa_map[str(row["id"])] = row.get("ground_truth")
    for e in entries:
        e["category"] = category
        if str(e["id"]) in pa_map:
            e["ground_truth"] = pa_map[str(e["id"])]
    return entries[:limit] if limit is not None else entries


def load_multi_turn_docs(involved_classes: List[str]) -> List[Dict[str, Any]]:
    class_to_file = {
        "GorillaFileSystem": "gorilla_file_system.json",
        "MathAPI": "math_api.json",
        "MessageAPI": "message_api.json",
        "TwitterAPI": "posting_api.json",
        "PostingAPI": "posting_api.json",
        "TicketAPI": "ticket_api.json",
        "TradingBot": "trading_bot.json",
        "TravelAPI": "travel_booking.json",
        "VehicleControlAPI": "vehicle_control.json",
        "MemoryKV": "memory_kv.json",
        "MemoryRecSum": "memory_rec_sum.json",
        "MemoryVector": "memory_vector.json",
    }
    docs: List[Dict[str, Any]] = []
    for cls_name in involved_classes:
        fn = class_to_file.get(cls_name)
        if not fn:
            continue
        p = BFCL_FUNC_DOC_DIR / fn
        if p.exists():
            docs.extend(_read_jsonl(p))
    return docs


def evaluate_entry(
    entry: Dict[str, Any],
    model_output: Any,
    model_name: str = "gpt-6.2-sol",
) -> Dict[str, Any]:
    """Run official `bfcl_eval` checker appropriate to `entry['category']`."""
    bfcl = _ensure_bfcl_eval()
    cat = str(entry.get("category") or "")
    if cat in ("irrelevance", "live_irrelevance"):
        ok = not bool(model_output)
        return {"id": entry["id"], "category": cat, "passed": ok, "score": 1.0 if ok else 0.0}
    if cat == "live_relevance":
        ok = bool(model_output)
        return {"id": entry["id"], "category": cat, "passed": ok, "score": 1.0 if ok else 0.0}
    if cat.startswith("multi_turn_"):
        gt = entry.get("ground_truth") or []
        res = bfcl["multi_turn_checker"](model_output, gt, entry, cat, model_name)
        return {"id": entry["id"], "category": cat, "passed": bool(res.get("valid")), "score": 1.0 if res.get("valid") else 0.0, "detail": res}
    if cat in ("memory", "web_search"):
        gt = entry.get("ground_truth") or []
        res = bfcl["agentic_checker"](str(model_output), [str(x) for x in gt])
        return {"id": entry["id"], "category": cat, "passed": bool(res.get("valid")), "score": 1.0 if res.get("valid") else 0.0, "detail": res}

    Language = bfcl["Language"]
    lang = Language.PYTHON
    if cat == "simple_java":
        lang = Language.JAVA
    elif cat == "simple_javascript":
        lang = Language.JAVASCRIPT
    res = bfcl["ast_checker"](entry.get("function") or [], model_output, entry.get("ground_truth") or [], lang, cat, model_name)
    return {"id": entry["id"], "category": cat, "passed": bool(res.get("valid")), "score": 1.0 if res.get("valid") else 0.0, "detail": res}


def _to_openai_tools(funcs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    tools = []
    for f in funcs:
        params = dict(f.get("parameters") or {"type": "object", "properties": {}})
        if params.get("type") == "dict":
            params["type"] = "object"
        tools.append({
            "type": "function",
            "function": {
                "name": str(f["name"]).replace(".", "_"),
                "description": str(f.get("description") or ""),
                "parameters": params,
            },
        })
    return tools


def run_single_turn_api(model: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """Run single-turn BFCL entry directly through loopback proxy against `htmustc.id.vn` GPT/Claude."""
    funcs = list(entry.get("function") or [])
    q_turns = entry.get("question") or [[]]
    messages = [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in q_turns[0]]
    name_map = {str(f["name"]).replace(".", "_"): str(f["name"]) for f in funcs}
    res = call_htmustc_chat(model, messages, tools=_to_openai_tools(funcs), run_id=f"bfcl-{entry['id']}")
    decoded: List[Dict[str, Any]] = []
    for tc in res.get("tool_calls") or []:
        if "function" in tc:
            fn = name_map.get(tc["function"]["name"], tc["function"]["name"])
            args_raw = tc["function"].get("arguments") or "{}"
            args = json.loads(args_raw) if isinstance(args_raw, str) else dict(args_raw)
        else:
            fn = name_map.get(str(tc.get("name")), str(tc.get("name")))
            args = dict(tc.get("input") or {})
        decoded.append({fn: args})
    ev = evaluate_entry(entry, decoded, model_name=model)
    return {**ev, "harness": "api", "model": model, "wire": res.get("wire")}


def _format_py_call(fn_name: str, args: Dict[str, Any]) -> str:
    kv = ", ".join(f"{k}={repr(v)}" for k, v in args.items())
    return f"{fn_name}({kv})"


def _normalize_multi_turn_output(raw: Any, n_turns: int) -> List[List[List[str]]]:
    if not isinstance(raw, list):
        return [[] for _ in range(n_turns)]
    out: List[List[List[str]]] = []
    for turn in raw[:n_turns]:
        if isinstance(turn, list) and turn and isinstance(turn[0], list):
            steps: List[List[str]] = []
            for st in turn:
                steps.append([x if isinstance(x, str) else _format_py_call(next(iter(x)), next(iter(x.values()))) for x in st if isinstance(x, (str, dict)) and x])
            out.append(steps)
        elif isinstance(turn, list):
            calls = [x if isinstance(x, str) else _format_py_call(next(iter(x)), next(iter(x.values()))) for x in turn if isinstance(x, (str, dict)) and x]
            out.append([calls] if calls else [[]])
        else:
            out.append([[]])
    while len(out) < n_turns:
        out.append([[]])
    return out


def run_harness_single_turn(
    harness: str,
    model: str,
    entry: Dict[str, Any],
    *,
    timeout_s: int = 180,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    """Evaluate any Suite v5 CLI harness on BFCL schema selection (single-turn, multi-turn, memory/web)."""
    cat = str(entry.get("category") or "")
    ws = make_temp_workspace("bfcl", "bfcl_v4")
    try:
        is_mt = cat.startswith("multi_turn_")
        funcs = load_multi_turn_docs(entry.get("involved_classes") or []) if is_mt else list(entry.get("function", []))
        (ws / "task.json").write_text(json.dumps({
            "id": entry["id"],
            "category": cat,
            "question": entry["question"],
            "functions": funcs,
            **({"initial_config": entry.get("initial_config"), "excluded_function": entry.get("excluded_function")} if is_mt else {}),
        }, indent=2) + "\n", encoding="utf-8", newline="\n")
        if is_mt:
            prompt = (
                "Inspect `task.json` (`question` is a list of sequential user turns; `functions` lists available Python API methods; `initial_config` shows starting state). "
                "Write `tool_calls.json` as a JSON array with one entry per user turn, each entry being a JSON array of exact Python call strings "
                'like `"cd(folder=\'dir\')"` (matching `functions` parameter names) to solve every turn cleanly.'
            )
        else:
            prompt = (
                "Inspect `task.json` containing `question` and `functions` schemas. "
                "Emit ONLY the exact function calls required (or `[]` if none of the provided functions are relevant) "
                'into `tool_calls.json` as a JSON array of objects `{ "<function_name>": { "<arg>": <val>, ... } }`.'
            )
        run_res = run_harness_in_workspace("bfcl_v4", str(entry["id"]), harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        raw_out: Any = []
        out_p = ws / "tool_calls.json"
        if out_p.exists():
            try:
                raw_out = json.loads(out_p.read_text(encoding="utf-8"))
            except Exception:
                raw_out = []
        if is_mt:
            decoded: Any = _normalize_multi_turn_output(raw_out, len(entry.get("ground_truth") or []))
        elif cat in ("memory", "web_search"):
            decoded = raw_out if isinstance(raw_out, str) else json.dumps(raw_out)
        else:
            decoded = raw_out if isinstance(raw_out, list) else []
        ev = evaluate_entry(entry, decoded, model_name=model)
        return {**run_res, **ev}
    finally:
        shutil.rmtree(ws, ignore_errors=True)
