"""Basic sanity tests for VersionedSignalBuffer."""

from solution import VersionedSignalBuffer


def test_basic_ops_and_branching() -> None:
    buf = VersionedSignalBuffer([2, -5, 4, -1, 3])
    assert buf.range_sum(0, 4) == 3
    assert buf.range_max_subarray(0, 4) == 6  # [4, -1, 3]

    s0 = buf.snapshot()
    assert s0 == 0

    buf.range_negate(0, 4)  # [-2, 5, -4, 1, -3]
    assert buf.range_max_subarray(0, 4) == 5
    s1 = buf.snapshot()
    assert s1 == 1

    buf.restore(s0)
    buf.range_assign(1, 3, -10)  # [2, -10, -10, -10, 3]
    assert buf.range_max_subarray(1, 3) == -10  # non-empty!
    buf.point_add(2, 15)  # [2, -10, 5, -10, 3]
    assert buf.range_max_subarray(1, 3) == 5
    assert buf.range_sum(0, 4) == -10

    buf.restore(s1)
    assert buf.range_sum(0, 4) == -3
    assert buf.range_max_subarray(0, 4) == 5


def test_invalid_snapshot_keyerror() -> None:
    buf = VersionedSignalBuffer([-4, -2])
    try:
        buf.restore(0)
    except KeyError:
        pass
    else:
        raise AssertionError("Expected KeyError for missing snapshot")


if __name__ == "__main__":
    test_basic_ops_and_branching()
    test_invalid_snapshot_keyerror()
    print("All sample tests passed!")
