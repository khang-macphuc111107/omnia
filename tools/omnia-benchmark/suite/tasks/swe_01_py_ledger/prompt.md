# Issue Report: Multi-Currency FX Split Precision & Idempotent Hold Reversal Bugs

Work strictly inside the current working directory. Use Python 3 stdlib only (no third-party packages). You can run the existing public test suite with:

```bash
python -m unittest discover -s tests -v
```

## Background

This repository implements `ledger/`, a multi-currency double-entry accounting ledger with:
- `ledger/models.py`: Accounts, currencies (`USD`, `EUR`, `GBP`, `JPY`, `KWD`, `CHF`, `CAD`), `JournalEntry`, `Leg`, `PendingHold`, and currency minor-unit quantization (`ROUND_HALF_EVEN`).
- `ledger/currency.py`: Date-effective FX rate table (`FXRateTable`) supporting direct lookup, inverse lookup, and USD triangulation.
- `ledger/engine.py`: Core `LedgerEngine` for posting entries, multi-currency split transfers (`post_split_transfer`), and journal reversals.
- `ledger/reconcile.py`: `ReconciliationEngine` for placing/capturing/releasing pending authorization holds, idempotently reversing captured holds, and reconciling account balances.

The existing basic tests pass, but production audits uncovered two bug clusters across `ledger/currency.py`, `ledger/engine.py`, and `ledger/reconcile.py`.

## Bug Cluster 1: FX Date Windows, Inverse/Triangulated Precision & Multi-Leg Split Allocation

1. **Date-effective FX window off-by-one (`ledger/currency.py`)**:
   - `FXRate` entries are documented as effective on the **half-open** date interval `[effective_from, effective_until)` — i.e., active when `effective_from <= as_of < effective_until`.
   - Currently, boundary rollover dates (`as_of == effective_until`) erroneously match the expired rate instead of either advancing to the new rate starting on `as_of` or raising `FXRateNotFoundError` when no successor rate exists.

2. **Inverse rate truncation & intermediate USD quantization (`ledger/currency.py`)**:
   - When computing an inverse rate (`quote -> base` from a stored `(base, quote)` rate) or triangulating across `USD` (`from_currency -> USD -> to_currency` when neither direct nor inverse pair exists), full `Decimal` precision must be preserved throughout rate calculation and multiplication.
   - Only the **final** converted amount returned by `FXRateTable.convert(...)` should be quantized to `to_currency`'s minor unit (`CURRENCY_EXPONENTS[to_currency]`) using `ROUND_HALF_EVEN`.
   - Currently, inverse rates are prematurely truncated via floating-point/4-decimal rounding, and USD-triangulated conversions prematurely quantize the intermediate USD value to 2 decimal places before converting to `to_currency`.

3. **Multi-leg non-USD split transfer quantization residual (`ledger/engine.py`)**:
   - `LedgerEngine.post_split_transfer(...)` transfers `total_source_amount` from `source_account_id` across `target_allocations: list[tuple[str, Decimal]]` (weights summing to `Decimal("1")`), where source and target accounts may use different non-USD currencies.
   - Source-currency shares MUST be allocated in the source currency's minor units so that **the sum of all source-currency shares equals `total_source_amount` exactly** (no dropped or created pennies/minor units).
   - Specifically, use **largest-remainder allocation** (floor/truncate each exact share `total_source_amount * weight` toward zero to source currency minor units, compute the remaining integer minor units, and distribute +1 minor unit to the legs with the largest fractional remainders, breaking ties by earliest leg index).
   - Each target leg's credited/debited amount in `target_account.currency` must then be converted from its exact allocated source-currency share using full-precision `FXRateTable.convert(..., as_of=as_of)`.
   - The resulting `JournalEntry` must record:
     - One `CREDIT` leg on `source_account_id` for `total_source_amount` in `source_account.currency` (assuming asset outflow; debit/credit convention matches existing `post_split_transfer`),
     - One `DEBIT` leg per target account in `target_account.currency` for its converted amount,
     - And `source_shares` metadata (`dict` or tuple of `(target_account_id, source_share)` in `entry.metadata["source_shares"]`) summing strictly to `total_source_amount`.

## Bug Cluster 2: Idempotent Reversal & Pending Hold Reconciliation (`ledger/reconcile.py` & `ledger/engine.py`)

1. **Idempotent reversal double-counting pending holds (`ledger/reconcile.py`)**:
   - `ReconciliationEngine.reverse_captured_hold(hold_id, as_of, reason, idempotency_key, restore_hold=False)` reverses the journal entry created when `hold_id` was captured.
   - When `restore_hold=False`: the captured journal entry is reversed (returning the funds to `posted_balance`), and the hold MUST NOT remain counted in `pending_holds_total` (it stays non-pending / released so `available_balance == posted_balance`).
   - When `restore_hold=True`: the captured journal entry is reversed AND the hold is restored to `PENDING` (so `pending_holds_total` includes the hold's amount once, and `available_balance == posted_balance - pending_holds_total`).
   - **Idempotency requirement**: Calling `reverse_captured_hold` multiple times with the **same `idempotency_key`** MUST be strictly idempotent — it must return the existing reversal `JournalEntry` without creating duplicate journal entries AND without creating/counting duplicate pending holds!
   - Calling `reverse_captured_hold` (or `engine.reverse_entry`) a second time on an already-reversed entry with a **different** `idempotency_key` MUST raise `AlreadyReversedError`.
   - `reconcile_account(account_id)` must compute `pending_holds_total` strictly from active `PENDING` holds on that account (never double-counting `CAPTURED` holds whose linked entries were reversed, nor counting `RELEASED` holds), and `available_balance = posted_balance - pending_holds_total`.

## Requirements

- Fix all root causes cleanly across the `ledger/` package.
- Do not break any existing public API or behavior verified by `tests/test_basic.py`.
- Verify your changes with `python -m unittest discover -s tests -v` and add/run thorough checks for all edge cases described above.
