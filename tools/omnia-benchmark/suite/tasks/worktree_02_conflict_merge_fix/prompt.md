# Task: Merge Two Conflicting Feature Branches Onto `main` and Fix Interaction Bug

This Git repository has two unmerged feature branches alongside `main`:
- `feat/rate-limiter`: adds sliding-window rate limiting (`gateway/limiter.py` + `gateway/config.py`)
- `feat/audit-hmac`: adds HMAC-SHA256 audit logging (`gateway/audit.py` + `gateway/config.py`)

Your job:
1. Merge BOTH `feat/rate-limiter` AND `feat/audit-hmac` onto `main` (so `main` contains both branches' Git ancestry, with zero leftover conflict markers).
2. Wire `gateway/server.py` (`Gateway.handle(req)`) so:
   - Both `ALLOWED` AND rate-limit `DENIED` requests emit signed audit records via `AuditLogger`.
   - Rate-limited `DENIED` requests do NOT consume/advance the sliding-window allowed quota!
   - Preserve merged `GatewayConfig` fields from both branches (`rate_limit`, `window_ms`, `audit_hmac_key`).
3. Commit your resolved integration on `main` and verify all tests pass cleanly.
