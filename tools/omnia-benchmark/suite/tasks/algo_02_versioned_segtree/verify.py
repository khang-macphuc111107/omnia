"""Hidden verification suite for algo_02_versioned_segtree."""

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

TASK_ID = "algo_02_versioned_segtree"
STRESS_TIME_LIMIT_S = 3.0


class _NaiveOracle:
    """Exact O(N) reference oracle for small/medium differential tests."""

    def __init__(self, values: list[int]) -> None:
        self.arr = list(values)
        self.snaps: list[list[int]] = []

    def range_assign(self, l: int, r: int, val: int) -> None:
        for i in range(l, r + 1):
            self.arr[i] = val

    def range_negate(self, l: int, r: int) -> None:
        for i in range(l, r + 1):
            self.arr[i] = -self.arr[i]

    def point_add(self, idx: int, delta: int) -> None:
        self.arr[idx] += delta

    def range_sum(self, l: int, r: int) -> int:
        return sum(self.arr[l : r + 1])

    def range_max_subarray(self, l: int, r: int) -> int:
        cur = self.arr[l]
        best = cur
        for i in range(l + 1, r + 1):
            v = self.arr[i]
            cur = v if cur < 0 else cur + v
            if cur > best:
                best = cur
        return best

    def snapshot(self) -> int:
        sid = len(self.snaps)
        self.snaps.append(list(self.arr))
        return sid

    def restore(self, snap_id: int) -> None:
        if not isinstance(snap_id, int) or isinstance(snap_id, bool) or snap_id < 0 or snap_id >= len(self.snaps):
            raise KeyError(snap_id)
        self.arr = list(self.snaps[snap_id])


class _FastPersistentOracle:
    """Exact O(log N) persistent lazy segtree for computing stress ground truth."""

    def __init__(self, values: list[int]) -> None:
        self.n = len(values)
        self.lc: list[int] = []
        self.rc: list[int] = []
        self.tot: list[int] = []
        self.mxp: list[int] = []
        self.mxs: list[int] = []
        self.mxb: list[int] = []
        self.mnp: list[int] = []
        self.mns: list[int] = []
        self.mnb: list[int] = []
        self.asg: list[int | None] = []
        self.neg: list[bool] = []
        self.snaps: list[int] = []
        self.root = self._build(values, 0, self.n - 1)

    def _new_leaf(self, v: int) -> int:
        idx = len(self.tot)
        self.lc.append(-1)
        self.rc.append(-1)
        self.tot.append(v)
        self.mxp.append(v)
        self.mxs.append(v)
        self.mxb.append(v)
        self.mnp.append(v)
        self.mns.append(v)
        self.mnb.append(v)
        self.asg.append(None)
        self.neg.append(False)
        return idx

    def _merge(self, l_id: int, r_id: int) -> int:
        idx = len(self.tot)
        lt = self.tot[l_id]
        rt = self.tot[r_id]
        t = lt + rt

        l_mxp = self.mxp[l_id]
        c_mxp = lt + self.mxp[r_id]
        mxp = l_mxp if l_mxp >= c_mxp else c_mxp

        r_mxs = self.mxs[r_id]
        c_mxs = rt + self.mxs[l_id]
        mxs = r_mxs if r_mxs >= c_mxs else c_mxs

        mxb = self.mxb[l_id]
        r_mxb = self.mxb[r_id]
        if r_mxb > mxb:
            mxb = r_mxb
        cross_mx = self.mxs[l_id] + self.mxp[r_id]
        if cross_mx > mxb:
            mxb = cross_mx

        l_mnp = self.mnp[l_id]
        c_mnp = lt + self.mnp[r_id]
        mnp = l_mnp if l_mnp <= c_mnp else c_mnp

        r_mns = self.mns[r_id]
        c_mns = rt + self.mns[l_id]
        mns = r_mns if r_mns <= c_mns else c_mns

        mnb = self.mnb[l_id]
        r_mnb = self.mnb[r_id]
        if r_mnb < mnb:
            mnb = r_mnb
        cross_mn = self.mns[l_id] + self.mnp[r_id]
        if cross_mn < mnb:
            mnb = cross_mn

        self.lc.append(l_id)
        self.rc.append(r_id)
        self.tot.append(t)
        self.mxp.append(mxp)
        self.mxs.append(mxs)
        self.mxb.append(mxb)
        self.mnp.append(mnp)
        self.mns.append(mns)
        self.mnb.append(mnb)
        self.asg.append(None)
        self.neg.append(False)
        return idx

    def _build(self, values: list[int], nl: int, nr: int) -> int:
        if nl == nr:
            return self._new_leaf(values[nl])
        mid = (nl + nr) >> 1
        l_id = self._build(values, nl, mid)
        r_id = self._build(values, mid + 1, nr)
        return self._merge(l_id, r_id)

    def _clone_assign(self, u: int, val: int, seg_len: int) -> int:
        idx = len(self.tot)
        s = val * seg_len
        if val >= 0:
            mx, mn = s, val
        else:
            mx, mn = val, s
        self.lc.append(self.lc[u])
        self.rc.append(self.rc[u])
        self.tot.append(s)
        self.mxp.append(mx)
        self.mxs.append(mx)
        self.mxb.append(mx)
        self.mnp.append(mn)
        self.mns.append(mn)
        self.mnb.append(mn)
        self.asg.append(None if seg_len == 1 else val)
        self.neg.append(False)
        return idx

    def _clone_negate(self, u: int, seg_len: int) -> int:
        idx = len(self.tot)
        self.lc.append(self.lc[u])
        self.rc.append(self.rc[u])
        self.tot.append(-self.tot[u])
        self.mxp.append(-self.mnp[u])
        self.mxs.append(-self.mns[u])
        self.mxb.append(-self.mnb[u])
        self.mnp.append(-self.mxp[u])
        self.mns.append(-self.mxs[u])
        self.mnb.append(-self.mxb[u])
        if seg_len == 1:
            self.asg.append(None)
            self.neg.append(False)
        else:
            old_asg = self.asg[u]
            if old_asg is not None:
                self.asg.append(-old_asg)
                self.neg.append(False)
            else:
                self.asg.append(None)
                self.neg.append(not self.neg[u])
        return idx

    def _push_children(self, u: int, nl: int, nr: int) -> tuple[int, int]:
        mid = (nl + nr) >> 1
        l_id = self.lc[u]
        r_id = self.rc[u]
        av = self.asg[u]
        if av is not None:
            l_id = self._clone_assign(l_id, av, mid - nl + 1)
            r_id = self._clone_assign(r_id, av, nr - mid)
        elif self.neg[u]:
            l_id = self._clone_negate(l_id, mid - nl + 1)
            r_id = self._clone_negate(r_id, nr - mid)
        return l_id, r_id

    def _upd_assign(self, u: int, nl: int, nr: int, ql: int, qr: int, val: int) -> int:
        if ql <= nl and nr <= qr:
            return self._clone_assign(u, val, nr - nl + 1)
        l_id, r_id = self._push_children(u, nl, nr)
        mid = (nl + nr) >> 1
        if ql <= mid:
            l_id = self._upd_assign(l_id, nl, mid, ql, qr, val)
        if qr > mid:
            r_id = self._upd_assign(r_id, mid + 1, nr, ql, qr, val)
        return self._merge(l_id, r_id)

    def _upd_negate(self, u: int, nl: int, nr: int, ql: int, qr: int) -> int:
        if ql <= nl and nr <= qr:
            return self._clone_negate(u, nr - nl + 1)
        l_id, r_id = self._push_children(u, nl, nr)
        mid = (nl + nr) >> 1
        if ql <= mid:
            l_id = self._upd_negate(l_id, nl, mid, ql, qr)
        if qr > mid:
            r_id = self._upd_negate(r_id, mid + 1, nr, ql, qr)
        return self._merge(l_id, r_id)

    def _upd_point_add(self, u: int, nl: int, nr: int, idx: int, delta: int) -> int:
        if nl == nr:
            return self._new_leaf(self.tot[u] + delta)
        l_id, r_id = self._push_children(u, nl, nr)
        mid = (nl + nr) >> 1
        if idx <= mid:
            l_id = self._upd_point_add(l_id, nl, mid, idx, delta)
        else:
            r_id = self._upd_point_add(r_id, mid + 1, nr, idx, delta)
        return self._merge(l_id, r_id)

    def range_assign(self, l: int, r: int, val: int) -> None:
        self.root = self._upd_assign(self.root, 0, self.n - 1, l, r, val)

    def range_negate(self, l: int, r: int) -> None:
        self.root = self._upd_negate(self.root, 0, self.n - 1, l, r)

    def point_add(self, idx: int, delta: int) -> None:
        self.root = self._upd_point_add(self.root, 0, self.n - 1, idx, delta)

    def _qsum(self, u: int, nl: int, nr: int, ql: int, qr: int, flip: bool) -> int:
        av = self.asg[u]
        if av is not None:
            ov = (nr if nr < qr else qr) - (nl if nl > ql else ql) + 1
            return (-av if flip else av) * ov
        if ql <= nl and nr <= qr:
            return -self.tot[u] if flip else self.tot[u]
        mid = (nl + nr) >> 1
        nflip = (not flip) if self.neg[u] else flip
        res = 0
        if ql <= mid:
            res += self._qsum(self.lc[u], nl, mid, ql, qr, nflip)
        if qr > mid:
            res += self._qsum(self.rc[u], mid + 1, nr, ql, qr, nflip)
        return res

    def range_sum(self, l: int, r: int) -> int:
        return self._qsum(self.root, 0, self.n - 1, l, r, False)

    def _qmax(self, u: int, nl: int, nr: int, ql: int, qr: int, flip: bool) -> tuple[int, int, int, int]:
        av = self.asg[u]
        if av is not None:
            v = -av if flip else av
            ov = (nr if nr < qr else qr) - (nl if nl > ql else ql) + 1
            s = v * ov
            if v >= 0:
                return (s, s, s, s)
            return (s, v, v, v)
        if ql <= nl and nr <= qr:
            if flip:
                return (-self.tot[u], -self.mnp[u], -self.mns[u], -self.mnb[u])
            return (self.tot[u], self.mxp[u], self.mxs[u], self.mxb[u])
        mid = (nl + nr) >> 1
        nflip = (not flip) if self.neg[u] else flip
        if qr <= mid:
            return self._qmax(self.lc[u], nl, mid, ql, qr, nflip)
        if ql > mid:
            return self._qmax(self.rc[u], mid + 1, nr, ql, qr, nflip)
        lt, lp, ls, lb = self._qmax(self.lc[u], nl, mid, ql, qr, nflip)
        rt, rp, rs, rb = self._qmax(self.rc[u], mid + 1, nr, ql, qr, nflip)
        p = lp if lp >= lt + rp else lt + rp
        s = rs if rs >= rt + ls else rt + ls
        b = lb if lb >= rb else rb
        cr = ls + rp
        if cr > b:
            b = cr
        return (lt + rt, p, s, b)

    def range_max_subarray(self, l: int, r: int) -> int:
        return self._qmax(self.root, 0, self.n - 1, l, r, False)[3]

    def snapshot(self) -> int:
        sid = len(self.snaps)
        self.snaps.append(self.root)
        return sid

    def restore(self, snap_id: int) -> None:
        if not isinstance(snap_id, int) or isinstance(snap_id, bool) or snap_id < 0 or snap_id >= len(self.snaps):
            raise KeyError(snap_id)
        self.root = self.snaps[snap_id]


def _load_class(workspace: Path) -> Any:
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
    if not hasattr(mod, "VersionedSignalBuffer"):
        raise AttributeError("VersionedSignalBuffer not found in solution.py")
    return mod.VersionedSignalBuffer


def _assert_int(val: Any, label: str) -> None:
    if isinstance(val, bool) or not isinstance(val, int):
        raise AssertionError(f"{label}: expected int, got {type(val).__name__} ({val!r})")


def _run_edge_cases(cls: Any) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add_check(name: str, fn: Any) -> None:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                fn()
            checks.append({"name": name, "passed": True, "group": "fail_to_pass", "detail": "ok"})
        except Exception as exc:
            checks.append({
                "name": name,
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            })

    def t01() -> None:
        b = cls([7])
        assert b.range_sum(0, 0) == 7
        assert b.range_max_subarray(0, 0) == 7
        b.range_negate(0, 0)
        assert b.range_sum(0, 0) == -7
        assert b.range_max_subarray(0, 0) == -7
        b.point_add(0, 2)
        assert b.range_sum(0, 0) == -5
        b.range_assign(0, 0, 10)
        assert b.range_max_subarray(0, 0) == 10

    def t02() -> None:
        b = cls([-10, -3, -7, -2, -9])
        assert b.range_max_subarray(0, 4) == -2
        assert b.range_max_subarray(0, 2) == -3
        assert b.range_max_subarray(4, 4) == -9
        assert b.range_sum(0, 4) == -31

    def t03() -> None:
        b = cls([0, 0, 0, 0])
        assert b.range_sum(0, 3) == 0
        assert b.range_max_subarray(0, 3) == 0
        b.range_negate(0, 3)
        assert b.range_sum(0, 3) == 0
        assert b.range_max_subarray(1, 2) == 0

    def t04() -> None:
        arr = [4, -1, 2, -5, 3, 4, -2, 5]
        b = cls(arr)
        o = _NaiveOracle(arr)
        for l in range(len(arr)):
            for r in range(l, len(arr)):
                assert b.range_sum(l, r) == o.range_sum(l, r)
                assert b.range_max_subarray(l, r) == o.range_max_subarray(l, r)

    def t05() -> None:
        b = cls([1, 2, 3, 4, 5, 6])
        b.range_assign(1, 4, 5)
        assert b.range_sum(1, 4) == 20
        assert b.range_max_subarray(1, 4) == 20
        b.range_assign(1, 4, -5)
        assert b.range_sum(1, 4) == -20
        assert b.range_max_subarray(1, 4) == -5
        assert b.range_max_subarray(0, 5) == 6

    def t06() -> None:
        b = cls([10, -8, -7, 10])
        assert b.range_max_subarray(0, 3) == 10
        b.range_negate(0, 3)  # [-10, 8, 7, -10]
        assert b.range_max_subarray(0, 3) == 15
        assert b.range_sum(0, 3) == -5

    def t07() -> None:
        arr = [3, -4, 5, -2, -1, 6, -3]
        b = cls(arr)
        b.range_negate(1, 5)
        b.range_negate(1, 5)
        assert b.range_sum(0, 6) == sum(arr)
        assert b.range_max_subarray(0, 6) == _NaiveOracle(arr).range_max_subarray(0, 6)

    def t08() -> None:
        b = cls([5, -2, 3, -4, 6, -1, 2, 8])
        b.range_negate(0, 7)
        b.range_assign(2, 5, 4)  # [-5, 2, 4, 4, 4, 4, -2, -8]
        assert b.range_sum(0, 7) == 3
        assert b.range_max_subarray(0, 7) == 18  # [2, 4, 4, 4, 4]
        assert b.range_max_subarray(2, 5) == 16

    def t09() -> None:
        b = cls([1, 2, 3, 4, 5, 6, 7, 8])
        b.range_assign(0, 7, 6)
        b.range_negate(0, 7)  # all -6
        assert b.range_sum(0, 7) == -48
        assert b.range_max_subarray(0, 7) == -6
        b.range_negate(2, 5)  # [-6, -6, 6, 6, 6, 6, -6, -6]
        assert b.range_sum(0, 7) == 0
        assert b.range_max_subarray(0, 7) == 24
        assert b.range_max_subarray(0, 1) == -6

    def t10() -> None:
        b = cls([0] * 10)
        b.range_assign(0, 9, -5)
        b.point_add(4, 12)  # a[4] = 7
        assert b.range_sum(0, 9) == -38
        assert b.range_max_subarray(0, 9) == 7
        assert b.range_max_subarray(0, 3) == -5
        assert b.range_max_subarray(5, 9) == -5

    def t11() -> None:
        b = cls([3, 4, 5, 6, 7, 8, 9, 10])
        b.range_negate(0, 7)  # [-3..-10]
        b.point_add(3, 20)  # a[3] = -6 + 20 = 14
        assert b.range_sum(3, 3) == 14
        assert b.range_max_subarray(0, 7) == 14
        assert b.range_sum(0, 7) == -52 + 20

    def t12() -> None:
        b = cls([5, 5, 5, 5])
        b.point_add(1, -20)
        assert b.range_sum(0, 3) == 0
        assert b.range_max_subarray(0, 3) == 10  # [5, 5]

    def t13() -> None:
        b = cls([1, 2, 3])
        assert b.snapshot() == 0
        b.point_add(0, 1)
        assert b.snapshot() == 1
        b.restore(0)
        assert b.snapshot() == 2

    def t14() -> None:
        b = cls([1, 2, 3, 4])
        s0 = b.snapshot()
        b.range_assign(0, 3, -99)
        assert b.range_sum(0, 3) == -396
        b.restore(s0)
        assert b.range_sum(0, 3) == 10
        assert b.range_max_subarray(0, 3) == 10

    def t15() -> None:
        b = cls([2, -3, 4, -1, 5])
        s0 = b.snapshot()
        b.range_negate(0, 4)  # [-2, 3, -4, 1, -5]
        s1 = b.snapshot()
        b.restore(s0)
        b.range_assign(1, 3, 10)  # [2, 10, 10, 10, 5]
        s2 = b.snapshot()
        b.restore(s1)
        assert b.range_sum(0, 4) == -7
        assert b.range_max_subarray(0, 4) == 3
        b.restore(s2)
        assert b.range_sum(0, 4) == 37
        assert b.range_max_subarray(0, 4) == 37
        b.restore(s0)
        assert b.range_sum(0, 4) == 7
        assert b.range_max_subarray(0, 4) == 8

    def t16() -> None:
        b = cls([1, -2, 3, -4, 5])
        s0 = b.snapshot()
        for delta in (10, -50, 99):
            b.restore(s0)
            assert b.range_sum(0, 4) == 3
            assert b.range_max_subarray(0, 4) == 5
            b.range_assign(0, 4, delta)
            assert b.range_sum(0, 4) == 5 * delta
        b.restore(s0)
        assert b.range_sum(0, 4) == 3

    def t17() -> None:
        # Critical persistent lazy test: unpushed root lazy tags shared across branches
        b = cls([1, 2, 3, 4, 5, 6, 7, 8])
        b.range_assign(0, 7, 10)
        b.range_negate(0, 7)  # root has pending assign(-10), NOT pushed!
        s0 = b.snapshot()
        # Mutate a subrange -> forces lazy push on branch 1
        b.point_add(3, 50)
        b.range_negate(0, 3)
        s1 = b.snapshot()
        # Restore s0 and push differently on branch 2
        b.restore(s0)
        assert b.range_sum(0, 7) == -80
        assert b.range_max_subarray(0, 7) == -10
        b.range_assign(4, 7, 25)
        assert b.range_sum(0, 7) == 60
        assert b.range_max_subarray(0, 7) == 100
        # Verify s0 AND s1 are completely intact!
        b.restore(s0)
        assert b.range_sum(0, 7) == -80
        assert b.range_max_subarray(0, 7) == -10
        b.restore(s1)
        # s1 was: all -10 -> point_add(3, 50) -> [-10,-10,-10,40,-10,-10,-10,-10]
        # -> range_negate(0,3) -> [10,10,10,-40,-10,-10,-10,-10] => sum=-50, max_sub=30
        assert b.range_sum(0, 7) == -50
        assert b.range_max_subarray(0, 7) == 30

    def t18() -> None:
        b = cls([5, -1, 2])
        for bad in (0, -1, 5):
            try:
                b.restore(bad)
            except KeyError:
                pass
            else:
                raise AssertionError(f"Expected KeyError for restore({bad})")
        s0 = b.snapshot()
        assert s0 == 0
        b.point_add(0, 10)
        for bad in (-1, 1, 999):
            try:
                b.restore(bad)
            except KeyError:
                pass
            else:
                raise AssertionError(f"Expected KeyError for restore({bad})")
        # Buffer must remain intact after failed restore
        assert b.range_sum(0, 2) == 16

    def t19() -> None:
        vals = [1, 2, 3, 4]
        b = cls(vals)
        vals[0] = 99999
        vals.append(12345)
        assert b.range_sum(0, 3) == 10
        assert b.range_max_subarray(0, 3) == 10

    def t20() -> None:
        big = 10**12
        b = cls([-big, -2 * big, -3 * big, -big])
        assert b.range_max_subarray(0, 3) == -big
        assert b.range_sum(0, 3) == -7 * big
        b.range_negate(1, 2)  # [-big, 2*big, 3*big, -big]
        assert b.range_max_subarray(0, 3) == 5 * big
        b.range_assign(0, 3, -5 * big)
        assert b.range_max_subarray(0, 3) == -5 * big
        assert b.range_sum(0, 3) == -20 * big

    def t21() -> None:
        arr = [3, -1, 4, -5, 2, 6, -3, 1, -2, 5]
        b = cls(arr)
        o = _NaiveOracle(arr)
        ops = [
            ("neg", 0, 6),
            ("asg", 2, 9, -4),
            ("neg", 4, 7),
            ("add", 5, 11),
            ("neg", 0, 9),
            ("asg", 1, 3, 7),
            ("add", 2, -20),
            ("neg", 2, 8),
        ]
        for op in ops:
            if op[0] == "neg":
                b.range_negate(op[1], op[2])
                o.range_negate(op[1], op[2])
            elif op[0] == "asg":
                b.range_assign(op[1], op[2], op[3])
                o.range_assign(op[1], op[2], op[3])
            else:
                b.point_add(op[1], op[2])
                o.point_add(op[1], op[2])
            for l, r in [(0, 9), (0, 4), (3, 7), (5, 9), (2, 2)]:
                assert b.range_sum(l, r) == o.range_sum(l, r)
                assert b.range_max_subarray(l, r) == o.range_max_subarray(l, r)

    def t22() -> None:
        for n in (1, 2, 3, 7, 8, 9, 15, 16, 17):
            arr = [((i * 7 + 3) % 13) - 6 for i in range(n)]
            b = cls(arr)
            o = _NaiveOracle(arr)
            assert b.range_sum(0, n - 1) == o.range_sum(0, n - 1)
            assert b.range_max_subarray(0, n - 1) == o.range_max_subarray(0, n - 1)
            b.range_negate(0, n - 1)
            o.range_negate(0, n - 1)
            assert b.range_sum(0, n - 1) == o.range_sum(0, n - 1)
            assert b.range_max_subarray(0, n - 1) == o.range_max_subarray(0, n - 1)

    tests = [
        ("edge_01_single_element", t01),
        ("edge_02_all_negative_max_subarray", t02),
        ("edge_03_all_zeros", t03),
        ("edge_04_kadane_all_subranges", t04),
        ("edge_05_assign_positive_and_negative", t05),
        ("edge_06_negate_flips_min_to_max", t06),
        ("edge_07_double_negate_cancels", t07),
        ("edge_08_assign_overrides_pending_negate", t08),
        ("edge_09_negate_on_pending_assign", t09),
        ("edge_10_point_add_through_pending_assign", t10),
        ("edge_11_point_add_through_pending_negate", t11),
        ("edge_12_point_add_negative_delta", t12),
        ("edge_13_snapshot_monotonic_ids", t13),
        ("edge_14_snapshot_immutability", t14),
        ("edge_15_restore_branching_history", t15),
        ("edge_16_repeated_restore_same_snapshot", t16),
        ("edge_17_snapshot_with_unpushed_lazy_tags", t17),
        ("edge_18_invalid_restore_raises_keyerror", t18),
        ("edge_19_init_no_list_aliasing", t19),
        ("edge_20_large_64bit_values", t20),
        ("edge_21_overlapping_lazy_chain", t21),
        ("edge_22_various_array_lengths", t22),
    ]
    for name, fn in tests:
        add_check(name, fn)
    return checks


def _run_diff_batch(cls: Any, n: int, q: int, seed: int, neg_bias: bool = False) -> tuple[bool, str]:
    rng = random.Random(seed)
    lo, hi = (-50, -1) if neg_bias else (-25, 25)
    init = [rng.randint(lo, hi) for _ in range(n)]
    buf = cls(list(init))
    oracle = _NaiveOracle(init)
    num_snaps = 0

    for step in range(q):
        r_op = rng.random()
        if r_op < 0.16:
            a, b = rng.randrange(n), rng.randrange(n)
            if a > b:
                a, b = b, a
            val = rng.randint(lo, hi)
            buf.range_assign(a, b, val)
            oracle.range_assign(a, b, val)
        elif r_op < 0.34:
            a, b = rng.randrange(n), rng.randrange(n)
            if a > b:
                a, b = b, a
            buf.range_negate(a, b)
            oracle.range_negate(a, b)
        elif r_op < 0.50:
            idx = rng.randrange(n)
            delta = rng.randint(-30, 30)
            buf.point_add(idx, delta)
            oracle.point_add(idx, delta)
        elif r_op < 0.68:
            a, b = rng.randrange(n), rng.randrange(n)
            if a > b:
                a, b = b, a
            got = buf.range_sum(a, b)
            _assert_int(got, "range_sum")
            exp = oracle.range_sum(a, b)
            if got != exp:
                return False, f"step {step} range_sum({a}, {b}): expected {exp}, got {got}"
        elif r_op < 0.86:
            a, b = rng.randrange(n), rng.randrange(n)
            if a > b:
                a, b = b, a
            got = buf.range_max_subarray(a, b)
            _assert_int(got, "range_max_subarray")
            exp = oracle.range_max_subarray(a, b)
            if got != exp:
                return False, f"step {step} range_max_subarray({a}, {b}): expected {exp}, got {got}"
        elif r_op < 0.93 or num_snaps == 0:
            got_sid = buf.snapshot()
            _assert_int(got_sid, "snapshot")
            exp_sid = oracle.snapshot()
            if got_sid != exp_sid:
                return False, f"step {step} snapshot(): expected {exp_sid}, got {got_sid}"
            num_snaps += 1
        else:
            sid = rng.randrange(num_snaps)
            buf.restore(sid)
            oracle.restore(sid)

    return True, f"{q}/{q} ops matched oracle (n={n}, snaps={num_snaps})"


def _build_stress_ops(n: int = 20_000, q: int = 20_000, seed: int = 20260402) -> tuple[list[int], list[tuple[Any, ...]]]:
    rng = random.Random(seed)
    init = [rng.randint(-1000, 1000) for _ in range(n)]
    ops: list[tuple[Any, ...]] = []
    num_snaps = 0

    def rand_wide_range() -> tuple[int, int]:
        if rng.random() < 0.75:
            a = rng.randint(0, n // 5)
            b = rng.randint(4 * n // 5, n - 1)
            return a, b
        a = rng.randrange(n)
        b = rng.randrange(n)
        if a > b:
            a, b = b, a
        return a, b

    for _ in range(q):
        r = rng.random()
        if r < 0.10:
            l, rr = rand_wide_range()
            ops.append(("asg", l, rr, rng.randint(-1000, 1000)))
        elif r < 0.22:
            l, rr = rand_wide_range()
            ops.append(("neg", l, rr))
        elif r < 0.32:
            ops.append(("add", rng.randrange(n), rng.randint(-500, 500)))
        elif r < 0.54:
            l, rr = rand_wide_range()
            ops.append(("sum", l, rr))
        elif r < 0.90:
            l, rr = rand_wide_range()
            ops.append(("max", l, rr))
        elif r < 0.95 or num_snaps == 0:
            ops.append(("snap",))
            num_snaps += 1
        else:
            ops.append(("rest", rng.randrange(num_snaps)))
    return init, ops


def _execute_workload(cls: Any, init: list[int], ops: list[tuple[Any, ...]]) -> list[int]:
    buf = cls(init)
    out: list[int] = []
    for op in ops:
        tag = op[0]
        if tag == "asg":
            buf.range_assign(op[1], op[2], op[3])
        elif tag == "neg":
            buf.range_negate(op[1], op[2])
        elif tag == "add":
            buf.point_add(op[1], op[2])
        elif tag == "sum":
            out.append(buf.range_sum(op[1], op[2]))
        elif tag == "max":
            out.append(buf.range_max_subarray(op[1], op[2]))
        elif tag == "snap":
            out.append(buf.snapshot())
        else:
            buf.restore(op[1])
    return out


def _run_functional_worker(workspace: Path) -> dict[str, Any]:
    try:
        cls = _load_class(workspace)
    except Exception as exc:
        return {"checks": [], "error": f"Import error: {type(exc).__name__}: {exc}"}

    checks = _run_edge_cases(cls)

    batches = [
        ("diff_batch_1_mixed_n30_q400", 30, 400, 101, False),
        ("diff_batch_2_lazy_heavy_n100_q600", 100, 600, 202, False),
        ("diff_batch_3_all_neg_n64_q500", 64, 500, 303, True),
        ("diff_batch_4_single_elem_n1_q200", 1, 200, 404, False),
        ("diff_batch_5_deep_branching_n250_q600", 250, 600, 505, False),
    ]
    for name, n, q, seed, neg_bias in batches:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                ok, detail = _run_diff_batch(cls, n, q, seed, neg_bias=neg_bias)
            checks.append({"name": name, "passed": ok, "group": "fail_to_pass", "detail": detail})
        except Exception as exc:
            checks.append({
                "name": name,
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            })

    return {"checks": checks, "error": None}


def _run_stress_worker(workspace: Path) -> dict[str, Any]:
    try:
        cls = _load_class(workspace)
    except Exception as exc:
        return {
            "checks": [{
                "name": "perf_stress_n20000_q20000",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"Import error: {type(exc).__name__}: {exc}",
            }],
            "error": None,
        }

    init, ops = _build_stress_ops(n=20_000, q=20_000, seed=20260402)
    expected = _execute_workload(_FastPersistentOracle, list(init), ops)

    try:
        init_copy = list(init)
        with contextlib.redirect_stdout(io.StringIO()):
            t0 = time.perf_counter()
            got = _execute_workload(cls, init_copy, ops)
            elapsed = time.perf_counter() - t0
    except Exception as exc:
        return {
            "checks": [{
                "name": "perf_stress_n20000_q20000",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            }],
            "error": None,
        }

    if got != expected:
        mismatch_idx = next((i for i, (a, b) in enumerate(zip(got, expected)) if a != b), len(got))
        exp_v = expected[mismatch_idx] if mismatch_idx < len(expected) else None
        got_v = got[mismatch_idx] if mismatch_idx < len(got) else None
        ok = False
        detail = f"Answer mismatch at query #{mismatch_idx}: expected {exp_v}, got {got_v} (elapsed={elapsed:.3f}s)"
    elif elapsed >= STRESS_TIME_LIMIT_S:
        ok = False
        detail = f"Correct answers ({len(got)} queries) but too slow: {elapsed:.3f}s >= {STRESS_TIME_LIMIT_S:.1f}s limit"
    else:
        ok = True
        detail = f"ok ({len(got)} queries verified, elapsed={elapsed:.3f}s < {STRESS_TIME_LIMIT_S:.1f}s)"

    return {
        "checks": [{
            "name": "perf_stress_n20000_q20000",
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
                "name": "perf_stress_n20000_q20000" if mode == "stress" else f"{mode}_timeout",
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"Timed out after {timeout_s:.1f}s (likely O(N) naive implementation)",
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

    stress_res = _invoke_worker("stress", workspace, timeout_s=10.0)
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
