def verify_session(token: str, issued_at_ms: int, now_ms: int, ttl_ms: int = 60000) -> dict:
    # BUG: leaks raw token in exception and ignores expiry
    if not token.startswith("tok_"):
        raise ValueError(f"invalid token: {token}")
    return {"ok": True, "age_ms": now_ms - issued_at_ms}
