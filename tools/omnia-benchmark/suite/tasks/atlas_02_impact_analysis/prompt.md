# Task: Breaking Protocol Change Impact Analysis (`atlas_02_impact_analysis`)

You are performing a pre-migration architectural impact audit on the **Nimbus Cloud** monorepo in the current working directory (`services/gateway/`, `services/auth/`, `services/billing/`, `services/worker/`, `shared/protocol/`, `config/`).

Work **strictly inside the current working directory**. Do **NOT** modify any existing repository files. Your sole deliverable is a single JSON report written to `./impact_report.json`.

---

## Proposed 3-Part Breaking Protocol & Schema Change

Engineering proposes shipping three coordinated wire-protocol and schema breaking changes:

1. **`tenant_tier_rename`**: Rename all `tenant_tier` (and `subscriptions.plan_tier`) enum values from `["free", "pro", "enterprise"]` to `["starter", "growth", "scale"]`.
2. **`invoice_amount_split`**: Remove the single integer field `invoice.amount_cents` from invoice payloads, wire DTOs, and database schema, replacing it with two fields: `subtotal_cents` + `tax_cents`.
3. **`webhook_hmac_header_rename`**: Rename the webhook HMAC signature HTTP header from `"X-Nimbus-Signature-V1"` to `"X-Nimbus-HMAC-SHA256"`.

---

## Required Analysis in `impact_report.json`

Use workspace-relative POSIX file paths (forward slashes, e.g. `services/worker/reconciler.py`) and 1-indexed inclusive line numbers (`line_start`, `line_end`). Do NOT cite non-existent files, symbols, or out-of-bounds line numbers — hallucinations are strictly penalized.

1. **`breaking_changes`**: For each of the 3 change IDs (`tenant_tier_rename`, `invoice_amount_split`, `webhook_hmac_header_rename`), list every affected file across `shared/protocol/`, `config/`, and `services/` (excluding `README.md`) in `affected_locations` with exact `file`, `symbol` (function/method/class/enum/table/config-key name appearing in that file), `line_start`, `line_end`, and concise `impact_summary`.
2. **`silent_failure_traps`**: Identify **every code consumer that would FAIL SILENTLY** (producing corrupted values, silently downgrading tiers/rate limits, computing `$0`, or bypassing signature checks instead of raising an exception or returning a 4xx/5xx error) if the breaking changes are deployed without updating that consumer. Include exact `change_id`, `file`, `symbol`, `line_start`, `line_end`, and `fallback_behavior`. Do NOT include consumers that fail loudly (e.g., raising `KeyError`, `ValueError`, returning HTTP 401, or violating SQL `CHECK` constraints).
3. **`serialization_boundaries`**: Identify the cross-service / storage serialization & wire-protocol boundaries impacted by these 3 changes (JWT claim serialization, Python/TypeScript invoice wire serialization, billing-to-worker queue JSON envelopes, and outbound/forwarded webhook HTTP headers). Include `boundary_type` (`"jwt"`, `"http_header"`, `"http_json"`, `"queue_json"`, `"db_sql"`, `"wire_dict"`, or `"schema"`), `file`, `symbol`, `line_start`, `line_end`, and `affected_changes` (non-empty subset of the 3 change IDs).
4. **`zero_downtime_rollout_order`**: Using expand-and-contract deployment (storage schema first, then deploying dual-read/dual-accept downstream consumers strictly before upstream producers begin emitting v2-only values), give the exact topological deployment order of these 5 units:
   - `"billing_db"` (PostgreSQL expand migration in `services/billing/db/schema.sql`)
   - `"worker"` (`services/worker/`)
   - `"billing"` (`services/billing/`)
   - `"gateway"` (`services/gateway/`)
   - `"auth"` (`services/auth/`)
   Also provide `rollout_rationale` listing at least the 4 consecutive `before` -> `after` producer/consumer dependency edges explaining why each deployment unit in `zero_downtime_rollout_order` must deploy before the next.

---

## Required `impact_report.json` Schema

Write valid UTF-8 JSON to `./impact_report.json`:

```json
{
  "breaking_changes": {
    "tenant_tier_rename": {
      "affected_locations": [
        {
          "file": "<relative/path>",
          "symbol": "<symbol_or_key>",
          "line_start": 1,
          "line_end": 10,
          "impact_summary": "..."
        }
      ]
    },
    "invoice_amount_split": {
      "affected_locations": [
        {
          "file": "<relative/path>",
          "symbol": "<symbol_or_key>",
          "line_start": 1,
          "line_end": 10,
          "impact_summary": "..."
        }
      ]
    },
    "webhook_hmac_header_rename": {
      "affected_locations": [
        {
          "file": "<relative/path>",
          "symbol": "<symbol_or_key>",
          "line_start": 1,
          "line_end": 10,
          "impact_summary": "..."
        }
      ]
    }
  },
  "silent_failure_traps": [
    {
      "change_id": "tenant_tier_rename | invoice_amount_split | webhook_hmac_header_rename",
      "file": "<relative/path>",
      "symbol": "<symbol>",
      "line_start": 1,
      "line_end": 10,
      "fallback_behavior": "..."
    }
  ],
  "serialization_boundaries": [
    {
      "boundary_type": "jwt | http_header | http_json | queue_json | db_sql | wire_dict | schema",
      "file": "<relative/path>",
      "symbol": "<symbol>",
      "line_start": 1,
      "line_end": 10,
      "affected_changes": ["tenant_tier_rename"]
    }
  ],
  "zero_downtime_rollout_order": [
    "<unit_1>",
    "<unit_2>",
    "<unit_3>",
    "<unit_4>",
    "<unit_5>"
  ],
  "rollout_rationale": [
    {
      "before": "<unit_1>",
      "after": "<unit_2>",
      "reason": "..."
    }
  ]
}
```
