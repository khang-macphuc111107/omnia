import json
from pathlib import Path

def write_summary(path: Path, data: dict) -> None:
    # BUG 5: ascii encoding, default CRLF on Windows, non-atomic write
    with open(path, "w") as f:
        f.write(json.dumps(data, ensure_ascii=True))
