MAX_SESSION_TTL_S = 3600
def resolve_ttl_01(requested_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    return min(max(60, requested_s), cap_s)
