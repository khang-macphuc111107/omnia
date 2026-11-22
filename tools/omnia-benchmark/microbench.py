"""Zero-Quota Clean-Room Micro-Benchmark (`n=10` repeats) for all installed harnesses.

Measures strictly without touching upstream LLM quota:
  1. Install disk footprint (MB) from clean-room manifest.
  2. `--version` cold/warm startup latency (ms, median & p95 across n=10).
  3. End-to-end startup-to-first-HTTP-request latency (`t_first_http_req - t_spawn`, ms)
     plus harness peak RSS / Job Peak Memory (MB) and CPU time (ms) against a local
     zero-latency mock `BenchTelemetryProxy(mock_mode=True)` with the hard loopback
     egress firewall active!
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List

from bench_telemetry_proxy import BenchTelemetryProxy
from cleanroom import (
    BENCH_ROOT,
    HARNESS_ROOT,
    assert_clean_ancestors,
    load_installed_manifest,
    prepare_harness_launch,
)
from proc_monitor import ProcessTreeMonitor, terminate_process_tree


def p95(vals: List[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    idx = min(len(s) - 1, int(math.ceil(0.95 * len(s))) - 1)
    return round(s[idx], 2)


def bench_version_startup(harness: str, binary: Path, n: int = 10) -> Dict[str, Any]:
    lat_ms: List[float] = []
    rss_mb: List[float] = []
    tmp_home = Path(tempfile.mkdtemp(prefix=f"mb_ver_{harness}_", dir=str(BENCH_ROOT / "env")))
    env = {
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
        "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
        "COMSPEC": os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe"),
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_home),
        "USERPROFILE": str(tmp_home),
        "APPDATA": str(tmp_home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(tmp_home / "AppData" / "Local"),
        "TEMP": str(tmp_home / "temp"),
        "TMP": str(tmp_home / "temp"),
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "NO_PROXY": "127.0.0.1,localhost",
    }
    (tmp_home / "temp").mkdir(parents=True, exist_ok=True)
    try:
        for i in range(n):
            t0 = time.perf_counter()
            p = subprocess.Popen(
                [str(binary), "--version"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            mon = ProcessTreeMonitor(p.pid, poll_interval_s=0.01, harness_root_exe=binary.name)
            mon.start()
            try:
                p.communicate(timeout=45)
            except subprocess.TimeoutExpired:
                terminate_process_tree(p.pid)
                p.communicate(timeout=5)
                continue
            finally:
                res = mon.stop()
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if p.returncode == 0:
                lat_ms.append(dt_ms)
                rss_mb.append(max(res.peak_harness_rss_mb, res.peak_job_memory_mb))
    finally:
        shutil.rmtree(tmp_home, ignore_errors=True)
    return {
        "n": len(lat_ms),
        "cold_first_ms": round(lat_ms[0], 2) if lat_ms else None,
        "median_ms": round(statistics.median(lat_ms), 2) if lat_ms else None,
        "warm_median_ms": round(statistics.median(lat_ms[1:]), 2) if len(lat_ms) > 1 else (round(lat_ms[0], 2) if lat_ms else None),
        "p95_ms": p95(lat_ms) if lat_ms else None,
        "median_peak_mem_mb": round(statistics.median(rss_mb), 2) if rss_mb else None,
    }


def bench_mock_first_request(harness: str, n: int = 10, omnia_bin: Path | None = None) -> Dict[str, Any]:
    first_req_ms: List[float] = []
    e2e_ms: List[float] = []
    peak_harness_rss: List[float] = []
    peak_job_mb: List[float] = []
    cpu_ms: List[float] = []
    failures = 0

    for i in range(n):
        ws = Path(tempfile.mkdtemp(prefix=f"mb_ws_{harness}_", dir=str(BENCH_ROOT / "workspaces")))
        (ws / "hello.txt").write_text("hello\n", encoding="utf-8")
        rid = f"mb-{harness}-{i:02d}"
        proxy = BenchTelemetryProxy(
            run_id=rid, harness=harness, task_id="microbench_mock", mock_mode=True
        )
        port = proxy.start()
        launch = prepare_harness_launch(
            harness, "mock-model", "Reply with exactly OK.", ws, port, run_id=rid, timeout_s=30, omnia_bin=omnia_bin
        )
        try:
            t_spawn_ns = time.perf_counter_ns()
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
            mon = ProcessTreeMonitor(proc.pid, poll_interval_s=0.02, harness_root_exe=launch.harness_root_exe)
            mon.start()
            try:
                stdout, stderr = proc.communicate(input=launch.stdin_text, timeout=90)
            except subprocess.TimeoutExpired:
                terminate_process_tree(proc.pid)
                proc.communicate(timeout=5)
                failures += 1
                continue
            finally:
                res = mon.stop()
            t_end_ns = time.perf_counter_ns()
            wire = proxy.stop()
            first_ns = wire.get("wire_first_req_perf_ns")
            if first_ns is not None and wire.get("wire_requests", 0) >= 1:
                first_req_ms.append((first_ns - t_spawn_ns) / 1e6)
                e2e_ms.append((t_end_ns - t_spawn_ns) / 1e6)
                peak_harness_rss.append(res.peak_harness_rss_mb)
                peak_job_mb.append(res.peak_job_memory_mb)
                cpu_ms.append(res.total_cpu_time_s * 1000.0)
            else:
                failures += 1
                if i == 0:
                    print(f"  [warn] {harness} mock run 0 made 0 wire reqs (rc={proc.returncode}): stderr={(stderr or '')[:300]} stdout={(stdout or '')[:200]}", flush=True)
        finally:
            if proxy._server is not None:
                proxy.stop()
            launch.cleanup()
            shutil.rmtree(ws, ignore_errors=True)

    return {
        "n_ok": len(first_req_ms),
        "n_fail": failures,
        "first_req_cold_ms": round(first_req_ms[0], 2) if first_req_ms else None,
        "first_req_median_ms": round(statistics.median(first_req_ms), 2) if first_req_ms else None,
        "first_req_p95_ms": p95(first_req_ms) if first_req_ms else None,
        "e2e_mock_median_ms": round(statistics.median(e2e_ms), 2) if e2e_ms else None,
        "idle_peak_harness_rss_mb": round(statistics.median(peak_harness_rss), 2) if peak_harness_rss else None,
        "idle_peak_job_mem_mb": round(statistics.median(peak_job_mb), 2) if peak_job_mb else None,
        "median_cpu_ms": round(statistics.median(cpu_ms), 2) if cpu_ms else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--harnesses", nargs="+", default=["codex", "claude", "opencode", "agy"])
    ap.add_argument("--repeats", type=int, default=10)
    ap.add_argument("--out", default=str(BENCH_ROOT / "results" / "microbench_stage0.json"))
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--omnia-bin", default=None, help="Explicit path to omnia.exe for omnia microbench")
    args = ap.parse_args()

    assert_clean_ancestors()
    manifest = load_installed_manifest()
    out_path = Path(args.out)
    omnia_bin = Path(args.omnia_bin) if args.omnia_bin else None
    if args.merge and out_path.exists():
        report = json.loads(out_path.read_text(encoding="utf-8"))
        report["repeats"] = args.repeats
    else:
        report: Dict[str, Any] = {"repeats": args.repeats, "harnesses": {}}

    for h in args.harnesses:
        info = dict(manifest.get(h, {}))
        if h == "omnia":
            binary = omnia_bin or Path(info.get("binary") or r"D:\OmniaData\build\omnia-rust-workspace\release\omnia.exe")
            if binary.exists():
                info["disk_mb"] = round(binary.stat().st_size / (1024 * 1024), 2)
                try:
                    vout = subprocess.check_output([str(binary), "--version"], text=True, timeout=15).strip()
                    info["version"] = vout.splitlines()[0] if vout else "0.1.0"
                except Exception:
                    info.setdefault("version", "0.1.0")
        else:
            binary = Path(info.get("binary") or (HARNESS_ROOT / h / "bin" / f"{h}.exe"))
        if not binary.exists():
            print(f"[SKIP] {h}: binary missing at {binary}", flush=True)
            continue
        print(f"=== Microbench: {h} ({info.get('version', '?')}, {info.get('disk_mb', '?')} MB) ===", flush=True)
        ver_stats = bench_version_startup(h, binary, n=args.repeats)
        print(f"  --version: cold={ver_stats['cold_first_ms']}ms med={ver_stats['median_ms']}ms p95={ver_stats['p95_ms']}ms mem={ver_stats['median_peak_mem_mb']}MB", flush=True)
        mock_stats = bench_mock_first_request(h, n=args.repeats, omnia_bin=binary if h == "omnia" else None)
        print(f"  mock-1req: ok={mock_stats['n_ok']}/{args.repeats} first_req_med={mock_stats['first_req_median_ms']}ms e2e_med={mock_stats['e2e_mock_median_ms']}ms rss={mock_stats['idle_peak_harness_rss_mb']}MB job_mem={mock_stats['idle_peak_job_mem_mb']}MB", flush=True)
        report["harnesses"][h] = {
            "version": info.get("version"),
            "disk_mb": info.get("disk_mb"),
            "binary": str(binary),
            "version_startup": ver_stats,
            "mock_first_request": mock_stats,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\nSaved microbench -> {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
