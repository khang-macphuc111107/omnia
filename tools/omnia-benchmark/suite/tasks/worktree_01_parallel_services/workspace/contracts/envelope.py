from dataclasses import dataclass

@dataclass(frozen=True)
class Envelope:
    trace_id: str
    tenant_id: str
    issued_at_ms: int
    payload: dict
