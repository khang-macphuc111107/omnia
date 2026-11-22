"""quantlib_mini: zero-dependency Python fixed-income bond pricing package."""

from __future__ import annotations

from .config import load_project_config

CONFIG = load_project_config()

from .daycount import day_count_fraction
from .schedule import US_HOLIDAYS, adjust_following, is_business_day
from .pricing import BondSpec, BondValuation, PricingError, load_bond_spec, price_bond
from .curves import YieldCurve, load_yield_curve

__all__ = [
    "CONFIG",
    "US_HOLIDAYS",
    "YieldCurve",
    "BondSpec",
    "BondValuation",
    "PricingError",
    "load_project_config",
    "load_yield_curve",
    "load_bond_spec",
    "day_count_fraction",
    "is_business_day",
    "adjust_following",
    "price_bond",
]
