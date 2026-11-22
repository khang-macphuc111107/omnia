# Issue Report: DAG Workflow Fan-In, Disconnected Cycle Detection & Retry Backoff Bugs

Work strictly inside the current working directory. Use Python 3 stdlib only (no third-party packages). You can run the existing public test suite with:

```bash
python -m unittest discover -s tests -v
```

## Background

`dagflow/` is a deterministic DAG workflow task scheduler composed of four modules:
- `dagflow/state.py`: `NodeStatus`, `TriggerRule` (`ALL_SUCCESS`, `NONE_FAILED_MIN_ONE_SUCCESS`, `ALL_DONE`), `SkipTask`, and `ExecutionReport`.
- `dagflow/graph.py`: `DAG`, `TaskNode`, and `CycleError`.
- `dagflow/retry.py`: `RetryPolicy` and `compute_backoff`.
- `dagflow/executor.py`: `DAGExecutor` running DAGs deterministically in dependency order with retries and trigger rules.

The baseline public tests pass, but three production bugs have been reported across `dagflow/executor.py`, `dagflow/graph.py`, and `dagflow/retry.py`.

## Bug 1: Diamond Fan-In Premature Execution & `SKIPPED` vs `FAILED` Semantics (`dagflow/executor.py`)

When a downstream node has multiple upstream parents (including asymmetric diamond branches such as `A -> B -> D` alongside `A -> C1 -> C2 -> D`), execution MUST obey these strict rules:

1. **No premature execution**: A node MUST NOT execute (and MUST NOT be finalized to `SKIPPED` or `UPSTREAM_FAILED`) until **ALL** of its upstream parents have reached a terminal state (`SUCCEEDED`, `FAILED`, `SKIPPED`, or `UPSTREAM_FAILED`).
   - Currently, `NONE_FAILED_MIN_ONE_SUCCESS` triggers as soon as a single parent succeeds while another parent is still `PENDING`/`RUNNING`, causing `D` to run prematurely even when the slower sibling branch later fails!
2. **Exact trigger-rule semantics** once all parents are terminal (note: root nodes with 0 parents are immediately ready to run):
   - `TriggerRule.ALL_SUCCESS`:
     - If all parents are `SUCCEEDED` -> run the node.
     - Else if ANY parent is `FAILED` or `UPSTREAM_FAILED` -> mark `UPSTREAM_FAILED` (failure takes precedence over skip).
     - Else (no parent failed, at least one parent is `SKIPPED`) -> mark `SKIPPED`.
   - `TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS`:
     - If ANY parent is `FAILED` or `UPSTREAM_FAILED` -> mark `UPSTREAM_FAILED`.
     - Else if at least one parent is `SUCCEEDED` (even if other parents are `SKIPPED`) -> run the node.
     - Else (all parents are `SKIPPED`) -> mark `SKIPPED`.
   - `TriggerRule.ALL_DONE`:
     - Once all parents are terminal -> ALWAYS run the node regardless of parent outcomes.
3. `SkipTask` raised by a task function marks that node `SKIPPED` immediately **without** retrying.

## Bug 2: Cycle Detection Missing Self-Loops & Disconnected Cycle Components (`dagflow/graph.py`)

`DAG.topological_sort()`, `DAG.validate()`, and `DAGExecutor.run()` MUST detect and raise `CycleError` for **every** cycle in the graph, including:
- Pure cycles (no zero-in-degree nodes),
- Disconnected cycle components alongside valid root-bearing components (e.g., `A -> B` and `C -> D -> C`),
- Cycles reachable downstream of a valid root (e.g., `A -> B -> C -> B`),
- Self-loops (`X -> X`), whether isolated or attached to another component (may also be rejected immediately in `add_edge`, and must never slip past `validate()`/`topological_sort()`).

Currently, Kahn's sort only raises `CycleError` when the initial zero-in-degree queue is empty, silently returning a partial node order whenever at least one acyclic root exists!

## Bug 3: Exponential Backoff Jitter Violating `[0.0, max_delay]` Bounds (`dagflow/retry.py`)

`compute_backoff(policy, attempt, rng=None)` calculates:
- Raw exponential delay `base_delay * (multiplier ** (attempt - 1))` (for 1-based `attempt >= 1`), capped at `policy.max_delay`.
- When `policy.jitter > 0`, applies symmetric uniform jitter in `[-capped * jitter, +capped * jitter]`.
- The final returned delay MUST ALWAYS be strictly clamped to `[0.0, policy.max_delay]` (never exceeding `policy.max_delay` and never negative!).

Currently, jitter is added *after* capping without re-clamping, allowing backoff delays to exceed `policy.max_delay` (or become negative when `jitter > 1.0`).

## Requirements

- Fix all three root causes across `dagflow/`.
- Preserve all existing public APIs and deterministic execution behavior verified by `tests/test_basic.py`.
- Verify with `python -m unittest discover -s tests -v` plus comprehensive tests covering all three bug areas.
