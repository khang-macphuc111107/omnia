MAX_SESSION_TTL_S = 3600
def old_compute_ttl_3(tenant_ttl_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    return max(tenant_ttl_s, cap_s)
