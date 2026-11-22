"""Hidden verification suite for algo_01_temporal_k_shortest."""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import random
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

TASK_ID = "algo_01_temporal_k_shortest"
STRESS_TIME_LIMIT_S = 2.0


def _oracle_backward_dp(
    n: int,
    edges: list[tuple[int, int, int, int, int, int, int]],
    wait_costs: list[int],
    src: int,
    dst: int,
    t_start: int,
    t_max: int,
) -> tuple[int, list[int]] | None:
    """Independent exact backward-DP oracle over (cost, arr_time, suffix_path)."""
    if t_start > t_max:
        return None
    if src == dst:
        return (0, [src])

    horizon = t_max - t_start
    adj: list[list[tuple[int, int, int, int, int, int]]] = [[] for _ in range(n)]
    for u, v, dt, base, s_start, s_end, s_extra in edges:
        if dt <= horizon:
            adj[u].append((v, dt, base, s_start - t_start, s_end - t_start, s_extra))

    # dp[t][u] = (min_cost, arr_time, best_suffix_path_starting_with_u) or None
    dp: list[list[tuple[int, int, list[int]] | None]] = [
        [None] * n for _ in range(horizon + 1)
    ]

    for t in range(horizon, -1, -1):
        for u in range(n):
            best: tuple[int, int, list[int]] | None = None
            if u == dst:
                best = (0, t, [dst])
            if t < horizon:
                nxt = dp[t + 1][u]
                if nxt is not None:
                    cand = (nxt[0] + wait_costs[u], nxt[1], nxt[2])
                    if best is None or cand < best:
                        best = cand
            for v, dt, base, ls, le, s_extra in adj[u]:
                ta = t + dt
                if ta <= horizon:
                    nxt = dp[ta][v]
                    if nxt is not None:
                        ec = base + (s_extra if ls <= t < le else 0)
                        cand = (nxt[0] + ec, nxt[1], [u] + nxt[2])
                        if best is None or cand < best:
                            best = cand
            dp[t][u] = best

    ans = dp[0][src]
    if ans is None:
        return None
    return (ans[0], ans[2])


def _solve_fast_exact(
    n: int,
    edges: list[tuple[int, int, int, int, int, int, int]],
    wait_costs: list[int],
    src: int,
    dst: int,
    t_start: int,
    t_max: int,
) -> tuple[int, list[int]] | None:
    """Fast O((N + M) * T) exact solver for verifying large stress instances."""
    if t_start > t_max:
        return None
    if src == dst:
        return (0, [src])

    horizon = t_max - t_start
    inf = 10**30

    adj: list[list[tuple[int, int, int, int, int, int]]] = [[] for _ in range(n)]
    radj: list[list[tuple[int, int, int, int, int, int]]] = [[] for _ in range(n)]
    for u, v, dt, base, s_start, s_end, s_extra in edges:
        if dt > horizon:
            continue
        ls = s_start - t_start
        le = s_end - t_start
        if ls >= le or s_extra == 0:
            ls, le, s_extra = 0, 0, 0
        adj[u].append((v, dt, base, ls, le, s_extra))
        radj[v].append((u, dt, base, ls, le, s_extra))

    fwd = [[inf] * n for _ in range(horizon + 1)]
    fwd[0][src] = 0

    for t in range(horizon):
        row = fwd[t]
        next_row = fwd[t + 1]
        for u in range(n):
            du = row[u]
            if du == inf:
                continue
            nw = du + wait_costs[u]
            if nw < next_row[u]:
                next_row[u] = nw
            for v, dt, base, ls, le, s_extra in adj[u]:
                ta = t + dt
                if ta <= horizon:
                    c = du + base + (s_extra if ls <= t < le else 0)
                    if c < fwd[ta][v]:
                        fwd[ta][v] = c

    best_cost = inf
    best_t = -1
    for t in range(horizon + 1):
        c = fwd[t][dst]
        if c < best_cost:
            best_cost = c
            best_t = t
    if best_cost == inf:
        return None

    bwd = [[inf] * n for _ in range(best_t + 1)]
    bwd[best_t][dst] = 0
    for t in range(best_t, 0, -1):
        row = bwd[t]
        prev_row = bwd[t - 1]
        for v in range(n):
            dv = row[v]
            if dv == inf:
                continue
            nw = dv + wait_costs[v]
            if nw < prev_row[v]:
                prev_row[v] = nw
            for u, dt, base, ls, le, s_extra in radj[v]:
                td = t - dt
                if td >= 0:
                    c = dv + base + (s_extra if ls <= td < le else 0)
                    if c < bwd[td][u]:
                        bwd[td][u] = c

    path = [src]
    cur_u = src
    active_times = {0}

    while True:
        if cur_u == dst and best_t in active_times:
            return (best_cost, path)

        wc = wait_costs[cur_u]
        t_min = min(active_times)
        closed = set(active_times)
        for t in range(t_min, best_t):
            if t in closed:
                if fwd[t][cur_u] + wc + bwd[t + 1][cur_u] == best_cost:
                    closed.add(t + 1)

        best_v = n
        next_times: set[int] = set()
        for t in closed:
            ft = fwd[t][cur_u]
            for v, dt, base, ls, le, s_extra in adj[cur_u]:
                if v > best_v:
                    continue
                ta = t + dt
                if ta > best_t:
                    continue
                ec = base + (s_extra if ls <= t < le else 0)
                if ft + ec + bwd[ta][v] == best_cost:
                    if v < best_v:
                        best_v = v
                        next_times = {ta}
                    else:
                        next_times.add(ta)

        path.append(best_v)
        cur_u = best_v
        active_times = next_times


def _build_edge_cases() -> list[tuple[str, tuple[Any, ...], tuple[int, list[int]] | None]]:
    cases: list[tuple[str, tuple[Any, ...], tuple[int, list[int]] | None]] = [
        (
            "edge_01_t_start_gt_t_max",
            (2, [(0, 1, 1, 1, 0, 0, 0)], [0, 0], 0, 0, 10, 9),
            None,
        ),
        (
            "edge_02_src_eq_dst",
            (3, [(0, 0, 1, 0, 0, 0, 0), (0, 1, 1, 0, 0, 0, 0)], [0, 0, 0], 0, 0, 2, 10),
            (0, [0]),
        ),
        (
            "edge_03_src_eq_dst_tight_time",
            (1, [], [5], 0, 0, 7, 7),
            (0, [0]),
        ),
        (
            "edge_04_unreachable_disconnected",
            (4, [(0, 1, 1, 1, 0, 0, 0), (2, 3, 1, 1, 0, 0, 0)], [1, 1, 1, 1], 0, 3, 0, 20),
            None,
        ),
        (
            "edge_05_unreachable_time_budget",
            (3, [(0, 1, 3, 1, 0, 0, 0), (1, 2, 3, 1, 0, 0, 0)], [0, 0, 0], 0, 2, 0, 5),
            None,
        ),
        (
            "edge_06_exact_deadline",
            (3, [(0, 1, 3, 4, 0, 0, 0), (1, 2, 3, 5, 0, 0, 0)], [1, 1, 1], 0, 2, 0, 6),
            (9, [0, 1, 2]),
        ),
        (
            "edge_07_wait_out_surge_wins",
            (2, [(0, 1, 2, 10, 0, 3, 50)], [4, 1], 0, 1, 0, 10),
            (22, [0, 1]),
        ),
        (
            "edge_08_depart_during_surge_wins",
            (2, [(0, 1, 2, 10, 0, 3, 10)], [5, 1], 0, 1, 0, 10),
            (20, [0, 1]),
        ),
        (
            "edge_09_surge_boundary_half_open",
            # Surge is [2, 5): t=2,3,4 surged (+100); t=5 NOT surged.
            # Start at t=2: waiting 3 steps to t=5 costs 3*2=6, then base 10 => 16.
            (2, [(0, 1, 1, 10, 2, 5, 100)], [2, 0], 0, 1, 2, 6),
            (16, [0, 1]),
        ),
        (
            "edge_10_surge_boundary_just_before_start",
            # Surge is [3, 6): departing at t=2 is NOT surged (cost 10, arr 3).
            (2, [(0, 1, 1, 10, 3, 6, 100)], [0, 0], 0, 1, 2, 10),
            (10, [0, 1]),
        ),
        (
            "edge_11_empty_and_inverted_surge_windows",
            (
                3,
                [
                    (0, 1, 1, 5, 4, 4, 999),  # empty [4, 4)
                    (1, 2, 1, 7, 10, 2, 999),  # inverted [10, 2)
                ],
                [1, 1, 1],
                0,
                2,
                4,
                10,
            ),
            (12, [0, 1, 2]),
        ),
        (
            "edge_12_parallel_edges_best_choice",
            (
                2,
                [
                    (0, 1, 1, 50, 0, 10, 0),
                    (0, 1, 3, 5, 0, 2, 40),   # wait 2 (cost 4) + 5 = 9, arr t=5
                    (0, 1, 2, 12, 0, 0, 0),   # depart t=0 cost 12, arr t=2
                ],
                [2, 0],
                0,
                1,
                0,
                5,
            ),
            (9, [0, 1]),
        ),
        (
            "edge_13_self_loop_beats_waiting",
            # Wait at 0 costs 100/step. Self-loop (0,0) advances time by 2 for cost 1!
            # Edge (0,1) has surge [0, 2) extra 500. Taking self-loop once -> t=2 -> take (0,1) -> total cost 1 + 5 = 6.
            (
                2,
                [
                    (0, 0, 2, 1, 0, 0, 0),
                    (0, 1, 1, 5, 0, 2, 500),
                ],
                [100, 100],
                0,
                1,
                0,
                5,
            ),
            (6, [0, 0, 1]),
        ),
        (
            "edge_14_waiting_does_not_duplicate_node",
            (2, [(0, 1, 1, 1, 0, 5, 100)], [1, 0], 0, 1, 0, 6),
            (6, [0, 1]),
        ),
        (
            "edge_15_tiebreak_arrival_time_over_lex",
            # Route 0->2->3: cost 10, arr t=2
            # Route 0->1->3: cost 10, arr t=3 (lex smaller, but arrives later!)
            (
                4,
                [
                    (0, 2, 1, 5, 0, 0, 0),
                    (2, 3, 1, 5, 0, 0, 0),
                    (0, 1, 2, 5, 0, 0, 0),
                    (1, 3, 1, 5, 0, 0, 0),
                ],
                [10, 10, 10, 10],
                0,
                3,
                0,
                5,
            ),
            (10, [0, 2, 3]),
        ),
        (
            "edge_16_tiebreak_lex_path_same_cost_and_time",
            (
                4,
                [
                    (0, 2, 1, 5, 0, 0, 0),
                    (2, 3, 1, 5, 0, 0, 0),
                    (0, 1, 1, 5, 0, 0, 0),
                    (1, 3, 1, 5, 0, 0, 0),
                ],
                [10, 10, 10, 10],
                0,
                3,
                0,
                5,
            ),
            (10, [0, 1, 3]),
        ),
        (
            "edge_17_tiebreak_lex_longer_smaller_vs_shorter_larger",
            # [0, 1, 2, 4] vs [0, 1, 4] both cost 0 and arrive at t=3!
            # [0, 1, 2, 4] < [0, 1, 4] because at index 2, 2 < 4.
            (
                5,
                [
                    (0, 1, 1, 0, 0, 0, 0),
                    (1, 4, 2, 0, 0, 0, 0),
                    (1, 2, 1, 0, 0, 0, 0),
                    (2, 4, 1, 0, 0, 0, 0),
                ],
                [5, 5, 5, 5, 5],
                0,
                4,
                0,
                5,
            ),
            (0, [0, 1, 2, 4]),
        ),
        (
            "edge_18_tiebreak_zero_cost_cycle_prefix_trap",
            # Classic forward-DP prefix trap:
            # At (2, t=3): path [0, 2] (via waiting) vs [0, 2, 1, 2] (via cycle 2->1->2).
            # At node 2: [0, 2] < [0, 2, 1, 2], BUT after appending 5:
            # [0, 2, 1, 2, 5] < [0, 2, 5]!
            (
                6,
                [
                    (0, 2, 1, 0, 0, 0, 0),
                    (2, 1, 1, 0, 0, 0, 0),
                    (1, 2, 1, 0, 0, 0, 0),
                    (2, 5, 1, 0, 0, 3, 100),
                ],
                [10, 10, 0, 10, 10, 10],
                0,
                5,
                0,
                4,
            ),
            (0, [0, 2, 1, 2, 5]),
        ),
        (
            "edge_19_large_shifted_t_start",
            (
                3,
                [
                    (0, 1, 2, 5, 100_000, 100_004, 80),
                    (1, 2, 3, 7, 100_006, 100_008, 50),
                ],
                [2, 1, 0],
                0,
                2,
                100_000,
                100_020,
            ),
            # Wait 4 at node 0 (cost 8) -> depart t=100004 -> arrive node 1 at t=100006 (cost 5, total 13)
            # Wait 2 at node 1 (cost 2) -> depart t=100008 -> arrive node 2 at t=100011 (cost 7, total 22)
            (22, [0, 1, 2]),
        ),
        (
            "edge_20_wait_at_intermediate_node",
            # Expensive wait at node 0 (50), cheap wait at node 1 (1).
            (
                3,
                [
                    (0, 1, 1, 2, 0, 0, 0),
                    (1, 2, 1, 3, 0, 4, 40),
                ],
                [50, 1, 50],
                0,
                2,
                0,
                6,
            ),
            # 0->1 at t=0 (cost 2, arr t=1); wait 3 units at 1 (cost 3, t=4); 1->2 at t=4 (cost 3) => total 8.
            (8, [0, 1, 2]),
        ),
        (
            "edge_21_wait_would_miss_deadline",
            # Surge [0, 4) extra 50, wait cost 1, travel_time 2, t_max 5.
            # Waiting until t=4 means arrival at t=6 > 5 (infeasible!). Must pay surge at t=0 -> cost 60.
            (2, [(0, 1, 2, 10, 0, 4, 50)], [1, 1], 0, 1, 0, 5),
            (60, [0, 1]),
        ),
        (
            "edge_22_multi_hop_coupled_surges",
            # If we wait at node 0 to avoid surge [0, 2) (+20), we arrive at node 1 at t=3, hitting surge [3, 6) (+100)!
            # Or wait until t=5 at node 0? Wait costs: [3, 2, 0].
            (
                3,
                [
                    (0, 1, 1, 5, 0, 2, 20),
                    (1, 2, 1, 5, 3, 6, 100),
                ],
                [3, 2, 0],
                0,
                2,
                0,
                10,
            ),
            # Option A: depart 0 at t=0 (cost 25, arr 1 at t=1) -> depart 1 at t=1 (cost 5, arr 2 at t=2) => 30.
            # Option B: wait 2 at 0 (cost 6), depart t=2 (cost 5, arr 1 at t=3), wait 3 at 1 (cost 6), depart t=6 (cost 5) => 22!
            (22, [0, 1, 2]),
        ),
        (
            "edge_23_all_zero_costs",
            (
                4,
                [
                    (0, 2, 1, 0, 0, 0, 0),
                    (0, 1, 1, 0, 0, 0, 0),
                    (1, 3, 1, 0, 0, 0, 0),
                    (2, 3, 1, 0, 0, 0, 0),
                ],
                [0, 0, 0, 0],
                0,
                3,
                0,
                5,
            ),
            (0, [0, 1, 3]),
        ),
    ]
    return cases


def _build_random_cases(count: int = 50, seed: int = 20260301) -> list[tuple[Any, ...]]:
    rng = random.Random(seed)
    cases: list[tuple[Any, ...]] = []
    for idx in range(count):
        n = rng.randint(2, 8)
        m = rng.randint(n, min(28, n * 4))
        t_start = rng.choice([0, 0, 5, 1000])
        horizon = rng.randint(4, 14)
        t_max = t_start + horizon
        wait_costs = [rng.choice([0, 0, 1, 2, 3, 5, 10]) for _ in range(n)]
        edges: list[tuple[int, int, int, int, int, int, int]] = []
        for _ in range(m):
            u = rng.randrange(n)
            v = rng.randrange(n)  # allows self-loops and parallel edges
            dt = rng.randint(1, max(1, horizon // 2))
            base = rng.choice([0, 0, 1, 2, 4, 8])
            s_start = t_start + rng.randint(-1, horizon + 1)
            s_end = s_start + rng.randint(-2, max(2, horizon // 2))
            s_extra = rng.choice([0, 1, 3, 8, 25])
            edges.append((u, v, dt, base, s_start, s_end, s_extra))
        src = rng.randrange(n)
        dst = rng.randrange(n)
        cases.append((n, edges, wait_costs, src, dst, t_start, t_max))
    return cases


def _build_stress_case(seed: int = 20260399) -> tuple[Any, ...]:
    rng = random.Random(seed)
    n = 200
    m = 1200
    t_start = 0
    t_max = 300
    wait_costs = [rng.randint(0, 12) for _ in range(n)]
    edges: list[tuple[int, int, int, int, int, int, int]] = []

    # Guaranteed multi-hop backbone so dst is reachable with interesting surge tradeoffs
    for i in range(0, n - 1):
        dt = rng.randint(1, 2)
        base = rng.randint(3, 15)
        s_start = rng.randint(0, t_max - 20)
        s_end = s_start + rng.randint(5, 25)
        s_extra = rng.randint(10, 80)
        edges.append((i, i + 1, dt, base, s_start, s_end, s_extra))

    while len(edges) < m:
        u = rng.randrange(n)
        # Locality-banded directed graph so optimal routes require ~20-40 hops
        if rng.random() < 0.8 and u < n - 1:
            v = min(n - 1, u + rng.randint(1, 10))
        else:
            v = max(0, min(n - 1, u + rng.randint(-6, 6)))
        dt = rng.randint(1, 6)
        base = rng.randint(2, 30)
        s_start = rng.randint(0, t_max - 10)
        s_end = s_start + rng.randint(5, 35)
        s_extra = rng.randint(10, 120)
        edges.append((u, v, dt, base, s_start, s_end, s_extra))

    return (n, edges, wait_costs, 0, n - 1, t_start, t_max)


def _validate_result_type(res: Any) -> str | None:
    if res is None:
        return None
    if not isinstance(res, tuple) or len(res) != 2:
        return f"Expected None or 2-tuple (int, list[int]), got {type(res).__name__}: {res!r}"
    cost, path = res
    if isinstance(cost, bool) or not isinstance(cost, int):
        return f"Expected int cost, got {type(cost).__name__}: {cost!r}"
    if not isinstance(path, list) or not all(
        isinstance(x, int) and not isinstance(x, bool) for x in path
    ):
        return f"Expected list[int] path, got {type(path).__name__}: {path!r}"
    return None


def _load_solution(workspace: Path) -> Any:
    sol_path = workspace / "solution.py"
    if not sol_path.is_file():
        raise FileNotFoundError(f"solution.py not found in {workspace}")
    sys.path.insert(0, str(workspace))
    spec = importlib.util.spec_from_file_location("solution", str(sol_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load spec from {sol_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["solution"] = mod
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(mod)
    if not hasattr(mod, "min_temporal_route_cost"):
        raise AttributeError("min_temporal_route_cost not found in solution.py")
    return mod.min_temporal_route_cost


def _run_functional_worker(workspace: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    try:
        fn = _load_solution(workspace)
    except Exception as exc:
        return {"checks": [], "error": f"Import error: {type(exc).__name__}: {exc}"}

    # Hand-crafted edge cases
    for name, args, expected in _build_edge_cases():
        # Verify our expected matches oracle!
        oracle_ans = _oracle_backward_dp(*args)
        assert oracle_ans == expected, f"Internal oracle mismatch on {name}: {oracle_ans} != {expected}"
        n, edges, wait_costs, src, dst, t_start, t_max = args
        edges_copy = list(edges)
        wait_copy = list(wait_costs)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                got = fn(n, edges_copy, wait_copy, src, dst, t_start, t_max)
            type_err = _validate_result_type(got)
            if type_err:
                checks.append({"name": name, "passed": False, "group": "fail_to_pass", "detail": type_err})
            elif got != expected:
                checks.append({
                    "name": name,
                    "passed": False,
                    "group": "fail_to_pass",
                    "detail": f"Expected {expected!r}, got {got!r}",
                })
            else:
                checks.append({"name": name, "passed": True, "group": "fail_to_pass", "detail": "ok"})
        except Exception as exc:
            checks.append({
                "name": name,
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            })

    # Check no input mutation
    mut_edges = [(0, 1, 2, 10, 0, 2, 50), (1, 2, 1, 5, 0, 0, 0)]
    mut_waits = [3, 2, 1]
    orig_edges = list(mut_edges)
    orig_waits = list(mut_waits)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            got = fn(3, mut_edges, mut_waits, 0, 2, 0, 8)
        ok = (got == (21, [0, 1, 2])) and (mut_edges == orig_edges) and (mut_waits == orig_waits)
        checks.append({
            "name": "edge_24_no_input_mutation",
            "passed": ok,
            "group": "fail_to_pass",
            "detail": "ok" if ok else f"got={got!r}, edges_mutated={mut_edges != orig_edges}, waits_mutated={mut_waits != orig_waits}",
        })
    except Exception as exc:
        checks.append({
            "name": "edge_24_no_input_mutation",
            "passed": False,
            "group": "fail_to_pass",
            "detail": f"{type(exc).__name__}: {exc}",
        })

    # Randomized differential testing (50 cases grouped into 5 batches of 10)
    rand_cases = _build_random_cases(count=50, seed=20260301)
    for batch_idx in range(5):
        batch_start = batch_idx * 10
        batch = rand_cases[batch_start : batch_start + 10]
        batch_ok = True
        detail = "10/10 matched oracle"
        for offset, args in enumerate(batch):
            expected = _oracle_backward_dp(*args)
            n, edges, wait_costs, src, dst, t_start, t_max = args
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    got = fn(n, list(edges), list(wait_costs), src, dst, t_start, t_max)
                type_err = _validate_result_type(got)
                if type_err:
                    batch_ok = False
                    detail = f"case {batch_start + offset}: {type_err}"
                    break
                if got != expected:
                    batch_ok = False
                    detail = f"case {batch_start + offset}: expected {expected!r}, got {got!r}"
                    break
            except Exception as exc:
                batch_ok = False
                detail = f"case {batch_start + offset}: {type(exc).__name__}: {exc}"
                break
        checks.append({
            "name": f"diff_random_batch_{batch_idx + 1}",
            "passed": batch_ok,
            "group": "fail_to_pass",
            "detail": detail,
        })

    return {"checks": checks, "error": None}


def _run_stress_worker(workspace: Path) -> dict[str, Any]:
    try:
        fn = _load_solution(workspace)
    except Exception as exc:
        return {
            "checks": [{
                "name": "perf_stress_n200_m1200_t300",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"Import error: {type(exc).__name__}: {exc}",
            }],
            "error": None,
        }

    args = _build_stress_case(seed=20260399)
    expected = _solve_fast_exact(*args)
    n, edges, wait_costs, src, dst, t_start, t_max = args
    edges_copy = list(edges)
    wait_copy = list(wait_costs)

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            t0 = time.perf_counter()
            got = fn(n, edges_copy, wait_copy, src, dst, t_start, t_max)
            elapsed = time.perf_counter() - t0
    except Exception as exc:
        return {
            "checks": [{
                "name": "perf_stress_n200_m1200_t300",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            }],
            "error": None,
        }

    type_err = _validate_result_type(got)
    if type_err:
        ok = False
        detail = f"{type_err} (elapsed={elapsed:.3f}s)"
    elif got != expected:
        ok = False
        detail = f"Output mismatch: expected cost={expected[0] if expected else None} path_len={len(expected[1]) if expected else 0}, got={got!r} (elapsed={elapsed:.3f}s)"
    elif elapsed >= STRESS_TIME_LIMIT_S:
        ok = False
        detail = f"Correct answer but too slow: {elapsed:.3f}s >= {STRESS_TIME_LIMIT_S:.1f}s limit"
    else:
        ok = True
        detail = f"ok (cost={got[0]}, hops={len(got[1]) - 1}, elapsed={elapsed:.3f}s < {STRESS_TIME_LIMIT_S:.1f}s)"

    return {
        "checks": [{
            "name": "perf_stress_n200_m1200_t300",
            "passed": ok,
            "group": "fail_to_pass",
            "detail": detail,
        }],
        "error": None,
    }


def _invoke_worker(mode: str, workspace: Path, timeout_s: float) -> dict[str, Any]:
    cmd = [sys.executable, str(Path(__file__).resolve()), "--workspace", str(workspace), "--_worker", mode]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    except subprocess.TimeoutExpired:
        return {
            "checks": [{
                "name": f"{mode}_timeout",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"Timed out after {timeout_s:.1f}s",
            }],
            "error": f"Worker '{mode}' timed out after {timeout_s:.1f}s",
        }
    if proc.returncode != 0:
        err_msg = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
        return {"checks": [], "error": f"Worker '{mode}' failed: {err_msg[-500:]}"}
    try:
        return json.loads(proc.stdout)
    except Exception as exc:
        return {"checks": [], "error": f"Invalid worker output for '{mode}': {exc}"}


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to workspace directory")
    parser.add_argument("--_worker", choices=["functional", "stress"], default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()

    if args._worker == "functional":
        print(json.dumps(_run_functional_worker(workspace)))
        return 0
    if args._worker == "stress":
        print(json.dumps(_run_stress_worker(workspace)))
        return 0

    checks: list[dict[str, Any]] = []
    errors: list[str] = []

    if not (workspace / "solution.py").is_file():
        result = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 1},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [{
                "name": "solution_exists",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"solution.py not found in {workspace}",
            }],
            "error": f"solution.py not found in {workspace}",
        }
        print(json.dumps(result))
        return 1

    func_res = _invoke_worker("functional", workspace, timeout_s=20.0)
    checks.extend(func_res.get("checks", []))
    if func_res.get("error"):
        errors.append(func_res["error"])

    stress_res = _invoke_worker("stress", workspace, timeout_s=8.0)
    checks.extend(stress_res.get("checks", []))
    if stress_res.get("error"):
        errors.append(stress_res["error"])

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    passed_total = f2p_passed + p2p_passed
    error_str = "; ".join(errors) if errors else None
    passed = (error_str is None) and (total > 0) and (passed_total == total)
    score = round(passed_total / total, 4) if total > 0 else 0.0

    output = {
        "task_id": TASK_ID,
        "passed": passed,
        "score": score,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": error_str,
    }
    print(json.dumps(output))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        fallback = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier crash: {type(exc).__name__}: {exc}\n{traceback.format_exc()[-400:]}",
        }
        print(json.dumps(fallback))
        sys.exit(1)
