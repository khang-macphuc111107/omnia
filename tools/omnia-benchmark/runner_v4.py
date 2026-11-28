"""Clean-Room 5-Harness v4 Benchmark Orchestrator (Omnia vs Codex vs Claude Code vs OpenCode vs AGY).

100% exclusive htmustc upstream enforcement:
  - Every run launches inside an ephemeral `D:\\omnia-bench\\env\\<harness>\\<run_id>\\`
    sandbox with strict allowlist minimal env and hard loopback egress firewall
    (`HTTP_PROXY=http://127.0.0.1:1`, `NO_PROXY=127.0.0.1,localhost`).
  - Every LLM request traverses `BenchTelemetryProxy` on an ephemeral loopback port,
    forwarding strictly to `https://htmustc.id.vn` (using `HTMUSTC_API_KEY` from env).
  - Exact wire-level telemetry (`telemetry_wire.jsonl`) + Win32 Job Object process-tree
    memory/CPU profiling (`proc_monitor.py`) + hidden deterministic verifiers (`verify.py`).
  - Serial execution (concurrency=1) with Latin-square interleaved harness rotation and
    5s cooldown to eliminate htmustc 429 storms and host CPU/RAM contention.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from bench_telemetry_proxy import BenchTelemetryProxy
from cleanroom import (
    BENCH_ROOT,
    assert_clean_ancestors,
    audit_non_loopback_sockets,
    prepare_harness_launch,
)
from proc_monitor import ProcessTreeMonitor, get_process_tree_pids, terminate_process_tree

SUITE_ROOT = Path(__file__).resolve().parent
TASKS_DIR = SUITE_ROOT / "suite" / "tasks"
RESULTS_DIR = BENCH_ROOT / "results" / "v4"

DEFAULT_MODELS = ["claude-sonnet-5-5", "gemini-3.8-flash", "gpt-6.2-sol"]
DEFAULT_HARNESSES = ["codex", "claude", "opencode", "agy", "omnia"]
EDIT_TOOL_HINTS = ("edit", "patch", "write", "replace", "multi_replace", "apply_patch", "str_replace")


def discover_tasks(task_ids: Optional[List[str]] = None, axes: Optional[List[int]] = None) -> List[Dict[str, Any]]:
    tasks: List[Dict[str, Any]] = []
    for entry in sorted(TASKS_DIR.iterdir()):
        mp = entry / "task.json"
        if not entry.is_dir() or not mp.exists():
            continue
        meta = json.loads(mp.read_text(encoding="utf-8"))
        meta["_dir"] = entry
        if task_ids and meta["id"] not in task_ids:
            continue
        if axes and int(meta["axis"]) not in axes:
            continue
        tasks.append(meta)
    tasks.sort(key=lambda t: (int(t["axis"]), t["id"]))
    return tasks


def prepare_workspace(task: Dict[str, Any], work_dir: Path, env: Dict[str, str]) -> None:
    tdir: Path = task["_dir"]
    src_ws = tdir / task.get("workspace_dir", "workspace")
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    if src_ws.exists():
        shutil.copytree(src_ws, work_dir)
    else:
        work_dir.mkdir(parents=True, exist_ok=True)
    setup_script = task.get("setup_script")
    if setup_script:
        sp = tdir / setup_script
        r = subprocess.run(
            [sys.executable, str(sp), "--workspace", str(work_dir)],
            cwd=str(tdir), env=env, capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            raise RuntimeError(f"setup.py failed ({r.returncode}): {r.stdout}\n{r.stderr}")


def run_verifier(task: Dict[str, Any], work_dir: Path, env: Dict[str, str], timeout_s: int = 120) -> Dict[str, Any]:
    tdir: Path = task["_dir"]
    vp = tdir / task.get("verify_script", "verify.py")
    t0 = time.perf_counter()
    try:
        r = subprocess.run(
            [sys.executable, str(vp), "--workspace", str(work_dir)],
            cwd=str(tdir), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_s,
        )
        dur = time.perf_counter() - t0
        stdout = (r.stdout or "").strip()
        parsed = None
        if stdout:
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError:
                for ln in reversed(stdout.splitlines()):
                    ln = ln.strip()
                    if ln.startswith("{") and ln.endswith("}"):
                        try:
                            parsed = json.loads(ln)
                            break
                        except json.JSONDecodeError:
                            continue
        if parsed is None:
            return {"passed": False, "score": 0.0, "error": f"non-JSON verifier output rc={r.returncode}: {stdout[-400:]} | {r.stderr[-400:]}", "verifier_exit_code": r.returncode, "verifier_duration_s": round(dur, 3)}
        parsed["verifier_exit_code"] = r.returncode
        parsed["verifier_duration_s"] = round(dur, 3)
        if r.returncode != 0:
            parsed["passed"] = False
        return parsed
    except Exception as exc:
        return {"passed": False, "score": 0.0, "error": str(exc), "verifier_exit_code": -1, "verifier_duration_s": round(time.perf_counter() - t0, 3)}


def _reader(stream, q: "queue.Queue[Tuple[str, float, Optional[str]]]", tag: str) -> None:
    try:
        for line in iter(stream.readline, ""):
            q.put((tag, time.perf_counter(), line))
    except Exception:
        pass
    finally:
        q.put((tag, time.perf_counter(), None))


def _detect_doom_loop(tool_sigs: List[str]) -> bool:
    """Detect >=3 identical consecutive calls or A->B->A->B oscillation."""
    if len(tool_sigs) >= 3:
        for i in range(len(tool_sigs) - 2):
            if tool_sigs[i] == tool_sigs[i + 1] == tool_sigs[i + 2]:
                return True
    if len(tool_sigs) >= 4:
        for i in range(len(tool_sigs) - 3):
            if tool_sigs[i] == tool_sigs[i + 2] and tool_sigs[i + 1] == tool_sigs[i + 3] and tool_sigs[i] != tool_sigs[i + 1]:
                return True
    return False


def parse_harness_stream(harness: str, stdout_events: List[Tuple[float, str]], t_spawn: float) -> Dict[str, Any]:
    """Extract normalized tool calls, edit failures, doom-loop flag, and client TTFT from NDJSON."""
    client_ttft_s: Optional[float] = None
    tool_calls: List[str] = []
    tool_sigs: List[str] = []
    tool_errors = 0
    edit_calls = 0
    edit_errors = 0
    errors: List[str] = []
    final_text = ""
    omnia_pending_args: Dict[str, str] = {}

    for ts, line in stdout_events:
        s = line.strip()
        if not s or not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except json.JSONDecodeError:
            continue

        if harness == "codex":
            et = ev.get("type", "")
            if et == "error" or et == "turn.failed":
                errors.append(str(ev.get("message") or ev.get("error") or ev)[:300])
            elif et in ("item.completed", "item.started"):
                item = ev.get("item") or {}
                itype = item.get("type", "")
                if itype == "agent_message" and item.get("text"):
                    if client_ttft_s is None:
                        client_ttft_s = max(0.0, ts - t_spawn)
                    final_text = str(item["text"])
                elif et == "item.completed" and itype in ("command_execution", "file_change", "mcp_tool_call", "function_call"):
                    tname = item.get("tool") or itype
                    tool_calls.append(tname)
                    sig = f"{tname}:{str(item.get('command') or item.get('changes') or item.get('arguments') or '')[:120]}"
                    tool_sigs.append(sig)
                    is_edit = itype == "file_change" or any(h in tname.lower() for h in EDIT_TOOL_HINTS)
                    if is_edit:
                        edit_calls += 1
                    failed = item.get("status") == "failed" or (isinstance(item.get("exit_code"), int) and item["exit_code"] != 0)
                    if failed:
                        tool_errors += 1
                        if is_edit:
                            edit_errors += 1

        elif harness == "claude":
            et = ev.get("type", "")
            if et == "assistant":
                msg = ev.get("message") or {}
                for blk in msg.get("content") or []:
                    if not isinstance(blk, dict):
                        continue
                    bt = blk.get("type")
                    if bt == "text" and blk.get("text"):
                        if client_ttft_s is None:
                            client_ttft_s = max(0.0, ts - t_spawn)
                        final_text = str(blk["text"])
                    elif bt == "tool_use":
                        if client_ttft_s is None:
                            client_ttft_s = max(0.0, ts - t_spawn)
                        tname = str(blk.get("name") or "unknown")
                        tool_calls.append(tname)
                        tool_sigs.append(f"{tname}:{json.dumps(blk.get('input') or {}, sort_keys=True)[:120]}")
                        if any(h in tname.lower() for h in EDIT_TOOL_HINTS):
                            edit_calls += 1
            elif et == "user":
                msg = ev.get("message") or {}
                for blk in msg.get("content") or []:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result" and blk.get("is_error") is True:
                        tool_errors += 1
                        if tool_calls and any(h in tool_calls[-1].lower() for h in EDIT_TOOL_HINTS):
                            edit_errors += 1
            elif et == "result":
                if ev.get("is_error"):
                    errors.append(str(ev.get("result") or ev.get("error") or "claude result error")[:300])
                if ev.get("result") and not final_text:
                    final_text = str(ev["result"])

        elif harness == "opencode":
            et = ev.get("type", "")
            part = ev.get("part") or {}
            if et == "error":
                errors.append(str(ev.get("error") or ev)[:300])
            elif et == "text" and part.get("text"):
                if client_ttft_s is None:
                    client_ttft_s = max(0.0, ts - t_spawn)
                final_text += str(part["text"])
            elif et == "tool_use":
                if client_ttft_s is None:
                    client_ttft_s = max(0.0, ts - t_spawn)
                tname = str(part.get("tool") or "unknown")
                st = part.get("state") or {}
                tool_calls.append(tname)
                tool_sigs.append(f"{tname}:{json.dumps(st.get('input') or {}, sort_keys=True)[:120]}")
                is_edit = any(h in tname.lower() for h in EDIT_TOOL_HINTS)
                if is_edit:
                    edit_calls += 1
                if st.get("status") == "error":
                    tool_errors += 1
                    if is_edit:
                        edit_errors += 1

        elif harness == "agy":
            et = ev.get("event", "")
            if et == "step_update":
                su = ev.get("step_update") or {}
                stype = su.get("step_type", "")
                if stype == "agent_response" and su.get("text_delta"):
                    if client_ttft_s is None:
                        client_ttft_s = max(0.0, ts - t_spawn)
                    final_text += str(su["text_delta"])
                elif stype == "tool" and su.get("state") == "DONE":
                    if client_ttft_s is None:
                        client_ttft_s = max(0.0, ts - t_spawn)
                    ti = su.get("tool_info") or {}
                    tname = str(su.get("tool_name") or ti.get("name") or "unknown")
                    tool_calls.append(tname)
                    tool_sigs.append(f"{tname}:{json.dumps(ti.get('parameters') or {}, sort_keys=True)[:120]}")
                    is_edit = any(h in tname.lower() for h in EDIT_TOOL_HINTS)
                    if is_edit:
                        edit_calls += 1
                    if ti.get("error"):
                        tool_errors += 1
                        if is_edit:
                            edit_errors += 1
            elif et == "result":
                res = ev.get("result") or {}
                if res.get("status") not in ("SUCCESS", None):
                    errors.append(str(res.get("error") or res.get("status"))[:300])
                if res.get("response") and not final_text:
                    final_text = str(res["response"])

        elif harness == "omnia":
            # Schema emitted by D:\Omnia\rust\omnia-cli\src\main.rs (stream-json):
            #   session_start | turn_start | turn_end | delta{textDelta,thinkingDelta}
            #   tool_start{toolName,arguments} | tool_end{toolName,isError,durationMs}
            #   auto_recovery | metrics | telemetry | final_summary{report} | error{message}
            et = ev.get("type", "") or ev.get("event", "")
            if et == "delta" or et in ("text_delta", "assistant_delta", "message_delta"):
                txt = ev.get("textDelta") or ev.get("text") or ev.get("delta") or ""
                if (txt or ev.get("thinkingDelta")) and client_ttft_s is None:
                    client_ttft_s = max(0.0, ts - t_spawn)
                final_text += str(txt)
            elif et == "tool_start":
                if client_ttft_s is None:
                    client_ttft_s = max(0.0, ts - t_spawn)
                omnia_pending_args[str(ev.get("toolCallId") or "")] = str(ev.get("arguments") or "")[:120]
            elif et in ("tool_end", "tool_execution_end", "tool_result"):
                tname = str(ev.get("toolName") or ev.get("tool") or ev.get("tool_name") or "unknown")
                tool_calls.append(tname)
                targs = omnia_pending_args.pop(str(ev.get("toolCallId") or ""), "") or str(ev.get("args") or ev.get("input") or "")[:120]
                tool_sigs.append(f"{tname}:{targs}")
                is_edit = any(h in tname.lower() for h in EDIT_TOOL_HINTS)
                if is_edit:
                    edit_calls += 1
                if ev.get("isError") or ev.get("is_error") or ev.get("error"):
                    tool_errors += 1
                    if is_edit:
                        edit_errors += 1
            elif et == "final_summary":
                rep = ev.get("report") or {}
                if isinstance(rep, dict):
                    if rep.get("final_text") and not final_text:
                        final_text = str(rep["final_text"])
                    if rep.get("success") is False and rep.get("error"):
                        errors.append(str(rep.get("error"))[:300])
            elif et == "error":
                errors.append(str(ev.get("error") or ev.get("message") or ev)[:300])

    hist: Dict[str, int] = {}
    for t in tool_calls:
        hist[t] = hist.get(t, 0) + 1
    return {
        "client_ttft_s": round(client_ttft_s, 4) if client_ttft_s is not None else None,
        "tool_call_count": len(tool_calls),
        "tool_error_count": tool_errors,
        "tool_error_rate": round(tool_errors / len(tool_calls), 4) if tool_calls else 0.0,
        "edit_call_count": edit_calls,
        "edit_error_count": edit_errors,
        "edit_failure_rate": round(edit_errors / edit_calls, 4) if edit_calls else 0.0,
        "doom_loop_detected": _detect_doom_loop(tool_sigs),
        "tool_histogram": hist,
        "harness_errors": errors[:10],
        "final_assistant_text": final_text[:8000],
    }


def run_single_trial(
    phase: str,
    harness: str,
    model: str,
    task: Dict[str, Any],
    repeat_idx: int = 0,
    *,
    omnia_bin: Optional[Path] = None,
    check_sockets: bool = True,
    results_root: Optional[Path] = None,
) -> Dict[str, Any]:
    tid = task["id"]
    tdir: Path = task["_dir"]
    prompt = (tdir / task.get("prompt_file", "prompt.md")).read_text(encoding="utf-8")
    timeout_s = int(task.get("timeout_s") or 300)
    fault_mode = task.get("fault_mode")

    rid = f"{phase}-{harness}-{model}-{tid}-r{repeat_idx}-{uuid.uuid4().hex[:6]}"
    (BENCH_ROOT / "workspaces").mkdir(parents=True, exist_ok=True)
    ws = Path(tempfile.mkdtemp(prefix=f"ws_{tid}_", dir=str(BENCH_ROOT / "workspaces")))
    out_dir = (results_root or (RESULTS_DIR / phase)) / harness / model
    out_dir.mkdir(parents=True, exist_ok=True)
    wire_log_path = out_dir / f"{tid}_r{repeat_idx}.wire.jsonl"
    wire_log_path.unlink(missing_ok=True)

    proxy = BenchTelemetryProxy(
        run_id=rid,
        harness=harness,
        task_id=tid,
        model_override=model,
        log_path=wire_log_path,
        fault_mode=fault_mode,
    )
    port = proxy.start()
    launch = prepare_harness_launch(
        harness, model, prompt, ws, port, run_id=rid, timeout_s=timeout_s, omnia_bin=omnia_bin
    )

    stdout_events: List[Tuple[float, str]] = []
    stderr_lines: List[str] = []
    timed_out = False
    exit_code = -1
    non_loopback_sockets: List[dict] = []

    try:
        prepare_workspace(task, ws, launch.env)
        wall_start_ns = time.perf_counter_ns()
        t_spawn = wall_start_ns / 1e9
        proc = subprocess.Popen(
            launch.cmd,
            cwd=str(ws),
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
        t_out = threading.Thread(target=_reader, args=(proc.stdout, q, "out"), daemon=True)
        t_err = threading.Thread(target=_reader, args=(proc.stderr, q, "err"), daemon=True)
        t_out.start()
        t_err.start()

        closed = 0
        socket_checked = False
        deadline = t_spawn + timeout_s
        while closed < 2:
            rem = deadline - time.perf_counter()
            if rem <= 0:
                timed_out = True
                terminate_process_tree(proc.pid)
                break
            if check_sockets and not socket_checked and (time.perf_counter() - t_spawn) >= 2.0:
                socket_checked = True
                pids, _ = get_process_tree_pids(proc.pid)
                non_loopback_sockets = audit_non_loopback_sockets(pids)
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
        res_summary = mon.stop()
        wire_summary = proxy.stop((wall_start_ns, wall_end_ns))
        harness_overhead_ms = wire_summary["wire_window_uncovered_ms"]

        stream_metrics = parse_harness_stream(harness, stdout_events, t_spawn)
        verify_res = run_verifier(task, ws, launch.env, timeout_s=120)


        record = {
            "schema_version": "4.0",
            "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "run_id": rid,
            "phase": phase,
            "harness": harness,
            "model": model,
            "task_id": tid,
            "axis": int(task["axis"]),
            "repeat": repeat_idx,
            "wire_protocol": launch.wire_protocol,
            "fault_mode": fault_mode,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "wall_time_s": round(wall_s, 3),
            "harness_overhead_ms": round(harness_overhead_ms, 2) if harness_overhead_ms is not None else None,
            "passed": bool(verify_res.get("passed")) and not timed_out,
            "score": float(verify_res.get("score", 0.0)),
            "verifier": verify_res,
            "wire": wire_summary,
            "stream": stream_metrics,
            "resources": res_summary.to_dict(),
            "egress_audit": {
                "non_loopback_sockets": non_loopback_sockets,
                "egress_clean": len(non_loopback_sockets) == 0,
                "htmustc_only_verified": wire_summary.get("wire_requests", 0) >= 1 and len(non_loopback_sockets) == 0,
            },
            "stderr_tail": "".join(stderr_lines)[-1200:],
        }
        rec_path = out_dir / f"{tid}_r{repeat_idx}.json"
        rec_path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        return record
    finally:
        if proxy._server is not None:
            proxy.stop()
        launch.cleanup()
        shutil.rmtree(ws, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="stage0")
    ap.add_argument("--harnesses", nargs="+", default=["codex", "claude", "opencode", "agy"])
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--tasks", nargs="+", default=None)
    ap.add_argument("--axes", nargs="+", type=int, default=None)
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--cooldown-s", type=float, default=5.0)
    ap.add_argument("--omnia-bin", default=None)
    ap.add_argument("--results-dir", default=None, help="Root for <harness>/<model>/<task>_r<k>.json records")
    ap.add_argument("--resume", action="store_true", help="Skip trials whose record JSON already exists")
    args = ap.parse_args()

    if not os.environ.get("HTMUSTC_API_KEY"):
        print("ERROR: HTMUSTC_API_KEY env var must be set (never hardcoded).", file=sys.stderr)
        return 2

    assert_clean_ancestors()
    tasks = discover_tasks(args.tasks, args.axes)
    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None
    results_root = Path(args.results_dir) if args.results_dir else (RESULTS_DIR / args.phase)
    results_root.mkdir(parents=True, exist_ok=True)
    grand = len(tasks) * len(args.models) * len(args.harnesses) * args.repeats
    print(f"=== Runner v4 [{args.phase}]: {len(tasks)} tasks x {len(args.models)} models x {len(args.harnesses)} harnesses x {args.repeats} repeats = {grand} runs -> {results_root} ===", flush=True)

    # Latin-square interleaved rotation across harnesses per (task, model, repeat)
    total_runs = 0
    idx = 0
    for r in range(args.repeats):
        for model in args.models:
            for task in tasks:
                rot = idx % len(args.harnesses)
                ordered = args.harnesses[rot:] + args.harnesses[:rot]
                idx += 1
                for h in ordered:
                    total_runs += 1
                    rec_path = results_root / h / model / f"{task['id']}_r{r}.json"
                    if args.resume and rec_path.exists():
                        print(f"[{total_runs}/{grand}] {h:9s} | {model:18s} | {task['id']:28s} (r{r}) SKIP (exists)", flush=True)
                        continue
                    print(f"[{total_runs}/{grand}] {h:9s} | {model:18s} | {task['id']:28s} (r{r}) ...", end=" ", flush=True)
                    try:
                        rec = run_single_trial(args.phase, h, model, task, r, omnia_bin=omnia_bin, results_root=results_root)
                    except Exception as exc:  # harness launch failure is a measured result, never a runner crash
                        rec_path.parent.mkdir(parents=True, exist_ok=True)
                        err_rec = {
                            "schema_version": "4.0", "phase": args.phase, "harness": h, "model": model,
                            "task_id": task["id"], "axis": int(task["axis"]), "repeat": r,
                            "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                            "passed": False, "score": 0.0, "runner_exception": f"{type(exc).__name__}: {exc}"[:800],
                        }
                        rec_path.write_text(json.dumps(err_rec, indent=2, ensure_ascii=False), encoding="utf-8")
                        print(f"ERROR {type(exc).__name__}: {str(exc)[:200]}", flush=True)
                        continue
                    w = rec["wire"]
                    res = rec["resources"]
                    st = rec["stream"]
                    overhead = rec["harness_overhead_ms"]
                    overhead_label = "unknown" if overhead is None else f"{overhead}ms"
                    print(
                        f"{'PASS' if rec['passed'] else 'FAIL'} "
                        f"rc={rec['exit_code']} to={int(rec['timed_out'])} wall={rec['wall_time_s']}s ovh={overhead_label} "
                        f"reqs={w.get('wire_requests')} werr={w.get('wire_errors')} tok={w.get('wire_total_tokens')} "
                        f"tc={st['tool_call_count']} terr={st['tool_error_count']} rss={res.get('peak_harness_rss_mb')}MB "
                        f"leaks={len(rec['egress_audit']['non_loopback_sockets'])}",
                        flush=True,
                    )
                    if args.cooldown_s > 0:
                        time.sleep(args.cooldown_s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
