# Task: Deep Monorepo Production Defect Audit (110+ Files)

This workspace contains a large polyglot monorepo (`services/` plus `legacy_deprecated/`).
`config/production_wiring.json` lists the **active production entrypoints**. Files under `legacy_deprecated/` and `test_fixtures/` are **NOT** deployed in production (ignore decoys there!).

Find the **3 active production defects** across the active services:
1. `auth_ttl_override`: Active auth module where a tenant TTL override accidentally uses `max()` instead of `min()` (allowing a tenant to exceed the global hard cap `MAX_SESSION_TTL_S`).
2. `billing_retry_storm`: Active billing module where retry multiplier amplifies exponentially without respecting `MAX_RETRY_DELAY_MS` cap.
3. `events_silent_dlq_drop`: Active events module where failed dead-letter events are silently dropped (`return None`) when `dlq_queue` is full instead of raising `DeadLetterOverflowError`.

Do NOT modify any source files. Write your findings to `audit_report.json` at the workspace root with this exact JSON schema:
```json
{
  "defects": {
    "auth_ttl_override": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    },
    "billing_retry_storm": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    },
    "events_silent_dlq_drop": {
      "file": "relative/posix/path",
      "symbol": "function_name",
      "line": 12
    }
  }
}
```
`line` must be the exact 1-based line number of the buggy statement (tolerance ±2 lines).
