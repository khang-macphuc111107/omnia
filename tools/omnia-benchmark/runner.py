"""Publication-grade 10-axis Coding Agent & Harness Benchmark Runner.

Supports:
  - goose    : Goose CLI (v1.60.2+) via `--output-format stream-json --stats -q -i -`
  - omp      : Oh-My-Pi CLI (v19.1.0+) via `-p --mode json` (stdin prompt)
  - omp-rpc       : Oh-My-Pi JSON-RPC mode (`--mode rpc`)
  - omp-omni      : Post-merge OMP Omni v0.1 Desktop/RPC harness (`--eval-rpc`)
  - omni-super    : Post-merge OMP Omni v0.2 8-in-1 Native Rust Super-Harness (`--eval-omni`)
  - omni-super-v3 : Post-merge OMP Omni v0.3 Frontier SOTA Native Rust Super-Harness (`--eval-omni`)

Features:
  - Fresh isolated workspace copy per (phase, harness, model, task)
  - Optional deterministic task setup (`setup.py --workspace <dir>`)
  - Live 250ms Win32 process-tree RSS, private commit, and CPU polling
  - Exact canonical token accounting across harnesses (input/uncached/cache_read/output/reasoning)
  - Wall-clock TTFT, LLM-reported TTFT, generation tok/s, e2e tok/s, turns, tool calls & errors
  - Strict timeouts with full process-tree termination (`taskkill /F /T /PID`)
  - Hidden programmatic verifier execution (`verify.py --workspace <dir>`)
  - Zero skipped failures & zero fabricated metrics; every attempt written to
    `results/raw/<phase>/<harness>/<model>/<task_id>.json`.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
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
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import winreg
except ImportError:
    winreg = None  # type: ignore

from proc_monitor import ProcessTreeMonitor, terminate_process_tree

BENCH_ROOT = Path(__file__).resolve().parent
TASKS_DIR = BENCH_ROOT / "suite" / "tasks"
RESULTS_RAW_DIR = BENCH_ROOT / "results" / "raw"
OMP_PROFILE_DIR = BENCH_ROOT / "omp_profile"

DEFAULT_PROVIDER_HOST = os.environ.get("HTMUSTC_BASE_URL", "https://htmustc.id.vn")
DEFAULT_API_KEY = os.environ.get("HTMUSTC_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
DEFAULT_BUN_DIR = Path(os.environ.get("OMNIA_BENCH_BUN_DIR", str(Path.home() / ".bun" / "bin")))
DEFAULT_OMP_CMD = Path(os.environ.get("OMNIA_BENCH_OMP_CMD", "omp.cmd"))
DEFAULT_OMNI_BIN = Path(os.environ.get("OMNIA_BIN_PATH", "omnia.exe"))
DEFAULT_GOOSE_FALLBACK = Path(os.environ.get("OMNIA_BENCH_GOOSE_BIN", "goose.exe"))
DEFAULT_PYTHON_FALLBACK = Path(os.environ.get("OMNIA_BENCH_PYTHON_BIN", str(Path.home() / ".local" / "bin" / "python.exe")))

TIER1_MODELS = [
    "gemini-3.8-flash",
    "gemini-4-carbon",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "gpt-6.2-sol",
]


def build_clean_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Assemble Windows environment with refreshed User+Machine PATH and Bun/Python/Goose."""
    env = os.environ.copy()
    path_parts: List[str] = []

    if DEFAULT_BUN_DIR.exists():
        path_parts.append(str(DEFAULT_BUN_DIR))
    if DEFAULT_PYTHON_FALLBACK.parent.exists():
        path_parts.append(str(DEFAULT_PYTHON_FALLBACK.parent))
    if DEFAULT_GOOSE_FALLBACK.parent.exists():
        path_parts.append(str(DEFAULT_GOOSE_FALLBACK.parent))

    if winreg is not None:
        for root, subkey in [
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ]:
            try:
                with winreg.OpenKey(root, subkey) as k:
                    val, _ = winreg.QueryValueEx(k, "Path")
                    if val:
                        path_parts.extend(p for p in val.split(";") if p)
            except OSError:
                pass

    current_path = env.get("PATH") or env.get("Path") or ""
    path_parts.extend(p for p in current_path.split(";") if p)

    seen = set()
    deduped: List[str] = []
    for p in path_parts:
        norm = os.path.normcase(os.path.normpath(p.strip()))
        if norm and norm not in seen:
            seen.add(norm)
            deduped.append(p.strip())

    env["PATH"] = ";".join(deduped)
    env.pop("Path", None)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    if extra:
        env.update(extra)
    return env


def resolve_executable(name: str, env: Dict[str, str], fallback: Optional[Path] = None) -> str:
    found = shutil.which(name, path=env.get("PATH"))
    if found:
        return found
    if fallback and fallback.exists():
        return str(fallback)
    raise FileNotFoundError(f"Executable '{name}' not found in PATH or fallback {fallback}")


def discover_tasks(
    task_ids: Optional[List[str]] = None,
    axes: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    tasks: List[Dict[str, Any]] = []
    if not TASKS_DIR.exists():
        return tasks
    for entry in sorted(TASKS_DIR.iterdir()):
        meta_path = entry / "task.json"
        if not entry.is_dir() or not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["_dir"] = entry
        if task_ids and meta["id"] not in task_ids:
            continue
        if axes and int(meta["axis"]) not in axes:
            continue
        tasks.append(meta)
    tasks.sort(key=lambda t: (int(t["axis"]), t["id"]))
    return tasks


def prepare_workspace(task: Dict[str, Any], work_dir: Path, env: Dict[str, str]) -> None:
    task_dir: Path = task["_dir"]
    src_ws = task_dir / task.get("workspace_dir", "workspace")
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    if src_ws.exists():
        shutil.copytree(src_ws, work_dir)
    else:
        work_dir.mkdir(parents=True, exist_ok=True)

    setup_script = task.get("setup_script")
    if setup_script:
        setup_path = task_dir / setup_script
        if not setup_path.exists():
            raise FileNotFoundError(f"Missing setup_script: {setup_path}")
        res = subprocess.run(
            [sys.executable, str(setup_path), "--workspace", str(work_dir)],
            cwd=str(task_dir),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        if res.returncode != 0:
            raise RuntimeError(
                f"Task setup failed for {task['id']} (rc={res.returncode}):\n"
                f"STDOUT: {res.stdout}\nSTDERR: {res.stderr}"
            )


def run_verifier(task: Dict[str, Any], work_dir: Path, env: Dict[str, str], timeout_s: int = 120) -> Dict[str, Any]:
    task_dir: Path = task["_dir"]
    verify_path = task_dir / task.get("verify_script", "verify.py")
    t0 = time.perf_counter()
    try:
        res = subprocess.run(
            [sys.executable, str(verify_path), "--workspace", str(work_dir)],
            cwd=str(task_dir),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
        dur = time.perf_counter() - t0
        parsed: Optional[Dict[str, Any]] = None
        stdout = (res.stdout or "").strip()
        if stdout:
            # Try full stdout first, then scan backwards for last JSON line
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError:
                for line in reversed(stdout.splitlines()):
                    line = line.strip()
                    if line.startswith("{") and line.endswith("}"):
                        try:
                            parsed = json.loads(line)
                            break
                        except json.JSONDecodeError:
                            continue
        if parsed is None:
            return {
                "passed": False,
                "score": 0.0,
                "fail_to_pass": {"passed": 0, "total": 0},
                "pass_to_pass": {"passed": 0, "total": 0},
                "checks": [],
                "error": f"Verifier produced non-JSON output (rc={res.returncode}): {stdout[-800:]} | stderr: {(res.stderr or '')[-800:]}",
                "verifier_exit_code": res.returncode,
                "verifier_duration_s": round(dur, 3),
            }
        parsed["verifier_exit_code"] = res.returncode
        parsed["verifier_duration_s"] = round(dur, 3)
        # Strict invariant: exit code must match passed flag; if non-zero exit, cannot be passed
        if res.returncode != 0:
            parsed["passed"] = False
        return parsed
    except subprocess.TimeoutExpired:
        dur = time.perf_counter() - t0
        return {
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier timed out after {timeout_s}s",
            "verifier_exit_code": -1,
            "verifier_duration_s": round(dur, 3),
        }
    except Exception as exc:
        dur = time.perf_counter() - t0
        return {
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier exception: {exc}",
            "verifier_exit_code": -2,
            "verifier_duration_s": round(dur, 3),
        }


def _reader_thread(stream, out_queue: "queue.Queue[Tuple[str, float, Optional[str]]]", tag: str) -> None:
    try:
        for line in iter(stream.readline, ""):
            out_queue.put((tag, time.perf_counter(), line))
    except Exception:
        pass
    finally:
        out_queue.put((tag, time.perf_counter(), None))


def _parse_goose_events(
    stdout_events: List[Tuple[float, str]],
    stderr_lines: List[str],
    t_start: float,
    wall_time_s: float,
) -> Dict[str, Any]:
    wall_ttft_s: Optional[float] = None
    turn_windows: Dict[str, List[float]] = {}
    tool_calls: List[str] = []
    tool_errors = 0
    seen_tool_req_ids = set()
    complete_event: Optional[Dict[str, Any]] = None
    final_text_parts: List[str] = []
    last_assistant_id: Optional[str] = None
    error_messages: List[str] = []

    for ts, line in stdout_events:
        s = line.strip()
        if not s or not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue

        etype = ev.get("type")
        if etype == "error":
            error_messages.append(str(ev.get("error") or ev.get("message") or ev))
        elif etype == "complete":
            complete_event = ev
        elif etype == "message":
            msg = ev.get("message") or {}
            role = msg.get("role")
            mid = msg.get("id") or f"anon-{len(turn_windows)}"
            contents = msg.get("content") or []

            if role == "assistant":
                if mid != last_assistant_id:
                    final_text_parts = []
                    last_assistant_id = mid
                if wall_ttft_s is None and contents:
                    wall_ttft_s = max(0.0, ts - t_start)
                if mid not in turn_windows:
                    turn_windows[mid] = [ts, ts]
                else:
                    turn_windows[mid][1] = ts

                for c in contents:
                    ctype = c.get("type")
                    if ctype == "text":
                        final_text_parts.append(c.get("text", ""))
                    elif ctype == "toolRequest":
                        tid = c.get("id")
                        if tid not in seen_tool_req_ids:
                            seen_tool_req_ids.add(tid)
                            tc = (c.get("toolCall") or {}).get("value") or {}
                            tool_calls.append(tc.get("name", "unknown"))
            elif role == "user":
                for c in contents:
                    if c.get("type") == "toolResponse":
                        tr = c.get("toolResult") or {}
                        val = tr.get("value") or {}
                        if tr.get("status") != "success" or val.get("isError") is True:
                            tool_errors += 1

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    total_tokens = 0
    reported_cost_usd: Optional[float] = None

    if complete_event:
        # Goose complete event: total_tokens = input_tokens + output_tokens;
        # cache_read_input_tokens is a subset of input_tokens.
        input_tokens = int(complete_event.get("input_tokens") or 0)
        output_tokens = int(complete_event.get("output_tokens") or 0)
        cache_read_tokens = int(complete_event.get("cache_read_input_tokens") or 0)
        cache_write_tokens = int(complete_event.get("cache_write_input_tokens") or 0)
        total_tokens = int(complete_event.get("total_tokens") or (input_tokens + output_tokens))
        if complete_event.get("cost_usd") is not None:
            reported_cost_usd = float(complete_event["cost_usd"])
    else:
        # Fallback: parse stderr `--stats` block if process exited before complete event
        stderr_blob = "\n".join(stderr_lines)
        m_out = re.search(r"Output tokens:\s*(\d+)", stderr_blob)
        if m_out:
            output_tokens = int(m_out.group(1))
            total_tokens = output_tokens
        m_ttft = re.search(r"Time to first token:\s*([\d.]+)s", stderr_blob)
        if m_ttft and wall_ttft_s is None:
            wall_ttft_s = float(m_ttft.group(1))

    uncached_input_tokens = max(0, input_tokens - cache_read_tokens - cache_write_tokens)

    # Generation duration across streaming assistant message windows
    gen_dur_s = 0.0
    for t0, t1 in turn_windows.values():
        gen_dur_s += max(0.05, t1 - t0)
    if gen_dur_s <= 0.0 and wall_ttft_s is not None:
        gen_dur_s = max(0.05, wall_time_s - wall_ttft_s)

    gen_tps = (output_tokens / gen_dur_s) if (output_tokens > 0 and gen_dur_s > 0) else 0.0
    e2e_tps = (output_tokens / wall_time_s) if (output_tokens > 0 and wall_time_s > 0) else 0.0

    tool_hist: Dict[str, int] = {}
    for tn in tool_calls:
        tool_hist[tn] = tool_hist.get(tn, 0) + 1

    return {
        "ttft_s": round(wall_ttft_s, 4) if wall_ttft_s is not None else None,
        "llm_ttft_s": None,
        "gen_duration_s": round(gen_dur_s, 4),
        "gen_tokens_per_sec": round(gen_tps, 2),
        "e2e_tokens_per_sec": round(e2e_tps, 2),
        "input_tokens": input_tokens,
        "uncached_input_tokens": uncached_input_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": None,
        "total_tokens": total_tokens,
        "cache_hit_rate": round(cache_read_tokens / input_tokens, 4) if input_tokens > 0 else 0.0,
        "reported_cost_usd": reported_cost_usd,
        "turn_count": len(turn_windows),
        "tool_call_count": len(tool_calls),
        "tool_error_count": tool_errors,
        "tool_histogram": tool_hist,
        "token_telemetry_complete": complete_event is not None,
        "final_assistant_text": "".join(final_text_parts)[:4000],
        "harness_errors": error_messages,
    }


def _parse_omp_events(
    stdout_events: List[Tuple[float, str]],
    t_start: float,
    wall_time_s: float,
) -> Dict[str, Any]:
    wall_ttft_s: Optional[float] = None
    first_llm_ttft_s: Optional[float] = None
    uncached_input = 0
    cache_read = 0
    cache_write = 0
    output_tokens = 0
    reasoning_tokens = 0
    has_reasoning = False
    gen_dur_s = 0.0
    turn_count = 0
    seen_response_ids = set()
    tool_calls: List[str] = []
    tool_errors = 0
    final_text = ""
    error_messages: List[str] = []

    for ts, line in stdout_events:
        s = line.strip()
        if not s or not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue

        etype = ev.get("type")
        if etype == "error":
            error_messages.append(str(ev.get("error") or ev.get("message") or ev))
        elif etype == "response" and ev.get("success") is False:
            error_messages.append(f"RPC error ({ev.get('command')}): {ev.get('error')}")
        elif etype == "message_update":
            ame = ev.get("assistantMessageEvent") or {}
            ame_type = ame.get("type", "")
            if wall_ttft_s is None and ame_type in (
                "thinking_delta",
                "text_delta",
                "toolcall_delta",
                "thinking_start",
                "text_start",
                "toolcall_start",
            ):
                wall_ttft_s = max(0.0, ts - t_start)
        elif etype == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") == "assistant":
                if msg.get("stopReason") == "error" or msg.get("errorMessage"):
                    error_messages.append(str(msg.get("errorMessage") or "assistant stopReason=error"))
                    if not (msg.get("content") or []):
                        continue

                # Deduplicate if an RPC stream replays message_end
                rid = msg.get("responseId") or f"ts-{msg.get('timestamp')}-{turn_count}"
                if rid in seen_response_ids:
                    continue
                seen_response_ids.add(rid)
                turn_count += 1

                if wall_ttft_s is None and (msg.get("content") or []):
                    wall_ttft_s = max(0.0, ts - t_start)

                usage = msg.get("usage") or {}
                uncached_input += int(usage.get("input") or 0)
                cache_read += int(usage.get("cacheRead") or 0)
                cache_write += int(usage.get("cacheWrite") or 0)
                output_tokens += int(usage.get("output") or 0)
                if "reasoningTokens" in usage and usage["reasoningTokens"] is not None:
                    has_reasoning = True
                    reasoning_tokens += int(usage["reasoningTokens"])

                ttft_ms = msg.get("ttft")
                dur_ms = msg.get("duration")
                if first_llm_ttft_s is None and ttft_ms is not None:
                    first_llm_ttft_s = float(ttft_ms) / 1000.0
                if dur_ms is not None:
                    d = float(dur_ms) / 1000.0
                    t = (float(ttft_ms) / 1000.0) if ttft_ms is not None else 0.0
                    # Pure generation window excluding provider TTFT
                    gen_dur_s += max(0.05, d - t) if d > t else max(0.05, d)

                texts = [c.get("text", "") for c in (msg.get("content") or []) if c.get("type") == "text"]
                if texts:
                    final_text = "".join(texts)
        elif etype == "tool_execution_start":
            tool_calls.append(ev.get("toolName") or "unknown")
        elif etype == "tool_execution_end":
            if ev.get("isError") is True:
                tool_errors += 1

    # Canonical normalized token totals:
    # OMP `usage.input` excludes `cacheRead` and `cacheWrite`.
    total_input = uncached_input + cache_read + cache_write
    total_tokens = total_input + output_tokens

    if gen_dur_s <= 0.0 and wall_ttft_s is not None:
        gen_dur_s = max(0.05, wall_time_s - wall_ttft_s)

    gen_tps = (output_tokens / gen_dur_s) if (output_tokens > 0 and gen_dur_s > 0) else 0.0
    e2e_tps = (output_tokens / wall_time_s) if (output_tokens > 0 and wall_time_s > 0) else 0.0

    tool_hist: Dict[str, int] = {}
    for tn in tool_calls:
        tool_hist[tn] = tool_hist.get(tn, 0) + 1

    return {
        "ttft_s": round(wall_ttft_s, 4) if wall_ttft_s is not None else None,
        "llm_ttft_s": round(first_llm_ttft_s, 4) if first_llm_ttft_s is not None else None,
        "gen_duration_s": round(gen_dur_s, 4),
        "gen_tokens_per_sec": round(gen_tps, 2),
        "e2e_tokens_per_sec": round(e2e_tps, 2),
        "input_tokens": total_input,
        "uncached_input_tokens": uncached_input,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens if has_reasoning else None,
        "total_tokens": total_tokens,
        "cache_hit_rate": round(cache_read / total_input, 4) if total_input > 0 else 0.0,
        "reported_cost_usd": 0.0,
        "turn_count": turn_count,
        "tool_call_count": len(tool_calls),
        "tool_error_count": tool_errors,
        "tool_histogram": tool_hist,
        "token_telemetry_complete": total_tokens > 0,
        "final_assistant_text": final_text[:4000],
        "harness_errors": error_messages,
    }


def _parse_omni_eval_report(
    report: Dict[str, Any],
    wall_time_s: float,
) -> Dict[str, Any]:
    """Normalize `omp-omni.exe --eval-rpc` / `--eval-omni` EvalRunReport JSON into canonical runner telemetry.

    Supports both:
      - Canonical EvalRunReport v1/v2 (emits `uncached_input_tokens` and `input_tokens == uncached_input_tokens`,
        so `total_input = uncached_input_tokens + cache_read_tokens + cache_write_tokens` with zero double-counting)
      - Legacy EvalRunReport (emits only uncached `input_tokens`, requiring `+ cache_read + cache_write`)
    """
    cache_read = int(report.get("cache_read_tokens") or 0)
    cache_write = int(report.get("cache_write_tokens") or 0)
    output_tokens = int(report.get("output_tokens") or 0)
    uncached_input = int(
        report["uncached_input_tokens"]
        if report.get("uncached_input_tokens") is not None
        else (report.get("input_tokens") or 0)
    )
    total_input = uncached_input + cache_read + cache_write
    expected_total = total_input + output_tokens
    reported_total = int(report.get("total_tokens") or 0)
    # Guard against any double-counting: canonical total_tokens MUST equal total_input + output_tokens
    total_tokens = expected_total if expected_total > 0 else reported_total

    ttft_ms = report.get("ttft_ms")
    llm_ttft_ms = report.get("llm_ttft_ms")
    startup_ms = int(report.get("startup_ms") or 0)
    elapsed_ms = int(report.get("elapsed_ms") or round(wall_time_s * 1000))
    llm_ttft_s = (
        (float(llm_ttft_ms) / 1000.0)
        if llm_ttft_ms is not None
        else ((float(ttft_ms) / 1000.0) if ttft_ms is not None else None)
    )
    wall_ttft_s = (
        round((startup_ms + float(ttft_ms)) / 1000.0, 4)
        if ttft_ms is not None
        else None
    )

    gen_dur_ms = report.get("gen_duration_ms")
    reported_gen_tps = report.get("gen_tokens_per_second")
    if gen_dur_ms is not None and float(gen_dur_ms) > 0:
        gen_dur_s = max(0.05, float(gen_dur_ms) / 1000.0)
    else:
        gen_dur_s = max(0.05, (elapsed_ms - startup_ms) / 1000.0) if elapsed_ms > startup_ms else max(0.05, wall_time_s)

    if reported_gen_tps is not None and float(reported_gen_tps) > 0 and output_tokens > 0:
        gen_tps = float(reported_gen_tps)
    elif gen_dur_ms is not None and float(gen_dur_ms) > 0 and output_tokens > 0:
        gen_tps = output_tokens / gen_dur_s
    else:
        gen_tps = float(report.get("tokens_per_second") or 0.0)

    e2e_tps = (output_tokens / wall_time_s) if (output_tokens > 0 and wall_time_s > 0) else 0.0

    errs: List[str] = []
    if report.get("error"):
        errs.append(str(report["error"]))

    reasoning_val = report.get("reasoning_tokens")
    tool_hist = report.get("tool_histogram") if isinstance(report.get("tool_histogram"), dict) else {}
    if "token_telemetry_complete" in report and report["token_telemetry_complete"] is not None:
        tok_complete = bool(report["token_telemetry_complete"])
    else:
        tok_complete = total_tokens > 0

    out: Dict[str, Any] = {
        "ttft_s": wall_ttft_s,
        "llm_ttft_s": round(llm_ttft_s, 4) if llm_ttft_s is not None else None,
        "gen_duration_s": round(gen_dur_s, 4),
        "gen_tokens_per_sec": round(gen_tps, 2),
        "e2e_tokens_per_sec": round(e2e_tps, 2),
        "input_tokens": total_input,
        "uncached_input_tokens": uncached_input,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output_tokens,
        "reasoning_tokens": int(reasoning_val) if reasoning_val is not None else None,
        "total_tokens": total_tokens,
        "cache_hit_rate": round(cache_read / total_input, 4) if total_input > 0 else 0.0,
        "reported_cost_usd": float(report.get("cost_usd") or 0.0),
        "turn_count": int(report.get("turns") or 0),
        "tool_call_count": int(report.get("tool_calls") or 0),
        "tool_error_count": int(report.get("tool_errors") or 0),
        "tool_histogram": tool_hist,
        "token_telemetry_complete": tok_complete,
        "final_assistant_text": str(report.get("final_text") or "")[:4000],
        "harness_errors": errs,
        # omp-omni specific protocol & reliability telemetry
        "omni_startup_ms": startup_ms,
        "omni_protocol_version": int(report.get("protocol_version") or 0),
        "omni_recovery_attempts": int(report.get("recovery_attempts") or 0),
        "omni_recovery_succeeded": bool(report.get("recovery_succeeded", False)),
        "omni_host_tool_calls": int(report.get("host_tool_calls") or 0),
        "omni_reported_peak_rss_mb": round(int(report.get("peak_rss_bytes") or 0) / (1024 * 1024), 2),
        "omni_status": str(report.get("status") or ""),
        "omni_version": str(report.get("version") or ""),
    }

    # v2.0 omni-super native Rust Super-Harness telemetry fields (preserved cleanly when emitted)
    if report.get("backend") is not None:
        out["omni_backend"] = str(report["backend"])
    if report.get("merkle_root") is not None:
        out["merkle_root"] = str(report["merkle_root"])
    if report.get("merkle_refresh_ms") is not None:
        out["merkle_refresh_ms"] = round(float(report["merkle_refresh_ms"]), 3)
    if report.get("merkle_file_count") is not None:
        out["merkle_file_count"] = int(report["merkle_file_count"])
    if report.get("graph_symbol_count") is not None:
        out["graph_symbol_count"] = int(report["graph_symbol_count"])
    if report.get("prefix_stable") is not None:
        out["prefix_stable"] = bool(report["prefix_stable"])
    if report.get("prefix_cache_hit_pct") is not None:
        out["prefix_cache_hit_pct"] = round(float(report["prefix_cache_hit_pct"]), 2)
    if report.get("lakeview_compressions") is not None:
        out["lakeview_compressions"] = int(report["lakeview_compressions"])
    if report.get("lakeview_chars_saved") is not None:
        out["lakeview_chars_saved"] = int(report["lakeview_chars_saved"])
    if report.get("loop_nudges") is not None:
        out["loop_nudges"] = int(report["loop_nudges"])
    if report.get("http_retries") is not None:
        out["http_retries"] = int(report["http_retries"])
    # v3.0 omni-super-v3 Frontier SOTA telemetry fields (strictly additive)
    if report.get("active_decode_ms") is not None:
        out["active_decode_ms"] = int(report["active_decode_ms"])
    if report.get("truncated_stream_retries") is not None:
        out["truncated_stream_retries"] = int(report["truncated_stream_retries"])
    if report.get("stall_retries") is not None:
        out["stall_retries"] = int(report["stall_retries"])
    if report.get("verify_gate_nudges") is not None:
        out["verify_gate_nudges"] = int(report["verify_gate_nudges"])
    if report.get("narration_nudges") is not None:
        out["narration_nudges"] = int(report["narration_nudges"])
    if report.get("interleaved_reasoning_turns") is not None:
        out["interleaved_reasoning_turns"] = int(report["interleaved_reasoning_turns"])
    if reported_total > 0 and expected_total > 0 and reported_total != expected_total:
        out["token_accounting_delta"] = reported_total - expected_total

    return out


def execute_harness(
    harness: str,
    model: str,
    prompt_text: str,
    work_dir: Path,
    timeout_s: int,
    max_turns: int,
    base_env: Dict[str, str],
    omni_bin: Optional[str] = None,
    omni_protocol: str = "eval-rpc",
    omni_fallback_rpc: bool = False,
    trajectory_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Run a single harness invocation inside `work_dir` with live streaming telemetry and RSS/CPU polling."""
    env = base_env.copy()
    is_rpc = False
    is_omni_eval = False
    harness_binary = ""
    aux_temp_dir: Optional[Path] = None
    omni_out_path: Optional[Path] = None

    if harness == "goose":
        goose_exe = resolve_executable("goose", env, DEFAULT_GOOSE_FALLBACK)
        harness_binary = goose_exe
        env.update(
            {
                "GOOSE_PROVIDER": "openai",
                "OPENAI_HOST": DEFAULT_PROVIDER_HOST,
                "OPENAI_BASE_PATH": "v1/chat/completions",
                "OPENAI_API_KEY": DEFAULT_API_KEY,
                "GOOSE_MODEL": model,
                "GOOSE_DISABLE_TELEMETRY": "1",
            }
        )
        cmd = [
            goose_exe,
            "run",
            "--no-session",
            "--no-profile",
            "--with-builtin",
            "developer",
            "--max-turns",
            str(max_turns),
            "--stats",
            "-q",
            "--output-format",
            "stream-json",
            "-i",
            "-",
        ]
    elif harness == "omp":
        omp_cmd = str(DEFAULT_OMP_CMD) if DEFAULT_OMP_CMD.exists() else resolve_executable("omp", env)
        harness_binary = omp_cmd
        env["PI_CODING_AGENT_DIR"] = str(OMP_PROFILE_DIR)
        cmd = [
            omp_cmd,
            "--no-session",
            "--no-lsp",
            "--model",
            f"htmustc/{model}",
            "-p",
            "--mode",
            "json",
        ]
    elif harness == "omp-rpc":
        omp_cmd = str(DEFAULT_OMP_CMD) if DEFAULT_OMP_CMD.exists() else resolve_executable("omp", env)
        harness_binary = omp_cmd
        env["PI_CODING_AGENT_DIR"] = str(OMP_PROFILE_DIR)
        is_rpc = True
        cmd = [
            omp_cmd,
            "--no-session",
            "--no-lsp",
            "--model",
            f"htmustc/{model}",
            "--mode",
            "rpc",
        ]
    elif harness == "omp-omni":
        resolved_omni = omni_bin or env.get("OMP_OMNI_BIN") or (str(DEFAULT_OMNI_BIN) if DEFAULT_OMNI_BIN.exists() else None)
        if resolved_omni and Path(resolved_omni).exists():
            harness_binary = str(Path(resolved_omni).resolve())
            env["PI_CODING_AGENT_DIR"] = str(OMP_PROFILE_DIR)
            if omni_protocol == "eval-rpc":
                is_omni_eval = True
                aux_temp_dir = Path(tempfile.mkdtemp(prefix="hb_omni_aux_"))
                prompt_file = aux_temp_dir / "prompt.md"
                omni_out_path = aux_temp_dir / "eval_report.json"
                prompt_file.write_text(prompt_text, encoding="utf-8")
                model_spec = model if "/" in model else f"htmustc/{model}"
                cmd = [
                    harness_binary,
                    "--eval-rpc",
                    "--cwd",
                    str(work_dir),
                    "--model",
                    model_spec,
                    "--prompt-file",
                    str(prompt_file),
                    "--out",
                    str(omni_out_path),
                    "--timeout",
                    str(timeout_s),
                    "--approval-mode",
                    "yolo",
                    "--config-dir",
                    str(OMP_PROFILE_DIR),
                ]
            elif omni_protocol == "rpc":
                is_rpc = True
                cmd = [
                    harness_binary,
                    "--no-session",
                    "--no-lsp",
                    "--model",
                    f"htmustc/{model}",
                    "--mode",
                    "rpc",
                ]
            else:
                cmd = [
                    harness_binary,
                    "--no-session",
                    "--no-lsp",
                    "--model",
                    f"htmustc/{model}",
                    "-p",
                    "--mode",
                    "json",
                ]
        elif omni_fallback_rpc:
            omp_cmd = str(DEFAULT_OMP_CMD) if DEFAULT_OMP_CMD.exists() else resolve_executable("omp", env)
            harness_binary = omp_cmd
            env["PI_CODING_AGENT_DIR"] = str(OMP_PROFILE_DIR)
            is_rpc = True
            cmd = [
                omp_cmd,
                "--no-session",
                "--no-lsp",
                "--model",
                f"htmustc/{model}",
                "--mode",
                "rpc",
            ]
        else:
            raise FileNotFoundError(
                f"omp-omni binary not found at {DEFAULT_OMNI_BIN}. Pass --omni-bin <path> (or set OMP_OMNI_BIN), "
                "or pass --omni-fallback-rpc to benchmark OMP's headless RPC engine directly."
            )
    elif harness in ("omni-super", "omni-super-v3"):
        resolved_omni = omni_bin or env.get("OMP_OMNI_BIN") or (str(DEFAULT_OMNI_BIN) if DEFAULT_OMNI_BIN.exists() else None)
        if not (resolved_omni and Path(resolved_omni).exists()):
            raise FileNotFoundError(
                f"omp-omni binary not found at {DEFAULT_OMNI_BIN}. Pass --omni-bin <path> (or set OMP_OMNI_BIN)."
            )
        harness_binary = str(Path(resolved_omni).resolve())
        env["PI_CODING_AGENT_DIR"] = str(OMP_PROFILE_DIR)
        env["OPENAI_API_KEY"] = DEFAULT_API_KEY
        is_omni_eval = True
        aux_temp_dir = Path(tempfile.mkdtemp(prefix="hb_omni_super_aux_"))
        prompt_file = aux_temp_dir / "prompt.md"
        omni_out_path = aux_temp_dir / "eval_report.json"
        prompt_file.write_text(prompt_text, encoding="utf-8")
        model_spec = model if "/" in model else f"htmustc/{model}"
        cmd = [
            harness_binary,
            "--eval-omni",
            "--cwd",
            str(work_dir),
            "--model",
            model_spec,
            "--prompt-file",
            str(prompt_file),
            "--config-dir",
            str(OMP_PROFILE_DIR),
            "--out",
            str(omni_out_path),
            "--timeout",
            str(timeout_s),
            "--max-turns",
            str(max_turns),
            "--approval-mode",
            "yolo",
            "--no-host-tools",
        ]
        if trajectory_path is not None:
            cmd.extend(["--trajectory", str(trajectory_path)])
    else:
        raise ValueError(f"Unsupported harness: {harness}")

    t_start = time.perf_counter()
    proc = subprocess.Popen(
        cmd,
        cwd=str(work_dir),
        env=env,
        stdin=subprocess.DEVNULL if is_omni_eval else subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    monitor = ProcessTreeMonitor(proc.pid, poll_interval_s=0.25)
    monitor.start()

    ev_q: "queue.Queue[Tuple[str, float, Optional[str]]]" = queue.Queue()
    t_out = threading.Thread(target=_reader_thread, args=(proc.stdout, ev_q, "stdout"), daemon=True)
    t_err = threading.Thread(target=_reader_thread, args=(proc.stderr, ev_q, "stderr"), daemon=True)
    t_out.start()
    t_err.start()

    # Feed prompt via stdin (unless omp-omni --eval-rpc uses --prompt-file)
    if not is_omni_eval:
        try:
            assert proc.stdin is not None
            if is_rpc:
                rpc_prompt = json.dumps({"id": "bench-prompt-1", "type": "prompt", "message": prompt_text})
                proc.stdin.write(rpc_prompt + "\n")
                proc.stdin.flush()
            else:
                proc.stdin.write(prompt_text)
                if not prompt_text.endswith("\n"):
                    proc.stdin.write("\n")
                proc.stdin.flush()
                proc.stdin.close()
        except Exception:
            pass

    stdout_events: List[Tuple[float, str]] = []
    stderr_lines: List[str] = []
    eof_count = 0
    timed_out = False
    rpc_done_sent = False
    rpc_finish_deadline: Optional[float] = None
    # Give omp-omni --eval-rpc +15s outer grace beyond its own internal --timeout so it can flush its --out JSON & Job Object cleanup
    outer_timeout = (timeout_s + 15) if is_omni_eval else timeout_s
    deadline = t_start + outer_timeout

    while eof_count < 2:
        now = time.perf_counter()
        if now >= deadline:
            timed_out = True
            terminate_process_tree(proc.pid)
            break
        if rpc_finish_deadline is not None and now >= rpc_finish_deadline:
            try:
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.close()
            except Exception:
                pass
            if proc.poll() is None:
                terminate_process_tree(proc.pid)
            break

        wait_s = min(0.25, max(0.01, deadline - now))
        try:
            tag, ts, line = ev_q.get(timeout=wait_s)
        except queue.Empty:
            if proc.poll() is not None and not t_out.is_alive() and not t_err.is_alive():
                break
            continue

        if line is None:
            eof_count += 1
            continue

        if tag == "stdout":
            stdout_events.append((ts, line))
            if is_rpc and not rpc_done_sent:
                s = line.strip()
                if s.startswith("{"):
                    try:
                        obj = json.loads(s)
                        otype = obj.get("type")
                        if otype == "prompt_result" or otype == "agent_end":
                            rpc_done_sent = True
                            rpc_finish_deadline = time.perf_counter() + 4.0
                            try:
                                if proc.stdin and not proc.stdin.closed:
                                    proc.stdin.write(
                                        json.dumps({"id": "bench-stats-1", "type": "get_session_stats"}) + "\n"
                                    )
                                    proc.stdin.flush()
                                    proc.stdin.close()
                            except Exception:
                                pass
                    except json.JSONDecodeError:
                        pass
            elif is_rpc and rpc_done_sent:
                s = line.strip()
                if s.startswith("{") and '"bench-stats-1"' in s:
                    rpc_finish_deadline = min(rpc_finish_deadline or (time.perf_counter() + 1.0), time.perf_counter() + 0.5)
        else:
            stderr_lines.append(line.rstrip("\r\n"))

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        terminate_process_tree(proc.pid)
        try:
            proc.wait(timeout=3)
        except Exception:
            pass

    wall_time_s = time.perf_counter() - t_start
    res_summary = monitor.stop()
    exit_code = proc.returncode if proc.returncode is not None else -9

    # Drain any remaining queued lines
    while not ev_q.empty():
        try:
            tag, ts, line = ev_q.get_nowait()
            if line is not None:
                if tag == "stdout":
                    stdout_events.append((ts, line))
                else:
                    stderr_lines.append(line.rstrip("\r\n"))
        except queue.Empty:
            break

    omni_report: Optional[Dict[str, Any]] = None
    if is_omni_eval:
        try:
            if omni_out_path and omni_out_path.exists():
                raw_txt = omni_out_path.read_text(encoding="utf-8")
                omni_report = json.loads(raw_txt)
                if not stdout_events:
                    stdout_events.append((time.perf_counter(), raw_txt + "\n"))
            else:
                blob = "".join(line for _, line in stdout_events).strip()
                if blob:
                    try:
                        omni_report = json.loads(blob)
                    except json.JSONDecodeError:
                        for _, raw_line in reversed(stdout_events):
                            s = raw_line.strip()
                            if s.startswith("{") and s.endswith("}"):
                                try:
                                    omni_report = json.loads(s)
                                    break
                                except json.JSONDecodeError:
                                    continue
        except Exception:
            omni_report = None
        finally:
            if aux_temp_dir:
                shutil.rmtree(aux_temp_dir, ignore_errors=True)

    if harness == "goose":
        telemetry = _parse_goose_events(stdout_events, stderr_lines, t_start, wall_time_s)
    elif is_omni_eval:
        if omni_report is not None:
            telemetry = _parse_omni_eval_report(omni_report, wall_time_s)
            if omni_report.get("status") == "timeout":
                timed_out = True
        else:
            telemetry = _parse_omni_eval_report(
                {"status": "timeout" if timed_out else "error", "error": "\n".join(stderr_lines)[-1000:]},
                wall_time_s,
            )
    else:
        telemetry = _parse_omp_events(stdout_events, t_start, wall_time_s)

    if is_omni_eval and omni_report is not None:
        omni_st = str(omni_report.get("status") or "")
        status = "timeout" if (timed_out or omni_st == "timeout") else ("completed" if omni_report.get("success") else "error")
    else:
        status = "timeout" if timed_out else ("completed" if exit_code == 0 else "error")
        if is_rpc and rpc_done_sent and not timed_out and not telemetry["harness_errors"]:
            status = "completed"

    res_dict = res_summary.to_dict()
    if is_omni_eval and omni_report and omni_report.get("peak_rss_bytes"):
        omni_rss_mb = round(int(omni_report["peak_rss_bytes"]) / (1024 * 1024), 2)
        if omni_rss_mb > res_dict.get("peak_rss_mb", 0.0):
            res_dict["peak_rss_mb"] = omni_rss_mb

    return {
        "status": status,
        "timed_out": timed_out,
        "exit_code": exit_code,
        "wall_time_s": round(wall_time_s, 4),
        "harness_binary": harness_binary,
        "telemetry": telemetry,
        "resources": res_dict,
        "raw_stdout_lines": [line for _, line in stdout_events],
        "raw_stderr_tail": "\n".join(stderr_lines)[-8000:],
    }


def run_single_task(
    phase: str,
    harness: str,
    model: str,
    task: Dict[str, Any],
    base_env: Dict[str, str],
    timeout_override: Optional[int] = None,
    max_turns_override: Optional[int] = None,
    keep_workspace: bool = False,
    omni_bin: Optional[str] = None,
    omni_protocol: str = "eval-rpc",
    omni_fallback_rpc: bool = False,
) -> Dict[str, Any]:
    task_id = task["id"]
    task_dir: Path = task["_dir"]
    timeout_s = timeout_override or int(task.get("timeout_s", 180))
    max_turns = max_turns_override or int(task.get("max_turns", 15))
    prompt_text = (task_dir / task.get("prompt_file", "prompt.md")).read_text(encoding="utf-8")

    out_dir = RESULTS_RAW_DIR / phase / harness / model
    logs_dir = out_dir / "logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{task_id}.json"

    work_dir = Path(tempfile.mkdtemp(prefix=f"hb_{harness}_{task_id}_"))
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    try:
        prepare_workspace(task, work_dir, base_env)
        traj_path = (logs_dir / f"{task_id}.trajectory.jsonl") if harness in ("omni-super", "omni-super-v3") else None
        if traj_path is not None and traj_path.exists():
            traj_path.unlink(missing_ok=True)
        exec_result = execute_harness(
            harness=harness,
            model=model,
            prompt_text=prompt_text,
            work_dir=work_dir,
            timeout_s=timeout_s,
            max_turns=max_turns,
            base_env=base_env,
            omni_bin=omni_bin,
            omni_protocol=omni_protocol,
            omni_fallback_rpc=omni_fallback_rpc,
            trajectory_path=traj_path,
        )
        verification = run_verifier(task, work_dir, base_env)

        # Save complete raw NDJSON stream for full auditability
        log_path = logs_dir / f"{task_id}.jsonl"
        log_path.write_text("".join(exec_result["raw_stdout_lines"]), encoding="utf-8")

        record = {
            "schema_version": "1.0",
            "phase": phase,
            "harness": harness,
            "model": model,
            "task_id": task_id,
            "axis": int(task["axis"]),
            "axis_name": task["axis_name"],
            "title": task["title"],
            "difficulty": task.get("difficulty", "hard"),
            "grading_type": task.get("grading_type", "unknown"),
            "started_at": started_at,
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "timeout_s": timeout_s,
            "max_turns": max_turns,
            "status": exec_result["status"],
            "timed_out": exec_result["timed_out"],
            "exit_code": exec_result["exit_code"],
            "wall_time_s": exec_result["wall_time_s"],
            "harness_binary": exec_result["harness_binary"],
            "telemetry": exec_result["telemetry"],
            "resources": exec_result["resources"],
            "verification": verification,
            "passed": bool(verification.get("passed", False)),
            "score": float(verification.get("score", 0.0)),
            "raw_log_path": str(log_path.relative_to(BENCH_ROOT)).replace("\\", "/"),
            "raw_stderr_tail": exec_result["raw_stderr_tail"],
        }
    except Exception as exc:
        record = {
            "schema_version": "1.0",
            "phase": phase,
            "harness": harness,
            "model": model,
            "task_id": task_id,
            "axis": int(task["axis"]),
            "axis_name": task["axis_name"],
            "title": task["title"],
            "difficulty": task.get("difficulty", "hard"),
            "grading_type": task.get("grading_type", "unknown"),
            "started_at": started_at,
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "timeout_s": timeout_s,
            "max_turns": max_turns,
            "status": "runner_error",
            "timed_out": False,
            "exit_code": -1,
            "wall_time_s": 0.0,
            "harness_binary": "",
            "telemetry": {
                "ttft_s": None,
                "llm_ttft_s": None,
                "gen_duration_s": 0.0,
                "gen_tokens_per_sec": 0.0,
                "e2e_tokens_per_sec": 0.0,
                "input_tokens": 0,
                "uncached_input_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": None,
                "total_tokens": 0,
                "cache_hit_rate": 0.0,
                "reported_cost_usd": None,
                "turn_count": 0,
                "tool_call_count": 0,
                "tool_error_count": 0,
                "tool_histogram": {},
                "final_assistant_text": "",
                "harness_errors": [str(exc)],
            },
            "resources": {},
            "verification": {"passed": False, "score": 0.0, "error": str(exc)},
            "passed": False,
            "score": 0.0,
            "raw_log_path": None,
            "raw_stderr_tail": str(exc),
        }
    finally:
        if not keep_workspace:
            shutil.rmtree(work_dir, ignore_errors=True)

    out_file.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="10-Axis Coding Agent & Harness Benchmark Runner")
    parser.add_argument("--phase", default="pre_merge", help="Benchmark phase (e.g. pre_merge, post_merge, dry_run)")
    parser.add_argument("--harnesses", nargs="+", default=["goose,omp"], help="Harnesses (comma or space separated): goose,omp,omp-rpc,omp-omni,omni-super,omni-super-v3")
    parser.add_argument("--models", nargs="+", default=[",".join(TIER1_MODELS)], help="Model IDs (comma or space separated)")
    parser.add_argument("--tasks", nargs="*", default=[], help="Task IDs (default: all tasks)")
    parser.add_argument("--axes", nargs="*", default=[], help="Axis numbers 1-7 (default: all)")
    parser.add_argument("--timeout", type=int, default=None, help="Override per-task timeout in seconds")
    parser.add_argument("--max-turns", type=int, default=None, help="Override max turns for Goose")
    parser.add_argument("--resume", action="store_true", help="Skip tasks whose output JSON already exists")
    parser.add_argument(
        "--retry-errors",
        action="store_true",
        help="With --resume, re-run tasks whose previous status was not 'completed' (e.g. HTTP 500 or timeout)",
    )
    parser.add_argument("--keep-workspaces", action="store_true", help="Keep isolated temp workspaces after run")
    parser.add_argument("--omni-bin", default=None, help="Path to omp-omni.exe (default: auto-detect scratch/omp-omni/target/release/omp-omni.exe)")
    parser.add_argument("--omni-protocol", choices=["eval-rpc", "rpc", "json"], default="eval-rpc")
    parser.add_argument("--omni-fallback-rpc", action="store_true", help="Allow omp-omni to run OMP --mode rpc if binary not provided")
    parser.add_argument("--concurrency", type=int, default=1, help="Number of concurrent isolated task workers (default: 1)")
    parser.add_argument("--list-tasks", action="store_true", help="List discovered tasks and exit")
    args = parser.parse_args()

    def _split_list(vals: List[str]) -> List[str]:
        out: List[str] = []
        for item in vals:
            for part in item.split(","):
                p = part.strip()
                if p:
                    out.append(p)
        return out

    task_filter = _split_list(args.tasks) or None
    axis_filter = [int(a) for a in _split_list(args.axes)] or None
    tasks = discover_tasks(task_ids=task_filter, axes=axis_filter)

    if args.list_tasks:
        for t in tasks:
            print(f"[Axis {t['axis']}] {t['id']:30s} | {t['title']}")
        print(f"Total: {len(tasks)} tasks")
        return 0

    if not tasks:
        print("No matching tasks found.", file=sys.stderr)
        return 1

    harnesses = _split_list(args.harnesses)
    models = _split_list(args.models)
    base_env = build_clean_env()

    work_items = [(h, m, t) for h in harnesses for m in models for t in tasks]
    total_runs = len(work_items)
    done = 0
    passed_count = 0
    print_lock = threading.Lock()
    workers = max(1, int(args.concurrency))

    print(
        f"=== Harness Benchmark Runner | phase={args.phase} | harnesses={harnesses} | "
        f"models={models} | tasks={len(tasks)} | total_runs={total_runs} | concurrency={workers} ===",
        flush=True,
    )

    def _exec_item(idx_item: Tuple[int, Tuple[str, str, Dict[str, Any]]]) -> bool:
        idx, (harness, model, task) = idx_item
        out_file = RESULTS_RAW_DIR / args.phase / harness / model / f"{task['id']}.json"
        if args.resume and out_file.exists():
            prev = json.loads(out_file.read_text(encoding="utf-8"))
            if not (args.retry_errors and prev.get("status") != "completed"):
                with print_lock:
                    print(
                        f"[{idx}/{total_runs}] SKIP(resume) {harness}/{model}/{task['id']} "
                        f"passed={prev.get('passed')} score={prev.get('score')}",
                        flush=True,
                    )
                return bool(prev.get("passed"))

        with print_lock:
            print(f"[{idx}/{total_runs}] RUN {harness}/{model}/{task['id']} ...", flush=True)

        rec = run_single_task(
            phase=args.phase,
            harness=harness,
            model=model,
            task=task,
            base_env=base_env,
            timeout_override=args.timeout,
            max_turns_override=args.max_turns,
            keep_workspace=args.keep_workspaces,
            omni_bin=args.omni_bin,
            omni_protocol=args.omni_protocol,
            omni_fallback_rpc=args.omni_fallback_rpc,
        )
        tel = rec["telemetry"]
        res = rec["resources"]
        verdict = "PASS" if rec["passed"] else "FAIL"
        extra_parts: List[str] = []
        if tel.get("merkle_refresh_ms") is not None:
            extra_parts.append(f"merkle={tel['merkle_refresh_ms']}ms")
        if tel.get("lakeview_compressions"):
            extra_parts.append(f"lv={tel['lakeview_compressions']}")
        if tel.get("omni_recovery_attempts"):
            extra_parts.append(f"recov={tel['omni_recovery_attempts']}")
        if tel.get("http_retries"):
            extra_parts.append(f"retry={tel['http_retries']}")
        if tel.get("stall_retries"):
            extra_parts.append(f"stall={tel['stall_retries']}")
        if tel.get("truncated_stream_retries"):
            extra_parts.append(f"trunc={tel['truncated_stream_retries']}")
        if tel.get("narration_nudges"):
            extra_parts.append(f"narr={tel['narration_nudges']}")
        if tel.get("verify_gate_nudges"):
            extra_parts.append(f"vgate={tel['verify_gate_nudges']}")
        if tel.get("interleaved_reasoning_turns"):
            extra_parts.append(f"ir={tel['interleaved_reasoning_turns']}")
        extra_str = (", " + ", ".join(extra_parts)) if extra_parts else ""
        with print_lock:
            print(
                f"    -> [{idx}/{total_runs}] {harness}/{model}/{task['id']}: {verdict} "
                f"(score={rec['score']:.2f}, status={rec['status']}, "
                f"wall={rec['wall_time_s']:.2f}s, ttft={tel.get('ttft_s')}s, "
                f"gen_tps={tel.get('gen_tokens_per_sec')}, tok={tel.get('total_tokens')} "
                f"[in={tel.get('input_tokens')}, cache={tel.get('cache_read_tokens')}, out={tel.get('output_tokens')}], "
                f"turns={tel.get('turn_count')}, tools={tel.get('tool_call_count')}, "
                f"rss={res.get('peak_rss_mb', 0):.1f}MB{extra_str})",
                flush=True,
            )
        return bool(rec["passed"])

    if workers == 1:
        for idx, item in enumerate(work_items, 1):
            done += 1
            if _exec_item((idx, item)):
                passed_count += 1
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            for ok in pool.map(_exec_item, enumerate(work_items, 1)):
                done += 1
                if ok:
                    passed_count += 1

    print(f"=== Completed {done}/{total_runs} runs | Passed: {passed_count}/{total_runs} ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
