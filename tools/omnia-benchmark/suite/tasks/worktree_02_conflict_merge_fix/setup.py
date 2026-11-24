import argparse, subprocess
from pathlib import Path

def _w(p: Path, s: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8", newline="\n")

def _git(ws: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(ws), check=True, capture_output=True)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    _git(ws, "init", "-b", "main")
    _git(ws, "config", "user.name", "Bench Setup")
    _git(ws, "config", "user.email", "bench@example.test")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "base gateway")

    # Branch 1: feat/rate-limiter
    _git(ws, "checkout", "-b", "feat/rate-limiter")
    _w(ws / "gateway" / "config.py", "class GatewayConfig:\n    def __init__(self, service_name: str = 'gw', rate_limit: int = 2, window_ms: int = 1000) -> None:\n        self.service_name = service_name\n        self.rate_limit = rate_limit\n        self.window_ms = window_ms\n")
    _w(ws / "gateway" / "limiter.py", """class SlidingLimiter:
    def __init__(self, limit: int, window_ms: int) -> None:
        self.limit = limit
        self.window_ms = window_ms
        self._hits: dict[str, list[int]] = {}

    def allow(self, key: str, ts_ms: int) -> bool:
        arr = [t for t in self._hits.get(key, []) if ts_ms - t < self.window_ms]
        # BUG if someone records denied hits into arr, so only append when allowed!
        if len(arr) >= self.limit:
            self._hits[key] = arr
            return False
        arr.append(ts_ms)
        self._hits[key] = arr
        return True
""")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "feat: sliding window rate limiter")

    # Branch 2: feat/audit-hmac (off main -> conflicts on gateway/config.py)
    _git(ws, "checkout", "main")
    _git(ws, "checkout", "-b", "feat/audit-hmac")
    _w(ws / "gateway" / "config.py", "class GatewayConfig:\n    def __init__(self, service_name: str = 'gw', audit_hmac_key: str = 'dummy_gw_key') -> None:\n        self.service_name = service_name\n        self.audit_hmac_key = audit_hmac_key\n")
    _w(ws / "gateway" / "audit.py", """import hashlib, hmac, json

class AuditLogger:
    def __init__(self, hmac_key: str) -> None:
        self.hmac_key = hmac_key.encode("utf-8")
        self.entries: list[dict] = []

    def record(self, req_id: str, decision: str) -> dict:
        msg = json.dumps({"req_id": req_id, "decision": decision}, separators=(",", ":"), sort_keys=True)
        sig = hmac.new(self.hmac_key, msg.encode("utf-8"), hashlib.sha256).hexdigest()
        entry = {"req_id": req_id, "decision": decision, "sig": sig}
        self.entries.append(entry)
        return entry
""")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "feat: audit hmac logger")

    _git(ws, "checkout", "main")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
