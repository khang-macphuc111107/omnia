#!/usr/bin/env python3
"""Verifier for heal_01_broken_py_pkg (Axis 7: Error Recovery & Self-Healing)."""

from __future__ import annotations

import argparse
import calendar as stdlib_calendar
import csv
from datetime import date, timedelta
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib
from typing import Any

TASK_ID = "heal_01_broken_py_pkg"
TOL = 1e-4

EXPECTED_CURVE_KNOTS: list[tuple[float, float]] = [
    (0.25, 0.0480),
    (0.50, 0.0470),
    (1.00, 0.0450),
    (2.00, 0.0425),
    (3.00, 0.0410),
    (5.00, 0.0400),
    (10.00, 0.0420),
]

EXPECTED_SAMPLE_BOND: dict[str, Any] = {
    "bond_id": "UST-2026-550",
    "face_value": 1000.0,
    "coupon_rate": 0.055,
    "day_count": "ACT/ACT",
    "valuation_date": "2024-05-15",
    "accrual_start_date": "2024-02-28",
    "payment_dates": ["2024-08-31", "2025-02-28", "2025-08-31", "2026-02-28"],
}

REF_HOLIDAYS: frozenset[date] = frozenset(
    {
        date(2024, 1, 1), date(2024, 7, 4), date(2024, 9, 2), date(2024, 12, 25),
        date(2025, 1, 1), date(2025, 7, 4), date(2025, 9, 1), date(2025, 12, 25),
        date(2026, 1, 1), date(2026, 7, 3), date(2026, 9, 7), date(2026, 12, 25),
        date(2027, 1, 1), date(2027, 7, 5), date(2027, 9, 6), date(2027, 12, 24),
    }
)


def _ref_adjust_following(d: date) -> date:
    cur = d
    while cur.weekday() >= 5 or cur in REF_HOLIDAYS:
        cur += timedelta(days=1)
    return cur


def _ref_dcf(d1: date, d2: date, conv: str) -> float:
    if d2 == d1:
        return 0.0
    c = conv.strip().upper()
    if c == "ACT/365F":
        return (d2 - d1).days / 365.0
    if c == "ACT/ACT":
        if d1.year == d2.year:
            denom = 366.0 if stdlib_calendar.isleap(d1.year) else 365.0
            return (d2 - d1).days / denom
        y1, y2 = d1.year, d2.year
        p1 = (date(y1 + 1, 1, 1) - d1).days / (366.0 if stdlib_calendar.isleap(y1) else 365.0)
        mid = float(y2 - y1 - 1)
        p2 = (d2 - date(y2, 1, 1)).days / (366.0 if stdlib_calendar.isleap(y2) else 365.0)
        return p1 + mid + p2
    if c == "30/360":
        dd1 = 30 if d1.day == 31 else d1.day
        dd2 = 30 if (d2.day == 31 and dd1 == 30) else d2.day
        return ((d2.year - d1.year) * 360 + (d2.month - d1.month) * 30 + (dd2 - dd1)) / 360.0
    raise ValueError(f"Unknown convention {conv}")


def _ref_zero_rate(knots: list[tuple[float, float]], t: float) -> float:
    sk = sorted(knots, key=lambda x: x[0])
    if t <= sk[0][0]:
        return sk[0][1]
    if t >= sk[-1][0]:
        return sk[-1][1]
    for (t0, r0), (t1, r1) in zip(sk, sk[1:]):
        if t0 <= t <= t1:
            return r0 + (r1 - r0) * (t - t0) / (t1 - t0)
    return sk[-1][1]


def _ref_price_bond(bond_dict: dict[str, Any], knots: list[tuple[float, float]]) -> dict[str, Any]:
    face = float(bond_dict["face_value"])
    cpn = float(bond_dict["coupon_rate"])
    conv = str(bond_dict["day_count"]).strip().upper()
    val_date = date.fromisoformat(bond_dict["valuation_date"])
    acc_start = date.fromisoformat(bond_dict["accrual_start_date"])
    pay_dates = [date.fromisoformat(d) for d in bond_dict["payment_dates"]]

    pv = 0.0
    wt = 0.0
    accrued = 0.0
    cnt = 0
    for idx, sched in enumerate(pay_dates):
        prev = acc_start if idx == 0 else pay_dates[idx - 1]
        alpha = _ref_dcf(prev, sched, conv)
        cf = face * cpn * alpha + (face if idx == len(pay_dates) - 1 else 0.0)
        if prev <= val_date < sched:
            accrued = face * cpn * _ref_dcf(prev, val_date, conv)
        adj = _ref_adjust_following(sched)
        if adj > val_date:
            t = _ref_dcf(val_date, adj, conv)
            df = 1.0 if t == 0.0 else math.exp(-_ref_zero_rate(knots, t) * t)
            cf_pv = cf * df
            pv += cf_pv
            wt += t * cf_pv
            cnt += 1

    return {
        "bond_id": bond_dict["bond_id"],
        "day_count_convention": conv,
        "cashflow_count": cnt,
        "pv": pv,
        "dirty_price": pv,
        "accrued_interest": accrued,
        "clean_price": pv - accrued,
        "macaulay_duration": (wt / pv) if pv > 0.0 else 0.0,
    }


def _run_py(workspace: Path, args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    return subprocess.run(
        [sys.executable, *args],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _compare_valuation(actual: dict[str, Any], expected: dict[str, Any]) -> tuple[bool, str]:
    for key in ("bond_id", "day_count_convention", "cashflow_count"):
        if actual.get(key) != expected[key]:
            return False, f"Field {key!r} mismatch: got {actual.get(key)!r}, expected {expected[key]!r}"
    for key in ("pv", "dirty_price", "accrued_interest", "clean_price", "macaulay_duration"):
        val = actual.get(key)
        if not isinstance(val, (int, float)):
            return False, f"Field {key!r} missing or non-numeric: {val!r}"
        diff = abs(float(val) - float(expected[key]))
        if diff > TOL:
            return False, f"Field {key!r} mismatch: got {val}, expected {expected[key]:.6f} (diff={diff:.6g})"
    return True, "exact match within 1e-4"


def run_checks(workspace: Path) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add(name: str, group: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    # --- pass_to_pass checks ---
    try:
        csv_path = workspace / "data" / "yield_curve.csv"
        bond_path = workspace / "data" / "sample_bond.json"
        if not csv_path.is_file() or not bond_path.is_file():
            add("data_files_intact", "pass_to_pass", False, "Missing data/yield_curve.csv or data/sample_bond.json")
        else:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
                rows = [
                    (float(r["tenor_years"].strip()), float(r["zero_rate"].strip()))
                    for r in csv.DictReader(fh)
                ]
            bond_data = json.loads(bond_path.read_text(encoding="utf-8"))
            curve_ok = len(rows) == len(EXPECTED_CURVE_KNOTS) and all(
                abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9
                for a, b in zip(rows, EXPECTED_CURVE_KNOTS)
            )
            bond_ok = bond_data == EXPECTED_SAMPLE_BOND
            if curve_ok and bond_ok:
                add("data_files_intact", "pass_to_pass", True, "data/yield_curve.csv and data/sample_bond.json intact")
            else:
                add("data_files_intact", "pass_to_pass", False, f"Data modified: curve_ok={curve_ok}, bond_ok={bond_ok}")
    except Exception as exc:
        add("data_files_intact", "pass_to_pass", False, f"Exception checking data files: {exc}")

    try:
        required_files = [
            workspace / "SPEC.md",
            workspace / "tests" / "test_curves.py",
            workspace / "tests" / "test_daycount.py",
            workspace / "tests" / "test_pricing.py",
        ]
        missing = [str(p.relative_to(workspace)) for p in required_files if not p.is_file()]
        if not missing:
            add("spec_and_tests_present", "pass_to_pass", True, "SPEC.md and all 3 test files present")
        else:
            add("spec_and_tests_present", "pass_to_pass", False, f"Missing files: {missing}")
    except Exception as exc:
        add("spec_and_tests_present", "pass_to_pass", False, f"Exception: {exc}")

    # --- fail_to_pass checks ---

    # 1. pyproject.toml valid TOML
    try:
        pyproject_path = workspace / "pyproject.toml"
        with pyproject_path.open("rb") as fh:
            parsed = tomllib.load(fh)
        has_sections = "project" in parsed and "quantlib_mini" in parsed.get("tool", {})
        if has_sections:
            add("pyproject_valid_toml", "fail_to_pass", True, "pyproject.toml parsed cleanly with tomllib")
        else:
            add("pyproject_valid_toml", "fail_to_pass", False, "Missing [project] or [tool.quantlib_mini]")
    except Exception as exc:
        add("pyproject_valid_toml", "fail_to_pass", False, f"TOML parse error: {exc}")

    # 2. No stdlib shadowing from workspace cwd
    try:
        probe = (
            "import calendar, statistics, json, pathlib; "
            "print(json.dumps({"
            "'cal_file': str(pathlib.Path(calendar.__file__).resolve()), "
            "'stat_file': str(pathlib.Path(statistics.__file__).resolve()), "
            "'isleap_2024': bool(calendar.isleap(2024)), "
            "'fmean': float(statistics.fmean([1.0, 2.0, 3.0]))"
            "}))"
        )
        res = _run_py(workspace, ["-c", probe])
        if res.returncode != 0:
            add("no_stdlib_shadowing", "fail_to_pass", False, f"Stdlib probe failed: {res.stderr.strip()}")
        else:
            info = json.loads(res.stdout.strip())
            ws_res = str(workspace.resolve()).lower()
            cal_in_ws = info["cal_file"].lower().startswith(ws_res)
            stat_in_ws = info["stat_file"].lower().startswith(ws_res)
            ok = (not cal_in_ws) and (not stat_in_ws) and info["isleap_2024"] is True and abs(info["fmean"] - 2.0) < 1e-9
            add(
                "no_stdlib_shadowing",
                "fail_to_pass",
                ok,
                f"calendar={info['cal_file']}, statistics={info['stat_file']}",
            )
    except Exception as exc:
        add("no_stdlib_shadowing", "fail_to_pass", False, f"Exception: {exc}")

    # 3. Clean imports in any order (no circular import)
    try:
        orders = [
            "import quantlib_mini; import quantlib_mini.pricing; import quantlib_mini.curves; import quantlib_mini.daycount",
            "import quantlib_mini.curves; import quantlib_mini.pricing",
            "import quantlib_mini.pricing; import quantlib_mini.curves",
        ]
        failures = []
        for stmt in orders:
            r = _run_py(workspace, ["-c", stmt])
            if r.returncode != 0:
                failures.append(f"{stmt} -> {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'rc=' + str(r.returncode)}")
        if not failures:
            add("package_import_no_circular", "fail_to_pass", True, "All import orderings succeeded cleanly")
        else:
            add("package_import_no_circular", "fail_to_pass", False, "; ".join(failures))
    except Exception as exc:
        add("package_import_no_circular", "fail_to_pass", False, f"Exception: {exc}")

    # 4. unittest discover passes and runs >= 10 tests
    try:
        res = _run_py(workspace, ["-m", "unittest", "discover", "-s", "tests", "-v"])
        combined = res.stdout + "\n" + res.stderr
        m = re.search(r"Ran\s+(\d+)\s+test", combined)
        ran_count = int(m.group(1)) if m else 0
        ok = res.returncode == 0 and ran_count >= 10
        tail = " | ".join(line.strip() for line in combined.strip().splitlines()[-4:])
        add(
            "unittest_discover_passes",
            "fail_to_pass",
            ok,
            f"rc={res.returncode}, ran={ran_count}; {tail}",
        )
    except Exception as exc:
        add("unittest_discover_passes", "fail_to_pass", False, f"Exception: {exc}")

    # 5. CLI on data/yield_curve.csv + data/sample_bond.json
    try:
        res = _run_py(
            workspace,
            ["-m", "quantlib_mini.cli", "--curve", "data/yield_curve.csv", "--bond", "data/sample_bond.json"],
        )
        if res.returncode != 0:
            add("cli_sample_bond_exact", "fail_to_pass", False, f"CLI rc={res.returncode}: {res.stderr.strip()}")
        else:
            actual = json.loads(res.stdout)
            expected = _ref_price_bond(EXPECTED_SAMPLE_BOND, EXPECTED_CURVE_KNOTS)
            ok, msg = _compare_valuation(actual, expected)
            add("cli_sample_bond_exact", "fail_to_pass", ok, msg)
    except Exception as exc:
        add("cli_sample_bond_exact", "fail_to_pass", False, f"Exception: {exc}")

    # 6. Hidden UTF-8 BOM + CRLF yield curve in temp directory
    try:
        hidden_knots = [
            (0.25, 0.0525),
            (0.50, 0.0510),
            (1.00, 0.0490),
            (2.00, 0.0460),
            (5.00, 0.0435),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_csv = Path(tmpdir) / "hidden_bom_crlf_curve.csv"
            lines = ["tenor_years,zero_rate"] + [f"{t:.2f},{r:.4f}" for t, r in hidden_knots]
            raw_bytes = b"\xef\xbb\xbf" + ("\r\n".join(lines) + "\r\n").encode("utf-8")
            tmp_csv.write_bytes(raw_bytes)

            res = _run_py(
                workspace,
                ["-m", "quantlib_mini.cli", "--curve", str(tmp_csv), "--bond", "data/sample_bond.json"],
            )
            if res.returncode != 0:
                add("hidden_bom_crlf_curve", "fail_to_pass", False, f"CLI rc={res.returncode}: {res.stderr.strip()}")
            else:
                actual = json.loads(res.stdout)
                expected = _ref_price_bond(EXPECTED_SAMPLE_BOND, hidden_knots)
                ok, msg = _compare_valuation(actual, expected)
                add("hidden_bom_crlf_curve", "fail_to_pass", ok, msg)
    except Exception as exc:
        add("hidden_bom_crlf_curve", "fail_to_pass", False, f"Exception: {exc}")

    # 7. Hidden leap-year boundary bond under ACT/365F, ACT/ACT, 30/360
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            conv_errors: list[str] = []
            for conv in ("ACT/365F", "ACT/ACT", "30/360"):
                bond_obj = {
                    "bond_id": f"HIDDEN-LEAP-{conv.replace('/', '_')}",
                    "face_value": 1000.0,
                    "coupon_rate": 0.06,
                    "day_count": conv,
                    "valuation_date": "2024-05-31",
                    "accrual_start_date": "2024-02-28",
                    "payment_dates": ["2024-08-31", "2025-02-28"],
                }
                bond_file = Path(tmpdir) / f"bond_{conv.replace('/', '_')}.json"
                bond_file.write_text(json.dumps(bond_obj), encoding="utf-8")
                res = _run_py(
                    workspace,
                    ["-m", "quantlib_mini.cli", "--curve", "data/yield_curve.csv", "--bond", str(bond_file)],
                )
                if res.returncode != 0:
                    conv_errors.append(f"{conv}: rc={res.returncode} {res.stderr.strip()}")
                    continue
                actual = json.loads(res.stdout)
                expected = _ref_price_bond(bond_obj, EXPECTED_CURVE_KNOTS)
                ok, msg = _compare_valuation(actual, expected)
                if not ok:
                    conv_errors.append(f"{conv}: {msg}")
            if not conv_errors:
                add("hidden_leap_year_all_conventions", "fail_to_pass", True, "ACT/365F, ACT/ACT, and 30/360 all exact")
            else:
                add("hidden_leap_year_all_conventions", "fail_to_pass", False, "; ".join(conv_errors))
    except Exception as exc:
        add("hidden_leap_year_all_conventions", "fail_to_pass", False, f"Exception: {exc}")

    # 8. Hidden day-count edge-case matrix
    try:
        matrix_code = r"""
import json
from datetime import date
from quantlib_mini.daycount import day_count_fraction

cases = [
    ("act365f_leap_full", date(2024, 1, 1), date(2025, 1, 1), "ACT/365F", 366.0 / 365.0),
    ("act365f_leap_feb29", date(2024, 2, 28), date(2024, 8, 31), "ACT/365F", 185.0 / 365.0),
    ("actact_cross_leap", date(2024, 7, 1), date(2025, 7, 1), "ACT/ACT", 184.0 / 366.0 + 181.0 / 365.0),
    ("actact_multi_year", date(2023, 7, 1), date(2025, 7, 1), "ACT/ACT", 184.0 / 365.0 + 1.0 + 181.0 / 365.0),
    ("t360_31_31", date(2024, 3, 31), date(2024, 8, 31), "30/360", 150.0 / 360.0),
    ("t360_31_28", date(2024, 8, 31), date(2025, 2, 28), "30/360", 178.0 / 360.0),
    ("t360_30_31", date(2024, 8, 30), date(2025, 1, 31), "30/360", 150.0 / 360.0),
    ("t360_28_31", date(2024, 2, 28), date(2024, 8, 31), "30/360", 183.0 / 360.0),
    ("same_day", date(2024, 2, 29), date(2024, 2, 29), "ACT/ACT", 0.0),
]
errs = []
for name, d1, d2, conv, exp in cases:
    got = day_count_fraction(d1, d2, conv)
    if abs(got - exp) > 1e-8:
        errs.append(f"{name}: got={got:.10f}, exp={exp:.10f}")
print(json.dumps({"ok": len(errs) == 0, "errors": errs}))
"""
        res = _run_py(workspace, ["-c", matrix_code])
        if res.returncode != 0:
            add("hidden_daycount_unit_matrix", "fail_to_pass", False, f"rc={res.returncode}: {res.stderr.strip()}")
        else:
            out = json.loads(res.stdout.strip())
            add(
                "hidden_daycount_unit_matrix",
                "fail_to_pass",
                out["ok"],
                "all 9 day-count edge cases passed" if out["ok"] else "; ".join(out["errors"]),
            )
    except Exception as exc:
        add("hidden_daycount_unit_matrix", "fail_to_pass", False, f"Exception: {exc}")

    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to task workspace directory")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    error: str | None = None
    checks: list[dict[str, Any]] = []

    try:
        if not workspace.is_dir():
            raise FileNotFoundError(f"Workspace directory not found: {workspace}")
        checks = run_checks(workspace)
    except Exception as exc:
        error = str(exc)

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    passed_total = sum(1 for c in checks if c["passed"])
    all_passed = error is None and total > 0 and passed_total == total
    score = round(passed_total / total, 4) if total > 0 and error is None else 0.0

    result = {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": 1.0 if all_passed else score,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": error,
    }
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
