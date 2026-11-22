"""Day-count convention calculations (ACT/365F, ACT/ACT ISDA, 30/360 US)."""

from __future__ import annotations

from calendar import isleap
from datetime import date


def day_count_fraction(start_date: date, end_date: date, convention: str) -> float:
    """Compute the year fraction between start_date and end_date.

    Supported conventions (see SPEC.md):
      - ACT/365F: Actual/365 Fixed
      - ACT/ACT:  ISDA Actual/Actual
      - 30/360:   US / Bond Basis
    """
    if end_date < start_date:
        raise ValueError(f"end_date ({end_date}) must be >= start_date ({start_date})")
    if end_date == start_date:
        return 0.0

    conv = convention.strip().upper()
    if conv == "ACT/365F":
        denom = 366.0 if isleap(start_date.year) else 365.0
        return (end_date - start_date).days / denom

    if conv == "ACT/ACT":
        denom = 366.0 if isleap(start_date.year) else 365.0
        return (end_date - start_date).days / denom

    if conv == "30/360":
        d1 = start_date.day
        d2 = end_date.day
        days_360 = (
            (end_date.year - start_date.year) * 360
            + (end_date.month - start_date.month) * 30
            + (d2 - d1)
        )
        return days_360 / 360.0

    raise ValueError(f"Unsupported day-count convention: {convention!r}")
