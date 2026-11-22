"""Basic sanity tests for min_temporal_route_cost."""

from solution import min_temporal_route_cost


def test_wait_out_surge() -> None:
    # Edge 0->1 has surge during [0, 2) with extra cost 50.
    # Waiting 2 units at node 0 costs 2 * 3 = 6, then departing at t=2 costs 10 -> total 16.
    # Departing immediately at t=0 costs 10 + 50 = 60.
    edges = [(0, 1, 2, 10, 0, 2, 50)]
    wait_costs = [3, 5]
    res = min_temporal_route_cost(2, edges, wait_costs, 0, 1, 0, 5)
    assert res == (16, [0, 1]), f"Expected (16, [0, 1]), got {res}"


def test_src_equals_dst() -> None:
    res = min_temporal_route_cost(3, [(0, 1, 1, 0, 0, 0, 0)], [0, 0, 0], 1, 1, 5, 10)
    assert res == (0, [1]), f"Expected (0, [1]), got {res}"


def test_unreachable() -> None:
    edges = [(0, 1, 4, 1, 0, 0, 0)]
    res = min_temporal_route_cost(2, edges, [1, 1], 0, 1, 0, 3)
    assert res is None, f"Expected None, got {res}"


if __name__ == "__main__":
    test_wait_out_surge()
    test_src_equals_dst()
    test_unreachable()
    print("All sample tests passed!")
