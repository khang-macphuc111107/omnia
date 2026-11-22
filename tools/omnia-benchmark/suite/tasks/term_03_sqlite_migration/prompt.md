# Task: Idempotent SQLite v1 -> v2 Schema Migration

Write a deterministic, **idempotent** Python 3 migration script `migrate.py` in the current working directory that migrates legacy SQLite tables (`users_legacy`, `orders_legacy`) into a normalized, foreign-key-enforced v2 schema inside the same database, converts multi-currency prices into integer USD cents, and quarantines invalid/orphaned orders to JSONL.

## CLI Interface

```bash
python migrate.py [--db app.db] [--fx fx_rates.json] [--quarantine output/quarantine.jsonl]
```

- All three flags must be optional with exact defaults:
  - `--db`: `app.db`
  - `--fx`: `fx_rates.json`
  - `--quarantine`: `output/quarantine.jsonl`
- Must work with arbitrary `--db`, `--fx`, and `--quarantine` paths (do **not** hardcode table contents or FX rates).
- Create the parent directory of `--quarantine` automatically if it does not exist.
- Before finishing, run `python migrate.py` so `app.db` and `output/quarantine.jsonl` are populated.

## Legacy Input Tables (Read-Only)

Keep `users_legacy` and `orders_legacy` untouched (read-only) in the database:
- `users_legacy(id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, created_at TEXT)`
- `orders_legacy(id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, total_raw TEXT, items_json TEXT, created_at TEXT)`

## Target v2 Schema

Enable `PRAGMA foreign_keys = ON;` and create these four tables inside the database:

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    total_usd_cents INTEGER NOT NULL CHECK(total_usd_cents >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    sku TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK(qty > 0),
    unit_price_usd_cents INTEGER NOT NULL CHECK(unit_price_usd_cents >= 0)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
```

Insert a migration record with `version = 2` and an ISO-8601 UTC `applied_at` timestamp into `schema_migrations`.

## Transformation & Validation Rules

### 1. User Deduplication & Canonical Remapping
- Normalize every `users_legacy.email` using `email.strip().lower()`.
- Multiple rows in `users_legacy` may collide after normalization (differing by case and/or leading/trailing whitespace).
- **Canonical winner rule**: Among rows sharing the same normalized email, the row with the **lowest `id`** is the canonical user.
- Insert only canonical users into `users` with `id = canonical_id`, `email = normalized_email`, `full_name = full_name.strip()`, and `created_at = created_at.strip()`.
- Remap **every** `orders_legacy.user_id` referencing a duplicate user ID to that user's canonical `id`.

### 2. Currency Parsing & Exact Decimal USD-Cent Conversion
- Load FX rates from `--fx` (`fx_rates.json`, mapping uppercase ISO currency codes like `"USD"`, `"EUR"`, `"GBP"`, `"JPY"` to decimal USD multiplier strings).
- Parse each item's `unit_price` (trimmed):
  - Prefix symbols: `"$"` -> `USD`, `"€"` -> `EUR`, `"£"` -> `GBP`, `"¥"` -> `JPY`.
  - Prefix 3-letter ISO codes (case-insensitive, optional whitespace before amount): e.g. `"USD 12.50"`, `"EUR 89.90"`, `"GBP 42.00"`, `"JPY 15000"`, `"CAD 10.00"`.
  - Bare numeric string with no symbol or code (e.g. `"1250"` or `"1,250.50"`): defaults to `USD`.
  - Strip commas (`,`) from the numeric portion and parse with Python's `decimal.Decimal`.
  - Currency code must exist in `fx_rates.json` and parsed amount must be finite and `>= 0`.
- Convert each item's `unit_price` to integer USD cents using `Decimal` with **`ROUND_HALF_UP`**:
  ```python
  unit_price_usd_cents = int(
      (amount * Decimal(fx_rates[currency]) * Decimal("100")).quantize(
          Decimal("1"), rounding=ROUND_HALF_UP
      )
  )
  ```
- Compute each migrated order's **`orders.total_usd_cents`** as the exact sum of its normalized line items:
  ```python
  total_usd_cents = sum(qty * unit_price_usd_cents for item in items)
  ```

### 3. Order Validation & Quarantine (`output/quarantine.jsonl`)
Process `orders_legacy` rows in ascending `id` order and evaluate rejection checks in this exact order:
1. **`"orphaned_user"`**: `orders_legacy.user_id` does not exist in `users_legacy`.
2. **`"invalid_items_json"`**: `items_json` fails JSON parsing or is not a **non-empty** JSON list.
3. **`"invalid_item"`**: Any entry in the items list is not a JSON object, has an empty/non-string `sku`, has a non-integer or `<= 0` `qty` (reject booleans), or has an invalid/negative/unknown-currency `unit_price`.

- Valid orders are inserted into `orders` (with remapped canonical `user_id` and computed `total_usd_cents`) and all of their items are inserted into `order_items`.
- Rejected orders are **not** inserted into `orders` or `order_items`. Instead, write every rejected order to `--quarantine` (UTF-8, LF `\n` line endings), sorted ascending by `order_id`, one JSON object per line:
  ```json
  {"order_id": 105, "user_id": 999, "reason": "orphaned_user", "raw_record": {"id": 105, "user_id": 999, "status": "paid", "total_raw": "$50.00", "items_json": "[...]", "created_at": "..."}}
  ```

### 4. True Idempotency & Atomicity
- Perform the SQLite migration atomically within a transaction.
- Running `python migrate.py` a **second** (or Nth) time against an already-migrated database must:
  - Exit with status code `0`.
  - Keep exact identical row counts and sums in `users`, `orders`, `order_items`, and `schema_migrations` (zero duplicate rows in `order_items` or any other table!).
  - Produce the exact same `--quarantine` JSONL file (overwrite, never append).
  - Pass `PRAGMA foreign_key_check` with zero violations.

## Constraints
- Use only the Python 3 standard library (`sqlite3`, `decimal`, `json`, `argparse`, etc.).
- Do not modify `users_legacy`, `orders_legacy`, or `fx_rates.json`.
- Work only inside the current working directory.
