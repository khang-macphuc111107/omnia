"""Domain models for double-entry accounting ledger."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, ROUND_HALF_EVEN
from enum import Enum
from typing import Any


CURRENCY_EXPONENTS: dict[str, int] = {
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "CHF": 2,
    "CAD": 2,
    "JPY": 0,
    "KWD": 3,
}


def get_currency_quantum(currency: str) -> Decimal:
    """Return the smallest minor unit quantum for a supported ISO currency."""
    code = currency.upper()
    if code not in CURRENCY_EXPONENTS:
        raise ValueError(f"Unsupported currency: {currency}")
    exp = CURRENCY_EXPONENTS[code]
    return Decimal("1") if exp == 0 else Decimal("1").scaleb(-exp)


def quantize_money(amount: Decimal | str | int, currency: str) -> Decimal:
    """Quantize a monetary amount to the currency's minor unit using ROUND_HALF_EVEN."""
    dec = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    quantum = get_currency_quantum(currency)
    return dec.quantize(quantum, rounding=ROUND_HALF_EVEN)


class AccountType(str, Enum):
    ASSET = "ASSET"
    LIABILITY = "LIABILITY"
    EQUITY = "EQUITY"
    REVENUE = "REVENUE"
    EXPENSE = "EXPENSE"

    @property
    def is_debit_normal(self) -> bool:
        return self in (AccountType.ASSET, AccountType.EXPENSE)


class EntryStatus(str, Enum):
    POSTED = "POSTED"
    REVERSED = "REVERSED"


class HoldStatus(str, Enum):
    PENDING = "PENDING"
    CAPTURED = "CAPTURED"
    RELEASED = "RELEASED"


@dataclass(frozen=True)
class Account:
    account_id: str
    name: str
    account_type: AccountType
    currency: str

    def __post_init__(self) -> None:
        code = self.currency.upper()
        if code not in CURRENCY_EXPONENTS:
            raise ValueError(f"Unsupported currency: {self.currency}")
        object.__setattr__(self, "currency", code)


@dataclass(frozen=True)
class Leg:
    account_id: str
    side: str  # "DEBIT" or "CREDIT"
    amount: Decimal
    currency: str

    def __post_init__(self) -> None:
        if self.side not in ("DEBIT", "CREDIT"):
            raise ValueError(f"Invalid leg side: {self.side}")
        dec = self.amount if isinstance(self.amount, Decimal) else Decimal(str(self.amount))
        if dec < Decimal("0"):
            raise ValueError("Leg amount must be non-negative")
        code = self.currency.upper()
        if code not in CURRENCY_EXPONENTS:
            raise ValueError(f"Unsupported currency: {self.currency}")
        object.__setattr__(self, "amount", quantize_money(dec, code))
        object.__setattr__(self, "currency", code)


@dataclass
class JournalEntry:
    entry_id: str
    as_of: date
    description: str
    legs: tuple[Leg, ...]
    status: EntryStatus = EntryStatus.POSTED
    reversed_by: str | None = None
    reverses: str | None = None
    idempotency_key: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PendingHold:
    hold_id: str
    account_id: str
    amount: Decimal
    currency: str
    status: HoldStatus = HoldStatus.PENDING
    captured_entry_id: str | None = None

    def __post_init__(self) -> None:
        code = self.currency.upper()
        dec = self.amount if isinstance(self.amount, Decimal) else Decimal(str(self.amount))
        if dec <= Decimal("0"):
            raise ValueError("Hold amount must be strictly positive")
        self.currency = code
        self.amount = quantize_money(dec, code)
