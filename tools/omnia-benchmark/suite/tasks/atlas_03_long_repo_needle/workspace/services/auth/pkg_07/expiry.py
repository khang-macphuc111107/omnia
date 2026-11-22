"""Active Production Auth TTL Resolver (wired by config/production_wiring.json)."""
MAX_SESSION_TTL_S = 3600

def compute_effective_ttl(tenant_ttl_s: int, cap_s: int = MAX_SESSION_TTL_S) -> int:
    if tenant_ttl_s <= 0:
        return 60
    # DEFECT: uses max() instead of min(), letting tenant bypass global cap!
    effective = max(tenant_ttl_s, cap_s)
    return effective
