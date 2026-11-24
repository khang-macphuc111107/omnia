def normalize_tenant(headers: dict) -> str:
    for k, v in headers.items():
        if k.lower() == "x-tenant-id":
            return v
    return ""

def execute_idempotent_post(client_fn) -> dict:
    # BUG: only tries once instead of retry_budget=4 on 429/503
    return client_fn()
