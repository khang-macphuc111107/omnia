import json
import unittest

import runner_v5
import scorer_v5


class RunnerScorerV5Tests(unittest.TestCase):
    def test_agy_and_empty_model_rejected_while_all_htmustc_families_allowed(self):
        with self.assertRaises(ValueError):
            runner_v5.validate_harness_and_model("agy", "gpt-6.2-sol")
        with self.assertRaises(ValueError):
            runner_v5.validate_harness_and_model("omnia", "")
        for model in (
            "gpt-6.2-sol",
            "claude-sonnet-5-5",
            "gemini-3.8-flash",
            "gemini-4-carbon",
            "deepseek-v4-pro",
            "glm-5.3",
            "kimi-k3.1-pro",
            "qwen3.8-max",
        ):
            runner_v5.validate_harness_and_model("omnia", model)
        runner_v5.validate_harness_and_model("dsh", "gpt-6.2-sol")

    def test_cleanroom_effort_and_multifamily_routing(self):
        import tempfile
        from pathlib import Path
        import cleanroom

        with tempfile.TemporaryDirectory() as ws:
            l_omnia = cleanroom.prepare_harness_launch(
                "omnia", "gemini-4-carbon", "hi", Path(ws), 45124, run_id="ut-eff-omnia", effort="max"
            )
            l_omp = cleanroom.prepare_harness_launch(
                "omp", "deepseek-v4-pro", "hi", Path(ws), 45125, run_id="ut-eff-omp", effort="xhigh"
            )
            l_claude = cleanroom.prepare_harness_launch(
                "claude", "claude-sonnet-5-5", "hi", Path(ws), 45126, run_id="ut-eff-claude", effort="high"
            )
            try:
                self.assertIn("--effort", l_omnia.cmd)
                self.assertIn("max", l_omnia.cmd)
                self.assertEqual(l_omp.wire_protocol, "openai_chat")
                self.assertIn("--thinking=xhigh", l_omp.cmd)
                self.assertIn("--effort", l_claude.cmd)
                self.assertEqual(l_claude.env.get("CLAUDE_CODE_EFFORT_LEVEL"), "high")
            finally:
                l_omnia.cleanup()
                l_omp.cleanup()
                l_claude.cleanup()

    def test_parse_dsh_json_stream_tracks_tools_edits_and_final(self):
        events = [
            (10.0, json.dumps({"type": "session", "sessionId": "s1", "cwd": "."})),
            (10.2, json.dumps({"type": "thinking", "text": "checking"})),
            (10.4, json.dumps({"type": "tool_call", "callId": "c1", "tool": "edit_file", "input": {"path": "a.py"}})),
            (10.5, json.dumps({"type": "tool_result", "callId": "c1", "status": "error", "result": "fail", "error": "nope"})),
            (10.6, json.dumps({"type": "tool_call", "callId": "c2", "tool": "edit_file", "input": {"path": "a.py", "ok": 1}})),
            (10.7, json.dumps({"type": "tool_result", "callId": "c2", "status": "completed", "result": "ok"})),
            (10.9, json.dumps({"type": "final", "sessionId": "s1", "reason": {"kind": "completed"}, "text": "DONE"})),
        ]
        parsed = runner_v5.parse_harness_stream_v5("dsh", events, [], 10.0, 1.0)
        self.assertEqual(parsed["client_ttft_s"], 0.2)
        self.assertEqual(parsed["tool_call_count"], 2)
        self.assertEqual(parsed["tool_error_count"], 1)
        self.assertEqual(parsed["edit_call_count"], 2)
        self.assertEqual(parsed["edit_error_count"], 1)
        self.assertEqual(parsed["final_assistant_text"], "DONE")
        self.assertFalse(parsed["doom_loop_detected"])

    def test_scorer_v5_covers_all_11_axes_and_mcnemar(self):
        records = []
        for idx, ax in enumerate(scorer_v5.V5_CAPABILITY_AXES):
            records.append({
                "harness": "omnia", "model": "gpt-6.2-sol", "task_id": f"t_{idx}", "axis": ax,
                "repeat": 0, "passed": True, "score": 1.0, "wall_s": 5.0,
                "wire_requests": 2, "wire_first_ttft_ms": 180.0, "wire_gen_tokens_per_sec": 90.0,
                "wire_total_tokens": 1000, "wire_uncached_input": 400, "wire_cache_read": 500,
                "wire_cache_write": 0, "wire_output_tokens": 100, "wire_prompt_total": 900,
                "wire_kv_cache_hit_rate_ge2": 0.6, "wire_effective_cost_units": 700,
                "wire_window_uncovered_ms": 50.0, "wire_turn1_prompt_tokens": 400,
                "peak_rss_mb": 42.0, "peak_harness_rss_mb": 20.0, "peak_job_memory_mb": 55.0,
                "total_cpu_time_s": 0.4, "tool_call_count": 4, "tool_error_count": 0,
                "edit_call_count": 2, "edit_error_count": 0, "non_loopback_sockets": [],
                "htmustc_only_verified": True,
            })
            records.append({
                "harness": "dsh", "model": "gpt-6.2-sol", "task_id": f"t_{idx}", "axis": ax,
                "repeat": 0, "passed": idx < 8, "score": 1.0 if idx < 8 else 0.25, "wall_s": 9.0,
                "wire_requests": 3, "wire_first_ttft_ms": 250.0, "wire_gen_tokens_per_sec": 60.0,
                "wire_total_tokens": 2000, "wire_uncached_input": 1000, "wire_cache_read": 800,
                "wire_cache_write": 0, "wire_output_tokens": 200, "wire_prompt_total": 1800,
                "wire_kv_cache_hit_rate_ge2": 0.4, "wire_effective_cost_units": 1500,
                "wire_window_uncovered_ms": 200.0, "wire_turn1_prompt_tokens": 900,
                "peak_rss_mb": 140.0, "peak_harness_rss_mb": 110.0, "peak_job_memory_mb": 180.0,
                "total_cpu_time_s": 1.2, "tool_call_count": 5, "tool_error_count": 1,
                "edit_call_count": 2, "edit_error_count": 1, "non_loopback_sockets": [],
                "htmustc_only_verified": True,
            })
        rep = scorer_v5.score_suite_v5(records)
        self.assertEqual(rep["ranking"][0], "omnia")
        self.assertEqual(rep["harnesses"]["omnia"]["axes_covered"], 11)
        self.assertEqual(rep["harnesses"]["omnia"]["c_cap_v5"], 100.0)
        self.assertIsNotNone(rep["harnesses"]["omnia"]["cost_per_solved_usd"])
        self.assertEqual(rep["harnesses"]["omnia"]["network_leaks_total"], 0)
        self.assertIsNotNone(rep["harnesses"]["omnia"]["median_wire_ttft_ms"])
        self.assertIsNotNone(rep["harnesses"]["omnia"]["tokens_per_solved"])
        self.assertIn("dsh", rep["mcnemar_vs_omnia"])
        self.assertIn("mcnemar_p", rep["mcnemar_vs_omnia"]["dsh"])
        md = scorer_v5.format_scoreboard_markdown(rep)
        self.assertIn("| omnia |", md)

    def test_reconcile_wire_429_preserves_200_usage_and_rejects_200_missing(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as td:
            wl = Path(td) / "w.jsonl"
            wl.write_text(
                "\n".join([
                    json.dumps({"is_inference": True, "http_status": 429, "usage_complete": False, "wire_ttft_ms": None, "output_tokens": 0, "tool_calls_emitted": 0}),
                    json.dumps({"is_inference": True, "http_status": 200, "usage_complete": True, "wire_ttft_ms": 4626.13, "prompt_total": 500, "uncached_input": 100, "cache_read": 400, "cache_write": 0, "output_tokens": 50, "reasoning_tokens": 0}),
                ]) + "\n",
                encoding="utf-8",
            )
            rec = runner_v5.reconcile_wire_http_error_usage(wl, {"wire_total_tokens": None, "wire_first_ttft_ms": None, "wire_turn1_prompt_tokens": 0})
            self.assertEqual(rec["wire_total_tokens"], 550)
            self.assertEqual(rec["wire_http_error_retries"], 1)
            self.assertEqual(rec["wire_first_ttft_ms"], 4626.13)
            self.assertEqual(rec["wire_turn1_prompt_tokens"], 500)

            wl2 = Path(td) / "w2.jsonl"
            wl2.write_text(
                json.dumps({"is_inference": True, "http_status": 200, "usage_complete": False, "output_tokens": 5}) + "\n",
                encoding="utf-8",
            )
            rec2 = runner_v5.reconcile_wire_http_error_usage(wl2, {"wire_total_tokens": None})
            self.assertIsNone(rec2["wire_total_tokens"])

    def test_fault_mode_resolution_honors_manifest_key(self):
        task = {"id": "resil_01_429_502_retry", "fault_mode": "429_502"}
        resolved = None or task.get("fault_mode") or task.get("proxy_fault_mode")
        self.assertEqual(resolved, "429_502")

    def test_cleanroom_preserves_rust_toolchain_paths_and_offline_isolation(self):
        import tempfile
        from pathlib import Path
        import cleanroom

        with tempfile.TemporaryDirectory() as ws:
            launch = cleanroom.prepare_harness_launch(
                "omnia",
                "gpt-6.2-sol",
                "hello",
                Path(ws),
                45123,
                run_id="unit-test-rust-env",
                timeout_s=120,
            )
            try:
                self.assertTrue(launch.env["RUSTUP_HOME"])
                self.assertTrue(launch.env["CARGO_HOME"])
                self.assertEqual(launch.env["CARGO_NET_OFFLINE"], "true")
                self.assertIn("unit-test-rust-env", launch.env["CARGO_TARGET_DIR"])
                self.assertEqual(launch.env["HTTP_PROXY"], "http://127.0.0.1:1")
                self.assertIn("117", launch.cmd)
            finally:
                launch.cleanup()

    def test_clean_setup_env_compiles_and_tests_rust_offline(self):
        import shutil
        import subprocess
        import tempfile
        from pathlib import Path

        src_rs = Path(__file__).resolve().parent / "suite" / "tasks" / "worktree_03_monorepo_codemod" / "workspace" / "rs_core"
        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            ws_rs = td_p / "rs_core"
            shutil.copytree(src_rs, ws_rs)
            env = runner_v5._clean_setup_env()
            env["CARGO_TARGET_DIR"] = str(td_p / "target")
            proc = subprocess.run(
                ["cargo", "test", "--manifest-path", str(ws_rs / "Cargo.toml"), "--offline"],
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-400:])

    def test_get_process_tree_pids_filters_older_pid_reuse_ancestors(self):
        from unittest.mock import patch
        import proc_monitor

        children = {100: [200], 200: [300, 999]}
        names = {100: "codex.exe", 200: "cmd.exe", 300: "python.exe", 999: "telegram.exe"}
        cts = {100: 5000, 200: 5100, 300: 5200, 999: 1000}
        with patch.object(proc_monitor, "_snapshot_processes", return_value=(children, names)):
            with patch.object(proc_monitor, "_process_creation_ticks", side_effect=lambda p: cts.get(p)):
                pids, _ = proc_monitor.get_process_tree_pids(100)
        self.assertEqual(pids, {100, 200, 300})
        self.assertNotIn(999, pids)

    def test_opencode_cleanroom_launch_uses_standalone(self):
        import tempfile
        from pathlib import Path
        import cleanroom

        with tempfile.TemporaryDirectory() as ws:
            launch = cleanroom.prepare_harness_launch(
                "opencode", "gpt-6.2-sol", "hello", Path(ws), 45123, run_id="unit-test-oc", timeout_s=60
            )
            try:
                self.assertIn("--standalone", launch.cmd)
            finally:
                launch.cleanup()


if __name__ == "__main__":
    unittest.main()
