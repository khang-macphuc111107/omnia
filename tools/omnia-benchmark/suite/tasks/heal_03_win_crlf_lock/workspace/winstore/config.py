import json
from pathlib import Path

def load_rules(path: Path) -> dict:
    # BUG 1: fails on UTF-8 BOM
    return json.loads(Path(path).read_text(encoding="utf-8"))
