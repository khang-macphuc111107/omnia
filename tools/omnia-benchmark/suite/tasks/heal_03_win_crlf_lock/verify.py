#!/usr/bin/env python3
"""Hidden verifier for heal_03_win_crlf_lock."""
from __future__ import annotations
import argparse, importlib, json, subprocess, sys, tempfile, threading
from pathlib import Path

TASK_ID = "heal_03_win_crlf_lock"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    def rec(name: str, fn) -> None:
        try:
            fn()
            checks.append({"name": name, "passed": True, "detail": "ok"})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "detail": f"{type(exc).__name__}: {exc}"})

    p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_unittest", "passed": p.returncode == 0, "detail": "ok" if p.returncode == 0 else (p.stdout + p.stderr)[-500:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "winstore" or m.startswith("winstore."):
            del sys.modules[m]

    def chk_bom_and_crlf():
        cfg = importlib.import_module("winstore.config")
        ing = importlib.import_module("winstore.ingest")
        r = cfg.load_rules(ws / "config" / "rules.json")
        assert r["region"] == "Hà Nội"
        rows = ing.read_csv_rows(ws / "data" / "batch_01.csv")
        assert rows[0]["city"] == "Hà Nội" and "\r" not in rows[0]["city"]
        assert rows[1]["city"] == "Đà Nẵng" and "\r" not in rows[1]["city"]

    def chk_sqlite_concurrent():
        dbmod = importlib.import_module("winstore.db")
        with tempfile.TemporaryDirectory() as td:
            st = dbmod.EventStore(Path(td) / "c.db")
            errs = []
            def worker(wid):
                try:
                    for j in range(15):
                        st.record_batch([{"id": f"{wid}-{j}", "amount": j, "city": "Hà Nội"}])
                except Exception as e:
                    errs.append(e)
            ts = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
            for t in ts: t.start()
            for t in ts: t.join()
            assert not errs, f"sqlite errors: {errs[:3]}"
            assert st.count() == 90, f"expected 90, got {st.count()}"

    def chk_counter_race():
        agg = importlib.import_module("winstore.aggregator")
        c = agg.ConcurrentCounter()
        def worker():
            for _ in range(40):
                c.add("total", 1)
        ts = [threading.Thread(target=worker) for _ in range(8)]
        for t in ts: t.start()
        for t in ts: t.join()
        assert c.totals.get("total") == 320, f"race lost updates: got {c.totals.get('total')}"

    def chk_export_utf8_lf():
        exp = importlib.import_module("winstore.export")
        with tempfile.TemporaryDirectory() as td:
            outp = Path(td) / "summary.json"
            exp.write_summary(outp, {"city": "Hà Nội", "lines": ["a", "b"]})
            raw = outp.read_bytes()
            assert b"\r\n" not in raw, "CRLF found in exported JSON"
            txt = raw.decode("utf-8")
            assert "Hà Nội" in txt, "non-ASCII escaped instead of UTF-8"
            assert json.loads(txt)["city"] == "Hà Nội"

    rec("bom_and_crlf", chk_bom_and_crlf)
    rec("sqlite_concurrent_wal", chk_sqlite_concurrent)
    rec("concurrent_counter_lock", chk_counter_race)
    rec("export_utf8_lf_atomic", chk_export_utf8_lf)

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(ok_n / len(checks), 4),
        "fail_to_pass": {"passed": ok_n, "total": len(checks)},
        "pass_to_pass": {"passed": 0, "total": 0},
        "checks": checks,
    }))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
