#!/usr/bin/env python3
"""Hidden verification script for swe_01_py_ledger."""

from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, ROUND_HALF_EVEN
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback


TASK_ID = "swe_01_py_ledger"


def run_checks(workspace: Path) -> dict:
    checks: list[dict] = []

    def record(name: str, group: str, fn) -> None:
        try:
            fn()
            checks.append({"name": name, "passed": True, "group": group, "detail": "ok"})
        except Exception as exc:  # noqa: BLE001
            checks.append(
                {
                    "name": name,
                    "passed": False,
                    "group": group,
                    "detail": f"{type(exc).__name__}: {exc}",
                }
            )

    # First run public tests in a clean subprocess
    def p2p_public_unittest() -> None:
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
            cwd=str(workspace),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise AssertionError(
                f"Public tests failed (rc={proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
            )

    record("p2p_public_unittest", "pass_to_pass", p2p_public_unittest)

    # Import workspace ledger cleanly
    sys.path.insert(0, str(workspace))
    for mod_name in list(sys.modules):
        if mod_name == "ledger" or mod_name.startswith("ledger."):
            del sys.modules[mod_name]

    try:
        ledger = importlib.import_module("ledger")
    except Exception as exc:  # noqa: BLE001
        return {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 1},
            "pass_to_pass": {"passed": 0, "total": 1},
            "checks": checks,
            "error": f"Failed to import ledger: {exc}\n{traceback.format_exc()}",
        }

    AccountType = ledger.AccountType
    AlreadyReversedError = ledger.AlreadyReversedError
    FXRateNotFoundError = ledger.FXRateNotFoundError
    FXRateTable = ledger.FXRateTable
    LedgerEngine = ledger.LedgerEngine
    Leg = ledger.Leg
    ReconciliationEngine = ledger.ReconciliationEngine
    quantize_money = ledger.quantize_money

    # --- PASS_TO_PASS checks ---
    def p2p_trial_balance_and_minor_units() -> None:
        assert quantize_money(Decimal("123.456"), "JPY") == Decimal("123")
        assert quantize_money(Decimal("12.3455"), "KWD") == Decimal("12.346")
        assert quantize_money(Decimal("2.505"), "USD") == Decimal("2.50")

        eng = LedgerEngine()
        eng.create_account("a1", "Asset", AccountType.ASSET, "KWD")
        eng.create_account("l1", "Liability", AccountType.LIABILITY, "KWD")
        eng.post_entry(
            "E1",
            date(2026, 1, 5),
            "Loan",
            [
                Leg("a1", "DEBIT", Decimal("100.125"), "KWD"),
                Leg("l1", "CREDIT", Decimal("100.125"), "KWD"),
            ],
        )
        assert eng.get_posted_balance("a1") == Decimal("100.125")
        assert eng.get_posted_balance("l1") == Decimal("100.125")
        assert eng.trial_balance("KWD") == (Decimal("100.125"), Decimal("100.125"))

    def p2p_normal_idempotency_and_reversal() -> None:
        eng = LedgerEngine()
        eng.create_account("c", "Cash", AccountType.ASSET, "USD")
        eng.create_account("r", "Rev", AccountType.REVENUE, "USD")
        e1 = eng.post_entry(
            "E1",
            date(2026, 1, 5),
            "Sale",
            [
                Leg("c", "DEBIT", Decimal("40.00"), "USD"),
                Leg("r", "CREDIT", Decimal("40.00"), "USD"),
            ],
            idempotency_key="sale-1",
        )
        e1_dup = eng.post_entry(
            "E2",
            date(2026, 1, 5),
            "Sale dup",
            [
                Leg("c", "DEBIT", Decimal("40.00"), "USD"),
                Leg("r", "CREDIT", Decimal("40.00"), "USD"),
            ],
            idempotency_key="sale-1",
        )
        assert e1.entry_id == e1_dup.entry_id == "E1"
        assert eng.get_posted_balance("c") == Decimal("40.00")

        r1 = eng.reverse_entry("E1", date(2026, 1, 6), "Refund", idempotency_key="rev-1")
        r2 = eng.reverse_entry("E1", date(2026, 1, 6), "Refund", idempotency_key="rev-1")
        assert r1.entry_id == r2.entry_id
        assert eng.get_posted_balance("c") == Decimal("0.00")

        raised = False
        try:
            eng.reverse_entry("E1", date(2026, 1, 6), "Refund 2", idempotency_key="rev-2")
        except AlreadyReversedError:
            raised = True
        assert raised, "Expected AlreadyReversedError on second reversal key"

    record("p2p_trial_balance_and_minor_units", "pass_to_pass", p2p_trial_balance_and_minor_units)
    record("p2p_normal_idempotency_and_reversal", "pass_to_pass", p2p_normal_idempotency_and_reversal)

    # --- FAIL_TO_PASS checks ---
    def f2p_fx_window_rollover() -> None:
        fx = FXRateTable()
        fx.add_rate("USD", "EUR", Decimal("0.90"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "EUR", Decimal("0.95"), date(2026, 2, 1), date(2026, 3, 1))
        assert fx.get_rate("USD", "EUR", date(2026, 1, 31)) == Decimal("0.90")
        got = fx.get_rate("USD", "EUR", date(2026, 2, 1))
        assert got == Decimal("0.95"), f"Expected 0.95 on rollover boundary, got {got}"
        conv = fx.convert(Decimal("100.00"), "USD", "EUR", date(2026, 2, 1))
        assert conv == Decimal("95.00"), f"Expected 95.00 EUR, got {conv}"

    def f2p_fx_window_expiry_exclusive() -> None:
        fx = FXRateTable()
        fx.add_rate("USD", "GBP", Decimal("0.79"), date(2026, 1, 1), date(2026, 2, 1))
        raised = False
        try:
            fx.get_rate("USD", "GBP", date(2026, 2, 1))
        except FXRateNotFoundError:
            raised = True
        assert raised, "Expected FXRateNotFoundError when as_of == effective_until"

    def f2p_inverse_fx_full_precision() -> None:
        fx = FXRateTable()
        fx.add_rate("USD", "JPY", Decimal("149.25"), date(2026, 1, 1), date(2026, 2, 1))
        rate = fx.get_rate("JPY", "USD", date(2026, 1, 15))
        expected_rate = Decimal("1") / Decimal("149.25")
        assert abs(rate - expected_rate) < Decimal("1e-12"), f"Imprecise inverse rate: {rate}"
        usd = fx.convert(Decimal("1000000"), "JPY", "USD", date(2026, 1, 15))
        assert usd == Decimal("6700.17"), f"Expected 6700.17 USD, got {usd}"

    def f2p_non_usd_triangulation_no_intermediate_quantize() -> None:
        fx = FXRateTable()
        fx.add_rate("EUR", "USD", Decimal("1.0846"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "KWD", Decimal("0.3077"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "JPY", Decimal("155"), date(2026, 1, 1), date(2026, 2, 1))

        # Exact: 0.05 * 1.0846 * 0.3077 = 0.016686571 -> 0.017 KWD
        kwd = fx.convert(Decimal("0.05"), "EUR", "KWD", date(2026, 1, 15))
        assert kwd == Decimal("0.017"), f"Expected 0.017 KWD without intermediate USD rounding, got {kwd}"

        # Exact: 0.04 * 1.0846 * 155 = 6.72452 -> 7 JPY
        jpy = fx.convert(Decimal("0.04"), "EUR", "JPY", date(2026, 1, 15))
        assert jpy == Decimal("7"), f"Expected 7 JPY without intermediate USD rounding, got {jpy}"

    def f2p_split_transfer_largest_remainder_multi_ccy() -> None:
        fx = FXRateTable()
        # Jan rates (must NOT be used on 2026-02-01!)
        fx.add_rate("USD", "EUR", Decimal("0.90"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "GBP", Decimal("0.78"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "JPY", Decimal("145"), date(2026, 1, 1), date(2026, 2, 1))
        fx.add_rate("USD", "KWD", Decimal("0.305"), date(2026, 1, 1), date(2026, 2, 1))
        # Feb rates (active on 2026-02-01)
        fx.add_rate("USD", "EUR", Decimal("0.9231"), date(2026, 2, 1), date(2026, 3, 1))
        fx.add_rate("USD", "GBP", Decimal("0.7915"), date(2026, 2, 1), date(2026, 3, 1))
        fx.add_rate("USD", "JPY", Decimal("152.35"), date(2026, 2, 1), date(2026, 3, 1))
        fx.add_rate("USD", "KWD", Decimal("0.3077"), date(2026, 2, 1), date(2026, 3, 1))

        eng = LedgerEngine(fx_table=fx)
        eng.create_account("src_eur", "EUR Treasury", AccountType.ASSET, "EUR")
        eng.create_account("dst_gbp", "UK Sub", AccountType.ASSET, "GBP")
        eng.create_account("dst_jpy", "JP Sub", AccountType.ASSET, "JPY")
        eng.create_account("dst_kwd", "KW Sub", AccountType.ASSET, "KWD")
        eng.create_account("eq_eur", "EUR Equity", AccountType.EQUITY, "EUR")
        eng.post_entry(
            "INIT",
            date(2026, 2, 1),
            "Seed EUR",
            [
                Leg("src_eur", "DEBIT", Decimal("500.00"), "EUR"),
                Leg("eq_eur", "CREDIT", Decimal("500.00"), "EUR"),
            ],
        )

        # Split 100.00 EUR equally across 3 non-USD accounts (1/3 each)
        w = Decimal("1") / Decimal("3")
        entry = eng.post_split_transfer(
            entry_id="SPLIT1",
            as_of=date(2026, 2, 1),
            description="3-way non-USD treasury sweep",
            source_account_id="src_eur",
            total_source_amount=Decimal("100.00"),
            target_allocations=[("dst_gbp", w), ("dst_jpy", w), ("dst_kwd", w)],
        )

        # Source balance must be exactly 400.00 EUR (100.00 credited, NOT 99.99)
        assert eng.get_posted_balance("src_eur") == Decimal("400.00"), (
            f"Expected src_eur balance 400.00, got {eng.get_posted_balance('src_eur')}"
        )

        # Source shares must follow largest-remainder tie-break (earliest index gets +0.01)
        shares = entry.metadata.get("source_shares")
        assert shares is not None, "Missing source_shares metadata"
        if isinstance(shares, dict):
            share_list = [(k, shares[k]) for k in ("dst_gbp", "dst_jpy", "dst_kwd")]
        else:
            share_list = list(shares)
        expected_shares = [
            ("dst_gbp", Decimal("33.34")),
            ("dst_jpy", Decimal("33.33")),
            ("dst_kwd", Decimal("33.33")),
        ]
        assert share_list == expected_shares, f"Expected shares {expected_shares}, got {share_list}"

        # Verify exact full-precision cross-currency conversions on 2026-02-01
        eur_to_usd = Decimal("1") / Decimal("0.9231")
        exp_gbp = (Decimal("33.34") * eur_to_usd * Decimal("0.7915")).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_EVEN
        )
        exp_jpy = (Decimal("33.33") * eur_to_usd * Decimal("152.35")).quantize(
            Decimal("1"), rounding=ROUND_HALF_EVEN
        )
        exp_kwd = (Decimal("33.33") * eur_to_usd * Decimal("0.3077")).quantize(
            Decimal("0.001"), rounding=ROUND_HALF_EVEN
        )
        assert eng.get_posted_balance("dst_gbp") == exp_gbp, (
            f"Expected dst_gbp {exp_gbp}, got {eng.get_posted_balance('dst_gbp')}"
        )
        assert eng.get_posted_balance("dst_jpy") == exp_jpy, (
            f"Expected dst_jpy {exp_jpy}, got {eng.get_posted_balance('dst_jpy')}"
        )
        assert eng.get_posted_balance("dst_kwd") == exp_kwd, (
            f"Expected dst_kwd {exp_kwd}, got {eng.get_posted_balance('dst_kwd')}"
        )

        # Also test non-equal remainders: 1.00 EUR split [0.124, 0.126, 0.750]
        # Exact: 0.124 (rem 0.004), 0.126 (rem 0.006), 0.750 (rem 0.000) -> 0.12, 0.13, 0.75
        e2 = eng.post_split_transfer(
            entry_id="SPLIT2",
            as_of=date(2026, 2, 1),
            description="Remainder priority check",
            source_account_id="src_eur",
            total_source_amount=Decimal("1.00"),
            target_allocations=[
                ("dst_gbp", Decimal("0.124")),
                ("dst_jpy", Decimal("0.126")),
                ("dst_kwd", Decimal("0.750")),
            ],
        )
        sh2 = e2.metadata["source_shares"]
        sh2_list = [(k, sh2[k]) for k in ("dst_gbp", "dst_jpy", "dst_kwd")] if isinstance(sh2, dict) else list(sh2)
        assert sh2_list == [
            ("dst_gbp", Decimal("0.12")),
            ("dst_jpy", Decimal("0.13")),
            ("dst_kwd", Decimal("0.75")),
        ], f"Largest remainder failed: got {sh2_list}"

    def f2p_reverse_captured_hold_no_restore() -> None:
        eng = LedgerEngine()
        eng.create_account("cash", "Cash", AccountType.ASSET, "USD")
        eng.create_account("rev", "Revenue", AccountType.REVENUE, "USD")
        eng.create_account("merch", "Merchant", AccountType.ASSET, "USD")
        recon = ReconciliationEngine(eng)

        eng.post_entry(
            "FUND",
            date(2026, 1, 10),
            "Deposit",
            [
                Leg("cash", "DEBIT", Decimal("1000.00"), "USD"),
                Leg("rev", "CREDIT", Decimal("1000.00"), "USD"),
            ],
        )
        recon.place_hold("H1", "cash", Decimal("200.00"))
        recon.capture_hold("H1", "CAP1", "merch", date(2026, 1, 11), "Purchase")
        recon.reverse_captured_hold(
            "H1", date(2026, 1, 12), "Chargeback", idempotency_key="cb-1", restore_hold=False
        )
        rep = recon.reconcile_account("cash")
        assert rep.posted_balance == Decimal("1000.00"), f"posted={rep.posted_balance}"
        assert rep.pending_holds_total == Decimal("0.00"), (
            f"Reversed capture without restore must not count as pending hold, got {rep.pending_holds_total}"
        )
        assert rep.available_balance == Decimal("1000.00"), f"avail={rep.available_balance}"
        assert rep.active_hold_count == 0, f"active_hold_count={rep.active_hold_count}"

    def f2p_reverse_captured_hold_idempotent_restore() -> None:
        eng = LedgerEngine()
        eng.create_account("cash", "Cash", AccountType.ASSET, "USD")
        eng.create_account("rev", "Revenue", AccountType.REVENUE, "USD")
        eng.create_account("merch", "Merchant", AccountType.ASSET, "USD")
        recon = ReconciliationEngine(eng)

        eng.post_entry(
            "FUND",
            date(2026, 1, 10),
            "Deposit",
            [
                Leg("cash", "DEBIT", Decimal("1000.00"), "USD"),
                Leg("rev", "CREDIT", Decimal("1000.00"), "USD"),
            ],
        )
        recon.place_hold("H1", "cash", Decimal("250.00"))
        recon.place_hold("H2", "cash", Decimal("50.00"))
        recon.capture_hold("H1", "CAP1", "merch", date(2026, 1, 11), "Purchase")

        # Simulate retry with identical idempotency key 3 times
        r1 = recon.reverse_captured_hold(
            "H1", date(2026, 1, 12), "Re-auth", idempotency_key="idem-rev-1", restore_hold=True
        )
        r2 = recon.reverse_captured_hold(
            "H1", date(2026, 1, 12), "Re-auth", idempotency_key="idem-rev-1", restore_hold=True
        )
        r3 = recon.reverse_captured_hold(
            "H1", date(2026, 1, 12), "Re-auth", idempotency_key="idem-rev-1", restore_hold=True
        )
        assert r1.entry_id == r2.entry_id == r3.entry_id
        assert len(eng.list_entries()) == 3, f"Expected 3 entries (FUND, CAP1, REV), got {len(eng.list_entries())}"

        rep = recon.reconcile_account("cash")
        assert rep.posted_balance == Decimal("1000.00"), f"posted={rep.posted_balance}"
        # Pending holds should be H2 (50) + restored H1 (250) = 300.00 exactly!
        assert rep.pending_holds_total == Decimal("300.00"), (
            f"Double-counted pending holds! Expected 300.00, got {rep.pending_holds_total}"
        )
        assert rep.available_balance == Decimal("700.00"), f"avail={rep.available_balance}"
        assert rep.active_hold_count == 2, f"Expected 2 active holds, got {rep.active_hold_count}"

        # Reversing again with a DIFFERENT idempotency key must raise AlreadyReversedError
        raised = False
        try:
            recon.reverse_captured_hold(
                "H1", date(2026, 1, 12), "Dup", idempotency_key="idem-rev-OTHER", restore_hold=True
            )
        except AlreadyReversedError:
            raised = True
        assert raised, "Expected AlreadyReversedError when reversing captured hold with new key"

    record("f2p_fx_window_rollover", "fail_to_pass", f2p_fx_window_rollover)
    record("f2p_fx_window_expiry_exclusive", "fail_to_pass", f2p_fx_window_expiry_exclusive)
    record("f2p_inverse_fx_full_precision", "fail_to_pass", f2p_inverse_fx_full_precision)
    record(
        "f2p_non_usd_triangulation_no_intermediate_quantize",
        "fail_to_pass",
        f2p_non_usd_triangulation_no_intermediate_quantize,
    )
    record(
        "f2p_split_transfer_largest_remainder_multi_ccy",
        "fail_to_pass",
        f2p_split_transfer_largest_remainder_multi_ccy,
    )
    record("f2p_reverse_captured_hold_no_restore", "fail_to_pass", f2p_reverse_captured_hold_no_restore)
    record(
        "f2p_reverse_captured_hold_idempotent_restore",
        "fail_to_pass",
        f2p_reverse_captured_hold_idempotent_restore,
    )

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    total_passed = f2p_passed + p2p_passed
    passed = total > 0 and total_passed == total

    return {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(total_passed / total, 4) if total else 0.0,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    result = run_checks(Path(args.workspace).resolve())
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
