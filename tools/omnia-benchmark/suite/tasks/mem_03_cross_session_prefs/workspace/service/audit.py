def format_audit_record(tenant_id: str, event: dict) -> dict:
    # BUG: forgets tenant normalization and leaks token/secret/authorization keys
    return {"tenant_id": tenant_id, "event": dict(event)}
