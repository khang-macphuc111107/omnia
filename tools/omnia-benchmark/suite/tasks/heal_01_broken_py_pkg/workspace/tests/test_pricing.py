"""Unit tests for bond valuation, business-day schedule adjustment, and CLI output."""

from datetime import date
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import quantlib_mini
from ..quantlib_mini.cli import main as cli_main
from ..quantlib_mini.curves import load_yield_curve
from ..quantlib_mini.pricing import BondSpec, load_bond_spec, price_bond
from ..quantlib_mini.schedule import adjust_following, is_business_day

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class TestBondPricing(unittest.TestCase):
    def test_business_day_following_adjustment(self) -> None:
        # 2024-08-31 is Saturday, 2024-09-01 is Sunday, 2024-09-02 is Labor Day holiday
        self.assertFalse(is_business_day(date(2024, 8, 31)))
        self.assertFalse(is_business_day(date(2024, 9, 2)))
        self.assertTrue(is_business_day(date(2024, 9, 3)))
        self.assertEqual(adjust_following(date(2024, 8, 31)), date(2024, 9, 3))

    def test_price_sample_bond_act_act(self) -> None:
        curve = load_yield_curve(DATA_DIR / "yield_curve.csv")
        bond = load_bond_spec(DATA_DIR / "sample_bond.json")
        val = price_bond(bond, curve)

        self.assertEqual(val.bond_id, "UST-2026-550")
        self.assertEqual(val.cashflow_count, 4)
        self.assertAlmostEqual(val.dirty_price, 1030.757893, places=4)
        self.assertAlmostEqual(val.accrued_interest, 11.571038, places=4)
        self.assertAlmostEqual(val.clean_price, 1019.186855, places=4)
        self.assertAlmostEqual(val.macaulay_duration, 1.717658, places=4)

    def test_leap_year_bond_act365f_vs_30_360(self) -> None:
        curve = load_yield_curve(DATA_DIR / "yield_curve.csv")
        base_kwargs = dict(
            bond_id="LEAP-TEST",
            face_value=1000.0,
            coupon_rate=0.06,
            valuation_date=date(2024, 5, 31),
            accrual_start_date=date(2024, 2, 28),
            payment_dates=(date(2024, 8, 31), date(2025, 2, 28)),
        )
        val_365 = price_bond(BondSpec(day_count="ACT/365F", **base_kwargs), curve)
        val_30 = price_bond(BondSpec(day_count="30/360", **base_kwargs), curve)

        self.assertAlmostEqual(val_365.dirty_price, 1024.954411, places=4)
        self.assertAlmostEqual(val_365.accrued_interest, 15.287671, places=4)
        self.assertAlmostEqual(val_30.dirty_price, 1025.111141, places=4)
        self.assertAlmostEqual(val_30.accrued_interest, 15.500000, places=4)

    def test_cli_json_output(self) -> None:
        buf = io.StringIO()
        argv = [
            "--curve",
            str(DATA_DIR / "yield_curve.csv"),
            "--bond",
            str(DATA_DIR / "sample_bond.json"),
        ]
        with patch("sys.stdout", buf):
            rc = cli_main(argv)
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["bond_id"], "UST-2026-550")
        self.assertEqual(payload["day_count_convention"], "ACT/ACT")
        self.assertEqual(payload["cashflow_count"], 4)
        self.assertAlmostEqual(payload["clean_price"], 1019.186855, places=4)


if __name__ == "__main__":
    unittest.main()
