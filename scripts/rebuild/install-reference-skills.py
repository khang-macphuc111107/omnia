#!/usr/bin/env python3
"""Validate the pinned Omnia skill snapshots without executing their scripts.

This helper intentionally does not install or update network content. Host
installation is performed through the official Codex skill-installer helper;
this command checks that the project mirror and lock file still agree.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "docs" / "rebuild" / "skills.lock.json"
MIRROR = ROOT / ".agents" / "skills" / "upstream"


def main() -> int:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    records = lock.get("skills", [])
    errors: list[str] = []
    for record in records:
        name = record.get("name")
        path = MIRROR / str(name) / "SKILL.md"
        if not path.is_file():
            errors.append(f"missing:{name}")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != record.get("skillSha256"):
            errors.append(f"hash:{name}")
    expected = {str(record.get("name")) for record in records}
    actual = {path.name for path in MIRROR.iterdir() if path.is_dir()}
    for extra in sorted(actual - expected):
        errors.append(f"unlocked-extra:{extra}")
    result = {
        "status": "pass" if not errors else "fail",
        "lockedSkillCount": len(records),
        "mirrorDirectoryCount": len(actual),
        "errors": errors,
        "scope": "project mirror only; does not prove host activation or skill quality",
    }
    print(json.dumps(result, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
