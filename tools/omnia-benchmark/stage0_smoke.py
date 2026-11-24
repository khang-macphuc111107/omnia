"""Stage 0 Live 3-Family Preflight Smoke Matrix (4 competitors x 3 htmustc models = 12 runs).

Verifies for every (harness, model) pair strictly against https://htmustc.id.vn:
  1. End-to-end tool execution: agent must inspect `calc.py` (which returns `a - b`), fix `add(a, b)`
     to return `a + b`, and verify with Python.
  2. Wire telemetry integrity: `wire_requests >= 1`, canonical tokens > 0, wire TTFT measured.
  3. Zero egress leaks: `non_loopback_sockets == []` (hard loopback firewall active).
  4. Honest compatibility recording: surfaces exact HTTP/wire/tool-call errors if a competitor
     fails on a non-home model family (e.g., Codex on Claude/Gemini, Claude Code on GPT).
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
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
from runner_v4 import _reader, parse_harness_stream

SMOKE_PROMPT = (
    "In this workspace, `calc.py` has a bug in `add(a, b)` (it subtracts instead of adding). "
    "Edit `calc.py` so `add(a, b)` returns `a + b`, verify by running `python -c \"import calc; assert calc.add(2, 3) == 5\"`, "
    "and reply with DONE."
)
MODELS = ["claude-sonnet-5-5", "gemini-3.8-flash", "gpt-6.2-sol"]
HARNESSES = ["codex", "claude", "opencode", "agy"]


def run_smoke_cell(harness: str, model: str, timeout_s: int = 120, omnia_bin: Optional[Path] = None) -> Dict[str, Any]:
    rid = f"s0-{harness}-{model}"
    ws = Path(tempfile.mkdtemp(prefix=f"s0_{harness}_", dir=str(BENCH_ROOT / "workspaces")))
    (ws / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8", newline="\n")
    wire_log = BENCH_ROOT / "results" / "stage0_smoke" / f"{harness}_{model}.wire.jsonl"
    wire_log.parent.mkdir(parents=True, exist_ok=True)
    wire_log.unlink(missing_ok=True)

    proxy = BenchTelemetryProxy(
        run_id=rid, harness=harness, task_id="stage0_smoke", model_override=model, log_path=wire_log
    )
    port = proxy.start()
    launch = prepare_harness_launch(
        harness, model, SMOKE_PROMPT, ws, port, run_id=rid, timeout_s=timeout_s, omnia_bin=omnia_bin
    )

    stdout_events: List[Tuple[float, str]] = []
    stderr_lines: List[str] = []
    timed_out = False
    exit_code = -1
    leaks: List[dict] = []

    try:
        wall_start_ns = time.perf_counter_ns()
        t0 = wall_start_ns / 1e9
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
        sock_done = False
        deadline = t0 + timeout_s
        while closed < 2:
            rem = deadline - time.perf_counter()
            if rem <= 0:
                timed_out = True
                terminate_process_tree(proc.pid)
                break
            if not sock_done and (time.perf_counter() - t0) >= 2.5:
                sock_done = True
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
        wire = proxy.stop((wall_start_ns, wall_end_ns))
        harness_overhead_ms = wire["wire_window_uncovered_ms"]
        stream = parse_harness_stream(harness, stdout_events, t0)

        # Verify calc.py actually fixed
        chk = subprocess.run(
            [sys.executable, "-c", "import calc; assert calc.add(2, 3) == 5 and calc.add(-1, 4) == 3"],
            cwd=str(ws), capture_output=True, text=True, timeout=10,
        )
        edit_passed = (chk.returncode == 0)
        calc_after = (ws / "calc.py").read_text("utf-8", errors="replace")

        return {
            "harness": harness,
            "model": model,
            "wire_protocol": launch.wire_protocol,
            "passed": edit_passed and not timed_out,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "wall_s": round(wall_s, 2),
            "wire_wall_window_ns": wire["wire_wall_window_ns"],
            "wire_window_inference_ns": wire["wire_window_inference_ns"],
            "harness_overhead_ms": round(harness_overhead_ms, 1) if harness_overhead_ms is not None else None,
            "wire_requests": wire.get("wire_requests", 0),
            "wire_errors": wire.get("wire_errors", 0),
            "wire_ttft_ms": wire.get("wire_first_ttft_ms"),
            "wire_tokens": wire.get("wire_total_tokens"),
            "wire_tool_calls": wire.get("wire_tool_calls_emitted", 0),
            "stream_tool_calls": stream.get("tool_call_count", 0),
            "peak_harness_rss_mb": res.peak_harness_rss_mb,
            "peak_job_mem_mb": res.peak_job_memory_mb,
            "non_loopback_sockets": leaks,
            "egress_clean": len(leaks) == 0,
            "htmustc_only_ok": wire.get("wire_requests", 0) >= 1 and len(leaks) == 0,
            "harness_errors": stream.get("harness_errors", []),
            "stderr_tail": "".join(stderr_lines)[-500:],
            "calc_after": calc_after[:200],
        }
    finally:
        if proxy._server is not None:
            proxy.stop()
        launch.cleanup()
        shutil.rmtree(ws, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--harnesses", nargs="+", default=HARNESSES)
    ap.add_argument("--models", nargs="+", default=MODELS)
    ap.add_argument("--timeout-s", type=int, default=120)
    ap.add_argument("--cooldown-s", type=float, default=3.0)
    ap.add_argument("--out", default=str(BENCH_ROOT / "results" / "stage0_smoke_matrix.json"))
    ap.add_argument("--omnia-bin", default=None)
    args = ap.parse_args()

    if not os.environ.get("HTMUSTC_API_KEY"):
        print("ERROR: set HTMUSTC_API_KEY env var", file=sys.stderr)
        return 2

    assert_clean_ancestors()
    rows: List[Dict[str, Any]] = []
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None

    for m in args.models:
        for h in args.harnesses:
            print(f"[SMOKE] {h:9s} x {m:18s} ...", end=" ", flush=True)
            row = run_smoke_cell(h, m, timeout_s=args.timeout_s, omnia_bin=omnia_bin)
            rows.append(row)
            status = "PASS" if row["passed"] else "FAIL"
            print(
                f"{status} rc={row['exit_code']} wall={row['wall_s']}s reqs={row['wire_requests']} "
                f"w_err={row['wire_errors']} tok={row['wire_tokens']} tc={row['stream_tool_calls']}/{row['wire_tool_calls']} "
                f"rss={row['peak_harness_rss_mb']}MB leaks={len(row['non_loopback_sockets'])}",
                flush=True,
            )
            if not row["passed"]:
                print(f"   diag: errs={row['harness_errors'][:2]} stderr={row['stderr_tail'][:240]!r}", flush=True)
            out_path.write_text(json.dumps({"cells": rows}, indent=2), encoding="utf-8")
            if args.cooldown_s > 0:
                time.sleep(args.cooldown_s)

    print(f"\nSaved Stage 0 smoke matrix -> {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
