"""Unit tests for container_runner (Terminal-Bench 4.1 & SWE-bench Verified bridge)."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent.parent
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))

from unittest.mock import MagicMock, patch

from public_suites.container_runner import (
    DEFERRED_BOUNDARY,
    ContainerExecutionResult,
    ContainerExecutionSpec,
    ContainerRuntimeInfo,
    detect_container_runtime,
    format_swe_bench_spec,
    format_terminal_bench_spec,
    run_in_container,
    sanitize_container_env,
)


class TestContainerRunner(unittest.TestCase):
    def test_detect_container_runtime_when_docker_present(self) -> None:
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "27.1.1"

        with patch("shutil.which", return_value="C:\\Program Files\\Docker\\docker.exe"):
            info = detect_container_runtime(runner=lambda *args, **kwargs: mock_proc)
            self.assertTrue(info.available)
            self.assertEqual(info.runtime_type, "docker")
            self.assertEqual(info.version, "27.1.1")

    def test_detect_container_runtime_when_wsl_present_and_docker_absent(self) -> None:
        def fake_which(cmd: str) -> str | None:
            if cmd == "wsl":
                return "C:\\Windows\\System32\\wsl.exe"
            return None

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "Default Distribution: Ubuntu\nDefault Version: 2\n"

        with patch("shutil.which", side_effect=fake_which):
            info = detect_container_runtime(runner=lambda *args, **kwargs: mock_proc)
            self.assertTrue(info.available)
            self.assertEqual(info.runtime_type, "wsl2")

    def test_detect_container_runtime_when_none_present(self) -> None:
        with patch("shutil.which", return_value=None):
            info = detect_container_runtime()
            self.assertFalse(info.available)
            self.assertIsNone(info.runtime_type)
            self.assertIn("No Docker or WSL2", info.details)

    def test_emits_deferred_boundary_honestly_when_runtime_missing(self) -> None:
        spec = ContainerExecutionSpec(
            image="test:latest",
            command=["pytest"],
            task_id="task_1",
            suite_name="test_suite",
        )
        runtime_info = ContainerRuntimeInfo(
            runtime_type=None,
            available=False,
            version=None,
            details="Docker not running",
        )
        res = run_in_container(spec, runtime_info=runtime_info)
        self.assertEqual(res.status, DEFERRED_BOUNDARY)
        self.assertTrue(res.deferred)
        self.assertFalse(res.passed)
        self.assertIsNone(res.score, "Deferred benchmarks must NOT fabricate scores")
        self.assertEqual(res.exit_code, 127)
        self.assertIn("honestly deferred", res.reason or "")

    def test_sanitize_container_env_removes_sensitive_keys(self) -> None:
        env = {
            "PATH": "/usr/bin",
            "OPENAI_API_KEY": "sk-secret123",
            "GITHUB_TOKEN": "ghp_secret456",
            "HTMUSTC_AUTH": "bearer-token",
            "SAFE_VAR": "hello_world",
            "DB_PASSWORD": "rootpassword",
        }
        clean = sanitize_container_env(env)
        self.assertIn("PATH", clean)
        self.assertIn("SAFE_VAR", clean)
        self.assertNotIn("OPENAI_API_KEY", clean)
        self.assertNotIn("GITHUB_TOKEN", clean)
        self.assertNotIn("HTMUSTC_AUTH", clean)
        self.assertNotIn("DB_PASSWORD", clean)
        self.assertEqual(clean["OMNIA_CONTAINER_BENCH"], "1")

    def test_format_terminal_bench_spec(self) -> None:
        spec = format_terminal_bench_spec(
            task_id="term_01",
            command=["bash", "-c", "python test.py"],
            workspace=Path("/tmp/ws"),
            timeout_s=180,
        )
        self.assertEqual(spec.suite_name, "terminal_bench_4_1")
        self.assertEqual(spec.network, "none")
        self.assertEqual(spec.timeout_s, 180)
        self.assertEqual(spec.command, ["bash", "-c", "python test.py"])

    def test_format_swe_bench_spec(self) -> None:
        spec = format_swe_bench_spec(
            instance_id="django__django-11099",
            test_patch="diff --git a/test.py ...",
            workspace=Path("/tmp/ws"),
            timeout_s=450,
        )
        self.assertEqual(spec.suite_name, "swe_bench_verified")
        self.assertIn("django__django-11099", spec.image)
        self.assertEqual(spec.network, "none")
        self.assertEqual(spec.timeout_s, 450)
        self.assertEqual(spec.env["INSTANCE_ID"], "django__django-11099")

    def test_run_in_container_success_mock(self) -> None:
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "All tests passed\n"
        mock_proc.stderr = ""

        spec = ContainerExecutionSpec(
            image="test:latest",
            command=["pytest"],
            workspace=Path("."),
        )
        runtime = ContainerRuntimeInfo(
            runtime_type="docker",
            available=True,
            version="27.0",
            details="Docker ready",
        )
        res = run_in_container(spec, runtime_info=runtime, runner=lambda *args, **kwargs: mock_proc)
        self.assertEqual(res.status, "completed")
        self.assertTrue(res.passed)
        self.assertEqual(res.score, 1.0)
        self.assertFalse(res.deferred)


if __name__ == "__main__":
    unittest.main()
