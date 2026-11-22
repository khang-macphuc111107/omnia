"""Public baseline test suite for ledger package."""

from datetime import date
from decimal import Decimal
import unittest

from ledger import (
    AccountType,
    FXRateTable,
    HoldStatus,
    LedgerEngine,
    Leg,
    ReconciliationEngine,
    UnbalancedEntryError,
)


class TestLedgerBasic(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = FXRateTable()
        self.fx.add_rate("USD", "EUR", Decimal("0.92"), date(2026, 1, 1), date(2026, 2, 1))
        self.fx.add_rate("USD", "JPY", Decimal("150"), date(2026, 1, 1), date(2026, 2, 1))
        self.engine = LedgerEngine(fx_table=self.fx)
        self.engine.create_account("cash_usd", "USD Operating", AccountType.ASSET, "USD")
        self.engine.create_account("rev_usd", "USD Revenue", AccountType.REVENUE, "USD")
        self.engine.create_account("vendor_usd", "Vendor Payable", AccountType.ASSET, "USD")
        self.recon = ReconciliationEngine(self.engine)

    def test_single_currency_posting_and_balance(self) -> None:
        self.engine.post_entry(
            entry_id="E1",
            as_of=date(2026, 1, 15),
            description="Initial funding",
            legs=[
                Leg("cash_usd", "DEBIT", Decimal("1000.00"), "USD"),
                Leg("rev_usd", "CREDIT", Decimal("1000.00"), "USD"),
            ],
        )
        self.assertEqual(self.engine.get_posted_balance("cash_usd"), Decimal("1000.00"))
        self.assertEqual(self.engine.get_posted_balance("rev_usd"), Decimal("1000.00"))

    def test_unbalanced_entry_rejected(self) -> None:
        with self.assertRaises(UnbalancedEntryError):
            self.engine.post_entry(
                entry_id="E_BAD",
                as_of=date(2026, 1, 15),
                description="Broken",
                legs=[
                    Leg("cash_usd", "DEBIT", Decimal("100.00"), "USD"),
                    Leg("rev_usd", "CREDIT", Decimal("99.50"), "USD"),
                ],
            )

    def test_direct_fx_conversion_inside_window(self) -> None:
        eur = self.fx.convert(Decimal("250.00"), "USD", "EUR", date(2026, 1, 15))
        self.assertEqual(eur, Decimal("230.00"))
        jpy = self.fx.convert(Decimal("10.00"), "USD", "JPY", date(2026, 1, 15))
        self.assertEqual(jpy, Decimal("1500"))

    def test_hold_place_release_and_capture(self) -> None:
        self.engine.post_entry(
            entry_id="FUND",
            as_of=date(2026, 1, 10),
            description="Fund",
            legs=[
                Leg("cash_usd", "DEBIT", Decimal("500.00"), "USD"),
                Leg("rev_usd", "CREDIT", Decimal("500.00"), "USD"),
            ],
        )
        self.recon.place_hold("H1", "cash_usd", Decimal("120.00"))
        self.recon.place_hold("H2", "cash_usd", Decimal("80.00"))
        rep1 = self.recon.reconcile_account("cash_usd")
        self.assertEqual(rep1.posted_balance, Decimal("500.00"))
        self.assertEqual(rep1.pending_holds_total, Decimal("200.00"))
        self.assertEqual(rep1.available_balance, Decimal("300.00"))

        self.recon.release_hold("H2")
        self.assertEqual(self.recon.get_hold("H2").status, HoldStatus.RELEASED)
        rep2 = self.recon.reconcile_account("cash_usd")
        self.assertEqual(rep2.pending_holds_total, Decimal("120.00"))
        self.assertEqual(rep2.available_balance, Decimal("380.00"))

        self.recon.capture_hold("H1", "CAP1", "vendor_usd", date(2026, 1, 12), "Settle H1")
        rep3 = self.recon.reconcile_account("cash_usd")
        self.assertEqual(rep3.posted_balance, Decimal("380.00"))
        self.assertEqual(rep3.pending_holds_total, Decimal("0.00"))
        self.assertEqual(rep3.available_balance, Decimal("380.00"))

    def test_standard_entry_reversal(self) -> None:
        self.engine.post_entry(
            entry_id="E1",
            as_of=date(2026, 1, 10),
            description="Charge",
            legs=[
                Leg("cash_usd", "DEBIT", Decimal("250.00"), "USD"),
                Leg("rev_usd", "CREDIT", Decimal("250.00"), "USD"),
            ],
        )
        self.engine.reverse_entry("E1", date(2026, 1, 11), "Mistake")
        self.assertEqual(self.engine.get_posted_balance("cash_usd"), Decimal("0.00"))
        self.assertEqual(self.engine.get_posted_balance("rev_usd"), Decimal("0.00"))


if __name__ == "__main__":
    unittest.main()
