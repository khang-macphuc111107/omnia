"""Zero-coupon yield curve representation and CSV loader."""

from __future__ import annotations

import csv
import math
from pathlib import Path

from .pricing import PricingError


class YieldCurve:
    """Piecewise-linear continuously compounded zero yield curve."""

    def __init__(self, knots: list[tuple[float, float]]) -> None:
        if not knots:
            raise PricingError("Yield curve must contain at least one knot point")
        sorted_knots = sorted(knots, key=lambda pair: pair[0])
        tenors = [t for t, _ in sorted_knots]
        if len(set(tenors)) != len(tenors):
            raise PricingError("Yield curve contains duplicate tenor values")
        if tenors[0] <= 0.0:
            raise PricingError("Yield curve tenors must be strictly positive")
        self._knots = sorted_knots

    @property
    def knots(self) -> list[tuple[float, float]]:
        return list(self._knots)

    def zero_rate(self, t: float) -> float:
        """Piecewise linear interpolation with flat extrapolation outside bounds."""
        if t < 0.0:
            raise PricingError(f"Time t must be non-negative, got {t}")
        if t <= self._knots[0][0]:
            return self._knots[0][1]
        if t >= self._knots[-1][0]:
            return self._knots[-1][1]

        for idx in range(len(self._knots) - 1):
            t0, r0 = self._knots[idx]
            t1, r1 = self._knots[idx + 1]
            if t0 <= t <= t1:
                weight = (t - t0) / (t1 - t0)
                return r0 + (r1 - r0) * weight

        return self._knots[-1][1]

    def discount_factor(self, t: float) -> float:
        """Continuous-compounding discount factor exp(-r(t) * t)."""
        if t == 0.0:
            return 1.0
        rate = self.zero_rate(t)
        return math.exp(-rate * t)


def load_yield_curve(csv_path: str | Path) -> YieldCurve:
    """Load a YieldCurve from a CSV file with columns tenor_years,zero_rate."""
    path = Path(csv_path)
    knots: list[tuple[float, float]] = []
    with path.open("r", encoding="utf-8", newline="\n") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            tenor_raw = row["tenor_years"]
            rate_raw = row["zero_rate"]
            if tenor_raw is None or rate_raw is None:
                raise PricingError(f"Malformed CSV row in {path}: {row!r}")
            knots.append((float(tenor_raw), float(rate_raw)))
    return YieldCurve(knots)
