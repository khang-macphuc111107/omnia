"""Deterministic wave-based DAG workflow executor."""

from __future__ import annotations

import random
from typing import Any, Callable

from .graph import DAG, TaskNode
from .retry import compute_backoff
from .state import ExecutionReport, NodeStatus, SkipTask, TriggerRule


class DAGExecutor:
    """Executes a validated DAG in deterministic scheduling waves."""

    def __init__(
        self,
        sleep_fn: Callable[[float], None] | None = None,
        rng_seed: int = 42,
    ) -> None:
        self._sleep_fn = sleep_fn if sleep_fn is not None else (lambda _s: None)
        self._rng_seed = rng_seed

    def _evaluate_trigger(
        self,
        node: TaskNode,
        parent_statuses: list[NodeStatus],
    ) -> str | NodeStatus:
        """Evaluate whether a PENDING node is ready to run, waiting, or terminal."""
        if not parent_statuses:
            return "READY"

        rule = node.trigger_rule
        if rule == TriggerRule.ALL_SUCCESS:
            if any(
                s in (NodeStatus.FAILED, NodeStatus.UPSTREAM_FAILED, NodeStatus.SKIPPED)
                for s in parent_statuses
            ):
                return NodeStatus.UPSTREAM_FAILED
            if all(s == NodeStatus.SUCCEEDED for s in parent_statuses):
                return "READY"
            return "WAIT"

        if rule == TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS:
            if any(
                s in (NodeStatus.FAILED, NodeStatus.UPSTREAM_FAILED, NodeStatus.SKIPPED)
                for s in parent_statuses
            ):
                return NodeStatus.UPSTREAM_FAILED
            if any(s == NodeStatus.SUCCEEDED for s in parent_statuses):
                return "READY"
            return "WAIT"

        if rule == TriggerRule.ALL_DONE:
            if all(s.is_terminal for s in parent_statuses):
                return "READY"
            return "WAIT"

        raise ValueError(f"Unsupported trigger rule: {rule}")

    def _execute_node(
        self,
        node: TaskNode,
        context: dict[str, Any],
        report: ExecutionReport,
        rng: random.Random,
    ) -> None:
        policy = node.retry_policy
        report.statuses[node.node_id] = NodeStatus.RUNNING
        report.execution_order.append(node.node_id)
        report.backoff_delays.setdefault(node.node_id, [])

        for attempt in range(1, policy.max_attempts + 1):
            report.attempts[node.node_id] = attempt
            try:
                result = node.fn(context)
                report.outputs[node.node_id] = result
                report.statuses[node.node_id] = NodeStatus.SUCCEEDED
                return
            except SkipTask:
                report.statuses[node.node_id] = NodeStatus.SKIPPED
                return
            except Exception as exc:  # noqa: BLE001
                report.errors[node.node_id] = f"{type(exc).__name__}: {exc}"
                if attempt < policy.max_attempts:
                    delay = compute_backoff(policy, attempt, rng=rng)
                    report.backoff_delays[node.node_id].append(delay)
                    self._sleep_fn(delay)
                else:
                    report.statuses[node.node_id] = NodeStatus.FAILED
                    return

    def run(self, dag: DAG, initial_context: dict[str, Any] | None = None) -> ExecutionReport:
        """Validate and execute `dag`, returning an ExecutionReport."""
        dag.validate()

        rng = random.Random(self._rng_seed)
        report = ExecutionReport()
        context: dict[str, Any] = dict(initial_context) if initial_context else {}
        context["outputs"] = report.outputs
        context["statuses"] = report.statuses

        all_node_ids = sorted(dag.nodes.keys())
        for nid in all_node_ids:
            report.statuses[nid] = NodeStatus.PENDING
            report.attempts[nid] = 0

        # Wave-based execution loop
        while True:
            pending = [nid for nid in all_node_ids if report.statuses[nid] == NodeStatus.PENDING]
            if not pending:
                break

            ready_wave: list[str] = []
            progressed = False

            for nid in pending:
                node = dag.nodes[nid]
                parent_statuses = [report.statuses[p] for p in dag.parents_of(nid)]
                decision = self._evaluate_trigger(node, parent_statuses)
                if decision == "READY":
                    ready_wave.append(nid)
                elif isinstance(decision, NodeStatus):
                    report.statuses[nid] = decision
                    progressed = True

            if ready_wave:
                progressed = True
                for nid in ready_wave:
                    self._execute_node(dag.nodes[nid], context, report, rng)

            if not progressed:
                raise RuntimeError(
                    f"Scheduler deadlock detected with remaining pending nodes: {pending}"
                )

        return report
