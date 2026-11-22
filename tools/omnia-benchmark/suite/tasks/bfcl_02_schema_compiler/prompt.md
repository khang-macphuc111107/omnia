# Task: Paginated API Reconciliation & Strict Schema Compilation (`bfcl_02_schema_compiler`)

Compile a verified multi-warehouse, multi-currency inventory reconciliation report as of **`2026-10-01`**, save it to `reconciliation.json` in the workspace root, and submit it through `catalog_tool.py`.

## Environment & Rules

1. Retrieve **all** data exclusively via `python catalog_tool.py <subcommand> ...` (see `README.md`):
   - Paginate `python catalog_tool.py list-products --cursor ...` until `next_cursor` is `null`.
   - Paginate `python catalog_tool.py list-warehouses --cursor ...` until `next_cursor` is `null`.
   - Paginate `python catalog_tool.py list-suppliers --cursor ...` until `next_cursor` is `null`.
   - Fetch FX rates via `python catalog_tool.py get-fx-rates --as-of 2026-10-01`.
2. **Handle HTTP 429 rate limits cleanly**: Some pages return a transient retryable rate-limit error (`"error": "RATE_LIMITED"`, `"http_status": 429`, exit code 1) on the first request. Retry the **same cursor** until it succeeds.
3. **NEVER** modify `catalog_tool.py`, `schema_spec.json`, or read/modify `.catalog_state.db` directly. Every tool call is cryptographically HMAC-chained inside `.catalog_state.db`.
4. After writing `reconciliation.json` in the workspace root, submit it via:
   ```powershell
   python catalog_tool.py submit-reconciliation --payload-file reconciliation.json
   ```
   Confirm `submit-reconciliation` exits `0` with `"ok": true`.

## Exact Reconciliation & Rounding Rules

Read `schema_spec.json` for the complete Draft-07 schema (`additionalProperties: false` at **every** level — zero extra keys permitted!).

1. **Inactive Product Exclusion**:
   - Any product with `"active": false` MUST be **excluded** from `items` and from all unit/USD summary totals.
   - Record the count of excluded inactive products in `summary.excluded_inactive_count`.
2. **Physical Stock Aggregation**:
   - For each active product, `physical_stock` is the sum of its quantities across **all** warehouses across all warehouse pages (treat an omitted SKU in a warehouse as `0`).
   - `discrepancy_units = physical_stock - expected_stock`.
   - `status`:
     - `"match"` if `discrepancy_units == 0`
     - `"shortage"` if `discrepancy_units < 0`
     - `"surplus"` if `discrepancy_units > 0`
3. **Supplier Risk Flag**:
   - Join each active product's `supplier_id` against the paginated supplier list.
   - `supplier_status` is the supplier's status (`"active"` or `"suspended"`).
   - `supplier_risk` is `true` iff `supplier_status == "suspended"`, otherwise `false`.
4. **Exact USD Valuation & Rounding (`Decimal` + `ROUND_HALF_UP`)**:
   - Compute using exact decimal arithmetic (`decimal.Decimal`) **before** rounding, using `rate_to_usd` from `get-fx-rates --as-of 2026-10-01`:
     - `physical_value_usd = (Decimal(physical_stock) * Decimal(str(unit_price)) * Decimal(str(rate_to_usd))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`
     - `discrepancy_value_usd = (Decimal(discrepancy_units) * Decimal(str(unit_price)) * Decimal(str(rate_to_usd))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`
   - Note: Python `decimal.ROUND_HALF_UP` rounds half-cent ties away from zero (e.g., `5.025 -> 5.03`, `-14.105 -> -14.11`). Do NOT use IEEE-754 float `round()` (banker's rounding).
5. **Summary Aggregates** (active items ONLY):
   - `active_product_count`: count of active items in `items`
   - `excluded_inactive_count`: count of excluded inactive products
   - `match_count`, `shortage_count`, `surplus_count`: counts of active items by `status`
   - `supplier_risk_count`: count of active items with `supplier_risk == true`
   - `total_expected_units`: sum of `expected_stock` across active items
   - `total_physical_units`: sum of `physical_stock` across active items
   - `total_physical_value_usd`: sum of the **rounded** per-item `physical_value_usd` values across active items (quantized to 2 decimal places)
   - `net_discrepancy_value_usd`: sum of the **rounded** per-item `discrepancy_value_usd` values across active items (quantized to 2 decimal places)
6. **Ordering & Metadata**:
   - `schema_version`: `"1.0"`
   - `as_of_date`: `"2026-10-01"`
   - `generated_at`: valid ISO-8601 UTC timestamp matching `YYYY-MM-DDTHH:MM:SSZ`
   - `base_currency`: `"USD"`
   - `items`: strictly sorted lexicographically ascending by `product_id` (`SKU-101`, `SKU-102`, ...).
