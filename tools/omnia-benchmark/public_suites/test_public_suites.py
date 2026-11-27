"""Offline deterministic unit tests for all 9 AA/frontier public suite modules + TB4.1 audit."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent.parent
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))
VENV_SITE = Path(r"D:\omnia-bench\.venv\Lib\site-packages")
if VENV_SITE.exists() and str(VENV_SITE) not in sys.path:
    sys.path.append(str(VENV_SITE))

from public_suites import (
    aa_lcr,
    aider_polyglot,
    bfcl_v4,
    compaction_bench,
    livecodebench,
    locomo,
    longmemeval,
    swe_atlas_qna,
    tau2_bench,
    terminal_bench_subset,
)


class PublicSuitesOfflineTests(unittest.TestCase):
    def test_swe_atlas_qna_loads_124_and_grades_majority_with_negative_polarity(self):
        tasks = swe_atlas_qna.load_tasks()
        self.assertEqual(len(tasks), 124)
        self.assertEqual(swe_atlas_qna.strip_rubric_prefix("1.3: Uses WAL journaling"), "Uses WAL journaling")
        synthetic_task = {
            "task_id": "t_syn",
            "prompt": "Explain module X.",
            "rubric_items": [
                {"id": "c1", "title": "1.1: Mentions foo"},
                {"id": "c2", "title": "1.2: Hallucinates bar", "annotations": [{"type": "negative hli verifier"}]},
            ],
        }
        votes = iter([
            {"verdict": "YES"}, {"verdict": "YES"}, {"verdict": "NO"}, {"verdict": "YES"}, {"verdict": "NO"},  # c1 -> YES (3/5)
            {"verdict": "NO"}, {"verdict": "NO"}, {"verdict": "YES"}, {"verdict": "NO"}, {"verdict": "NO"},     # c2 neg -> NO (4/5) -> MET!
        ])
        res = swe_atlas_qna.grade_answer(synthetic_task, "foo only", votes_per_criterion=5, judge_fn=lambda p, a, c: next(votes))
        self.assertTrue(res["passed"])
        self.assertEqual(res["criteria_met"], 2)

    def test_livecodebench_decodes_private_and_executes_stdin_and_functional(self):
        tasks = livecodebench.load_tasks(limit=3)
        self.assertEqual(len(tasks), 3)
        decoded = livecodebench.decode_test_cases(tasks[0])
        self.assertGreater(len(decoded["public"]) + len(decoded["private"]), 0)
        stdin_task = {
            "question_id": "syn_stdin",
            "public_test_cases": json.dumps([{"input": "2 3\n", "output": "5\n", "testtype": "stdin"}]),
            "private_test_cases": "[]",
            "metadata": {},
        }
        ev = livecodebench.evaluate_solution(stdin_task, "a, b = map(int, input().split()); print(a + b)")
        self.assertTrue(ev["passed"])
        func_task = {
            "question_id": "syn_func",
            "public_test_cases": json.dumps([{"input": "[1, 2, 3]", "output": "6", "testtype": "functional"}]),
            "private_test_cases": "[]",
            "metadata": {"func_name": "sumArr"},
        }
        ev2 = livecodebench.evaluate_solution(func_task, "class Solution:\n    def sumArr(self, nums):\n        return sum(nums)\n")
        self.assertTrue(ev2["passed"])

    def test_bfcl_v4_official_ast_and_multi_turn_checkers(self):
        simple = bfcl_v4.load_category("simple_python", limit=1)[0]
        gt = simple["ground_truth"]
        # Extract ground truth valid call automatically for smoke verification
        res = bfcl_v4.evaluate_entry(simple, [{"calculate_triangle_area": {"base": 10, "height": 5, "unit": "units"}}], model_name="gpt-6.2-sol")
        self.assertTrue(res["passed"], res)
        irr = bfcl_v4.load_category("irrelevance", limit=1)[0]
        self.assertTrue(bfcl_v4.evaluate_entry(irr, [])["passed"])
        mt = bfcl_v4.load_category("multi_turn_base", limit=1)[0]
        mt_norm = bfcl_v4._normalize_multi_turn_output(mt["ground_truth"], len(mt["ground_truth"]))
        self.assertTrue(bfcl_v4.evaluate_entry(mt, mt_norm, model_name="gpt-6.2-sol")["passed"])

    def test_tau2_bench_loads_domains_and_golden_replay(self):
        mock_tasks = tau2_bench.load_tasks("mock")
        self.assertEqual(len(mock_tasks), 10)
        t0 = mock_tasks[0]
        env = tau2_bench.build_task_env("mock", t0)
        # Apply golden actions to verify DB hash matches compute_gold_hashes
        from tau2.data_model.message import ToolCall
        for idx, act in enumerate(t0.evaluation_criteria.actions or []):
            env.get_response(ToolCall(id=f"c_{idx}", name=act.name, arguments=dict(act.arguments or {}), requestor="assistant"))
        ev = tau2_bench.evaluate_environment("mock", env, t0, ["Task created successfully."])
        self.assertTrue(ev["agent_db_match"])

    def test_locomo_longmemeval_compaction_and_aa_lcr(self):
        locs = locomo.load_tasks()
        self.assertEqual(len(locs), 10)
        self.assertTrue(locomo.grade_qa("7 May 2023", {"answer": "7 May 2023", "category": 2})["passed"])
        self.assertTrue(locomo.grade_qa("That was not mentioned.", {"answer": "", "category": 5})["passed"])

        lmes = longmemeval.load_tasks(limit=2)
        self.assertEqual(len(lmes), 2)
        self.assertTrue(longmemeval.grade_prediction("GPS system not functioning correctly", lmes[0])["passed"])

        cbs = compaction_bench.load_tasks("all")
        self.assertEqual(len(cbs), 32)
        p0 = cbs[0]["cycles"][0]["probes"][0]
        self.assertTrue(compaction_bench.grade_probe(json.dumps(p0["answer"]), p0)["passed"])
        self.assertFalse(compaction_bench.grade_probe(json.dumps(p0.get("traps") or ["wrong"]), p0)["passed"])

        lcr_tasks = aa_lcr.load_tasks()
        self.assertEqual(len(lcr_tasks), 100)
        self.assertTrue(aa_lcr.grade_answer("1. Airline Industry (12)\n2. Accommodation Industry (4)", lcr_tasks[0]["answer"])["passed"])

    def test_aider_polyglot_and_terminal_bench_honesty(self):
        exs = aider_polyglot.discover_exercises()
        self.assertEqual(len(exs), 225)
        runnable = [x for x in exs if x["runnable"]]
        blocked = [x for x in exs if not x["runnable"]]
        self.assertEqual(len(runnable), 113)
        self.assertEqual(len(blocked), 112)

        tb = terminal_bench_subset.audit_terminal_bench_41()
        self.assertGreaterEqual(tb["total_task_dirs"], 66)
        rt = tb["container_runtime"]
        if not rt["container_runtime_available"]:
            self.assertIn("WSL2", rt["exact_blocker"])

    def test_aider_rust_verify_exercise_links_cleanly_offline(self):
        import shutil
        import tempfile

        ex_acc = next(it for it in aider_polyglot.discover_exercises(["rust"]) if it["id"] == "rust/accumulate")
        tmp = Path(tempfile.mkdtemp(prefix="test_rs_link_"))
        try:
            aider_polyglot._stage_exercise_workspace(ex_acc, tmp)
            (tmp / "src" / "lib.rs").write_text(
                "pub fn map<T, U, F: FnMut(T) -> U>(input: Vec<T>, mut function: F) -> Vec<U> {\n"
                "    input.into_iter().map(function).collect()\n"
                "}\n",
                encoding="utf-8",
                newline="\n",
            )
            res = aider_polyglot.verify_exercise(ex_acc, tmp)
            self.assertTrue(res["passed"], res)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_cli_select_tasks_and_reject_agy_gemini(self):
        import argparse
        from public_suites import cli, common

        with self.assertRaises(ValueError):
            cli.runner_v5.validate_harness_and_model("agy", "gpt-6.2-sol")
        with self.assertRaises(ValueError):
            cli.runner_v5.validate_harness_and_model("omnia", "gemini-4-argon")
        items = cli._select_tasks_for_suite(argparse.Namespace(
            suite="aider_polyglot", limit=150, category="all", domain="mock", lang="all_runnable", stratified=True,
        ))
        self.assertEqual(len(items), 113)
        strat_swe = cli._select_tasks_for_suite(argparse.Namespace(
            suite="swe_atlas_qna_aa", limit=11, category="all", domain="mock", lang="python", stratified=True,
        ))
        self.assertEqual(len({x[1]["repository_url"] for x in strat_swe}), 11)

        summ = common.summarize_suite_results("tau2_bench", [
            {"harness": "omnia", "model": "gpt-6.2-sol", "task_id": "t1", "passed": True, "score": 1.0, "wall_s": 5.0, "wire_prompt_total": 100, "wire_cache_read": 80, "wire_output_tokens": 50, "wire_total_tokens": 150, "wire_requests_missing_usage": 0},
            {"harness": "api", "model": "gpt-6.2-sol", "task_id": "t1", "passed": False, "score": 0.75, "wall_s": 8.0, "wire_prompt_total": 100, "wire_cache_read": 0, "wire_output_tokens": 20, "wire_total_tokens": 120, "wire_requests_missing_usage": 0},
        ])
        ci_lo, ci_hi = summ["groups"]["api:gpt-6.2-sol"]["wilson_95ci"]
        self.assertGreaterEqual(ci_lo, 0.0)
        self.assertLessEqual(ci_hi, 100.0)
        self.assertEqual(summ["groups"]["omnia:gpt-6.2-sol"]["pooled_kv_cache_hit_pct"], 80.0)
        self.assertIn("api", summ.get("mcnemar_vs_omnia", {}))


if __name__ == "__main__":
    unittest.main()
