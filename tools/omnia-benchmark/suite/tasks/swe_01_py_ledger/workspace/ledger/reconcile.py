"""Pending authorization holds, idempotent captured-hold reversals, and account reconciliation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from .engine import AlreadyReversedError, LedgerEngine, LedgerError
from .models import EntryStatus, HoldStatus, JournalEntry, Leg, PendingHold, quantize_money


class HoldError(LedgerError):
    """Raised on invalid authorization hold transitions."""


@dataclass(frozen=True)
class ReconciliationReport:
    account_id: str
    currency: str
    posted_balance: Decimal
    pending_holds_total: Decimal
    available_balance: Decimal
    active_hold_count: int
    reversed_entry_count: int


class ReconciliationEngine:
    """Manages pending holds and reconciles posted vs available balances."""

    def __init__(self, engine: LedgerEngine) -> None:
        self.engine = engine
        self._holds: dict[str, PendingHold] = {}
        self._hold_order: list[str] = []

    def place_hold(
        self,
        hold_id: str,
        account_id: str,
        amount: Decimal | str,
        currency: str | None = None,
    ) -> PendingHold:
        if hold_id in self._holds:
            raise HoldError(f"Hold already exists: {hold_id}")
        acct = self.engine.get_account(account_id)
        ccy = (currency or acct.currency).upper()
        if ccy != acct.currency:
            raise HoldError(f"Hold currency {ccy} does not match account currency {acct.currency}")
        hold = PendingHold(
            hold_id=hold_id,
            account_id=account_id,
            amount=amount if isinstance(amount, Decimal) else Decimal(str(amount)),
            currency=ccy,
            status=HoldStatus.PENDING,
        )
        self._holds[hold_id] = hold
        self._hold_order.append(hold_id)
        return hold

    def get_hold(self, hold_id: str) -> PendingHold:
        if hold_id not in self._holds:
            raise HoldError(f"Unknown hold: {hold_id}")
        return self._holds[hold_id]

    def release_hold(self, hold_id: str) -> PendingHold:
        hold = self.get_hold(hold_id)
        if hold.status != HoldStatus.PENDING:
            raise HoldError(f"Cannot release hold {hold_id} in status {hold.status}")
        hold.status = HoldStatus.RELEASED
        return hold

    def capture_hold(
        self,
        hold_id: str,
        entry_id: str,
        counter_account_id: str,
        as_of: date,
        description: str,
        idempotency_key: str | None = None,
    ) -> JournalEntry:
        """Capture a pending hold by posting a transfer from hold.account_id to counter_account_id."""
        hold = self.get_hold(hold_id)
        if hold.status != HoldStatus.PENDING:
            raise HoldError(f"Cannot capture hold {hold_id} in status {hold.status}")

        src_acct = self.engine.get_account(hold.account_id)
        dst_acct = self.engine.get_account(counter_account_id)
        if src_acct.currency != dst_acct.currency:
            raise HoldError("Cross-currency hold capture is not supported directly")

        entry = self.engine.post_entry(
            entry_id=entry_id,
            as_of=as_of,
            description=description,
            legs=[
                Leg(account_id=hold.account_id, side="CREDIT", amount=hold.amount, currency=hold.currency),
                Leg(account_id=counter_account_id, side="DEBIT", amount=hold.amount, currency=hold.currency),
            ],
            idempotency_key=idempotency_key,
            metadata={"hold_id": hold_id},
        )
        hold.status = HoldStatus.CAPTURED
        hold.captured_entry_id = entry.entry_id
        return entry

    def reverse_captured_hold(
        self,
        hold_id: str,
        as_of: date,
        reason: str,
        idempotency_key: str,
        restore_hold: bool = False,
    ) -> JournalEntry:
        """Idempotently reverse the journal entry associated with a captured hold."""
        hold = self.get_hold(hold_id)
        if hold.captured_entry_id is None:
            raise HoldError(f"Hold {hold_id} has not been captured")

        rev_entry = self.engine.reverse_entry(
            entry_id=hold.captured_entry_id,
            as_of=as_of,
            reason=reason,
            idempotency_key=idempotency_key,
        )

        if restore_hold:
            restored_id = f"{hold.hold_id}#restored#{len(self._hold_order)}"
            restored = PendingHold(
                hold_id=restored_id,
                account_id=hold.account_id,
                amount=hold.amount,
                currency=hold.currency,
                status=HoldStatus.PENDING,
            )
            self._holds[restored_id] = restored
            self._hold_order.append(restored_id)

        return rev_entry

    def list_account_holds(self, account_id: str) -> list[PendingHold]:
        self.engine.get_account(account_id)
        return [
            self._holds[hid]
            for hid in self._hold_order
            if self._holds[hid].account_id == account_id
        ]

    def reconcile_account(self, account_id: str) -> ReconciliationReport:
        """Compute posted balance, pending hold exposure, and available balance."""
        acct = self.engine.get_account(account_id)
        posted = self.engine.get_posted_balance(account_id)

        reversed_entry_ids = {
            e.entry_id
            for e in self.engine.list_entries()
            if e.status == EntryStatus.REVERSED
            and any(leg.account_id == account_id for leg in e.legs)
        }

        pending_total = Decimal("0")
        active_count = 0
        for hold in self.list_account_holds(account_id):
            if hold.status == HoldStatus.PENDING:
                pending_total += hold.amount
                active_count += 1
            elif (
                hold.status == HoldStatus.CAPTURED
                and hold.captured_entry_id in reversed_entry_ids
            ):
                # Reversed capture still counted as pending exposure
                pending_total += hold.amount
                active_count += 1

        pending_total = quantize_money(pending_total, acct.currency)
        available = quantize_money(posted - pending_total, acct.currency)

        return ReconciliationReport(
            account_id=account_id,
            currency=acct.currency,
            posted_balance=posted,
            pending_holds_total=pending_total,
            available_balance=available,
            active_hold_count=active_count,
            reversed_entry_count=len(reversed_entry_ids),
        )
