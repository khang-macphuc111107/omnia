import sys
from telemetry import RollingWindowStats

def main() -> int:
    # Emit ~155 KB of noisy passing packet traces before the failing boundary assertion
    for i in range(2100):
        print(f"[TRACE {i:04d}] packet_seq={i} status=OK payload=0x{i*2654435761 & 0xffffffff:08x} route=edge-ap-southeast-1 checksum=VALID")
    w = RollingWindowStats(window_ms=100)
    w.push(1000, 10)
    w.push(1050, 20)
    w.push(1100, 30)  # inclusive window [1000, 1100] MUST still retain ts=1000!
    if w.total() != 60 or w.count() != 3:
        print(f"FAIL: check_inclusive_window_boundary expected total=60 count=3 got total={w.total()} count={w.count()}")
        return 1
    w.push(1101, 5)  # now ts=1000 is strictly older than 1101 - 100 = 1001 -> evicted!
    if w.total() != 55 or w.count() != 3:
        print(f"FAIL: check_evict_strictly_older expected total=55 count=3 got total={w.total()} count={w.count()}")
        return 1
    print("ALL_NOISY_TESTS_PASS")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
