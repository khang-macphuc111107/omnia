"""Shared runtime, loopback telemetry proxy, socket audit, and statistics helpers for public suites."""
from __future__ import annotations

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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BENCH_DIR = Path(__file__).resolve().parent.parent
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))

from bench_telemetry_proxy import BenchTelemetryProxy
from cleanroom import assert_clean_ancestors, audit_non_loopback_sockets, prepare_harness_launch
from proc_monitor import ProcessTreeMonitor, get_process_tree_pids, terminate_process_tree
import runner_v4
import runner_v5
import scorer_v4
import scorer_v5

DATASET_ROOT = Path(r"D:\OmniaData\qa\v5-bench\datasets")
SWE_ATLAS_PARQUET = Path(r"D:\OmniaData\qa\omp-20261124-harness-a\swe-atlas-qna-aa\test-00000-of-00001.parquet")
SWE_ATLAS_RUBRIC_CFG = Path(r"D:\OmniaData\qa\omp-20261124-harness-a\swe-atlas-qna-aa\rubric_evaluation_config.yaml")
EXT_LIBS_ROOT = Path(r"D:\OmniaData\qa\v5-bench\ext_libs")
DEFAULT_PUBLIC_OUT = Path(r"D:\OmniaData\qa\v5-bench\public_suites")
VENV_PYTHON = Path(r"D:\omnia-bench\.venv\Scripts\python.exe")


def python_exe() -> str:
    return str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable


def clean_host_env() -> Dict[str, str]:
    env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME") if k in os.environ}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    return env


def run_harness_in_workspace(
    suite_name: str,
    task_id: str,
    harness: str,
    model: str,
    prompt: str,
    workspace: Path,
    *,
    timeout_s: int = 300,
    omnia_bin: Optional[Path] = None,
    check_sockets: bool = True,
    logs_root: Optional[Path] = None,
) -> Dict[str, Any]:
    """Execute any Suite v5 harness cleanly inside `workspace` through loopback `BenchTelemetryProxy`."""
    runner_v5.validate_harness_and_model(harness, model)
    assert_clean_ancestors()

    out_root = logs_root or (DEFAULT_PUBLIC_OUT / suite_name / "traces" / harness / model)
    out_root.mkdir(parents=True, exist_ok=True)
    safe_tid = re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)[:80]
    wire_log = out_root / f"{safe_tid}.wire.jsonl"
    stdout_log = out_root / f"{safe_tid}.stdout.jsonl"
    wire_log.unlink(missing_ok=True)

    run_id = f"{suite_name}-{harness}-{model}-{safe_tid}"
    api_key = runner_v5.load_htmustc_api_key(model)
    proxy = BenchTelemetryProxy(
        run_id=run_id,
        harness=harness,
        task_id=task_id,
        model_override=model,
        upstream_api_key=api_key,
        log_path=wire_log,
    )
    launch = None
    leaks: List[dict] = []
    timed_out = False
    exit_code = -1
    stdout_events: List[Tuple[float, str]] = []
    stderr_lines: List[str] = []

    try:
        port = proxy.start()
        launch = prepare_harness_launch(
            harness, model, prompt, workspace, port, run_id=run_id, timeout_s=timeout_s, omnia_bin=omnia_bin
        )
        wall_start_ns = time.perf_counter_ns()
        t0 = wall_start_ns / 1e9
        proc = subprocess.Popen(
            launch.cmd,
            cwd=str(workspace),
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
        wire = runner_v5.reconcile_wire_http_error_usage(wire_log, proxy.stop((wall_start_ns, wall_end_ns)))
        stdout_log.write_text("".join(line for _, line in stdout_events), encoding="utf-8", newline="\n")
        stream = runner_v5.parse_harness_stream_v5(harness, stdout_events, stderr_lines, t0, wall_s)
        rec = {
            "harness": harness,
            "model": model,
            "task_id": task_id,
            "suite": suite_name,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "wall_s": round(wall_s, 3),
            "non_loopback_sockets": leaks,
            "egress_clean": len(leaks) == 0,
            "peak_rss_mb": round(res.peak_rss_mb, 2),
            "peak_harness_rss_mb": round(res.peak_harness_rss_mb, 2),
            "peak_job_memory_mb": round(res.peak_job_memory_mb, 2),
            "total_cpu_time_s": round(res.total_cpu_time_s, 3),
            "wire_log_path": str(wire_log),
            "stdout_log_path": str(stdout_log),
            **wire,
            **stream,
        }
        rec["cost_usd_est"] = scorer_v5.estimate_record_cost_usd(rec)
        return rec
    finally:
        try:
            if getattr(proxy, "_server", None) is not None:
                proxy.stop()
        except Exception:
            pass
        if launch is not None:
            launch.cleanup()


def call_htmustc_chat(
    model: str,
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    response_format: Optional[Dict[str, Any]] = None,
    temperature: float = 0.0,
    max_tokens: int = 2048,
    timeout_s: int = 90,
    run_id: str = "public-suite-api",
) -> Dict[str, Any]:
    """Call `https://htmustc.id.vn` GPT or Claude model strictly through loopback `BenchTelemetryProxy`."""
    runner_v5.validate_harness_and_model("omnia", model)
    api_key = runner_v5.load_htmustc_api_key(model)
    if not api_key:
        raise RuntimeError(f"Missing HTMUSTC API key for model {model}")

    is_claude = "claude" in model.lower()
    proxy = BenchTelemetryProxy(
        run_id=run_id,
        harness="api_judge",
        task_id=run_id,
        model_override=model,
        upstream_api_key=api_key,
    )
    port = proxy.start()
    try:
        wall_start_ns = time.perf_counter_ns()
        if is_claude:
            system_parts = [m["content"] for m in messages if m.get("role") == "system"]
            non_sys = [m for m in messages if m.get("role") != "system"]
            payload: Dict[str, Any] = {
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": non_sys,
            }
            if system_parts:
                payload["system"] = "\n\n".join(str(x) for x in system_parts)
            if tools:
                anthropic_tools = []
                for t in tools:
                    if isinstance(t, dict) and t.get("type") == "function" and isinstance(t.get("function"), dict):
                        fn = t["function"]
                        anthropic_tools.append({
                            "name": fn["name"],
                            "description": fn.get("description") or "",
                            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                        })
                    else:
                        anthropic_tools.append(t)
                payload["tools"] = anthropic_tools
            url = f"http://127.0.0.1:{port}/v1/messages"
            headers = {
                "Content-Type": "application/json",
                "x-api-key": "<proxy-injected>",
                "anthropic-version": "2023-06-01",
            }
        else:
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if tools:
                payload["tools"] = tools
            if response_format:
                payload["response_format"] = response_format
            url = f"http://127.0.0.1:{port}/v1/chat/completions"
            headers = {
                "Content-Type": "application/json",
                "Authorization": "Bearer <proxy-injected>",
            }
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        raw = ""
        last_err: Optional[Exception] = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                last_err = None
                break
            except urllib.error.HTTPError as exc:
                last_err = exc
                if exc.code not in (429, 500, 502, 503, 504) or attempt >= 3:
                    raise
                ra = exc.headers.get("Retry-After") if exc.headers else None
                wait_s = min(20.0, float(ra)) if (ra and str(ra).isdigit()) else min(16.0, 1.5 * (2 ** attempt))
                time.sleep(wait_s)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                last_err = exc
                if attempt >= 3:
                    raise
                time.sleep(min(12.0, 1.5 * (2 ** attempt)))
        if last_err is not None:
            raise last_err
        wall_end_ns = time.perf_counter_ns()
        wire = proxy.stop((wall_start_ns, wall_end_ns))
        parsed = json.loads(raw)
        if is_claude:
            text_parts = [b.get("text", "") for b in parsed.get("content", []) if isinstance(b, dict) and b.get("type") == "text"]
            tool_uses = [b for b in parsed.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_use"]
            return {"text": "\n".join(text_parts), "tool_calls": tool_uses, "raw": parsed, "wire": wire}
        choice = (parsed.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        return {
            "text": msg.get("content") or "",
            "tool_calls": msg.get("tool_calls") or [],
            "raw": parsed,
            "wire": wire,
        }
    finally:
        if getattr(proxy, "_server", None) is not None:
            proxy.stop()


def summarize_suite_results(suite: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Summarize pass rate + Wilson 95% CI + telemetry across rows grouped by (harness, model)."""
    grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for r in rows:
        key = (str(r.get("harness") or "unknown"), str(r.get("model") or "unknown"))
        grouped.setdefault(key, []).append(r)
    summary: Dict[str, Any] = {}
    for (h, m), items in sorted(grouped.items()):
        n = len(items)
        k = sum(1 for x in items if x.get("passed"))
        lo, hi = scorer_v4.wilson_ci(k, n)
        scores = [float(x.get("score") if x.get("score") is not None else (1.0 if x.get("passed") else 0.0)) for x in items]
        leaks = sum(len(x.get("non_loopback_sockets") or []) for x in items)
        summary[f"{h}:{m}"] = {
            "suite": suite,
            "harness": h,
            "model": m,
            "total": n,
            "passed": k,
            "pass_rate_pct": round(100.0 * k / n, 2) if n else 0.0,
            "wilson_95ci": [round(lo, 2), round(hi, 2)],
            "mean_score": round(sum(scores) / n, 4) if n else 0.0,
            "network_leaks": leaks,
        }
    return {"suite": suite, "groups": summary}


def make_temp_workspace(prefix: str, suite_name: str) -> Path:
    base = DEFAULT_PUBLIC_OUT / suite_name / "_workspaces"
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{prefix}_", dir=str(base)))
