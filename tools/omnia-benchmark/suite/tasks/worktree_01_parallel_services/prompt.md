# Task: Migrate 3 Independent Packages onto Envelope v2 Contract

`contracts/envelope.py` was upgraded to require `trace_id`, `tenant_id`, and `issued_at_ms` (and HMAC signature validation).
Three disjoint packages (`packages/billing/service.py`, `packages/auth/service.py`, `packages/notify/service.py`) are currently broken:
1. `packages/billing/service.py`: uses float USD (`amount * 1.07`) causing rounding errors and calls old `Envelope(...)` positional signature; fix to integer cents half-up (`(amount_cents * 107 + 50) // 100`) and pass `trace_id`, `tenant_id`, `issued_at_ms`.
2. `packages/auth/service.py`: ignores expired tokens (`now_ms - issued_at_ms > ttl_ms`) and leaks raw bearer strings inside ValueError messages; enforce expiry and mask secrets (`"[REDACTED]"`).
3. `packages/notify/service.py`: drops `trace_id` when constructing outbound notifications and retries failed deliveries indefinitely without deduplicating by `(tenant_id, trace_id)`.

Run `python -m unittest discover -s tests` to inspect failing tests and fix all 3 packages cleanly without editing `tests/` or `contracts/`.
