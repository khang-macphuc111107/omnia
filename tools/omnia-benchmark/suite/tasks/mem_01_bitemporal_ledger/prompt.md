# Task: Reconstruct Bi-Temporal Policy Rules Across Multi-Session History

Inspect the chronological session transcripts in `logs/` (`session_01.jsonl` .. `session_06.jsonl`).
Across these 6 sessions (~95 KB of interleaved engineering chatter, dead-end proposals, and policy updates), authorization thresholds, tier multipliers, region exclusions, and hold periods changed over time — some rules were **retracted** or **superseded** with explicit `effective_from` / `invalid_at` timestamps.

Implement `evaluate_order(order: dict, as_of_utc: str) -> dict` in `policy_engine/validator.py` so it evaluates orders using ONLY the policy rules valid at `as_of_utc` (inclusive `effective_from <= as_of_utc < invalid_at`, ignoring retracted proposals):

Required return schema:
```python
{
    "decision": "APPROVE" | "MANUAL_HOLD" | "REJECT",
    "reason": str,          # short machine tag e.g. "ok", "blocked_region", "above_auto_limit", "below_min_amount"
    "fee_cents": int,       # integer fee rounded half-up
    "hold_hours": int,      # 0 for APPROVE/REJECT, configured hold window for MANUAL_HOLD
    "active_policy_rev": str,
}
```
Run `python -m unittest discover -s tests` to confirm baseline public tests, and make sure both historical time-travel queries (`as_of_utc` in early vs mid vs latest dates) and current rules work cleanly without editing `tests/`.
