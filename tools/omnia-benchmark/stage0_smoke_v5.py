"""Suite v5 Clean-Room Live Preflight Smoke Matrix (7 harnesses x GPT & Claude ONLY).

Strictly excludes `agy` and all `gemini-*` models. Verifies end-to-end tool edits,
loopback BenchTelemetryProxy capture (`wire_requests >= 1`, canonical tokens, wire TTFT),
and zero non-loopback network egress across all 6 staged competitors + Omnia.
"""
from __future__ import annotations

import argparse
import json
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
from cleanroom import assert_clean_ancestors, audit_non_loopback_sockets, prepare_harness_launch
from proc_monitor import ProcessTreeMonitor, get_process_tree_pids, terminate_process_tree
import runner_v4
import runner_v5

SMOKE_PROMPT = (
    "In this workspace, `calc.py` has a bug in `add(a, b)` (it returns `a - b` instead of `a + b`). "
    "Edit `calc.py` so `add(a, b)` returns `a + b`, verify by running "
    "`python -c \"import calc; assert calc.add(2, 3) == 5\"`, and reply with DONE."
)


def run_smoke_cell(
    harness: str,
    model: str,
    *,
    timeout_s: int = 120,
    omnia_bin: Optional[Path] = None,
    out_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    runner_v5.validate_harness_and_model(harness, model)
    assert_clean_ancestors()

    base = out_dir or Path(r"D:\OmniaData\qa\v5-bench\stage0_smoke")
    ws_parent = base / "_workspaces"
    log_dir = base / "logs"
    ws_parent.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    rid = f"s0v5-{harness}-{model}"
    ws = Path(tempfile.mkdtemp(prefix=f"s0v5_{harness}_", dir=str(ws_parent)))
    (ws / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8", newline="\n")
    wire_log = log_dir / f"{harness}_{model}.wire.jsonl"
    stdout_log = log_dir / f"{harness}_{model}.stdout.jsonl"
    wire_log.unlink(missing_ok=True)

    api_key = runner_v5.load_htmustc_api_key(model)
    proxy = BenchTelemetryProxy(
        run_id=rid,
        harness=harness,
        task_id="stage0_smoke_v5",
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
            harness, model, SMOKE_PROMPT, ws, port, run_id=rid, timeout_s=timeout_s, omnia_bin=omnia_bin
        )
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
        t_out = threading.Thread(target=runner_v4._reader, args=(proc.stdout, q, "out"), daemon=True)
        t_err = threading.Thread(target=runner_v4._reader, args=(proc.stderr, q, "err"), daemon=True)
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
            if not sock_done and (time.perf_counter() - t0) >= 2.0:
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
        wire = runner_v5.reconcile_wire_http_error_usage(wire_log, proxy.stop((wall_start_ns, wall_end_ns)))
        stdout_log.write_text("".join(ln for _, ln in stdout_events), encoding="utf-8", newline="\n")
        stream = runner_v5.parse_harness_stream_v5(harness, stdout_events, stderr_lines, t0, wall_s)

        chk = subprocess.run(
            [sys.executable, "-B", "-c", "import calc; assert calc.add(2, 3) == 5 and calc.add(-1, 4) == 3"],
            cwd=str(ws),
            capture_output=True,
            text=True,
            timeout=10,
        )
        edit_passed = chk.returncode == 0
        calc_after = (ws / "calc.py").read_text("utf-8", errors="replace")
        return {
            "harness": harness,
            "model": model,
            "wire_protocol": launch.wire_protocol,
            "passed": edit_passed and not timed_out,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "wall_s": round(wall_s, 2),
            "wire_requests": wire.get("wire_requests", 0),
            "wire_errors": wire.get("wire_errors", 0),
            "wire_ttft_ms": wire.get("wire_first_ttft_ms"),
            "wire_tokens": wire.get("wire_total_tokens"),
            "wire_tool_calls": wire.get("wire_tool_calls_emitted", 0),
            "stream_tool_calls": stream.get("tool_call_count", 0),
            "peak_rss_mb": round(res.peak_rss_mb, 2),
            "peak_job_mem_mb": round(res.peak_job_memory_mb, 2),
            "non_loopback_sockets": leaks,
            "egress_clean": len(leaks) == 0,
            "htmustc_only_ok": (wire.get("wire_requests") or 0) >= 1 and len(leaks) == 0,
            "harness_errors": stream.get("harness_errors", []),
            "stderr_tail": "".join(stderr_lines)[-400:],
            "calc_after": calc_after[:160],
        }
    finally:
        try:
            if getattr(proxy, "_server", None) is not None:
                proxy.stop()
        except Exception:
            pass
        if launch is not None:
            launch.cleanup()
        shutil.rmtree(ws, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Suite v5 clean-room live Stage 0 smoke matrix")
    ap.add_argument("--harnesses", nargs="+", default=["codex", "claude", "opencode", "goose", "omp", "dsh"])
    ap.add_argument("--models", nargs="+", default=list(runner_v5.V5_DEFAULT_MODELS))
    ap.add_argument("--timeout-s", type=int, default=120)
    ap.add_argument("--cooldown-s", type=float, default=2.0)
    ap.add_argument("--omnia-bin", default=None)
    ap.add_argument("--out", default=r"D:\OmniaData\qa\v5-bench\stage0_smoke\matrix.json")
    ap.add_argument("--overwrite", action="store_true", help="Replace existing out file instead of merging by (harness, model)")
    args = ap.parse_args()

    for m in args.models:
        for h in args.harnesses:
            runner_v5.validate_harness_and_model(h, m)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None
    merged_map: Dict[Tuple[str, str], Dict[str, Any]] = {}
    if not args.overwrite and out_path.exists():
        try:
            for c in json.loads(out_path.read_text(encoding="utf-8")).get("cells") or []:
                merged_map[(str(c.get("harness")), str(c.get("model")))] = c
        except Exception:
            merged_map = {}

    for m in args.models:
        for h in args.harnesses:
            print(f"[SMOKE-v5] {h:8s} x {m:18s} ...", end=" ", flush=True)
            row = run_smoke_cell(h, m, timeout_s=args.timeout_s, omnia_bin=omnia_bin, out_dir=out_path.parent)
            merged_map[(h, m)] = row
            status = "PASS" if row["passed"] else "FAIL"
            print(
                f"{status} rc={row['exit_code']} wall={row['wall_s']}s reqs={row['wire_requests']} "
                f"w_err={row['wire_errors']} tok={row['wire_tokens']} tc={row['stream_tool_calls']}/{row['wire_tool_calls']} "
                f"rss={row['peak_rss_mb']}MB leaks={len(row['non_loopback_sockets'])}",
                flush=True,
            )
            if not row["passed"]:
                print(f"   diag: errs={row['harness_errors'][:2]} stderr={row['stderr_tail'][:200]!r}", flush=True)
            out_path.write_text(json.dumps({"cells": list(merged_map.values())}, indent=2) + "\n", encoding="utf-8", newline="\n")
            if args.cooldown_s > 0:
                time.sleep(args.cooldown_s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
