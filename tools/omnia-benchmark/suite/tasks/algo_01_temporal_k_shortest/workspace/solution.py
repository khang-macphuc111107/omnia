"""Time-Windowed Dynamic Toll-Surge Minimum-Cost Routing with Waiting Costs."""

from __future__ import annotations


def min_temporal_route_cost(
    n: int,
    edges: list[tuple[int, int, int, int, int, int, int]],
    wait_costs: list[int],
    src: int,
    dst: int,
    t_start: int,
    t_max: int,
) -> tuple[int, list[int]] | None:
    """Compute the optimal temporal route from (src, t_start) to dst by t_max.

    Args:
        n: Number of nodes (labeled 0 .. n-1).
        edges: Directed edges as tuples:
            (u, v, travel_time, base_cost, surge_start, surge_end, surge_extra)
            where travel_time >= 1, base_cost >= 0, surge_extra >= 0.
            Departing u at time t incurs surge_extra iff surge_start <= t < surge_end.
        wait_costs: List of length n; wait_costs[u] >= 0 is the cost to wait
            1 time unit at node u ((u, t) -> (u, t + 1)).
        src: Starting node index.
        dst: Destination node index.
        t_start: Initial integer departure time.
        t_max: Maximum allowed arrival time (inclusive).

    Returns:
        (total_cost, path) minimizing:
            1. total_cost
            2. arrival time at dst
            3. lexicographically smallest node path (waiting does not duplicate nodes;
               traversing any edge (u, v) appends v)
        or None if dst cannot be reached with t_start <= t <= t_max.
    """
    raise NotImplementedError("Implement min_temporal_route_cost")
