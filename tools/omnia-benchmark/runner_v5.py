"""Suite v5 Clean-Room Benchmark Runner (33 tasks, 7 harnesses, ALL HTMUSTC models, parallel workers & effort levels).

Strict execution guarantees:
  - Excludes `agy` strictly while allowing ALL live `https://htmustc.id.vn` text/coding model families
    (`claude-*`, `gpt-*`, `gemini-*`, `deepseek-*`, `glm-*`, `kimi-*`, `qwen*`, etc.).
  - Routes 100% of API traffic through loopback `BenchTelemetryProxy` with live
    non-loopback egress socket audits (`audit_non_loopback_sockets`).
  - Wraps every harness in `ProcessTreeMonitor` (Win32 Job Object + 50 ms RSS/CPU poll).
  - Separates harness cold start, wire TTFT, client TTFT, active decode TPS, E2E TPS,
    canonical token totals, KV hit rate, tool/edit error rates, effort level, and container/OS checks.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from bench_telemetry_proxy import BenchTelemetryProxy
from cleanroom import (
    BENCH_ROOT,
    SAFE_SYSTEM_KEYS,
    assert_clean_ancestors,
    audit_non_loopback_sockets,
    build_minimal_path,
    prepare_harness_launch,
)
from proc_monitor import ProcessTreeMonitor, get_process_tree_pids, terminate_process_tree
import runner as legacy_runner
import runner_v4

V5_HARNESSES: Tuple[str, ...] = ("omnia", "codex", "claude", "opencode", "goose", "omp", "dsh")
V5_DEFAULT_MODELS: Tuple[str, ...] = ("gpt-6.2-sol", "claude-sonnet-5-5")
DEFAULT_RESULTS_ROOT = Path(r"D:\OmniaData\qa\v5-bench\suite-v5")
MODELS_YML_PATH = Path(r"D:\OmniaData\omp-tui\agent\models.yml")

EDIT_TOOL_NAMES = frozenset({
    "write",
    "edit",
    "replace",
    "patch",
    "write_file",
    "edit_file",
    "apply_patch",
    "create_file",
    "replace_file_content",
    "multi_replace_file_content",
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "developer__text_editor",
})


def validate_harness_and_model(harness: str, model: str) -> None:
    """Enforce Suite v5 competitor allowlist (no agy) while allowing all HTMUSTC text/coding models."""
    h = (harness or "").strip().lower()
    if h == "agy":
        raise ValueError("Harness 'agy' is strictly excluded from Suite v5 benchmarks")
    if h not in V5_HARNESSES:
        raise ValueError(f"Unsupported Suite v5 harness '{harness}'; expected one of {V5_HARNESSES}")
    m = (model or "").strip().lower()
    if not m:
        raise ValueError(f"Model '{model}' disallowed: model name cannot be empty")


def load_htmustc_api_key(model: str) -> Optional[str]:
    """Read HTMUSTC API key cleanly at runtime via env or models.yml without printing/logging."""
    env_key = os.environ.get("HTMUSTC_API_KEY")
    if env_key:
        return env_key.strip()
    if not MODELS_YML_PATH.exists():
        return None
    low = (model or "").lower()
    if "claude" in low:
        preferred = ("htmustc-claude", "htmustc-openai", "htmustc-gemini")
    elif "gemini" in low:
        preferred = ("htmustc-gemini", "htmustc-openai", "htmustc-claude")
    else:
        preferred = ("htmustc-openai", "htmustc-claude", "htmustc-gemini")
    raw = MODELS_YML_PATH.read_text(encoding="utf-8", errors="replace")
    try:
        import yaml  # type: ignore
        parsed = yaml.safe_load(raw) or {}
        providers = parsed.get("providers") or {}
        for pname in preferred:
            val = (providers.get(pname) or {}).get("apiKey")
            if val:
                return str(val).strip()
        for pname, prov in providers.items():
            if "htmustc" in str(pname).lower() and isinstance(prov, dict) and prov.get("apiKey"):
                return str(prov["apiKey"]).strip()
    except Exception:
        pass
    # Minimal zero-dependency fallback YAML key extractor scoped strictly to preferred providers
    for target_provider in preferred:
        in_target = False
        target_indent: Optional[int] = None
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            indent = len(line) - len(line.lstrip(" "))
            if re.match(rf"^{re.escape(target_provider)}\s*:", stripped):
                in_target = True
                target_indent = indent
                continue
            if in_target and target_indent is not None and indent <= target_indent and ":" in stripped:
                break
            if in_target and stripped.startswith("apiKey:"):
                val = stripped.split(":", 1)[1].strip().strip("'\"")
                if val:
                    return val
    return None


def _is_edit_tool(name: str) -> bool:
    low = (name or "").strip().lower()
    if low in EDIT_TOOL_NAMES:
        return True
    return any(tok in low for tok in ("edit", "write_file", "apply_patch", "replace_file", "text_editor"))


def _scan_goose_edit_stats(stdout_events: List[Tuple[float, str]], t0: float) -> Dict[str, Any]:
    edit_calls = 0
    edit_errors = 0
    req_is_edit: Dict[str, bool] = {}
    recent_sigs: List[str] = []
    client_ttft_s: Optional[float] = None
    for ts, line in stdout_events:
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "message":
            continue
        msg = ev.get("message") or {}
        for item in msg.get("content") or []:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if client_ttft_s is None and msg.get("role") == "assistant" and itype in ("text", "thinking", "toolRequest"):
                client_ttft_s = max(0.0, ts - t0)
            if itype == "toolRequest":
                rid = str(item.get("id") or "")
                tc = (item.get("toolCall") or {}).get("value") or {}
                tname = str(tc.get("name") or "")
                is_ed = _is_edit_tool(tname)
                if rid:
                    req_is_edit[rid] = is_ed
                if is_ed:
                    edit_calls += 1
                sig = hashlib.sha256(f"{tname}:{json.dumps(tc.get('arguments'), sort_keys=True, default=str)}".encode()).hexdigest()[:12]
                recent_sigs.append(sig)
            elif itype == "toolResponse":
                rid = str(item.get("id") or "")
                tr = item.get("toolResult") or {}
                is_err = str(tr.get("status") or "").lower() == "error" or tr.get("isError") is True
                if is_err and req_is_edit.get(rid):
                    edit_errors += 1
    doom = len(recent_sigs) >= 3 and any(recent_sigs[i] == recent_sigs[i + 1] == recent_sigs[i + 2] for i in range(len(recent_sigs) - 2))
    return {"client_ttft_s": client_ttft_s, "edit_call_count": edit_calls, "edit_error_count": edit_errors, "doom_loop_detected": doom}


def _scan_omp_edit_stats(stdout_events: List[Tuple[float, str]], t0: float) -> Dict[str, Any]:
    edit_calls = 0
    edit_errors = 0
    call_is_edit: Dict[str, bool] = {}
    recent_sigs: List[str] = []
    client_ttft_s: Optional[float] = None
    for ts, line in stdout_events:
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue
        etype = ev.get("type")
        if client_ttft_s is None and etype in ("message_update", "tool_execution_start"):
            client_ttft_s = max(0.0, ts - t0)
        if etype == "tool_execution_start":
            cid = str(ev.get("toolCallId") or ev.get("id") or "")
            tname = str(ev.get("toolName") or ev.get("tool") or "")
            is_ed = _is_edit_tool(tname)
            if cid:
                call_is_edit[cid] = is_ed
            if is_ed:
                edit_calls += 1
            sig = hashlib.sha256(f"{tname}:{json.dumps(ev.get('args'), sort_keys=True, default=str)}".encode()).hexdigest()[:12]
            recent_sigs.append(sig)
        elif etype == "tool_execution_end":
            cid = str(ev.get("toolCallId") or ev.get("id") or "")
            tname = str(ev.get("toolName") or ev.get("tool") or "")
            if ev.get("isError") and (call_is_edit.get(cid) or _is_edit_tool(tname)):
                edit_errors += 1
    doom = len(recent_sigs) >= 3 and any(recent_sigs[i] == recent_sigs[i + 1] == recent_sigs[i + 2] for i in range(len(recent_sigs) - 2))
    return {"client_ttft_s": client_ttft_s, "edit_call_count": edit_calls, "edit_error_count": edit_errors, "doom_loop_detected": doom}


def _parse_dsh_events(stdout_events: List[Tuple[float, str]], stderr_lines: List[str], t0: float) -> Dict[str, Any]:
    """Parse `@deepseek-ai/dsh-headless --json` NDJSON event stream."""
    client_ttft_s: Optional[float] = None
    tool_calls = 0
    tool_errors = 0
    edit_calls = 0
    edit_errors = 0
    tool_hist: Dict[str, int] = {}
    call_map: Dict[str, str] = {}
    recent_sigs: List[str] = []
    text_chunks: List[str] = []
    final_text: Optional[str] = None
    errs: List[str] = []

    for ts, line in stdout_events:
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue
        etype = ev.get("type")
        if etype in ("text", "thinking", "tool_call") and client_ttft_s is None:
            client_ttft_s = round(max(0.0, ts - t0), 4)
        if etype == "text":
            txt = ev.get("text")
            if isinstance(txt, str):
                text_chunks.append(txt)
        elif etype == "tool_call":
            tname = str(ev.get("tool") or "unknown")
            cid = str(ev.get("callId") or "")
            tool_calls += 1
            tool_hist[tname] = tool_hist.get(tname, 0) + 1
            if cid:
                call_map[cid] = tname
            if _is_edit_tool(tname):
                edit_calls += 1
            sig = hashlib.sha256(f"{tname}:{json.dumps(ev.get('input'), sort_keys=True, default=str)}".encode()).hexdigest()[:12]
            recent_sigs.append(sig)
        elif etype == "tool_result":
            cid = str(ev.get("callId") or "")
            tname = call_map.get(cid, "")
            is_err = ev.get("status") == "error" or bool(ev.get("error"))
            if is_err:
                tool_errors += 1
                if _is_edit_tool(tname):
                    edit_errors += 1
        elif etype == "final":
            ft = ev.get("text")
            if isinstance(ft, str):
                final_text = ft
            rsn = ev.get("reason")
            if isinstance(rsn, dict) and rsn.get("kind") not in (None, "completed", "end_turn", "stop"):
                errs.append(f"dsh_reason:{json.dumps(rsn)}")
        elif etype == "error":
            errs.append(str(ev.get("message") or ev.get("error") or ev))

    if final_text is None:
        final_text = "".join(text_chunks)
    if not errs and not final_text and stderr_lines:
        tail = "".join(stderr_lines).strip()
        if "Error" in tail or "Exception" in tail:
            errs.append(tail[-400:])

    doom = len(recent_sigs) >= 3 and any(recent_sigs[i] == recent_sigs[i + 1] == recent_sigs[i + 2] for i in range(len(recent_sigs) - 2))
    return {
        "client_ttft_s": client_ttft_s,
        "doom_loop_detected": doom,
        "edit_call_count": edit_calls,
        "edit_error_count": edit_errors,
        "edit_failure_rate": round(edit_errors / edit_calls, 4) if edit_calls > 0 else 0.0,
        "final_assistant_text": final_text[:8000],
        "harness_errors": errs,
        "tool_call_count": tool_calls,
        "tool_error_count": tool_errors,
        "tool_error_rate": round(tool_errors / tool_calls, 4) if tool_calls > 0 else 0.0,
        "tool_histogram": tool_hist,
    }


def parse_harness_stream_v5(
    harness: str,
    stdout_events: List[Tuple[float, str]],
    stderr_lines: List[str],
    t0: float,
    wall_time_s: float = 0.0,
) -> Dict[str, Any]:
    """Unified normalized stream parser across all 7 Suite v5 harnesses."""
    h = (harness or "").strip().lower()
    if h == "agy":
        raise ValueError("Harness 'agy' is strictly excluded from Suite v5")
    if h in ("codex", "claude", "opencode", "omnia"):
        return runner_v4.parse_harness_stream(h, stdout_events, t0)
    if h == "dsh":
        return _parse_dsh_events(stdout_events, stderr_lines, t0)
    if h == "goose":
        base = legacy_runner._parse_goose_events(stdout_events, stderr_lines, t0, max(0.05, wall_time_s))
        extra = _scan_goose_edit_stats(stdout_events, t0)
    elif h == "omp":
        base = legacy_runner._parse_omp_events(stdout_events, t0, max(0.05, wall_time_s))
        extra = _scan_omp_edit_stats(stdout_events, t0)
    else:
        raise ValueError(f"Unsupported harness: {harness}")

    tc = int(base.get("tool_call_count") or 0)
    te = int(base.get("tool_error_count") or 0)
    ec = int(extra["edit_call_count"])
    ee = int(extra["edit_error_count"])
    ttft = base.get("ttft_s") if base.get("ttft_s") is not None else extra["client_ttft_s"]
    return {
        "client_ttft_s": round(float(ttft), 4) if ttft is not None else None,
        "doom_loop_detected": bool(extra["doom_loop_detected"]),
        "edit_call_count": ec,
        "edit_error_count": ee,
        "edit_failure_rate": round(ee / ec, 4) if ec > 0 else 0.0,
        "final_assistant_text": str(base.get("final_assistant_text") or "")[:8000],
        "harness_errors": list(base.get("harness_errors") or []),
        "tool_call_count": tc,
        "tool_error_count": te,
        "tool_error_rate": round(te / tc, 4) if tc > 0 else 0.0,
        "tool_histogram": dict(base.get("tool_histogram") or {}),
    }


def reconcile_wire_http_error_usage(wire_log: Path, wire: Dict[str, Any]) -> Dict[str, Any]:
    """Recover exact 200-OK wire token sums, TTFT, and Turn-1 stats across 429/5xx retries."""
    if not wire_log.exists():
        return wire
    rows = []
    for ln in wire_log.read_text(encoding="utf-8", errors="replace").splitlines():
        s = ln.strip()
        if s.startswith("{"):
            try:
                rows.append(json.loads(s))
            except json.JSONDecodeError:
                pass
    inf = [r for r in rows if r.get("is_inference")]
    if not inf:
        return wire

    def _is_rejected_retry(r: Dict[str, Any]) -> bool:
        st = r.get("http_status")
        return isinstance(st, int) and st >= 400 and (r.get("output_tokens") or 0) == 0 and (r.get("tool_calls_emitted") or 0) == 0 and not r.get("usage_complete")

    ok_rows = []
    http_err_retries = 0
    for r in inf:
        if _is_rejected_retry(r):
            http_err_retries += 1
        else:
            ok_rows.append(r)

    if ok_rows and _is_rejected_retry(inf[0]):
        if wire.get("wire_first_ttft_ms") is None and ok_rows[0].get("wire_ttft_ms") is not None:
            wire["wire_first_ttft_ms"] = round(float(ok_rows[0]["wire_ttft_ms"]), 2)
        if (wire.get("wire_turn1_prompt_tokens") or 0) == 0 and ok_rows[0].get("usage_complete"):
            wire["wire_turn1_prompt_tokens"] = int(ok_rows[0].get("prompt_total") or 0)
            ge2 = [r for r in ok_rows[1:] if r.get("usage_complete")]
            ge2_p = sum(int(r.get("prompt_total") or 0) for r in ge2)
            ge2_c = sum(int(r.get("cache_read") or 0) for r in ge2)
            wire["wire_kv_cache_hit_rate_ge2"] = round((ge2_c / ge2_p) if ge2_p > 0 else 0.0, 4)

    if wire.get("wire_total_tokens") is not None:
        wire.setdefault("wire_http_error_retries", http_err_retries)
        return wire
    if not ok_rows or any(not r.get("usage_complete") for r in ok_rows):
        wire["wire_http_error_retries"] = http_err_retries
        return wire

    uncached = sum(int(r.get("uncached_input") or 0) for r in ok_rows)
    cread = sum(int(r.get("cache_read") or 0) for r in ok_rows)
    cwrite = sum(int(r.get("cache_write") or 0) for r in ok_rows)
    out_tok = sum(int(r.get("output_tokens") or 0) for r in ok_rows)
    reas = sum(int(r.get("reasoning_tokens") or 0) for r in ok_rows)
    ptot = sum(int(r.get("prompt_total") or 0) for r in ok_rows)
    wire["wire_uncached_input"] = uncached
    wire["wire_cache_read"] = cread
    wire["wire_cache_write"] = cwrite
    wire["wire_output_tokens"] = out_tok
    wire["wire_reasoning_tokens"] = reas
    wire["wire_prompt_total"] = ptot
    wire["wire_total_tokens"] = ptot + out_tok
    wire["wire_effective_cost_units"] = round(1.0 * uncached + 0.1 * cread + 1.25 * cwrite + 5.0 * out_tok, 1)
    wire["wire_requests_missing_usage"] = 0
    wire["wire_http_error_retries"] = http_err_retries
    return wire


def _clean_setup_env() -> Dict[str, str]:
    keys = SAFE_SYSTEM_KEYS + ("TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA")
    env = {k: os.environ[k] for k in keys if k in os.environ}
    env["PATH"] = build_minimal_path()
    env["RUSTUP_HOME"] = os.environ.get("RUSTUP_HOME") or str(Path.home() / ".rustup")
    env["CARGO_HOME"] = os.environ.get("CARGO_HOME") or str(Path.home() / ".cargo")
    env["CARGO_NET_OFFLINE"] = "true"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    return env


def run_single_trial_v5(
    phase: str,
    harness: str,
    model: str,
    task: Dict[str, Any],
    repeat_idx: int = 0,
    *,
    omnia_bin: Optional[Path] = None,
    check_sockets: bool = True,
    results_root: Optional[Path] = None,
    timeout_override_s: Optional[int] = None,
    proxy_fault_mode: Optional[str] = None,
    effort: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute one isolated clean-room Suite v5 trial and collect wire + tree telemetry."""
    validate_harness_and_model(harness, model)
    assert_clean_ancestors()

    tid = task["id"]
    eff_label = (effort or "").strip().lower()
    eff_suffix = f".{eff_label}" if eff_label else ""
    run_id = f"{phase}-{harness}-{model}-{tid}-r{repeat_idx}" + (f"-{eff_label}" if eff_label else "")
    out_root = results_root or DEFAULT_RESULTS_ROOT
    logs_dir = out_root / "traces" / phase / harness / model
    ws_parent = out_root / "_workspaces"
    ws_parent.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    wire_log = logs_dir / f"{tid}.r{repeat_idx}{eff_suffix}.wire.jsonl"
    stdout_log = logs_dir / f"{tid}.r{repeat_idx}{eff_suffix}.stdout.jsonl"
    wire_log.unlink(missing_ok=True)

    work_dir = Path(tempfile.mkdtemp(prefix=f"v5_{harness}_{tid}_", dir=str(ws_parent)))
    timeout_s = int(timeout_override_s or task.get("timeout_s") or 300)
    prompt = (task["_dir"] / task.get("prompt_file", "prompt.md")).read_text(encoding="utf-8")

    # Fault-injection tasks on A11 opt into proxy chaos unless caller overrides
    fault_mode = proxy_fault_mode or task.get("fault_mode") or task.get("proxy_fault_mode")
    api_key = load_htmustc_api_key(model)

    proxy = BenchTelemetryProxy(
        run_id=run_id,
        harness=harness,
        task_id=tid,
        model_override=model,
        upstream_api_key=api_key,
        log_path=wire_log,
        fault_mode=fault_mode,
    )
    launch = None
    leaks: List[dict] = []
    timed_out = False
    exit_code = -1
    stdout_events: List[Tuple[float, str]] = []
    stderr_lines: List[str] = []

    try:
        setup_env = _clean_setup_env()
        legacy_runner.prepare_workspace(task, work_dir, setup_env)
        port = proxy.start()
        launch = prepare_harness_launch(
            harness,
            model,
            prompt,
            work_dir,
            port,
            run_id=run_id,
            timeout_s=timeout_s,
            omnia_bin=omnia_bin,
            effort=effort,
        )

        wall_start_ns = time.perf_counter_ns()
        t0 = wall_start_ns / 1e9
        proc = subprocess.Popen(
            launch.cmd,
            cwd=str(work_dir),
            env=launch.env,
            stdin=subprocess.PIPE if launch.stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        mon = ProcessTreeMonitor(proc.pid, poll_interval_s=0.05, harness_root_exe=launch.harness_root_exe)
        mon.start()
        if launch.stdin_text is not None and proc.stdin is not None:
            try:
                proc.stdin.write(launch.stdin_text)
                proc.stdin.close()
            except Exception:
                pass

        q: "queue.Queue[Tuple[str, float, Optional[str]]]" = queue.Queue()
        t_out = threading.Thread(target=runner_v4._reader, args=(proc.stdout, q, "out"), daemon=True)
        t_err = threading.Thread(target=runner_v4._reader, args=(proc.stderr, q, "err"), daemon=True)
        t_out.start()
        t_err.start()

        closed = 0
        sock_checked = False
        deadline = t0 + timeout_s
        while closed < 2:
            rem = deadline - time.perf_counter()
            if rem <= 0:
                timed_out = True
                terminate_process_tree(proc.pid)
                break
            if check_sockets and not sock_checked and (time.perf_counter() - t0) >= 2.0:
                sock_checked = True
                pids, _ = get_process_tree_pids(proc.pid)
                leaks = audit_non_loopback_sockets(pids)
            try:
                tag, ts, line = q.get(timeout=min(0.25, max(0.05, rem)))
            except queue.Empty:
                if proc.poll() is not None and not t_out.is_alive() and not t_err.is_alive():
                    break
                continue
            if line is None:
                closed += 1
            elif tag == "out":
                stdout_events.append((ts, line))
            else:
                stderr_lines.append(line)

        try:
            exit_code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate_process_tree(proc.pid)
            exit_code = -9

        wall_end_ns = time.perf_counter_ns()
        wall_s = (wall_end_ns - wall_start_ns) / 1e9
        res = mon.stop()
        wire = reconcile_wire_http_error_usage(wire_log, proxy.stop((wall_start_ns, wall_end_ns)))
        stdout_log.write_text("".join(line for _, line in stdout_events), encoding="utf-8", newline="\n")

        stream = parse_harness_stream_v5(harness, stdout_events, stderr_lines, t0, wall_s)
        ver = runner_v4.run_verifier(task, work_dir, _clean_setup_env(), timeout_s=120)

        out_tok = wire.get("wire_output_tokens") or 0
        e2e_tps = round(out_tok / wall_s, 2) if (out_tok > 0 and wall_s > 0) else 0.0

        return {
            "phase": phase,
            "run_id": run_id,
            "harness": harness,
            "model": model,
            "effort": eff_label or "default",
            "task_id": tid,
            "axis": int(task["axis"]),
            "axis_name": task.get("axis_name", ""),
            "repeat": repeat_idx,
            "wire_protocol": launch.wire_protocol,
            "passed": bool(ver.get("passed")) and not timed_out,
            "score": float(ver.get("score") or 0.0) if not timed_out else float(ver.get("score") or 0.0),
            "fail_to_pass": ver.get("fail_to_pass"),
            "pass_to_pass": ver.get("pass_to_pass"),
            "verifier_error": ver.get("error"),
            "verifier_checks": ver.get("checks"),
            "exit_code": exit_code,
            "timed_out": timed_out,
            "wall_s": round(wall_s, 3),
            "e2e_tokens_per_sec": e2e_tps,
            "wire_log_path": str(wire_log),
            "stdout_log_path": str(stdout_log),
            "non_loopback_sockets": leaks,
            "egress_clean": len(leaks) == 0,
            "htmustc_only_ok": len(leaks) == 0 and (wire.get("wire_requests") or 0) >= 1,
            "htmustc_only_verified": len(leaks) == 0 and (wire.get("wire_requests") or 0) >= 1,
            "peak_rss_mb": round(res.peak_rss_mb, 2),
            "peak_harness_rss_mb": round(res.peak_harness_rss_mb, 2),
            "peak_test_child_rss_mb": round(res.peak_test_child_rss_mb, 2),
            "peak_job_memory_mb": round(res.peak_job_memory_mb, 2),
            "total_cpu_time_s": round(res.total_cpu_time_s, 3),
            "stderr_tail": "".join(stderr_lines)[-600:],
            **wire,
            **stream,
        }
    finally:
        try:
            if getattr(proxy, "_server", None) is not None:
                proxy.stop()
        except Exception:
            pass
        if launch is not None:
            launch.cleanup()
        shutil.rmtree(work_dir, ignore_errors=True)


def _atomic_write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(str(tmp), str(path))


def main() -> int:
    ap = argparse.ArgumentParser(description="Suite v5 clean-room multi-harness benchmark runner")
    ap.add_argument("--phase", default="v5_wave3")
    ap.add_argument("--harnesses", nargs="+", default=list(V5_HARNESSES))
    ap.add_argument("--models", nargs="+", default=list(V5_DEFAULT_MODELS))
    ap.add_argument("--axes", nargs="+", type=int, default=None)
    ap.add_argument("--tasks", nargs="+", default=None)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--timeout-s", type=int, default=None)
    ap.add_argument("--cooldown-s", type=float, default=None, help="Per-trial sleep (defaults to 0.0 when --workers > 1, else 2.0)")
    ap.add_argument("--workers", type=int, default=1, help="Parallel worker count (ThreadPoolExecutor)")
    ap.add_argument("--effort", default=None, help="Reasoning effort: auto|none|minimal|low|medium|high|xhigh|max")
    ap.add_argument("--efforts", nargs="+", default=None, help="Multiple reasoning effort levels to sweep in parallel")
    ap.add_argument("--omnia-bin", default=None)
    ap.add_argument("--results-root", default=str(DEFAULT_RESULTS_ROOT))
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for m in args.models:
        for h in args.harnesses:
            validate_harness_and_model(h, m)

    effort_list: List[Optional[str]] = list(args.efforts) if args.efforts else ([args.effort] if args.effort else [None])
    workers = max(1, int(args.workers))
    cooldown_s = (0.0 if workers > 1 else 2.0) if args.cooldown_s is None else float(args.cooldown_s)

    all_tasks = legacy_runner.discover_tasks(task_ids=args.tasks, axes=args.axes)
    tasks = all_tasks

    results_root = Path(args.results_root)
    results_root.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (results_root / f"{args.phase}_records.json")
    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None

    if args.dry_run:
        print(json.dumps({
            "phase": args.phase,
            "harnesses": args.harnesses,
            "models": args.models,
            "efforts": [e or "default" for e in effort_list],
            "workers": workers,
            "cooldown_s": cooldown_s,
            "task_count": len(tasks),
            "repeats": args.repeats,
            "planned_trials": len(args.harnesses) * len(args.models) * len(tasks) * args.repeats * len(effort_list),
            "task_ids": [t["id"] for t in tasks],
        }, indent=2))
        return 0

    records: List[Dict[str, Any]] = []
    done_keys = set()
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding="utf-8"))
            records = list(prev.get("records") or [])
            done_keys = {
                (r["harness"], r["model"], r["task_id"], int(r["repeat"]), str(r.get("effort") or "default").lower())
                for r in records
            }
        except Exception:
            records = []

    jobs: List[Tuple[int, Dict[str, Any], str, str, Optional[str]]] = []
    for rep in range(args.repeats):
        for task in tasks:
            for model in args.models:
                for eff in effort_list:
                    eff_key = (eff or "default").strip().lower()
                    for h in args.harnesses:
                        key = (h, model, task["id"], rep, eff_key)
                        if key in done_keys:
                            continue
                        jobs.append((rep, task, model, h, eff))

    write_lock = threading.Lock()
    print_lock = threading.Lock()

    def _run_job(job: Tuple[int, Dict[str, Any], str, str, Optional[str]]) -> Dict[str, Any]:
        rep, task, model, h, eff = job
        eff_key = (eff or "default").strip().lower()
        rec = run_single_trial_v5(
            args.phase, h, model, task, repeat_idx=rep,
            omnia_bin=omnia_bin, results_root=results_root, timeout_override_s=args.timeout_s, effort=eff,
        )
        status = "PASS" if rec["passed"] else ("TOUT" if rec["timed_out"] else "FAIL")
        eff_disp = f" eff={eff_key}" if eff else ""
        with write_lock:
            records.append(rec)
            done_keys.add((h, model, task["id"], rep, eff_key))
            _atomic_write_json(out_path, {
                "schema_version": "5.0",
                "phase": args.phase,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "records": records,
            })
        with print_lock:
            print(
                f"[{args.phase}] r{rep} {h:8s} {model:22s}{eff_disp} {task['id']:30s} ... "
                f"{status} s={rec['score']:.2f} wall={rec['wall_s']:.1f}s "
                f"ttft={rec.get('wire_first_ttft_ms')}ms tok={rec.get('wire_total_tokens')} "
                f"tps={rec.get('wire_gen_tokens_per_sec')} rss={rec['peak_rss_mb']:.1f}MB",
                flush=True,
            )
        if cooldown_s > 0:
            time.sleep(cooldown_s)
        return rec

    if workers == 1:
        for job in jobs:
            _run_job(job)
    elif jobs:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers, len(jobs))) as ex:
            futs = [ex.submit(_run_job, job) for job in jobs]
            for fut in concurrent.futures.as_completed(futs):
                fut.result()

    print(f"Saved {len(records)} Suite v5 records -> {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
