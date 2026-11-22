from collections import deque

class RollingWindowStats:
    def __init__(self, window_ms: int) -> None:
        self.window_ms = int(window_ms)
        self._buf: deque[tuple[int, int]] = deque()
        self._sum = 0

    def push(self, ts_ms: int, value: int) -> None:
        self._buf.append((ts_ms, value))
        self._sum += value
        cutoff = ts_ms - self.window_ms
        # BUG: uses <= instead of < (evicts exact boundary ts == ts_ms - window_ms)
        # AND uses pop() instead of popleft() when > 100 items trigger burst trim!
        while self._buf and self._buf[0][0] <= cutoff:
            _, v = self._buf.popleft()
            self._sum -= v

    def total(self) -> int:
        return self._sum

    def count(self) -> int:
        return len(self._buf)
