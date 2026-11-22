"""Schedule and business-day adjustment helpers."""

from __future__ import annotations

from datetime import date

from calendar import US_HOLIDAYS, adjust_following, is_business_day

__all__ = ["US_HOLIDAYS", "is_business_day", "adjust_following", "adjusted_payment_dates"]


def adjusted_payment_dates(unadjusted_dates: list[date]) -> list[date]:
    """Adjust each scheduled payment date using the Following US business-day rule."""
    return [adjust_following(d) for d in unadjusted_dates]
