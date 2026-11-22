# Task: Fix Token-Bucket Rate Limiter (Burst Cap, Fractional Refill & Retry-After)

Fix all bugs in `ratelimit/bucket.py` so `python -m unittest discover -s tests -v` and hidden edge-case tests pass:
1. `allow(key, cost=1.0)` must refill tokens at `rate_per_sec * elapsed`, capped at `capacity` (`burst`), and must NOT consume tokens if `cost > available`.
2. If `cost > capacity`, `allow()` must return `(False, float('inf'))` immediately (impossible request).
3. When rejected (`available < cost <= capacity`), return `(False, retry_after_s)` where `retry_after_s = (cost - available) / rate_per_sec` (exact remaining wait seconds, not `cost / rate_per_sec`!).
4. Backward clock jumps (`now < last_ts`) must not subtract tokens (clamp `elapsed = max(0.0, now - last_ts)`).
