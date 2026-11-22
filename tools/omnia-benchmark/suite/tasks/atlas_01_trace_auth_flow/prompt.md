# Task: Cross-Service Architecture & Execution Trace (`atlas_01_trace_auth_flow`)

You are auditing the **Nimbus Cloud** multi-language monorepo in the current working directory (`services/gateway/`, `services/auth/`, `services/billing/`, `services/worker/`, `shared/protocol/`, `config/`).

Work **strictly inside the current working directory**. Do **NOT** modify any existing repository files. Your sole deliverable is a single JSON file written to `./answer.json` answering 6 architectural tracing questions with exact file paths (POSIX forward slashes, workspace-relative, e.g. `services/auth/token_service.py`), exact symbol names, and 1-indexed inclusive line ranges (`line_start`, `line_end`).

---

## Questions to Answer in `answer.json`

1. **`gateway_middleware_order`**: Trace the exact runtime execution order of the 6 middleware functions registered for the production gateway pipeline (`services/gateway/`). Cite the top-level pipeline registration function (`registration_entrypoint`) AND the ordered 6-element `middlewares` array, where each element gives the exact middleware function `name`, `file`, `line_start`, and `line_end` covering its implementation.
2. **`token_refresh_race`**: Locate the refresh-token rotation race condition in `services/auth/`. Provide the exact `file`, `symbol` (e.g. `ClassName.method_name`), the function's `line_start`/`line_end`, the exact 1-indexed line number where the refresh record is read (`redis_read_line`), the exact 1-indexed line number where it is marked used (`redis_mark_used_line`), and `root_cause` (exact classification string `"non_atomic_check_then_act"`).
3. **`redis_ttl_precedence`**: Trace how Redis session TTLs are resolved across the 3 configuration layers (`"defaults"`, `"env"`, `"tenant_override"`) in `prod`. Provide:
   - `precedence_order`: 3-element array ordering those three layer names from lowest to highest precedence
   - `config_files`: exact workspace-relative paths for `defaults`, `env_prod`, and `tenants`
   - `resolver`: `{ "file", "symbol", "line_start", "line_end" }` of the Python method resolving the TTL
   - `prod_clamp_bounds`: `{ "min_ttl_sec": int, "max_ttl_sec": int }`
   - `effective_prod_ttl_sec`: exact computed integer TTL in seconds under `env_name="prod"` for `"tnt_acme"`, `"tnt_globex"`, `"tnt_initech"`, and `"tnt_umbrella"`.
4. **`http_error_mapping`**: Trace how upstream/limiter gateway errors map to HTTP `429` vs `503`. Provide `{ "file", "symbol", "line_start", "line_end" }` of the mapping function, the exact line ranges of the `429` branch (`branch_429`) and `503` branch (`branch_503`), and the exact sets of error code strings mapped to `codes_429` and `codes_503`.
5. **`dlq_retry_backoff`**: Trace the worker DLQ retry backoff calculation and merged `prod` configuration. Provide:
   - `formula_location`: `{ "file", "symbol", "line_start", "line_end" }` of the backoff formula function
   - `config_files`: sorted list of config files merged to compute prod worker DLQ settings
   - `prod_params`: `{ "base_delay_sec": int, "backoff_multiplier": int, "max_delay_sec": int, "max_attempts": int, "jitter_pct": float }`
   - `retry_delays_before_dlq_sec`: ordered list of exact unjittered retry delays (in seconds, as integers/numbers) scheduled by `DlqProcessor.schedule_retry_or_dlq` for a failing job starting at `attempt: 1` before it is dead-lettered under `prod` config
   - `dlq_key`: exact Redis DLQ key string.
6. **`subscription_state_mutators`**: Identify the **complete, exact set** of workspace files containing application code that directly executes a SQL `INSERT` or `UPDATE` statement mutating `subscriptions.subscription_state` (exclude schema DDL files and read-only consumers). Provide an array of objects, each with `{ "file", "symbols": [str, ...], "line_ranges": [{"symbol": str, "line_start": int, "line_end": int}, ...] }`.

---

## Required `answer.json` Schema

Write valid UTF-8 JSON to `./answer.json` matching this exact structure:

```json
{
  "gateway_middleware_order": {
    "registration_entrypoint": {
      "file": "services/gateway/src/...",
      "symbol": "...",
      "line_start": 1,
      "line_end": 10
    },
    "middlewares": [
      {
        "name": "...",
        "file": "services/gateway/src/...",
        "line_start": 1,
        "line_end": 10
      }
    ]
  },
  "token_refresh_race": {
    "file": "services/auth/...",
    "symbol": "...",
    "line_start": 1,
    "line_end": 10,
    "redis_read_line": 1,
    "redis_mark_used_line": 2,
    "root_cause": "non_atomic_check_then_act"
  },
  "redis_ttl_precedence": {
    "precedence_order": ["<lowest_layer>", "<middle_layer>", "<highest_layer>"],
    "config_files": {
      "defaults": "config/...",
      "env_prod": "config/...",
      "tenants": "config/..."
    },
    "resolver": {
      "file": "services/auth/...",
      "symbol": "...",
      "line_start": 1,
      "line_end": 10
    },
    "prod_clamp_bounds": {
      "min_ttl_sec": 0,
      "max_ttl_sec": 0
    },
    "effective_prod_ttl_sec": {
      "tnt_acme": 0,
      "tnt_globex": 0,
      "tnt_initech": 0,
      "tnt_umbrella": 0
    }
  },
  "http_error_mapping": {
    "file": "services/gateway/src/...",
    "symbol": "...",
    "line_start": 1,
    "line_end": 10,
    "branch_429": { "line_start": 1, "line_end": 2 },
    "branch_503": { "line_start": 3, "line_end": 4 },
    "codes_429": ["..."],
    "codes_503": ["..."]
  },
  "dlq_retry_backoff": {
    "formula_location": {
      "file": "services/worker/...",
      "symbol": "...",
      "line_start": 1,
      "line_end": 10
    },
    "config_files": ["config/...", "config/..."],
    "prod_params": {
      "base_delay_sec": 0,
      "backoff_multiplier": 0,
      "max_delay_sec": 0,
      "max_attempts": 0,
      "jitter_pct": 0.0
    },
    "retry_delays_before_dlq_sec": [0],
    "dlq_key": "..."
  },
  "subscription_state_mutators": [
    {
      "file": "services/...",
      "symbols": ["..."],
      "line_ranges": [
        { "symbol": "...", "line_start": 1, "line_end": 10 }
      ]
    }
  ]
}
```
