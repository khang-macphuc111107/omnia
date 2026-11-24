from .config import GatewayConfig

class Gateway:
    def __init__(self, cfg: GatewayConfig) -> None:
        self.cfg = cfg

    def handle(self, req: dict) -> dict:
        return {'decision': 'ALLOWED', 'audit': None}
