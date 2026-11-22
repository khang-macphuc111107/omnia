"""Unit tests for zero-coupon yield curve loading and interpolation."""

from pathlib import Path
import math
import unittest

import quantlib_mini
from src.quantlib_mini.curves import YieldCurve, load_yield_curve

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class TestYieldCurve(unittest.TestCase):
    def test_load_yield_curve_bom_crlf(self) -> None:
        curve = load_yield_curve(DATA_DIR / "yield_curve.csv")
        self.assertEqual(len(curve.knots), 7)
        self.assertAlmostEqual(curve.knots[0][0], 0.25, places=6)
        self.assertAlmostEqual(curve.knots[0][1], 0.0480, places=6)
        self.assertAlmostEqual(curve.knots[-1][0], 10.00, places=6)
        self.assertAlmostEqual(curve.knots[-1][1], 0.0420, places=6)

    def test_piecewise_linear_interpolation(self) -> None:
        curve = YieldCurve([(0.5, 0.04), (1.5, 0.06), (3.5, 0.05)])
        self.assertAlmostEqual(curve.zero_rate(1.0), 0.05, places=8)
        self.assertAlmostEqual(curve.zero_rate(2.5), 0.055, places=8)
        self.assertAlmostEqual(curve.discount_factor(1.0), math.exp(-0.05 * 1.0), places=8)

    def test_flat_extrapolation_and_zero_time(self) -> None:
        curve = YieldCurve([(0.25, 0.048), (5.0, 0.040)])
        self.assertAlmostEqual(curve.zero_rate(0.1), 0.048, places=8)
        self.assertAlmostEqual(curve.zero_rate(12.0), 0.040, places=8)
        self.assertEqual(curve.discount_factor(0.0), 1.0)


if __name__ == "__main__":
    unittest.main()
