"""Unit tests for ACT/365F, ACT/ACT (ISDA), and 30/360 (US) day-count conventions."""

from datetime import date
import unittest

import quantlib_mini
from src.quantlib_mini.daycount import day_count_fraction


class TestDayCount(unittest.TestCase):
    def test_act_365f_in_leap_year(self) -> None:
        # 2024 is a leap year, yet ACT/365F always divides by 365.0
        frac = day_count_fraction(date(2024, 1, 1), date(2024, 7, 1), "ACT/365F")
        self.assertAlmostEqual(frac, 182.0 / 365.0, places=8)

        full_leap = day_count_fraction(date(2024, 1, 1), date(2025, 1, 1), "ACT/365F")
        self.assertAlmostEqual(full_leap, 366.0 / 365.0, places=8)

    def test_act_act_isda_across_leap_year_boundary(self) -> None:
        # 2024 (leap, 366 days): 184 days from Jul 1 to Jan 1
        # 2025 (non-leap, 365 days): 181 days from Jan 1 to Jul 1
        frac = day_count_fraction(date(2024, 7, 1), date(2025, 7, 1), "ACT/ACT")
        expected = (184.0 / 366.0) + (181.0 / 365.0)
        self.assertAlmostEqual(frac, expected, places=8)

    def test_thirty_360_us_end_of_month_rules(self) -> None:
        # d1=31 -> 30, d2=28 stays 28 => (30 + (28 - 30)) / 360 = 28/360
        frac1 = day_count_fraction(date(2024, 1, 31), date(2024, 2, 28), "30/360")
        self.assertAlmostEqual(frac1, 28.0 / 360.0, places=8)

        # d1=30, d2=31 -> 30 => (5*30 + 0) / 360 = 150/360
        frac2 = day_count_fraction(date(2024, 8, 30), date(2025, 1, 31), "30/360")
        self.assertAlmostEqual(frac2, 150.0 / 360.0, places=8)

        # d1=28 (not 30/31), d2=31 stays 31 => (6*30 + 3) / 360 = 183/360
        frac3 = day_count_fraction(date(2024, 2, 28), date(2024, 8, 31), "30/360")
        self.assertAlmostEqual(frac3, 183.0 / 360.0, places=8)

    def test_zero_and_invalid_spans(self) -> None:
        self.assertEqual(day_count_fraction(date(2024, 5, 15), date(2024, 5, 15), "ACT/ACT"), 0.0)
        with self.assertRaises(ValueError):
            day_count_fraction(date(2024, 6, 1), date(2024, 5, 1), "ACT/365F")


if __name__ == "__main__":
    unittest.main()
