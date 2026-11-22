import json, zlib
from pathlib import Path

class WalCorruptionError(RuntimeError):
    pass

def _crc(payload: str) -> str:
    return f"{zlib.crc32(payload.encode('utf-8')) & 0xffffffff:08x}"

def append_op(path: Path, op: str, key: str, value=None) -> None:
    payload = f"{op}|{key}|{json.dumps(value, separators=(',', ':'))}"
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(f"{_crc(payload)}|{payload}\n")

def replay(path: Path) -> dict:
    # BUG: skips CRC verification and crashes on truncated tail line
    state = {}
    if not Path(path).exists():
        return state
    for line in Path(path).read_text("utf-8").splitlines():
        if not line:
            continue
        _, op, key, val_raw = line.split("|", 3)
        if op == "SET":
            state[key] = json.loads(val_raw)
        elif op == "DEL":
            state.pop(key, None)
    return state

def compact(path: Path) -> int:
    # BUG: not implemented
    return 0
