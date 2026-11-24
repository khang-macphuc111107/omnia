from contracts import Envelope

class Notifier:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def send(self, env: Envelope) -> bool:
        # BUG: drops trace_id and fails to deduplicate (tenant_id, trace_id)
        self.sent.append({"tenant_id": env.tenant_id, "payload": env.payload})
        return True
