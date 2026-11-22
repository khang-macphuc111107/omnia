"""Directed Acyclic Graph (DAG) representation and topological validation."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .retry import RetryPolicy
from .state import TriggerRule


class GraphError(Exception):
    """Base error for invalid DAG structures."""


class CycleError(GraphError):
    """Raised when a cycle is detected in the workflow graph."""


@dataclass
class TaskNode:
    node_id: str
    fn: Callable[[dict[str, Any]], Any]
    trigger_rule: TriggerRule = TriggerRule.ALL_SUCCESS
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)


class DAG:
    """Directed workflow graph with named task nodes and directed dependency edges."""

    def __init__(self, name: str = "workflow") -> None:
        self.name = name
        self._nodes: dict[str, TaskNode] = {}
        self._children: dict[str, set[str]] = {}
        self._parents: dict[str, set[str]] = {}

    def add_node(
        self,
        node_id: str,
        fn: Callable[[dict[str, Any]], Any],
        trigger_rule: TriggerRule = TriggerRule.ALL_SUCCESS,
        retry_policy: RetryPolicy | None = None,
    ) -> TaskNode:
        if node_id in self._nodes:
            raise GraphError(f"Duplicate node_id: {node_id}")
        node = TaskNode(
            node_id=node_id,
            fn=fn,
            trigger_rule=trigger_rule,
            retry_policy=retry_policy if retry_policy is not None else RetryPolicy(),
        )
        self._nodes[node_id] = node
        self._children[node_id] = set()
        self._parents[node_id] = set()
        return node

    def add_edge(self, src: str, dst: str) -> None:
        if src not in self._nodes:
            raise GraphError(f"Unknown source node: {src}")
        if dst not in self._nodes:
            raise GraphError(f"Unknown destination node: {dst}")
        self._children[src].add(dst)
        self._parents[dst].add(src)

    @property
    def nodes(self) -> dict[str, TaskNode]:
        return dict(self._nodes)

    def parents_of(self, node_id: str) -> list[str]:
        if node_id not in self._nodes:
            raise GraphError(f"Unknown node: {node_id}")
        return sorted(self._parents[node_id])

    def children_of(self, node_id: str) -> list[str]:
        if node_id not in self._nodes:
            raise GraphError(f"Unknown node: {node_id}")
        return sorted(self._children[node_id])

    def topological_sort(self) -> list[str]:
        """Return a deterministic topological ordering of all nodes, or raise CycleError."""
        in_degree = {nid: len(self._parents[nid]) for nid in self._nodes}
        ready = sorted(nid for nid, deg in in_degree.items() if deg == 0)

        if self._nodes and not ready:
            raise CycleError("Cycle detected: graph has no zero-in-degree root nodes")

        queue = deque(ready)
        order: list[str] = []

        while queue:
            current = queue.popleft()
            order.append(current)
            newly_ready: list[str] = []
            for child in sorted(self._children[current]):
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    newly_ready.append(child)
            for nxt in sorted(newly_ready):
                queue.append(nxt)

        return order

    def validate(self) -> None:
        """Validate that the DAG contains no cycles."""
        self.topological_sort()
