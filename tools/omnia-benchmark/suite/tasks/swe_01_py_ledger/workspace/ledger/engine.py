"""Core double-entry ledger engine with multi-currency split transfers and reversals."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Iterable, Sequence

from .currency import FXRateTable
from .models import (
    Account,
    AccountType,
    EntryStatus,
    JournalEntry,
    Leg,
    quantize_money,
)


class LedgerError(Exception):
    """Base error for ledger operations."""


class AccountNotFoundError(LedgerError):
    """Raised when an account ID does not exist."""


class UnbalancedEntryError(LedgerError):
    """Raised when a single-currency journal entry does not balance."""


class AlreadyReversedError(LedgerError):
    """Raised when attempting to reverse an entry that is already reversed."""


class LedgerEngine:
    """In-memory double-entry ledger supporting multi-currency FX transfers."""

    def __init__(self, fx_table: FXRateTable | None = None, base_currency: str = "USD") -> None:
        self.fx_table = fx_table if fx_table is not None else FXRateTable()
        self.base_currency = base_currency.upper()
        self._accounts: dict[str, Account] = {}
        self._entries: dict[str, JournalEntry] = {}
        self._entry_order: list[str] = []
        self._idempotency_index: dict[str, str] = {}

    def create_account(
        self,
        account_id: str,
        name: str,
        account_type: AccountType,
        currency: str,
    ) -> Account:
        if account_id in self._accounts:
            raise LedgerError(f"Account already exists: {account_id}")
        acct = Account(
            account_id=account_id,
            name=name,
            account_type=account_type,
            currency=currency,
        )
        self._accounts[account_id] = acct
        return acct

    def get_account(self, account_id: str) -> Account:
        if account_id not in self._accounts:
            raise AccountNotFoundError(f"Unknown account: {account_id}")
        return self._accounts[account_id]

    def get_entry(self, entry_id: str) -> JournalEntry:
        if entry_id not in self._entries:
            raise LedgerError(f"Unknown journal entry: {entry_id}")
        return self._entries[entry_id]

    def get_entry_by_idempotency_key(self, key: str) -> JournalEntry | None:
        entry_id = self._idempotency_index.get(key)
        return self._entries[entry_id] if entry_id is not None else None

    def list_entries(self) -> list[JournalEntry]:
        return [self._entries[eid] for eid in self._entry_order]

    def post_entry(
        self,
        entry_id: str,
        as_of: date,
        description: str,
        legs: Sequence[Leg],
        idempotency_key: str | None = None,
        metadata: dict | None = None,
        allow_multi_currency: bool = False,
    ) -> JournalEntry:
        """Post a balanced journal entry."""
        if idempotency_key is not None and idempotency_key in self._idempotency_index:
            return self._entries[self._idempotency_index[idempotency_key]]

        if entry_id in self._entries:
            raise LedgerError(f"Duplicate entry_id: {entry_id}")
        if len(legs) < 2:
            raise UnbalancedEntryError("Journal entry must have at least two legs")

        currencies: set[str] = set()
        for leg in legs:
            acct = self.get_account(leg.account_id)
            if acct.currency != leg.currency:
                raise LedgerError(
                    f"Leg currency {leg.currency} does not match account {acct.account_id} ({acct.currency})"
                )
            currencies.add(leg.currency)

        if len(currencies) == 1:
            debits = sum((l.amount for l in legs if l.side == "DEBIT"), Decimal("0"))
            credits = sum((l.amount for l in legs if l.side == "CREDIT"), Decimal("0"))
            if debits != credits:
                raise UnbalancedEntryError(
                    f"Entry {entry_id} is unbalanced: debits={debits}, credits={credits}"
                )
        elif not allow_multi_currency:
            # Verify balance in base reporting currency
            debits_base = Decimal("0")
            credits_base = Decimal("0")
            for leg in legs:
                conv = self.fx_table.convert(leg.amount, leg.currency, self.base_currency, as_of)
                if leg.side == "DEBIT":
                    debits_base += conv
                else:
                    credits_base += conv
            if debits_base != credits_base:
                raise UnbalancedEntryError(
                    f"Multi-currency entry {entry_id} unbalanced in {self.base_currency}: "
                    f"debits={debits_base}, credits={credits_base}"
                )

        entry = JournalEntry(
            entry_id=entry_id,
            as_of=as_of,
            description=description,
            legs=tuple(legs),
            status=EntryStatus.POSTED,
            idempotency_key=idempotency_key,
            metadata=dict(metadata) if metadata else {},
        )
        self._entries[entry_id] = entry
        self._entry_order.append(entry_id)
        if idempotency_key is not None:
            self._idempotency_index[idempotency_key] = entry_id
        return entry

    def post_split_transfer(
        self,
        entry_id: str,
        as_of: date,
        description: str,
        source_account_id: str,
        total_source_amount: Decimal | str,
        target_allocations: Sequence[tuple[str, Decimal]],
        idempotency_key: str | None = None,
    ) -> JournalEntry:
        """Split a source amount across one or more target accounts (potentially multi-currency).

        Credits `source_account_id` for `total_source_amount` and debits each target
        account in its own native currency based on the allocated source share.
        """
        if idempotency_key is not None and idempotency_key in self._idempotency_index:
            return self._entries[self._idempotency_index[idempotency_key]]

        source_acct = self.get_account(source_account_id)
        total_dec = quantize_money(total_source_amount, source_acct.currency)
        if total_dec <= Decimal("0"):
            raise LedgerError("Split transfer total amount must be positive")
        if not target_allocations:
            raise LedgerError("target_allocations must not be empty")

        weight_sum = sum((Decimal(str(w)) for _, w in target_allocations), Decimal("0"))
        if abs(weight_sum - Decimal("1")) > Decimal("1e-9"):
            raise LedgerError(f"Allocation weights must sum to 1, got {weight_sum}")

        legs: list[Leg] = []
        source_shares: list[tuple[str, Decimal]] = []

        # Allocate each leg by multiplying independently and rounding
        allocated_total = Decimal("0")
        for target_id, raw_weight in target_allocations:
            target_acct = self.get_account(target_id)
            weight = Decimal(str(raw_weight))
            if weight < Decimal("0"):
                raise LedgerError("Allocation weights must be non-negative")
            src_share = quantize_money(total_dec * weight, source_acct.currency)
            allocated_total += src_share
            source_shares.append((target_id, src_share))

            target_amount = self.fx_table.convert(
                src_share, source_acct.currency, target_acct.currency, as_of
            )
            legs.append(
                Leg(
                    account_id=target_id,
                    side="DEBIT",
                    amount=target_amount,
                    currency=target_acct.currency,
                )
            )

        legs.insert(
            0,
            Leg(
                account_id=source_account_id,
                side="CREDIT",
                amount=allocated_total,
                currency=source_acct.currency,
            ),
        )

        return self.post_entry(
            entry_id=entry_id,
            as_of=as_of,
            description=description,
            legs=legs,
            idempotency_key=idempotency_key,
            metadata={"source_shares": source_shares},
            allow_multi_currency=True,
        )

    def reverse_entry(
        self,
        entry_id: str,
        as_of: date,
        reason: str,
        reversal_entry_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> JournalEntry:
        """Create an offsetting reversal journal entry for an existing posted entry."""
        if idempotency_key is not None and idempotency_key in self._idempotency_index:
            return self._entries[self._idempotency_index[idempotency_key]]

        orig = self.get_entry(entry_id)
        if orig.status == EntryStatus.REVERSED:
            raise AlreadyReversedError(f"Entry {entry_id} was already reversed by {orig.reversed_by}")

        rev_id = reversal_entry_id or f"REV-{entry_id}"
        flipped_legs = tuple(
            Leg(
                account_id=leg.account_id,
                side="CREDIT" if leg.side == "DEBIT" else "DEBIT",
                amount=leg.amount,
                currency=leg.currency,
            )
            for leg in orig.legs
        )

        rev_entry = self.post_entry(
            entry_id=rev_id,
            as_of=as_of,
            description=f"Reversal of {entry_id}: {reason}",
            legs=flipped_legs,
            idempotency_key=idempotency_key,
            allow_multi_currency=True,
        )
        rev_entry.reverses = entry_id
        orig.status = EntryStatus.REVERSED
        orig.reversed_by = rev_id
        return rev_entry

    def get_posted_balance(self, account_id: str) -> Decimal:
        """Compute an account's native-currency posted balance from all journal entries."""
        acct = self.get_account(account_id)
        balance = Decimal("0")
        for entry in self.list_entries():
            for leg in entry.legs:
                if leg.account_id != account_id:
                    continue
                if acct.account_type.is_debit_normal:
                    balance += leg.amount if leg.side == "DEBIT" else -leg.amount
                else:
                    balance += leg.amount if leg.side == "CREDIT" else -leg.amount
        return quantize_money(balance, acct.currency)

    def trial_balance(self, currency: str) -> tuple[Decimal, Decimal]:
        """Return (total_debits, total_credits) across all entries in a single currency."""
        code = currency.upper()
        debits = Decimal("0")
        credits = Decimal("0")
        for entry in self.list_entries():
            if all(l.currency == code for l in entry.legs):
                for leg in entry.legs:
                    if leg.side == "DEBIT":
                        debits += leg.amount
                    else:
                        credits += leg.amount
        return quantize_money(debits, code), quantize_money(credits, code)

    def iter_accounts(self) -> Iterable[Account]:
        return self._accounts.values()
