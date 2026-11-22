#!/usr/bin/env python3
"""Hidden verification script for swe_02_py_scheduler."""

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import traceback


TASK_ID = "swe_02_py_scheduler"


def run_checks(workspace: Path) -> dict:
    checks: list[dict] = []

    def record(name: str, group: str, fn) -> None:
        try:
            fn()
            checks.append({"name": name, "passed": True, "group": group, "detail": "ok"})
        except Exception as exc:  # noqa: BLE001
            checks.append(
                {
                    "name": name,
                    "passed": False,
                    "group": group,
                    "detail": f"{type(exc).__name__}: {exc}",
                }
            )

    def p2p_public_unittest() -> None:
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
            cwd=str(workspace),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise AssertionError(
                f"Public tests failed (rc={proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
            )

    record("p2p_public_unittest", "pass_to_pass", p2p_public_unittest)

    sys.path.insert(0, str(workspace))
    for mod_name in list(sys.modules):
        if mod_name == "dagflow" or mod_name.startswith("dagflow."):
            del sys.modules[mod_name]

    try:
        dagflow = importlib.import_module("dagflow")
    except Exception as exc:  # noqa: BLE001
        return {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 1},
            "pass_to_pass": {"passed": 0, "total": 1},
            "checks": checks,
            "error": f"Failed to import dagflow: {exc}\n{traceback.format_exc()}",
        }

    CycleError = dagflow.CycleError
    DAG = dagflow.DAG
    DAGExecutor = dagflow.DAGExecutor
    NodeStatus = dagflow.NodeStatus
    RetryPolicy = dagflow.RetryPolicy
    SkipTask = dagflow.SkipTask
    TriggerRule = dagflow.TriggerRule
    compute_backoff = dagflow.compute_backoff

    # --- PASS_TO_PASS ---
    def p2p_empty_and_retry_exhaustion() -> None:
        empty_report = DAGExecutor().run(DAG("empty"))
        assert empty_report.statuses == {}
        assert empty_report.execution_order == []

        dag = DAG("exhaust")
        dag.add_node(
            "failer",
            lambda _ctx: (_ for _ in ()).throw(RuntimeError("always fails")),
            retry_policy=RetryPolicy(max_attempts=3, base_delay=0.1, multiplier=2.0, max_delay=1.0, jitter=0.0),
        )
        sleeps: list[float] = []
        rep = DAGExecutor(sleep_fn=sleeps.append).run(dag)
        assert rep.statuses["failer"] == NodeStatus.FAILED
        assert rep.attempts["failer"] == 3
        assert sleeps == [0.1, 0.2]
        assert "always fails" in rep.errors["failer"]

    def p2p_topological_order_valid_dag() -> None:
        dag = DAG("topo")
        for n in ("a", "b", "c", "d", "e"):
            dag.add_node(n, lambda _ctx: None)
        dag.add_edge("a", "b")
        dag.add_edge("a", "c")
        dag.add_edge("b", "d")
        dag.add_edge("c", "d")
        dag.add_edge("d", "e")
        order = dag.topological_sort()
        assert len(order) == 5
        assert order.index("a") < order.index("b") < order.index("d") < order.index("e")
        assert order.index("a") < order.index("c") < order.index("d")

    record("p2p_empty_and_retry_exhaustion", "pass_to_pass", p2p_empty_and_retry_exhaustion)
    record("p2p_topological_order_valid_dag", "pass_to_pass", p2p_topological_order_valid_dag)

    # --- FAIL_TO_PASS ---
    def f2p_asymmetric_diamond_no_premature_exec() -> None:
        dag = DAG("asym_diamond")
        d_ran = {"called": False}

        def run_d(_ctx):
            d_ran["called"] = True
            return "bad"

        dag.add_node("a", lambda _ctx: "ok")
        dag.add_node("b", lambda _ctx: "fast_ok")
        dag.add_node("c1", lambda _ctx: "step1_ok")
        dag.add_node("c2", lambda _ctx: (_ for _ in ()).throw(RuntimeError("slow_fail")))
        dag.add_node("d", run_d, trigger_rule=TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS)
        dag.add_edge("a", "b")
        dag.add_edge("a", "c1")
        dag.add_edge("c1", "c2")
        dag.add_edge("b", "d")
        dag.add_edge("c2", "d")

        rep = DAGExecutor().run(dag)
        assert not d_ran["called"], f"Node 'd' executed prematurely! order={rep.execution_order}"
        assert "d" not in rep.execution_order
        assert rep.statuses["d"] == NodeStatus.UPSTREAM_FAILED, f"Got {rep.statuses['d']}"

        # Also check asymmetric diamond where slower branch SUCCEEDS: d must run AFTER c2!
        dag2 = DAG("asym_diamond_ok")
        dag2.add_node("a", lambda _ctx: 1)
        dag2.add_node("b", lambda _ctx: 2)
        dag2.add_node("c1", lambda _ctx: 3)
        dag2.add_node("c2", lambda _ctx: 4)
        dag2.add_node(
            "d",
            lambda ctx: ctx["outputs"]["b"] + ctx["outputs"]["c2"],
            trigger_rule=TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS,
        )
        dag2.add_edge("a", "b")
        dag2.add_edge("a", "c1")
        dag2.add_edge("c1", "c2")
        dag2.add_edge("b", "d")
        dag2.add_edge("c2", "d")
        rep2 = DAGExecutor().run(dag2)
        assert rep2.statuses["d"] == NodeStatus.SUCCEEDED
        assert rep2.outputs["d"] == 6
        assert rep2.execution_order.index("c2") < rep2.execution_order.index("d")

    def f2p_diamond_none_failed_min_one_success_with_skip() -> None:
        dag = DAG("skip_branch")

        def skip_fn(_ctx):
            raise SkipTask("not applicable")

        dag.add_node("a", lambda _ctx: "start")
        dag.add_node(
            "b",
            skip_fn,
            retry_policy=RetryPolicy(max_attempts=3, base_delay=0.1),
        )
        dag.add_node("c", lambda _ctx: "branch_ok")
        dag.add_node(
            "d",
            lambda ctx: f"merged:{ctx['outputs'].get('c')}",
            trigger_rule=TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS,
        )
        dag.add_edge("a", "b")
        dag.add_edge("a", "c")
        dag.add_edge("b", "d")
        dag.add_edge("c", "d")

        rep = DAGExecutor().run(dag)
        assert rep.statuses["b"] == NodeStatus.SKIPPED
        assert rep.attempts["b"] == 1, "SkipTask must not be retried"
        assert rep.statuses["c"] == NodeStatus.SUCCEEDED
        assert rep.statuses["d"] == NodeStatus.SUCCEEDED, f"Expected d SUCCEEDED, got {rep.statuses['d']}"
        assert rep.outputs["d"] == "merged:branch_ok"

    def f2p_diamond_all_success_skip_vs_fail_precedence() -> None:
        def skip_fn(_ctx):
            raise SkipTask("skip")

        # Case 1: ALL_SUCCESS with one SKIPPED and one SUCCEEDED -> SKIPPED
        dag1 = DAG("all_success_skip")
        dag1.add_node("a", lambda _ctx: 1)
        dag1.add_node("b", skip_fn)
        dag1.add_node("c", lambda _ctx: 2)
        dag1.add_node("d", lambda _ctx: 3, trigger_rule=TriggerRule.ALL_SUCCESS)
        dag1.add_edge("a", "b")
        dag1.add_edge("a", "c")
        dag1.add_edge("b", "d")
        dag1.add_edge("c", "d")
        rep1 = DAGExecutor().run(dag1)
        assert rep1.statuses["d"] == NodeStatus.SKIPPED, f"Expected SKIPPED, got {rep1.statuses['d']}"

        # Case 2: ALL_SUCCESS with fast SKIPPED branch and slower FAILED branch -> UPSTREAM_FAILED
        dag2 = DAG("skip_vs_fail")
        dag2.add_node("a", lambda _ctx: 1)
        dag2.add_node("b", skip_fn)
        dag2.add_node("c1", lambda _ctx: 2)
        dag2.add_node("c2", lambda _ctx: (_ for _ in ()).throw(RuntimeError("fail")))
        dag2.add_node("d", lambda _ctx: 3, trigger_rule=TriggerRule.ALL_SUCCESS)
        dag2.add_edge("a", "b")
        dag2.add_edge("a", "c1")
        dag2.add_edge("c1", "c2")
        dag2.add_edge("b", "d")
        dag2.add_edge("c2", "d")
        rep2 = DAGExecutor().run(dag2)
        assert rep2.statuses["d"] == NodeStatus.UPSTREAM_FAILED, (
            f"Failure must take precedence over SKIPPED, got {rep2.statuses['d']}"
        )

        # Case 3: NONE_FAILED_MIN_ONE_SUCCESS when ALL parents are SKIPPED -> SKIPPED
        dag3 = DAG("all_skipped")
        dag3.add_node("a", lambda _ctx: 1)
        dag3.add_node("b", skip_fn)
        dag3.add_node("c", skip_fn)
        dag3.add_node("d", lambda _ctx: 3, trigger_rule=TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS)
        dag3.add_edge("a", "b")
        dag3.add_edge("a", "c")
        dag3.add_edge("b", "d")
        dag3.add_edge("c", "d")
        rep3 = DAGExecutor().run(dag3)
        assert rep3.statuses["d"] == NodeStatus.SKIPPED, f"Expected SKIPPED, got {rep3.statuses['d']}"

    def f2p_disconnected_cycle_detection() -> None:
        dag = DAG("disconnected_cycle")
        for n in ("a", "b", "c", "d"):
            dag.add_node(n, lambda _ctx: None)
        dag.add_edge("a", "b")
        dag.add_edge("c", "d")
        dag.add_edge("d", "c")

        for label, fn in (
            ("validate", dag.validate),
            ("topological_sort", dag.topological_sort),
            ("executor.run", lambda: DAGExecutor().run(dag)),
        ):
            raised = False
            try:
                fn()
            except CycleError:
                raised = True
            assert raised, f"{label} failed to detect disconnected cycle c->d->c"

    def f2p_attached_cycle_and_self_loops() -> None:
        # Attached cycle downstream of valid root
        dag1 = DAG("attached")
        for n in ("a", "b", "c"):
            dag1.add_node(n, lambda _ctx: None)
        dag1.add_edge("a", "b")
        dag1.add_edge("b", "c")
        dag1.add_edge("c", "b")
        raised1 = False
        try:
            dag1.validate()
        except CycleError:
            raised1 = True
        assert raised1, "Failed to detect downstream cycle a->b->c->b"

        # Self-loop alongside valid root component
        dag2 = DAG("self_loop_isolated")
        for n in ("a", "b", "x"):
            dag2.add_node(n, lambda _ctx: None)
        dag2.add_edge("a", "b")
        raised2 = False
        try:
            dag2.add_edge("x", "x")
            dag2.validate()
        except CycleError:
            raised2 = True
        assert raised2, "Failed to detect isolated self-loop x->x"

        # Self-loop on downstream node
        dag3 = DAG("self_loop_downstream")
        for n in ("a", "b"):
            dag3.add_node(n, lambda _ctx: None)
        dag3.add_edge("a", "b")
        raised3 = False
        try:
            dag3.add_edge("b", "b")
            dag3.validate()
        except CycleError:
            raised3 = True
        assert raised3, "Failed to detect downstream self-loop b->b"

    def f2p_backoff_jitter_respects_bounds() -> None:
        rng = random.Random(12345)
        policy = RetryPolicy(
            max_attempts=10,
            base_delay=1.0,
            multiplier=2.0,
            max_delay=2.0,
            jitter=0.5,
        )
        samples: list[float] = []
        for attempt in range(1, 7):
            for _ in range(100):
                d = compute_backoff(policy, attempt, rng=rng)
                assert 0.0 <= d <= policy.max_delay, (
                    f"Backoff delay {d} violated bounds [0.0, {policy.max_delay}] at attempt={attempt}"
                )
                samples.append(d)
        assert len(set(round(s, 6) for s in samples)) > 10, "Jitter appears to have been disabled"

        # High jitter (> 1.0) must never return negative values either
        high_jitter = RetryPolicy(
            max_attempts=5,
            base_delay=1.0,
            multiplier=2.0,
            max_delay=2.0,
            jitter=1.5,
        )
        for _ in range(200):
            d = compute_backoff(high_jitter, 2, rng=rng)
            assert 0.0 <= d <= high_jitter.max_delay, f"High jitter delay out of bounds: {d}"

        # End-to-end executor backoff delays
        dag = DAG("jitter_exec")
        dag.add_node(
            "flaky",
            lambda _ctx: (_ for _ in ()).throw(RuntimeError("err")),
            retry_policy=RetryPolicy(
                max_attempts=12, base_delay=0.8, multiplier=2.0, max_delay=1.0, jitter=0.5
            ),
        )
        recorded: list[float] = []
        rep = DAGExecutor(sleep_fn=recorded.append, rng_seed=7).run(dag)
        assert len(recorded) == 11
        assert all(0.0 <= d <= 1.0 for d in recorded), f"Executor recorded out-of-bounds delays: {recorded}"
        assert rep.backoff_delays["flaky"] == recorded

    record("f2p_asymmetric_diamond_no_premature_exec", "fail_to_pass", f2p_asymmetric_diamond_no_premature_exec)
    record("f2p_diamond_none_failed_min_one_success_with_skip", "fail_to_pass", f2p_diamond_none_failed_min_one_success_with_skip)
    record("f2p_diamond_all_success_skip_vs_fail_precedence", "fail_to_pass", f2p_diamond_all_success_skip_vs_fail_precedence)
    record("f2p_disconnected_cycle_detection", "fail_to_pass", f2p_disconnected_cycle_detection)
    record("f2p_attached_cycle_and_self_loops", "fail_to_pass", f2p_attached_cycle_and_self_loops)
    record("f2p_backoff_jitter_respects_bounds", "fail_to_pass", f2p_backoff_jitter_respects_bounds)

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    total_passed = f2p_passed + p2p_passed
    passed = total > 0 and total_passed == total

    return {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(total_passed / total, 4) if total else 0.0,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    result = run_checks(Path(args.workspace).resolve())
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
