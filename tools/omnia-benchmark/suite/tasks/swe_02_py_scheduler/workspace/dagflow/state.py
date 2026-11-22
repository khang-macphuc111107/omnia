"""Execution states, trigger rules, and report models for dagflow."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class NodeStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    UPSTREAM_FAILED = "UPSTREAM_FAILED"

    @property
    def is_terminal(self) -> bool:
        return self in (
            NodeStatus.SUCCEEDED,
            NodeStatus.FAILED,
            NodeStatus.SKIPPED,
            NodeStatus.UPSTREAM_FAILED,
        )


class TriggerRule(str, Enum):
    ALL_SUCCESS = "ALL_SUCCESS"
    NONE_FAILED_MIN_ONE_SUCCESS = "NONE_FAILED_MIN_ONE_SUCCESS"
    ALL_DONE = "ALL_DONE"


class SkipTask(Exception):
    """Raised by a task callable to mark the task SKIPPED without failure or retry."""


@dataclass
class ExecutionReport:
    statuses: dict[str, NodeStatus] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    execution_order: list[str] = field(default_factory=list)
    attempts: dict[str, int] = field(default_factory=dict)
    backoff_delays: dict[str, list[float]] = field(default_factory=dict)
