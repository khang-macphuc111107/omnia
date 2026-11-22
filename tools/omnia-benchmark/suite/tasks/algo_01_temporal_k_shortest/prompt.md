# Time-Windowed Dynamic Toll-Surge Minimum-Cost Routing with Waiting Costs

Implement `min_temporal_route_cost` in `solution.py` using **Python 3.13 standard library only** (no third-party packages).

## Problem Specification

You are given a directed graph with `n` nodes labeled `0` through `n - 1` (`n >= 1`).

```python
def min_temporal_route_cost(
    n: int,
    edges: list[tuple[int, int, int, int, int, int, int]],
    wait_costs: list[int],
    src: int,
    dst: int,
    t_start: int,
    t_max: int,
) -> tuple[int, list[int]] | None:
```

### Graph & Transitions

1. **Directed Edges**:
   Each tuple in `edges` has the form:
   `(u, v, travel_time, base_cost, surge_start, surge_end, surge_extra)`
   - `0 <= u < n`, `0 <= v < n`
   - `travel_time >= 1` (strictly positive integer)
   - `base_cost >= 0`, `surge_extra >= 0`
   - Parallel edges between the same `(u, v)` and self-loops (`u == v`) are allowed.
   - If you are at node `u` at integer time `t` (`t_start <= t <= t_max`), you may depart along edge `e` provided `t_arr = t + travel_time <= t_max`. You arrive at node `v` at time `t_arr`.
   - **Toll-Surge Window (Half-Open)**:
     - If `surge_start <= t < surge_end`, the cost of traversing this edge at departure time `t` is `base_cost + surge_extra`.
     - Otherwise (including when `surge_start >= surge_end`, which denotes an empty surge window), the traversal cost is `base_cost`.

2. **Waiting at a Node**:
   - `wait_costs` is a list of length `n` with `wait_costs[u] >= 0`.
   - At any node `u` at integer time `t < t_max`, you may wait for 1 time unit, transitioning `(u, t) -> (u, t + 1)` at cost `wait_costs[u]`.
   - Waiting may be repeated any number of times (as long as `t <= t_max`) and can be optimal to wait out a surge window before departing.

3. **Path Representation**:
   - A route begins at `(src, t_start)` with initial node path `[src]`.
   - **Waiting** at a node `u` does **not** append `u` to the returned path.
   - **Traversing an edge** `(u, v, ...)` **always** appends `v` to the returned path (including if `u == v` for a self-loop, which appends `u` to the path).
   - Cycles and repeated visits to nodes are permitted if they yield an optimal route under the objective below.

### Objective & Tie-Breaking

Starting from `(src, t_start)`, reach `dst` at any integer arrival time `t` with `t_start <= t <= t_max` minimizing, in strict priority order:

1. **Minimum total cost** (sum of all edge traversal costs and waiting costs).
2. **Minimum arrival time `t`** at `dst`.
3. **Lexicographically smallest node path** `list[int]` (standard Python list comparison: compare element-by-element from index `0`; if one list is a prefix of the other, the shorter list is smaller).

### Edge Cases & Return Value

- If `t_start > t_max`, return `None`.
- If `src == dst` and `t_start <= t_max`, you are already at `dst` at time `t_start`, so return `(0, [src])`.
- If `dst` cannot be reached at any time `t <= t_max`, return `None`.
- Otherwise, return `(total_cost, path)`.

### Constraints & Performance Expectations

- `1 <= n <= 500`
- `0 <= len(edges) <= 5000`
- `t_start` may be large (e.g. `100_000`), while when `t_start <= t_max`, the time horizon `T = t_max - t_start <= 1000`.
- Stress test: `n = 200`, `len(edges) = 1200`, `t_max - t_start = 300` must complete well under `2.0` seconds in pure Python 3.13.
- Do not mutate caller-provided input lists.

## Local Testing

A small sample test script `test_sample.py` is included in the workspace:

```bash
python test_sample.py
```

Your implementation will be evaluated against an extensive hidden verification suite covering tricky edge cases, randomized differential testing against an exact oracle, and a performance stress test.
