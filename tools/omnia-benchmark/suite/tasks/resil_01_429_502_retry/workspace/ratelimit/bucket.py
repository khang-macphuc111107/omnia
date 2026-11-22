from typing import Callable, Tuple

class TokenBucketLimiter:
    def __init__(self, rate_per_sec: float, capacity: float, clock: Callable[[], float]) -> None:
        self.rate = float(rate_per_sec)
        self.capacity = float(capacity)
        self.clock = clock
        self._state: dict[str, Tuple[float, float]] = {}

    def allow(self, key: str, cost: float = 1.0) -> Tuple[bool, float]:
        now = self.clock()
        tokens, last_ts = self._state.get(key, (self.capacity, now))
        # BUGS: no negative elapsed clamp, no burst cap, consumes on reject, wrong retry_after
        tokens = tokens + (now - last_ts) * self.rate
        if tokens >= cost:
            self._state[key] = (tokens - cost, now)
            return True, 0.0
        self._state[key] = (tokens, now)
        return False, cost / self.rate
