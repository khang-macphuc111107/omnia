from contracts import Envelope

def create_invoice(trace_id: str, tenant_id: str, issued_at_ms: int, subtotal_cents: int) -> Envelope:
    # BUG: wrong positional args & float tax
    total = round(subtotal_cents * 1.07, 2)
    return Envelope(trace_id, total)
