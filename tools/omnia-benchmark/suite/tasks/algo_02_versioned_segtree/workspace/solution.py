"""VersionedSignalBuffer: Persistent Lazy Segment Tree with Branching Snapshots."""

from __future__ import annotations


class VersionedSignalBuffer:
    """Snapshot-restorable integer signal buffer supporting O(log N) range ops.

    All range indices (l, r) are 0-indexed and inclusive (0 <= l <= r < n).
    """

    def __init__(self, values: list[int]) -> None:
        """Initialize the buffer with a non-empty list of integers."""
        raise NotImplementedError("Implement VersionedSignalBuffer.__init__")

    def range_assign(self, l: int, r: int, val: int) -> None:
        """Set a[i] = val for all l <= i <= r."""
        raise NotImplementedError("Implement VersionedSignalBuffer.range_assign")

    def range_negate(self, l: int, r: int) -> None:
        """Set a[i] = -a[i] for all l <= i <= r."""
        raise NotImplementedError("Implement VersionedSignalBuffer.range_negate")

    def point_add(self, idx: int, delta: int) -> None:
        """Add delta to a[idx]."""
        raise NotImplementedError("Implement VersionedSignalBuffer.point_add")

    def range_sum(self, l: int, r: int) -> int:
        """Return sum(a[l : r + 1])."""
        raise NotImplementedError("Implement VersionedSignalBuffer.range_sum")

    def range_max_subarray(self, l: int, r: int) -> int:
        """Return maximum sum of a non-empty contiguous subarray within a[l..r]."""
        raise NotImplementedError("Implement VersionedSignalBuffer.range_max_subarray")

    def snapshot(self) -> int:
        """Save an immutable snapshot of current state and return its integer ID (0, 1, 2, ...)."""
        raise NotImplementedError("Implement VersionedSignalBuffer.snapshot")

    def restore(self, snap_id: int) -> None:
        """Restore current state to snapshot snap_id; raise KeyError if snap_id does not exist."""
        raise NotImplementedError("Implement VersionedSignalBuffer.restore")
