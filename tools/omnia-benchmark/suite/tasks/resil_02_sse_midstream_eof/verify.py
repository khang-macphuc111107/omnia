#!/usr/bin/env python3
"""Hidden verifier for resil_02_sse_midstream_eof."""
from __future__ import annotations
import argparse, importlib, json, sys, tempfile
from pathlib import Path

TASK_ID = "resil_02_sse_midstream_eof"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "wal" or m.startswith("wal."):
            del sys.modules[m]
    checks = []
    def rec(name, fn):
        try:
            fn()
            checks.append({"name": name, "passed": True, "detail": "ok"})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    def chk_wal():
        mod = importlib.import_module("wal")
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "a.wal"
            mod.append_op(p, "SET", "z", {"v": 1})
            mod.append_op(p, "SET", "a", "hello|pipe")
            mod.append_op(p, "SET", "z", {"v": 2})
            mod.append_op(p, "DEL", "gone")
            # Tail partial write tolerated
            with open(p, "a", encoding="utf-8") as f:
                f.write("00000000|SET|x|{broken")
            assert mod.replay(p) == {"a": "hello|pipe", "z": {"v": 2}}
            # Compact rewrites cleanly sorted
            n = mod.compact(p)
            assert n == 2
            lines = p.read_text("utf-8").splitlines()
            assert len(lines) == 2
            assert mod.replay(p) == {"a": "hello|pipe", "z": {"v": 2}}
            # Mid-file corruption MUST raise WalCorruptionError
            badp = Path(td) / "bad.wal"
            mod.append_op(badp, "SET", "k1", 1)
            with open(badp, "a", encoding="utf-8") as f:
                f.write("00000000|SET|k2|999\n")
            mod.append_op(badp, "SET", "k3", 3)
            raised = False
            try:
                mod.replay(badp)
            except mod.WalCorruptionError:
                raised = True
            assert raised, "expected WalCorruptionError on non-final corrupted record"

    rec("wal_crc_truncation_and_compact", chk_wal)
    passed = all(c["passed"] for c in checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": 1.0 if passed else 0.0, "fail_to_pass": {"passed": int(passed), "total": 1}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
