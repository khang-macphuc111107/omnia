# Catalog & Inventory Reconciliation CLI (`catalog_tool.py`)

`catalog_tool.py` provides paginated read access to products, warehouse physical stock counts, supplier records, and FX rates, plus a strict Draft-07 schema-validated submission endpoint. Every command prints a single JSON object to stdout and records a signed entry in `.catalog_state.db`.

> **Important:** Do NOT edit `catalog_tool.py`, `schema_spec.json`, or `.catalog_state.db` directly. Always fetch data and submit your final reconciliation exclusively through `python catalog_tool.py <subcommand>`.

## Subcommands

1. **List products** (paginated; follow `next_cursor` until `null`)
   ```powershell
   python catalog_tool.py list-products --cursor p1
   ```

2. **List warehouses** (paginated; follow `next_cursor` until `null`)
   ```powershell
   python catalog_tool.py list-warehouses --cursor w1
   ```

3. **List suppliers** (paginated; follow `next_cursor` until `null`)
   ```powershell
   python catalog_tool.py list-suppliers --cursor s1
   ```

4. **Fetch FX conversion rates to USD** (`--as-of YYYY-MM-DD`)
   ```powershell
   python catalog_tool.py get-fx-rates --as-of YYYY-MM-DD
   ```

5. **Submit compiled reconciliation payload** (validates strictly against `schema_spec.json`)
   ```powershell
   python catalog_tool.py submit-reconciliation --payload-file reconciliation.json
   ```

## Rate Limiting & Retries

Some paginated endpoints may return a transient HTTP 429 error (`"error": "RATE_LIMITED"`, `"retryable": true`, exit code 1). Retry the **same cursor** to retrieve that page cleanly.

## Workspace Files

- `catalog_tool.py` — Audited catalog API CLI (read-only)
- `schema_spec.json` — Strict Draft-07 JSON Schema for `reconciliation.json` (read-only)
- `.catalog_state.db` — SQLite state & HMAC audit log managed exclusively by `catalog_tool.py`
