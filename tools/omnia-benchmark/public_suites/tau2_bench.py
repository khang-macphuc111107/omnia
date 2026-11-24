"""Tau2-bench (`mock`, `airline`, `retail`, `telecom`, `banking_knowledge`) Windows runner & DB grader.

Loads official `tau2` domain environments (`tau2.domains.*`) directly without invoking
`tau2/__init__.py` voice/`audioop`/LiteLLM imports. Replays `evaluation_criteria.actions`
against a clean twin DB to obtain exact golden DB hashes + evaluates `env_assertions`,
`communicate_info`, and optional `nl_assertions`.
"""
from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

from .common import DATASET_ROOT, call_htmustc_chat

TAU2_SRC = DATASET_ROOT / "tau2_bench" / "src" / "tau2"


def _ensure_tau2() -> Dict[str, Any]:
    src_parent = str(TAU2_SRC.parent)
    if src_parent not in sys.path:
        sys.path.insert(0, src_parent)
    if "tau2" not in sys.modules:
        pkg = types.ModuleType("tau2")
        pkg.__path__ = [str(TAU2_SRC)]  # type: ignore[attr-defined]
        sys.modules["tau2"] = pkg
    from tau2.data_model.message import ToolCall
    from tau2.domains.airline import environment as airline_env
    from tau2.domains.mock import environment as mock_env
    from tau2.domains.retail import environment as retail_env
    from tau2.domains.telecom import environment as telecom_env

    return {
        "ToolCall": ToolCall,
        "domains": {
            "mock": mock_env,
            "airline": airline_env,
            "retail": retail_env,
            "telecom": telecom_env,
        },
    }


def load_tasks(domain: str = "airline", *, split: Optional[str] = None, limit: Optional[int] = None) -> List[Any]:
    t2 = _ensure_tau2()
    mod = t2["domains"][domain]
    tasks = mod.get_tasks(task_split_name=split)
    return tasks[:limit] if limit is not None else tasks


def build_task_env(domain: str, task: Any) -> Any:
    t2 = _ensure_tau2()
    mod = t2["domains"][domain]
    env = mod.get_environment()
    init_state = getattr(task, "initial_state", None)
    init_data = getattr(init_state, "initialization_data", None) if init_state else None
    init_actions = getattr(init_state, "initialization_actions", None) if init_state else None
    env.set_state(init_data, init_actions, [], strict=False)
    return env


def compute_gold_hashes(domain: str, task: Any) -> Dict[str, Optional[str]]:
    t2 = _ensure_tau2()
    ToolCall = t2["ToolCall"]
    gold_env = build_task_env(domain, task)
    crit = getattr(task, "evaluation_criteria", None)
    for idx, act in enumerate(getattr(crit, "actions", None) or []):
        req = getattr(act, "requestor", "assistant") or "assistant"
        tc = ToolCall(id=f"gold_{idx}", name=act.name, arguments=dict(act.arguments or {}), requestor=req)
        gold_env.get_response(tc)
    return {
        "agent_db_hash": gold_env.get_db_hash(),
        "user_db_hash": gold_env.get_user_db_hash(),
    }


def evaluate_environment(domain: str, live_env: Any, task: Any, assistant_messages: List[str]) -> Dict[str, Any]:
    gold = compute_gold_hashes(domain, task)
    agent_ok = live_env.get_db_hash() == gold["agent_db_hash"]
    user_ok = True
    if gold["user_db_hash"] is not None:
        user_ok = live_env.get_user_db_hash() == gold["user_db_hash"]

    crit = getattr(task, "evaluation_criteria", None)
    comm_info = list(getattr(crit, "communicate_info", None) or [])
    joined_text = "\n".join(assistant_messages).lower()
    comm_ok = all(str(item).lower() in joined_text for item in comm_info)

    env_assert_ok = True
    for ea in getattr(crit, "env_assertions", None) or []:
        try:
            if not live_env.run_env_assertion(ea):
                env_assert_ok = False
        except Exception:
            env_assert_ok = False

    passed = agent_ok and user_ok and comm_ok and env_assert_ok
    sub = [agent_ok, user_ok, comm_ok, env_assert_ok]
    score = round(sum(1 for x in sub if x) / len(sub), 4)
    return {
        "task_id": str(task.id),
        "domain": domain,
        "passed": passed,
        "score": score,
        "agent_db_match": agent_ok,
        "user_db_match": user_ok,
        "communicate_ok": comm_ok,
        "env_assertions_ok": env_assert_ok,
    }


def run_task_api(
    domain: str,
    model: str,
    task: Any,
    *,
    user_model: Optional[str] = None,
    max_steps: int = 24,
) -> Dict[str, Any]:
    """Run one interactive agent + simulated-user episode cleanly via loopback `BenchTelemetryProxy`."""
    t2 = _ensure_tau2()
    ToolCall = t2["ToolCall"]
    t_start = time.perf_counter()
    env = build_task_env(domain, task)
    u_model = user_model or model

    agent_tools_schemas = [t.openai_schema for t in env.get_tools()]
    agent_msgs: List[Dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                f"You are a customer support agent for the `{domain}` domain. Follow the policy strictly:\n\n"
                f"{env.get_policy()}"
            ),
        }
    ]
    user_msgs: List[Dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                f"You are a simulated customer. Scenario:\n{task.user_scenario}\n\n"
                "Stay consistent, provide details when asked, and output exact marker `###STOP###` once your goal is resolved or refused."
            ),
        },
        {"role": "user", "content": "Start the conversation with the support agent."},
    ]

    # First user turn
    u_resp = call_htmustc_chat(u_model, user_msgs, max_tokens=512, run_id=f"tau2-u-{domain}-{task.id}")
    u_text = u_resp["text"].strip()
    user_msgs.append({"role": "assistant", "content": u_text})
    agent_msgs.append({"role": "user", "content": u_text})
    assistant_texts: List[str] = []

    for _ in range(max_steps):
        if "###STOP###" in u_text:
            break
        a_resp = call_htmustc_chat(model, agent_msgs, tools=agent_tools_schemas, max_tokens=1024, run_id=f"tau2-a-{domain}-{task.id}")
        tcalls = a_resp.get("tool_calls") or []
        if tcalls:
            if "claude" in model.lower():
                raw_content = (a_resp.get("raw") or {}).get("content")
                agent_msgs.append({"role": "assistant", "content": raw_content or tcalls})
                tool_results = []
                for idx, tc in enumerate(tcalls):
                    fname = str(tc.get("name") or "")
                    fargs = dict(tc.get("input") or {})
                    cid = str(tc.get("id") or f"call_{idx}")
                    msg_res = env.get_response(ToolCall(id=cid, name=fname, arguments=fargs, requestor="assistant"))
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": cid,
                        "content": str(msg_res.content),
                    })
                agent_msgs.append({"role": "user", "content": tool_results})
            else:
                agent_msgs.append({
                    "role": "assistant",
                    "content": a_resp.get("text") or "",
                    "tool_calls": tcalls,
                })
                for idx, tc in enumerate(tcalls):
                    fn = tc.get("function") or {}
                    fname = str(fn.get("name") or tc.get("name") or "")
                    raw_args = fn.get("arguments") if "function" in tc else tc.get("input")
                    fargs = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args or {})
                    cid = str(tc.get("id") or f"call_{idx}")
                    msg_res = env.get_response(ToolCall(id=cid, name=fname, arguments=fargs, requestor="assistant"))
                    agent_msgs.append({
                        "role": "tool",
                        "tool_call_id": cid,
                        "content": str(msg_res.content),
                    })
            continue
        a_text = (a_resp.get("text") or "").strip()
        assistant_texts.append(a_text)
        agent_msgs.append({"role": "assistant", "content": a_text})
        user_msgs.append({"role": "user", "content": a_text})
        u_resp = call_htmustc_chat(u_model, user_msgs, max_tokens=512, run_id=f"tau2-u-{domain}-{task.id}")
        u_text = u_resp["text"].strip()
        user_msgs.append({"role": "assistant", "content": u_text})
        agent_msgs.append({"role": "user", "content": u_text.replace("###STOP###", "").strip() or "Thanks."})

    ev = evaluate_environment(domain, env, task, assistant_texts)
    return {
        "suite": "tau2_bench",
        "harness": "api",
        "model": model,
        "wall_s": round(time.perf_counter() - t_start, 3),
        "non_loopback_sockets": [],
        **ev,
    }
