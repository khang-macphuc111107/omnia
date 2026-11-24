"""Container runtime probe & honest Terminal-Bench 4.1 / SWE-bench Windows audit.

Critical honesty guarantee:
  - Never fabricates or extrapolates Docker container scores when Docker/Podman/WSL2 are absent.
  - Reports exact runtime blocker details and audits Terminal-Bench 4.1 tasks (`66` tasks / `68` dirs)
    to identify Linux container dependencies vs non-container pure-Python/JS/Rust candidates.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List

from .common import DATASET_ROOT

TB41_TASKS_DIR = DATASET_ROOT / "terminal_bench_41" / "tasks"

LINUX_ONLY_MARKERS = (
    "apt-get",
    "apk add",
    "yum ",
    "dnf ",
    "pacman ",
    "/etc/",
    "/usr/local/",
    "/var/",
    "systemctl",
    "gcc ",
    "g++ ",
    "cmake",
    "coqc",
    "lean",
    "qemu",
    "freecad",
    "octave",
    "postgres",
    "redis",
    "sqlite3 /",
    "id -u",
    "chmod go-w",
)


def probe_container_runtime() -> Dict[str, Any]:
    docker_bin = shutil.which("docker")
    podman_bin = shutil.which("podman")
    wsl_bin = shutil.which("wsl")
    wsl_ok = False
    wsl_detail = "wsl.exe missing"
    if wsl_bin:
        try:
            r = subprocess.run([wsl_bin, "--status"], capture_output=True, text=True, timeout=5)
            wsl_ok = r.returncode == 0
            wsl_detail = (r.stdout or r.stderr or "").strip().replace("\x00", "")[:300]
        except Exception as exc:
            wsl_detail = str(exc)

    docker_ok = False
    if docker_bin:
        try:
            r = subprocess.run([docker_bin, "info"], capture_output=True, text=True, timeout=5)
            docker_ok = r.returncode == 0
        except Exception:
            docker_ok = False

    available = docker_ok or bool(podman_bin)
    blocker = None if available else (
        "Linux container runtime unavailable on host (docker=None, podman=None, "
        f"wsl_installed={wsl_ok}: {wsl_detail}). Admin/user setup of WSL2 + Docker Desktop is required "
        "to execute official Terminal-Bench 4.1 & SWE-bench Verified/Pro container grades."
    )
    return {
        "docker_bin": docker_bin,
        "docker_daemon_ok": docker_ok,
        "podman_bin": podman_bin,
        "wsl_bin": wsl_bin,
        "wsl_installed": wsl_ok,
        "wsl_detail": wsl_detail,
        "container_runtime_available": available,
        "exact_blocker": blocker,
        "swe_bench_verified_pro": {
            "status": "blocked_no_linux_container_runtime" if not available else "ready",
            "note": "Official SWE-bench Verified/Pro harnesses require Docker Linux images per instance.",
        },
    }


def audit_terminal_bench_41() -> Dict[str, Any]:
    tasks: List[Dict[str, Any]] = []
    if not TB41_TASKS_DIR.exists():
        return {"tasks_dir_exists": False, "total": 0, "tasks": []}

    for td in sorted(d for d in TB41_TASKS_DIR.iterdir() if d.is_dir()):
        df_p = td / "environment" / "Dockerfile"
        ts_p = td / "tests" / "test.sh"
        ins_p = td / "instruction.md"
        df = df_p.read_text(encoding="utf-8", errors="replace") if df_p.exists() else ""
        ts = ts_p.read_text(encoding="utf-8", errors="replace") if ts_p.exists() else ""
        ins = ins_p.read_text(encoding="utf-8", errors="replace") if ins_p.exists() else ""
        combined = f"{df}\n{ts}\n{ins}".lower()
        hits = [m for m in LINUX_ONLY_MARKERS if m in combined]
        uses_posix_root_paths = any(p in (ts + "\n" + ins) for p in ("/app", "/tests", "/logs/verifier"))
        tasks.append({
            "task_id": td.name,
            "linux_markers": hits,
            "uses_posix_container_paths": uses_posix_root_paths,
            "windows_unmodified_compatible": (not hits) and (not uses_posix_root_paths),
            "windows_adapted_candidate": (not hits),
        })

    return {
        "tasks_dir_exists": True,
        "total_task_dirs": len(tasks),
        "unmodified_windows_compatible": [t["task_id"] for t in tasks if t["windows_unmodified_compatible"]],
        "no_linux_pkg_candidates_requiring_path_remap": [t["task_id"] for t in tasks if t["windows_adapted_candidate"]],
        "linux_container_required": [t["task_id"] for t in tasks if not t["windows_adapted_candidate"]],
        "container_runtime": probe_container_runtime(),
    }
