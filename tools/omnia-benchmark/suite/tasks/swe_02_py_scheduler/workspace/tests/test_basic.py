"""Public baseline test suite for dagflow package."""

import unittest

from dagflow import (
    CycleError,
    DAG,
    DAGExecutor,
    NodeStatus,
    RetryPolicy,
    TriggerRule,
    compute_backoff,
)


class TestDagFlowBasic(unittest.TestCase):
    def test_linear_pipeline_success(self) -> None:
        dag = DAG("linear")
        dag.add_node("a", lambda ctx: 10)
        dag.add_node("b", lambda ctx: ctx["outputs"]["a"] + 5)
        dag.add_node("c", lambda ctx: ctx["outputs"]["b"] * 2)
        dag.add_edge("a", "b")
        dag.add_edge("b", "c")

        report = DAGExecutor().run(dag)
        self.assertEqual(report.execution_order, ["a", "b", "c"])
        self.assertEqual(report.outputs["c"], 30)
        self.assertTrue(all(s == NodeStatus.SUCCEEDED for s in report.statuses.values()))

    def test_symmetric_diamond_all_success(self) -> None:
        dag = DAG("diamond")
        dag.add_node("a", lambda ctx: 1)
        dag.add_node("b", lambda ctx: ctx["outputs"]["a"] + 1)
        dag.add_node("c", lambda ctx: ctx["outputs"]["a"] + 2)
        dag.add_node("d", lambda ctx: ctx["outputs"]["b"] + ctx["outputs"]["c"])
        dag.add_edge("a", "b")
        dag.add_edge("a", "c")
        dag.add_edge("b", "d")
        dag.add_edge("c", "d")

        report = DAGExecutor().run(dag)
        self.assertEqual(report.outputs["d"], 5)
        self.assertEqual(report.execution_order[0], "a")
        self.assertEqual(report.execution_order[-1], "d")

    def test_pure_cycle_raises(self) -> None:
        dag = DAG("cycle")
        dag.add_node("a", lambda ctx: None)
        dag.add_node("b", lambda ctx: None)
        dag.add_edge("a", "b")
        dag.add_edge("b", "a")
        with self.assertRaises(CycleError):
            dag.validate()

    def test_failure_propagation_and_all_done_cleanup(self) -> None:
        dag = DAG("cleanup")
        dag.add_node("a", lambda ctx: "ok")
        dag.add_node("b", lambda ctx: (_ for _ in ()).throw(RuntimeError("boom")))
        dag.add_node("c", lambda ctx: "skipped_downstream", trigger_rule=TriggerRule.ALL_SUCCESS)
        dag.add_node("cleanup", lambda ctx: "cleaned", trigger_rule=TriggerRule.ALL_DONE)
        dag.add_edge("a", "b")
        dag.add_edge("b", "c")
        dag.add_edge("b", "cleanup")

        report = DAGExecutor().run(dag)
        self.assertEqual(report.statuses["b"], NodeStatus.FAILED)
        self.assertEqual(report.statuses["c"], NodeStatus.UPSTREAM_FAILED)
        self.assertEqual(report.statuses["cleanup"], NodeStatus.SUCCEEDED)

    def test_retry_without_jitter(self) -> None:
        state = {"calls": 0}

        def flaky(_ctx):
            state["calls"] += 1
            if state["calls"] < 3:
                raise ValueError("transient")
            return "recovered"

        dag = DAG("retry")
        policy = RetryPolicy(max_attempts=4, base_delay=0.5, multiplier=2.0, max_delay=1.5, jitter=0.0)
        dag.add_node("job", flaky, retry_policy=policy)

        recorded: list[float] = []
        report = DAGExecutor(sleep_fn=recorded.append).run(dag)
        self.assertEqual(report.statuses["job"], NodeStatus.SUCCEEDED)
        self.assertEqual(report.attempts["job"], 3)
        self.assertEqual(recorded, [0.5, 1.0])
        self.assertEqual(compute_backoff(policy, 5), 1.5)


if __name__ == "__main__":
    unittest.main()
