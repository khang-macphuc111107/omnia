def evaluate_order(order: dict, as_of_utc: str) -> dict:
    # BUG: hardcoded stale placeholder ignoring bi-temporal history in logs/
    return {
        "decision": "MANUAL_HOLD",
        "reason": "unimplemented",
        "fee_cents": 0,
        "hold_hours": 99,
        "active_policy_rev": "rev-0",
    }
