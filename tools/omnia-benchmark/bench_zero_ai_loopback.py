"""100% Zero-AI Local Systems & Multi-Turn Mock Loopback Benchmark for Omnia v4.4.

Makes ZERO calls to htmustc.id.vn or any external AI provider!
Measures:
  1. Omnia v4.4 CLI cold/warm startup (n=10) & --profile-startup RSS
  2. Omnia v4.4 1-turn Local Mock SSE E2E (n=10) + Win32 Job Object Peak RSS/Mem/CPU
  3. Omnia v4.4 5-Turn Multi-Tool Synthetic Coding Loop (n=5, read->search->edit->shell->done)
     against a 0ms local loopback SSE mock server
  4. Omnia Studio (omnia-studio.exe) cold boot ms, idle RSS, and 100-request local loopback
     latency/RPS across /health, /api/notebooks/*, /api/downloads/*, /api/omni-drive/*
"""
from __future__ import annotations

import http.server
import json
import os
import shutil
import socket
import socketserver
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

from proc_monitor import ProcessTreeMonitor

REL_DIR = Path(r"D:\OmniaData\build\omnia-rust-workspace\release")
OMNIA_EXE = REL_DIR / "omnia.exe"
STUDIO_EXE = REL_DIR / "omnia-studio.exe"
OUT_JSON = Path(r"D:\omnia-bench\results\zero_ai_systems_bench.json")
ARCHIVE_JSON = Path(r"D:\OmniaData\qa\benchmarks\zero_ai_systems_bench.json")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def pctl(vals: List[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[idx], 2)


class ScriptedSseServer:
    """Deterministic local loopback OpenAI Chat SSE server (0ms LLM wait, 0 AI calls)."""

    def __init__(self, turns: List[str]):
        self.turns = turns
        self.turn_idx = 0
        self.req_count = 0
        self.first_req_perf: float | None = None
        self.lock = threading.Lock()
        self.port = free_port()
        parent = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length > 0:
                    _ = self.rfile.read(length)
                with parent.lock:
                    if parent.first_req_perf is None:
                        parent.first_req_perf = time.perf_counter()
                    idx = min(parent.turn_idx, len(parent.turns) - 1)
                    body_str = parent.turns[idx]
                    parent.turn_idx += 1
                    parent.req_count += 1
                body = body_str.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()

        class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self._srv = ThreadedServer(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._srv.shutdown()
        self._srv.server_close()


def sse_tool(call_id: str, name: str, args_obj: Dict[str, Any], prompt_tok: int, out_tok: int) -> str:
    payload = {
        "id": f"mock_{call_id}",
        "object": "chat.completion.chunk",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(args_obj),
                            },
                        }
                    ]
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tok,
            "completion_tokens": out_tok,
            "prompt_tokens_details": {"cached_tokens": max(0, prompt_tok - 120)},
        },
    }
    return f"data: {json.dumps(payload)}\n\ndata: [DONE]\n\n"


def sse_text(content: str, prompt_tok: int, out_tok: int) -> str:
    payload = {
        "id": "mock_final",
        "object": "chat.completion.chunk",
        "choices": [
            {
                "index": 0,
                "delta": {"content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tok,
            "completion_tokens": out_tok,
            "prompt_tokens_details": {"cached_tokens": max(0, prompt_tok - 120)},
        },
    }
    return f"data: {json.dumps(payload)}\n\ndata: [DONE]\n\n"


def minimal_env(home_dir: Path) -> Dict[str, str]:
    env = {
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
        "COMSPEC": os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe"),
        "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
        "PATHEXT": os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home_dir),
        "USERPROFILE": str(home_dir),
        "APPDATA": str(home_dir / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home_dir / "AppData" / "Local"),
        "TEMP": str(home_dir / "tmp"),
        "TMP": str(home_dir / "tmp"),
        "OMNIA_HOME": str(home_dir / "omnia"),
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
        "NO_PROXY": "127.0.0.1,localhost",
    }
    for d in ["AppData/Roaming", "AppData/Local", "tmp", "omnia"]:
        (home_dir / d).mkdir(parents=True, exist_ok=True)
    return env


def bench_version_and_profile(n: int = 10) -> Dict[str, Any]:
    times: List[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        r = subprocess.run([str(OMNIA_EXE), "--version"], capture_output=True, text=True, check=True)
        times.append((time.perf_counter() - t0) * 1000.0)
        assert "omnia" in r.stdout.lower()
    prof = json.loads(subprocess.run([str(OMNIA_EXE), "--profile-startup"], capture_output=True, text=True, check=True).stdout)
    return {
        "runs": n,
        "cold_ms": round(times[0], 2),
        "median_ms": round(statistics.median(times), 2),
        "p95_ms": pctl(times, 95),
        "min_ms": round(min(times), 2),
        "profile_startup": prof,
    }


def bench_1req_mock(n: int = 10) -> Dict[str, Any]:
    first_reqs, e2es, rsss, jobs, cpus = [], [], [], [], []
    for _ in range(n):
        tmp = Path(tempfile.mkdtemp(prefix="omnia_m1_"))
        ws = tmp / "ws"
        ws.mkdir()
        srv = ScriptedSseServer([sse_text("MOCK_OK", 120, 4)])
        srv.start()
        try:
            env = minimal_env(tmp / "home")
            cmd = [
                str(OMNIA_EXE), "run",
                "--workspace", str(ws),
                "--model", "mock-fast-1",
                "--base-url", f"http://127.0.0.1:{srv.port}/v1",
                "--api-key", "mock-local-key",
                "--wire-api", "chat",
                "--output-format", "stream-json",
                "--auto-approve",
                "Reply MOCK_OK",
            ]
            t0 = time.perf_counter()
            proc = subprocess.Popen(cmd, cwd=str(ws), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            mon = ProcessTreeMonitor(proc.pid, poll_interval_s=0.02, harness_root_exe="omnia.exe")
            mon.start()
            stdout, stderr = proc.communicate(timeout=30)
            e2e_ms = (time.perf_counter() - t0) * 1000.0
            res = mon.stop().to_dict()
            assert proc.returncode == 0, f"rc={proc.returncode} err={stderr}"
            assert srv.first_req_perf is not None
            first_reqs.append((srv.first_req_perf - t0) * 1000.0)
            e2es.append(e2e_ms)
            rsss.append(res["peak_harness_rss_mb"])
            jobs.append(res["peak_job_memory_mb"])
            cpus.append(res["total_cpu_time_s"] * 1000.0)
        finally:
            srv.stop()
            shutil.rmtree(tmp, ignore_errors=True)
    return {
        "runs": n,
        "first_req_med_ms": round(statistics.median(first_reqs), 2),
        "first_req_p95_ms": pctl(first_reqs, 95),
        "e2e_med_ms": round(statistics.median(e2es), 2),
        "e2e_p95_ms": pctl(e2es, 95),
        "peak_rss_med_mb": round(statistics.median(rsss), 2),
        "peak_job_mem_med_mb": round(statistics.median(jobs), 2),
        "cpu_med_ms": round(statistics.median(cpus), 2),
    }


def bench_multiturn_coding_loop(n: int = 5) -> Dict[str, Any]:
    """Full 5-turn agent loop: read_file -> search_files -> edit_file -> shell(python) -> finish."""
    e2es, rsss, jobs, cpus = [], [], [], []
    verified_all = 0
    for _ in range(n):
        tmp = Path(tempfile.mkdtemp(prefix="omnia_mt_"))
        ws = tmp / "ws"
        ws.mkdir()
        (ws / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
        (ws / "test_calc.py").write_text("from calc import add\nassert add(2, 3) == 5\nprint('1 passed, 0 failed')\n", encoding="utf-8")
        turns = [
            sse_tool("c1", "read_file", {"path": "calc.py"}, 300, 15),
            sse_tool("c2", "search_files", {"query": "def add"}, 500, 15),
            sse_tool("c3", "edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"}, 700, 25),
            sse_tool("c4", "shell", {"command": "python test_calc.py"}, 950, 15),
            sse_text("Fixed calc.py and verified 1 passed, 0 failed.", 1150, 12),
        ]
        srv = ScriptedSseServer(turns)
        srv.start()
        try:
            env = minimal_env(tmp / "home")
            cmd = [
                str(OMNIA_EXE), "run",
                "--workspace", str(ws),
                "--model", "mock-coder-1",
                "--base-url", f"http://127.0.0.1:{srv.port}/v1",
                "--api-key", "mock-local-key",
                "--wire-api", "chat",
                "--output-format", "stream-json",
                "--auto-approve",
                "Fix add() in calc.py and verify with test_calc.py",
            ]
            t0 = time.perf_counter()
            proc = subprocess.Popen(cmd, cwd=str(ws), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            mon = ProcessTreeMonitor(proc.pid, poll_interval_s=0.02, harness_root_exe="omnia.exe")
            mon.start()
            stdout, stderr = proc.communicate(timeout=45)
            e2e_ms = (time.perf_counter() - t0) * 1000.0
            res = mon.stop().to_dict()
            assert proc.returncode == 0, f"rc={proc.returncode} err={stderr}"
            fixed = (ws / "calc.py").read_text(encoding="utf-8")
            assert "return a + b" in fixed, f"edit failed: {fixed!r}"
            assert srv.req_count == 5, f"expected 5 turns (anti-termination-lag skip!), got {srv.req_count}"
            verified_all += 1
            e2es.append(e2e_ms)
            rsss.append(res["peak_harness_rss_mb"])
            jobs.append(res["peak_job_memory_mb"])
            cpus.append(res["total_cpu_time_s"] * 1000.0)
        finally:
            srv.stop()
            shutil.rmtree(tmp, ignore_errors=True)
    return {
        "runs": n,
        "verified_pass": f"{verified_all}/{n}",
        "turns_per_run": 5,
        "tools_per_run": 4,
        "e2e_med_ms": round(statistics.median(e2es), 2),
        "e2e_p95_ms": pctl(e2es, 95),
        "ms_per_turn_med": round(statistics.median(e2es) / 5.0, 2),
        "peak_rss_med_mb": round(statistics.median(rsss), 2),
        "peak_job_mem_med_mb": round(statistics.median(jobs), 2),
        "cpu_med_ms": round(statistics.median(cpus), 2),
    }


def bench_studio_loopback(reqs: int = 100) -> Dict[str, Any]:
    tmp = Path(tempfile.mkdtemp(prefix="omnia_studio_bench_"))
    port = free_port()
    env = minimal_env(tmp / "home")
    env["OMNIA_STUDIO_PORT"] = str(port)
    env["OMNIA_WORKSPACE_ROOT"] = str(tmp / "ws")
    (tmp / "ws").mkdir()
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [
            str(STUDIO_EXE),
            "--port", str(port),
            "--workspace-root", str(tmp / "ws"),
            "--ui-root", r"D:\Omnia\ui",
            "--runtime-url", "off",
        ],
        cwd=str(tmp / "ws"),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    mon = ProcessTreeMonitor(proc.pid, poll_interval_s=0.05, harness_root_exe="omnia-studio.exe")
    mon.start()
    boot_ms = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        for _ in range(100):
            try:
                with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=1.0) as resp:
                    if resp.status == 200:
                        boot_ms = (time.perf_counter() - t0) * 1000.0
                        break
            except Exception:
                time.sleep(0.02)
        assert boot_ms is not None, "omnia-studio failed to boot"
        endpoints = [
            "/api/health",
            "/api/notebooks/status",
            "/api/downloads/list",
            "/api/omni-drive/providers",
        ]
        lats: List[float] = []
        t_all = time.perf_counter()
        for i in range(reqs):
            ep = endpoints[i % len(endpoints)]
            ts = time.perf_counter()
            with opener.open(f"http://127.0.0.1:{port}{ep}", timeout=2.0) as resp:
                assert resp.status == 200
                _ = resp.read()
            lats.append((time.perf_counter() - ts) * 1000.0)
        total_s = time.perf_counter() - t_all
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        res = mon.stop().to_dict()
        return {
            "boot_to_health_200_ms": round(boot_ms, 2),
            "requests": reqs,
            "throughput_rps": round(reqs / total_s, 1),
            "latency_p50_ms": round(statistics.median(lats), 2),
            "latency_p95_ms": pctl(lats, 95),
            "peak_rss_mb": res["peak_harness_rss_mb"],
            "peak_job_mem_mb": res["peak_job_memory_mb"],
        }
    finally:
        if proc.poll() is None:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    binaries = {
        name: {
            "bytes": (REL_DIR / name).stat().st_size,
            "mib": round((REL_DIR / name).stat().st_size / 1048576.0, 2),
        }
        for name in ["omnia.exe", "omnia-native.exe", "omnia-studio.exe", "omnia-runtime.exe", "omnia_qa_seed.exe"]
        if (REL_DIR / name).exists()
    }
    report = {
        "zero_ai_calls": True,
        "binaries": binaries,
        "cli_startup_n10": bench_version_and_profile(10),
        "cli_mock_1req_n10": bench_1req_mock(10),
        "cli_multiturn_5turn_4tool_n5": bench_multiturn_coding_loop(5),
        "studio_loopback_100req": bench_studio_loopback(100),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    ARCHIVE_JSON.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(report, indent=2)
    OUT_JSON.write_text(txt, encoding="utf-8")
    ARCHIVE_JSON.write_text(txt, encoding="utf-8")
    print(txt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
