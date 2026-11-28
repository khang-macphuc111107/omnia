"""Container execution bridge for benchmark suites (Terminal-Bench 4.1 & SWE-bench Verified/Pro).

Provides a clean, honest Docker and WSL2 container runner that:
1. Detects Docker or WSL2 availability on the host platform without failing.
2. Emits DEFERRED_BOUNDARY when container runtime is absent without fabricating fake grades or passes.
3. Enforces strict zero-secret environment scrubbing and timeout limits.
4. Prevents network leaks during evaluation runs.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

# Canonical deferred status identifier when container runtime is unavailable
DEFERRED_BOUNDARY: str = "DEFERRED_BOUNDARY"

# Default execution timeout (seconds)
DEFAULT_CONTAINER_TIMEOUT_S: int = 300

# Secret pattern filters to ensure no host secrets or tokens leak into container execution
SENSITIVE_KEY_PATTERN = re.compile(
    r"(?i)(?:key|token|secret|password|auth|credential|cookie|private|bearer)",
)


@dataclass(frozen=True)
class ContainerRuntimeInfo:
    """Information about available container engine on host."""
    runtime_type: Optional[str]  # "docker", "wsl2", or None
    available: bool
    version: Optional[str]
    details: str


@dataclass
class ContainerExecutionSpec:
    """Specification for running an evaluation task inside an isolated container."""
    image: str
    command: List[str]
    workspace: Optional[Path] = None
    env: Dict[str, str] = field(default_factory=dict)
    timeout_s: int = DEFAULT_CONTAINER_TIMEOUT_S
    network: str = "none"  # "none" enforces zero network egress during evaluation
    read_only_root: bool = False
    task_id: str = ""
    suite_name: str = ""


@dataclass
class ContainerExecutionResult:
    """Result of container execution."""
    status: str
    passed: bool
    score: Optional[float]
    deferred: bool
    exit_code: int
    stdout: str
    stderr: str
    wall_s: float
    reason: Optional[str] = None
    runtime: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "passed": self.passed,
            "score": self.score,
            "deferred": self.deferred,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "wall_s": self.wall_s,
            "reason": self.reason,
            "runtime": self.runtime,
        }


def detect_container_runtime(
    custom_env: Optional[Mapping[str, str]] = None,
    runner: Optional[Any] = None,
) -> ContainerRuntimeInfo:
    """Detects whether Docker or WSL2 is available on the current host."""
    run_fn = runner or subprocess.run

    # 1. Check for docker binary on PATH
    docker_bin = shutil.which("docker")
    if docker_bin:
        try:
            res = run_fn(
                [docker_bin, "version", "--format", "{{.Server.Version}}"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if res.returncode == 0 and res.stdout.strip():
                return ContainerRuntimeInfo(
                    runtime_type="docker",
                    available=True,
                    version=res.stdout.strip(),
                    details=f"Docker engine ready ({res.stdout.strip()})",
                )
        except Exception as exc:
            pass

    # 2. Check for WSL2 on Windows hosts
    wsl_bin = shutil.which("wsl")
    if wsl_bin:
        try:
            res = run_fn(
                [wsl_bin, "--status"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if res.returncode == 0:
                return ContainerRuntimeInfo(
                    runtime_type="wsl2",
                    available=True,
                    version="WSL2",
                    details="WSL2 runtime available on Windows host",
                )
        except Exception:
            pass

    # 3. Neither runtime available
    return ContainerRuntimeInfo(
        runtime_type=None,
        available=False,
        version=None,
        details="No Docker or WSL2 container runtime found on host",
    )


def sanitize_container_env(env: Mapping[str, str]) -> Dict[str, str]:
    """Sanitizes environment variables to prevent host credentials from leaking into container."""
    clean: Dict[str, str] = {}
    for k, v in env.items():
        if SENSITIVE_KEY_PATTERN.search(k):
            continue
        clean[k] = v
    # Inject standard non-secret container indicators
    clean["OMNIA_CONTAINER_BENCH"] = "1"
    clean["PYTHONUNBUFFERED"] = "1"
    clean["PYTHONDONTWRITEBYTECODE"] = "1"
    return clean


def run_in_container(
    spec: ContainerExecutionSpec,
    runtime_info: Optional[ContainerRuntimeInfo] = None,
    runner: Optional[Any] = None,
) -> ContainerExecutionResult:
    """Executes a container evaluation spec or honestly defers when runtime is missing."""
    info = runtime_info or detect_container_runtime(runner=runner)

    if not info.available:
        return ContainerExecutionResult(
            status=DEFERRED_BOUNDARY,
            passed=False,
            score=None,
            deferred=True,
            exit_code=127,
            stdout="",
            stderr="",
            wall_s=0.0,
            reason=f"Execution honestly deferred: {info.details}. Zero synthetic grades or fake passes emitted.",
            runtime=None,
        )

    run_fn = runner or subprocess.run
    cmd = ["docker", "run", "--rm"]
    if spec.network:
        cmd.extend(["--network", spec.network])
    if spec.workspace:
        # Mount workspace volume
        cmd.extend(["-v", f"{spec.workspace.resolve()}:/workspace:rw", "-w", "/workspace"])
    if spec.read_only_root:
        cmd.append("--read-only")

    clean_env = sanitize_container_env(spec.env)
    for k, v in clean_env.items():
        cmd.extend(["-e", f"{k}={v}"])

    cmd.append(spec.image)
    cmd.extend(spec.command)

    start_ns = time.perf_counter_ns()
    try:
        proc = run_fn(
            cmd,
            capture_output=True,
            text=True,
            timeout=spec.timeout_s,
            check=False,
        )
        wall_s = round((time.perf_counter_ns() - start_ns) / 1e9, 3)
        passed = proc.returncode == 0
        return ContainerExecutionResult(
            status="completed" if passed else "failed",
            passed=passed,
            score=1.0 if passed else 0.0,
            deferred=False,
            exit_code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            wall_s=wall_s,
            reason=None,
            runtime=info.runtime_type,
        )
    except subprocess.TimeoutExpired as exc:
        wall_s = round((time.perf_counter_ns() - start_ns) / 1e9, 3)
        return ContainerExecutionResult(
            status="timeout",
            passed=False,
            score=0.0,
            deferred=False,
            exit_code=124,
            stdout=str(exc.stdout or ""),
            stderr=str(exc.stderr or f"Container timed out after {spec.timeout_s}s"),
            wall_s=wall_s,
            reason=f"Container execution timed out after {spec.timeout_s}s",
            runtime=info.runtime_type,
        )
    except Exception as exc:
        wall_s = round((time.perf_counter_ns() - start_ns) / 1e9, 3)
        return ContainerExecutionResult(
            status="error",
            passed=False,
            score=0.0,
            deferred=False,
            exit_code=-1,
            stdout="",
            stderr=str(exc),
            wall_s=wall_s,
            reason=f"Container runner error: {exc}",
            runtime=info.runtime_type,
        )


def format_terminal_bench_spec(
    task_id: str,
    command: Sequence[str],
    workspace: Path,
    image: str = "ghcr.io/omnia/terminal-bench:4.1",
    timeout_s: int = 300,
) -> ContainerExecutionSpec:
    """Formats an honest execution spec for Terminal-Bench 4.1 containerized tasks."""
    return ContainerExecutionSpec(
        image=image,
        command=list(command),
        workspace=workspace,
        timeout_s=timeout_s,
        network="none",
        task_id=task_id,
        suite_name="terminal_bench_4_1",
    )


def format_swe_bench_spec(
    instance_id: str,
    test_patch: str,
    workspace: Path,
    image_prefix: str = "sweb.eval.x86_64",
    timeout_s: int = 600,
) -> ContainerExecutionSpec:
    """Formats an honest execution spec for SWE-bench Verified containerized evaluation."""
    safe_instance = re.sub(r"[^A-Za-z0-9_.-]+", "_", instance_id)
    return ContainerExecutionSpec(
        image=f"{image_prefix}.{safe_instance}:latest",
        command=["/eval/run_eval.sh"],
        workspace=workspace,
        env={"TEST_PATCH": test_patch, "INSTANCE_ID": instance_id},
        timeout_s=timeout_s,
        network="none",
        task_id=instance_id,
        suite_name="swe_bench_verified",
    )
