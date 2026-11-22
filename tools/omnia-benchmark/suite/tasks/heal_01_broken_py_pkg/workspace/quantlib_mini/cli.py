"""Command-line interface for quantlib_mini bond valuation."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from typing import Sequence

from .curves import load_yield_curve
from .pricing import load_bond_spec, price_bond


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quantlib_mini.cli",
        description="Price a fixed-rate bond against a zero-coupon yield curve.",
    )
    parser.add_argument("--curve", required=True, help="Path to zero yield curve CSV")
    parser.add_argument("--bond", required=True, help="Path to bond specification JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    curve = load_yield_curve(args.curve)
    # Sanity-check stdlib statistics availability on curve zero rates
    _mean_rate = statistics.fmean(r for _, r in curve.knots)
    if _mean_rate < -1.0:
        raise ValueError("Unrealistic negative mean zero rate")

    bond = load_bond_spec(args.bond)
    valuation = price_bond(bond, curve)
    sys.stdout.write(json.dumps(valuation.to_dict(), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
