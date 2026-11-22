import time

class ConcurrentCounter:
    def __init__(self) -> None:
        self.totals: dict[str, int] = {}

    def add(self, key: str, delta: int) -> None:
        # BUG 4: unsynchronized read-modify-write race
        cur = self.totals.get(key, 0)
        time.sleep(0.0001)
        self.totals[key] = cur + delta
