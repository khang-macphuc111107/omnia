# VersionedSignalBuffer: Persistent Lazy Segment Tree with Branching Snapshots

Implement `VersionedSignalBuffer` in `solution.py` using **Python 3.13 standard library only** (no third-party packages).

## Problem Specification

Design and implement a high-performance, snapshot-restorable data structure `VersionedSignalBuffer` managing a 0-indexed integer array `a[0..n-1]` (`n >= 1`) with arbitrary branching history.

```python
class VersionedSignalBuffer:
    def __init__(self, values: list[int]) -> None: ...
    def range_assign(self, l: int, r: int, val: int) -> None: ...
    def range_negate(self, l: int, r: int) -> None: ...
    def point_add(self, idx: int, delta: int) -> None: ...
    def range_sum(self, l: int, r: int) -> int: ...
    def range_max_subarray(self, l: int, r: int) -> int: ...
    def snapshot(self) -> int: ...
    def restore(self, snap_id: int) -> None: ...
```

### Method Semantics

All range arguments `(l, r)` are **0-indexed and inclusive** (`0 <= l <= r < n`), and `idx` satisfies `0 <= idx < n`.

1. **`__init__(self, values: list[int]) -> None`**:
   - Initializes the buffer from `values` (`len(values) >= 1`).
   - Must not mutate or alias the caller's `values` list (later changes to the caller's list must not affect the buffer).

2. **`range_assign(self, l: int, r: int, val: int) -> None`**:
   - Sets `a[i] = val` for every `i` with `l <= i <= r`.

3. **`range_negate(self, l: int, r: int) -> None`**:
   - Replaces `a[i]` with `-a[i]` for every `i` with `l <= i <= r`.

4. **`point_add(self, idx: int, delta: int) -> None`**:
   - Updates `a[idx] = a[idx] + delta` (where `delta` may be positive, zero, or negative).

5. **`range_sum(self, l: int, r: int) -> int`**:
   - Returns the exact sum `sum(a[l : r + 1])`.

6. **`range_max_subarray(self, l: int, r: int) -> int`**:
   - Returns the maximum sum of any **non-empty** contiguous subarray `a[i..j]` with `l <= i <= j <= r`.
   - **Important**: The subarray MUST be non-empty (`i <= j`). If all elements in `a[l..r]` are negative, this returns `max(a[l..r])` (a negative integer), **not** `0`.

7. **`snapshot(self) -> int`**:
   - Saves an immutable snapshot of the current buffer state and returns a monotonically increasing integer snapshot ID: `0, 1, 2, ...`
   - Does **not** alter the current buffer state.
   - Subsequent mutations to the buffer must **never** alter any previously created snapshot.

8. **`restore(self, snap_id: int) -> None`**:
   - Restores the current buffer state to the exact state captured by snapshot `snap_id`.
   - Must support **arbitrary branching** and **repeated restores**: e.g., taking snapshot `0`, mutating, taking snapshot `1`, restoring `0`, mutating differently, taking snapshot `2`, restoring `1`, and later restoring `0` again must all produce exact results without corrupting any snapshot.
   - Raises `KeyError` if `snap_id` does not correspond to an existing snapshot (e.g., negative IDs or IDs not yet created), leaving the current buffer state unchanged.

### Complexity & Performance Requirements

- Element values and intermediate sums may be large Python integers (e.g., `±10**12` or larger — do not rely on small sentinel constants like `10**9`).
- All operations must run in **$O(\log N)$** worst-case time (`snapshot` and `restore` in **$O(1)$** time) — e.g. via a persistent / copy-on-write lazy segment tree maintaining dual min/max Kadane summaries and non-commuting `(assign, negate)` lazy tags.
- Stress test: `N = 20,000`, `Q = 20,000` mixed updates, queries, and branching snapshots/restores must complete in **`< 3.0` seconds** in pure Python 3.13. (Naive $O(N)$ list copying or linear scans will time out.)

## Local Testing

A small sample test script `test_sample.py` is included in the workspace:

```bash
python test_sample.py
```

Your implementation will be evaluated against a hidden verification suite with 20+ edge cases, 2,000+ randomized differential operations against an exact oracle, and the `N = 20,000, Q = 20,000` performance stress test.
