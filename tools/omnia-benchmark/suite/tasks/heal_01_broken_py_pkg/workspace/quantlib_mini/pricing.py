"""Fixed-rate bond valuation engine."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import json
from pathlib import Path
from typing import Any

from .curves import YieldCurve, load_yield_curve
from .daycount import day_count_fraction
from .schedule import adjust_following


class PricingError(ValueError):
    """Domain error raised for invalid curves, schedules, or bond inputs."""


@dataclass(frozen=True)
class BondSpec:
    bond_id: str
    face_value: float
    coupon_rate: float
    day_count: str
    valuation_date: date
    accrual_start_date: date
    payment_dates: tuple[date, ...]


@dataclass(frozen=True)
class BondValuation:
    bond_id: str
    day_count_convention: str
    cashflow_count: int
    pv: float
    dirty_price: float
    accrued_interest: float
    clean_price: float
    macaulay_duration: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "bond_id": self.bond_id,
            "day_count_convention": self.day_count_convention,
            "cashflow_count": self.cashflow_count,
            "pv": round(self.pv, 6),
            "dirty_price": round(self.dirty_price, 6),
            "accrued_interest": round(self.accrued_interest, 6),
            "clean_price": round(self.clean_price, 6),
            "macaulay_duration": round(self.macaulay_duration, 6),
        }


def load_bond_spec(json_path: str | Path) -> BondSpec:
    """Load a BondSpec from a JSON file."""
    path = Path(json_path)
    with path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)

    payment_dates = tuple(date.fromisoformat(d) for d in raw["payment_dates"])
    if not payment_dates:
        raise PricingError("BondSpec must specify at least one payment date")
    if list(payment_dates) != sorted(payment_dates):
        raise PricingError("BondSpec payment_dates must be sorted ascending")

    return BondSpec(
        bond_id=str(raw["bond_id"]),
        face_value=float(raw["face_value"]),
        coupon_rate=float(raw["coupon_rate"]),
        day_count=str(raw["day_count"]).strip().upper(),
        valuation_date=date.fromisoformat(raw["valuation_date"]),
        accrual_start_date=date.fromisoformat(raw["accrual_start_date"]),
        payment_dates=payment_dates,
    )


def price_bond(bond: BondSpec, curve: YieldCurve) -> BondValuation:
    """Price a fixed-rate bond against a continuously compounded zero curve."""
    pv_total = 0.0
    weighted_time_pv = 0.0
    cashflow_count = 0

    accrued_interest = 0.0
    num_periods = len(bond.payment_dates)

    for idx, sched_date in enumerate(bond.payment_dates):
        prev_date = bond.accrual_start_date if idx == 0 else bond.payment_dates[idx - 1]
        alpha = day_count_fraction(prev_date, sched_date, bond.day_count)
        coupon = bond.face_value * bond.coupon_rate * alpha
        principal = bond.face_value if idx == num_periods - 1 else 0.0
        cashflow = coupon + principal

        if prev_date <= bond.valuation_date < sched_date:
            accrued_alpha = day_count_fraction(prev_date, bond.valuation_date, bond.day_count)
            accrued_interest = bond.face_value * bond.coupon_rate * accrued_alpha

        pay_date = adjust_following(sched_date)
        if pay_date > bond.valuation_date:
            t_pay = day_count_fraction(bond.valuation_date, pay_date, bond.day_count)
            df = curve.discount_factor(t_pay)
            cf_pv = cashflow * df
            pv_total += cf_pv
            weighted_time_pv += t_pay * cf_pv
            cashflow_count += 1

    dirty_price = pv_total
    clean_price = dirty_price - accrued_interest
    macaulay_duration = (weighted_time_pv / dirty_price) if dirty_price > 0.0 else 0.0

    return BondValuation(
        bond_id=bond.bond_id,
        day_count_convention=bond.day_count,
        cashflow_count=cashflow_count,
        pv=pv_total,
        dirty_price=dirty_price,
        accrued_interest=accrued_interest,
        clean_price=clean_price,
        macaulay_duration=macaulay_duration,
    )


__all__ = [
    "PricingError",
    "BondSpec",
    "BondValuation",
    "load_bond_spec",
    "load_yield_curve",
    "price_bond",
]
