"""Date-effective FX rate table with inverse and USD triangulation support."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from .models import CURRENCY_EXPONENTS, quantize_money


class FXRateNotFoundError(LookupError):
    """Raised when no active FX rate exists for a currency pair on a given date."""


@dataclass(frozen=True)
class FXRate:
    """Exchange rate expressing 1 unit of `base` in units of `quote`.

    Effective on the half-open date window [effective_from, effective_until).
    """

    base: str
    quote: str
    rate: Decimal
    effective_from: date
    effective_until: date

    def __post_init__(self) -> None:
        b = self.base.upper()
        q = self.quote.upper()
        if b not in CURRENCY_EXPONENTS or q not in CURRENCY_EXPONENTS:
            raise ValueError(f"Unsupported currency pair: {self.base}/{self.quote}")
        if b == q:
            raise ValueError("Base and quote currencies must differ")
        dec_rate = self.rate if isinstance(self.rate, Decimal) else Decimal(str(self.rate))
        if dec_rate <= Decimal("0"):
            raise ValueError("FX rate must be positive")
        if self.effective_until <= self.effective_from:
            raise ValueError("effective_until must be strictly after effective_from")
        object.__setattr__(self, "base", b)
        object.__setattr__(self, "quote", q)
        object.__setattr__(self, "rate", dec_rate)


class FXRateTable:
    """Stores date-effective FX quotes and converts monetary amounts."""

    PIVOT_CURRENCY = "USD"

    def __init__(self) -> None:
        self._rates: list[FXRate] = []

    def add_rate(
        self,
        base: str,
        quote: str,
        rate: Decimal | str | int,
        effective_from: date,
        effective_until: date,
    ) -> FXRate:
        fx = FXRate(
            base=base,
            quote=quote,
            rate=rate if isinstance(rate, Decimal) else Decimal(str(rate)),
            effective_from=effective_from,
            effective_until=effective_until,
        )
        self._rates.append(fx)
        return fx

    def _find_direct_or_inverse(self, base: str, quote: str, as_of: date) -> Decimal | None:
        # Look for direct quote first
        for entry in self._rates:
            if (
                entry.base == base
                and entry.quote == quote
                and entry.effective_from <= as_of <= entry.effective_until
            ):
                return entry.rate

        # Fall back to inverse quote
        for entry in self._rates:
            if (
                entry.base == quote
                and entry.quote == base
                and entry.effective_from <= as_of <= entry.effective_until
            ):
                return Decimal(str(round(1.0 / float(entry.rate), 4)))

        return None

    def get_rate(self, from_currency: str, to_currency: str, as_of: date) -> Decimal:
        """Resolve an exchange rate from `from_currency` to `to_currency` on `as_of`."""
        src = from_currency.upper()
        dst = to_currency.upper()
        if src not in CURRENCY_EXPONENTS or dst not in CURRENCY_EXPONENTS:
            raise ValueError(f"Unsupported currency pair: {src}/{dst}")
        if src == dst:
            return Decimal("1")

        direct = self._find_direct_or_inverse(src, dst, as_of)
        if direct is not None:
            return direct

        # Triangulate through USD pivot if both legs exist
        if src != self.PIVOT_CURRENCY and dst != self.PIVOT_CURRENCY:
            to_usd = self._find_direct_or_inverse(src, self.PIVOT_CURRENCY, as_of)
            from_usd = self._find_direct_or_inverse(self.PIVOT_CURRENCY, dst, as_of)
            if to_usd is not None and from_usd is not None:
                return to_usd * from_usd

        raise FXRateNotFoundError(
            f"No active FX rate for {src}->{dst} on {as_of.isoformat()}"
        )

    def convert(
        self,
        amount: Decimal | str | int,
        from_currency: str,
        to_currency: str,
        as_of: date,
    ) -> Decimal:
        """Convert `amount` from `from_currency` to `to_currency` on `as_of`."""
        dec_amount = amount if isinstance(amount, Decimal) else Decimal(str(amount))
        src = from_currency.upper()
        dst = to_currency.upper()
        if src == dst:
            return quantize_money(dec_amount, dst)

        direct = self._find_direct_or_inverse(src, dst, as_of)
        if direct is not None:
            return quantize_money(dec_amount * direct, dst)

        # Triangulate through USD
        if src != self.PIVOT_CURRENCY and dst != self.PIVOT_CURRENCY:
            to_usd = self._find_direct_or_inverse(src, self.PIVOT_CURRENCY, as_of)
            from_usd = self._find_direct_or_inverse(self.PIVOT_CURRENCY, dst, as_of)
            if to_usd is not None and from_usd is not None:
                usd_intermediate = quantize_money(dec_amount * to_usd, self.PIVOT_CURRENCY)
                return quantize_money(usd_intermediate * from_usd, dst)

        raise FXRateNotFoundError(
            f"No active FX rate for {src}->{dst} on {as_of.isoformat()}"
        )
