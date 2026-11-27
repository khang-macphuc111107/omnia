import json
import tempfile
import unittest
from pathlib import Path

import generate_final_report_v5


class GenerateFinalReportV5Tests(unittest.TestCase):
    def test_build_final_scoreboard_matches_studio_and_size_caps(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            sv5 = root / "suite-v5"
            pub = root / "public_suites"
            sv5.mkdir()
            pub.mkdir()
            (sv5 / "wave3.json").write_text(
                json.dumps({
                    "records": [
                        {
                            "harness": "omnia", "model": "gpt-6.2-sol", "task_id": "swe_01", "axis": 1, "repeat": 0,
                            "passed": True, "score": 1.0, "wall_s": 12.5, "wire_requests": 3,
                            "wire_first_ttft_ms": 200.0, "wire_gen_tokens_per_sec": 70.0,
                            "wire_prompt_total": 1000, "wire_uncached_input": 200, "wire_cache_read": 800,
                            "wire_cache_write": 0, "wire_output_tokens": 100, "wire_total_tokens": 1100,
                            "wire_requests_missing_usage": 0, "non_loopback_sockets": [], "htmustc_only_ok": True,
                            "peak_rss_mb": 40.0, "peak_job_memory_mb": 50.0, "total_cpu_time_s": 0.5,
                            "tool_call_count": 2, "tool_error_count": 0, "edit_call_count": 1, "edit_error_count": 0,
                        },
                        {
                            "harness": "dsh", "model": "gpt-6.2-sol", "task_id": "swe_01", "axis": 1, "repeat": 0,
                            "passed": False, "score": 0.2, "wall_s": 25.0, "wire_requests": 4,
                            "wire_first_ttft_ms": 400.0, "wire_gen_tokens_per_sec": 45.0,
                            "wire_prompt_total": 2000, "wire_uncached_input": 1000, "wire_cache_read": 1000,
                            "wire_cache_write": 0, "wire_output_tokens": 200, "wire_total_tokens": 2200,
                            "wire_requests_missing_usage": 0, "non_loopback_sockets": [], "htmustc_only_ok": True,
                            "peak_rss_mb": 200.0, "peak_job_memory_mb": 220.0, "total_cpu_time_s": 2.0,
                            "tool_call_count": 4, "tool_error_count": 1, "edit_call_count": 1, "edit_error_count": 1,
                        },
                    ]
                }),
                encoding="utf-8",
            )
            (pub / "public_suites_inventory.json").write_text(
                json.dumps({
                    "terminal_bench_41": {
                        "total_task_dirs": 66,
                        "container_runtime": {"container_runtime_available": False, "exact_blocker": "Requires WSL2 + Docker."},
                    }
                }),
                encoding="utf-8",
            )
            sb = generate_final_report_v5.build_final_scoreboard(
                suite_v5_dir=sv5,
                public_dir=pub,
                microbench_path=root / "missing.json",
                omnia_bin=root / "missing.exe",
                recorded_at_ms=1700000000000,
            )
            for req in ("suite", "axes", "pass_rate", "tasks", "recordedAtMs", "summary"):
                self.assertIn(req, sb)
            self.assertEqual(sb["pass_rate"], 100.0)
            self.assertEqual(sb["ranking"][0], "omnia")
            self.assertLess(len(json.dumps(sb).encode("utf-8")), 2 * 1024 * 1024)
            md = generate_final_report_v5.format_final_scoreboard_markdown(sb)
            self.assertIn("WSL2", md)
            self.assertIn("**omnia**", md)


if __name__ == "__main__":
    unittest.main()
