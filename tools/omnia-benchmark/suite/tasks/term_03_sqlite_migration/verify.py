#!/usr/bin/env python3
"""State verification grader for term_03_sqlite_migration."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path


TASK_ID = "term_03_sqlite_migration"

SYMBOL_TO_CURRENCY = {
    "$": "USD",
    "\u20ac": "EUR",
    "\u00a3": "GBP",
    "\u00a5": "JPY",
}
PREFIX_CODE_RE = re.compile(r"^([A-Za-z]{3})\s*(.+)$")


def parse_price_to_usd_cents(raw_price: object, fx_rates: dict[str, Decimal]) -> int | None:
    if isinstance(raw_price, bool) or raw_price is None:
        return None
    if isinstance(raw_price, (int, float)):
        raw_str = str(raw_price)
    elif isinstance(raw_price, str):
        raw_str = raw_price.strip()
    else:
        return None

    if not raw_str:
        return None

    currency = "USD"
    num_part = raw_str

    if raw_str[0] in SYMBOL_TO_CURRENCY:
        currency = SYMBOL_TO_CURRENCY[raw_str[0]]
        num_part = raw_str[1:].strip()
    else:
        m = PREFIX_CODE_RE.match(raw_str)
        if m:
            currency = m.group(1).upper()
            num_part = m.group(2).strip()

    if currency not in fx_rates:
        return None

    cleaned = num_part.replace(",", "").strip()
    if not cleaned:
        return None
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return None

    if not amount.is_finite() or amount < 0:
        return None

    cents_dec = (amount * fx_rates[currency] * Decimal("100")).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    )
    return int(cents_dec)


def compute_expected_migration(db_path: Path, fx_path: Path) -> dict:
    fx_raw = json.loads(fx_path.read_text(encoding="utf-8"))
    fx_rates = {k.upper(): Decimal(str(v)) for k, v in fx_raw.items()}

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        legacy_users = cur.execute(
            "SELECT id, email, full_name, created_at FROM users_legacy ORDER BY id ASC"
        ).fetchall()
        legacy_orders = cur.execute(
            "SELECT id, user_id, status, total_raw, items_json, created_at FROM orders_legacy ORDER BY id ASC"
        ).fetchall()
    finally:
        conn.close()

    email_to_canonical: dict[str, int] = {}
    legacy_to_canonical: dict[int, int] = {}
    canonical_users: list[tuple[int, str, str, str]] = []

    for uid, email, full_name, created_at in legacy_users:
        norm_email = email.strip().lower()
        if norm_email not in email_to_canonical:
            email_to_canonical[norm_email] = uid
            canonical_users.append((uid, norm_email, full_name.strip(), created_at.strip()))
        legacy_to_canonical[uid] = email_to_canonical[norm_email]

    migrated_orders: list[tuple[int, int, str, int, str]] = []
    migrated_items: list[tuple[int, str, int, int]] = []
    quarantined: list[dict] = []

    for oid, uid, status, total_raw, items_json, created_at in legacy_orders:
        raw_record = {
            "id": oid,
            "user_id": uid,
            "status": status,
            "total_raw": total_raw,
            "items_json": items_json,
            "created_at": created_at,
        }
        if uid not in legacy_to_canonical:
            quarantined.append(
                {
                    "order_id": oid,
                    "user_id": uid,
                    "reason": "orphaned_user",
                    "raw_record": raw_record,
                }
            )
            continue

        try:
            parsed_items = json.loads(items_json)
        except Exception:
            quarantined.append(
                {
                    "order_id": oid,
                    "user_id": uid,
                    "reason": "invalid_items_json",
                    "raw_record": raw_record,
                }
            )
            continue

        if not isinstance(parsed_items, list) or len(parsed_items) == 0:
            quarantined.append(
                {
                    "order_id": oid,
                    "user_id": uid,
                    "reason": "invalid_items_json",
                    "raw_record": raw_record,
                }
            )
            continue

        valid_items_for_order: list[tuple[int, str, int, int]] = []
        item_invalid = False
        for item in parsed_items:
            if not isinstance(item, dict):
                item_invalid = True
                break
            sku = item.get("sku")
            qty = item.get("qty")
            unit_price = item.get("unit_price")
            if not isinstance(sku, str) or not sku.strip():
                item_invalid = True
                break
            if isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0:
                item_invalid = True
                break
            cents = parse_price_to_usd_cents(unit_price, fx_rates)
            if cents is None:
                item_invalid = True
                break
            valid_items_for_order.append((oid, sku.strip(), qty, cents))

        if item_invalid:
            quarantined.append(
                {
                    "order_id": oid,
                    "user_id": uid,
                    "reason": "invalid_item",
                    "raw_record": raw_record,
                }
            )
            continue

        total_cents = sum(qty * cents for _, _, qty, cents in valid_items_for_order)
        migrated_orders.append(
            (oid, legacy_to_canonical[uid], status.strip(), total_cents, created_at.strip())
        )
        migrated_items.extend(valid_items_for_order)

    return {
        "users": sorted(canonical_users, key=lambda r: r[0]),
        "orders": sorted(migrated_orders, key=lambda r: r[0]),
        "order_items": sorted(migrated_items),
        "quarantine": sorted(quarantined, key=lambda r: r["order_id"]),
        "total_orders_cents": sum(r[3] for r in migrated_orders),
        "total_items_cents": sum(qty * cents for _, _, qty, cents in migrated_items),
    }


def check_legacy_intact(workspace: Path) -> tuple[bool, str]:
    db_path = workspace / "app.db"
    fx_path = workspace / "fx_rates.json"
    if not db_path.is_file() or not fx_path.is_file():
        return False, "app.db or fx_rates.json missing"
    setup_script = Path(__file__).resolve().parent / "setup.py"
    with tempfile.TemporaryDirectory(prefix="t3_ref_") as tmp:
        ref_ws = Path(tmp)
        proc = subprocess.run(
            [sys.executable, str(setup_script), "--workspace", str(ref_ws)],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return False, f"reference setup failed: {proc.stderr}"
        if json.loads(fx_path.read_text(encoding="utf-8")) != json.loads((ref_ws / "fx_rates.json").read_text(encoding="utf-8")):
            return False, "fx_rates.json was modified"

        c_ws = sqlite3.connect(str(db_path))
        c_ref = sqlite3.connect(str(ref_ws / "app.db"))
        try:
            for tbl in ("users_legacy", "orders_legacy"):
                ws_rows = c_ws.execute(f"SELECT * FROM {tbl} ORDER BY id ASC").fetchall()
                ref_rows = c_ref.execute(f"SELECT * FROM {tbl} ORDER BY id ASC").fetchall()
                if ws_rows != ref_rows:
                    return False, f"{tbl} modified (ws={len(ws_rows)}, ref={len(ref_rows)})"
        except sqlite3.Error as exc:
            return False, f"legacy table query failed: {exc}"
        finally:
            c_ws.close()
            c_ref.close()
    return True, "users_legacy, orders_legacy, and fx_rates.json intact"


def inspect_v2_schema_and_constraints(db_path: Path) -> tuple[bool, str]:
    required_tables = {"users", "orders", "order_items", "schema_migrations"}
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        missing = sorted(required_tables - tables)
        if missing:
            return False, f"missing tables: {missing}"

        fk_violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_violations:
            return False, f"foreign_key_check violations: {fk_violations[:5]}"

        mig_rows = conn.execute(
            "SELECT version, applied_at FROM schema_migrations WHERE version = 2"
        ).fetchall()
        if len(mig_rows) != 1 or not str(mig_rows[0][1]).strip():
            return False, f"schema_migrations missing valid version=2 row: {mig_rows}"

        # Check UNIQUE constraint on users.email & FK enforcement on a temp copy!
    finally:
        conn.close()

    with tempfile.TemporaryDirectory(prefix="t3_chk_") as tmp:
        copy_db = Path(tmp) / "copy.db"
        shutil.copy2(db_path, copy_db)
        c = sqlite3.connect(str(copy_db))
        try:
            c.execute("PRAGMA foreign_keys = ON")
            sample_email = c.execute("SELECT email FROM users LIMIT 1").fetchone()
            if not sample_email:
                return False, "users table is empty"
            try:
                c.execute(
                    "INSERT INTO users (id, email, full_name, created_at) VALUES (999999, ?, 'Dup Test', '2026-01-01T00:00:00Z')",
                    (sample_email[0],),
                )
                return False, "users.email UNIQUE constraint not enforced"
            except sqlite3.IntegrityError:
                pass

            try:
                c.execute(
                    "INSERT INTO orders (id, user_id, status, total_usd_cents, created_at) VALUES (999999, 888888, 'paid', 100, '2026-01-01T00:00:00Z')"
                )
                return False, "orders.user_id FOREIGN KEY constraint not enforced"
            except sqlite3.IntegrityError:
                pass

            sample_oid = c.execute("SELECT id FROM orders LIMIT 1").fetchone()
            if sample_oid:
                try:
                    c.execute(
                        "INSERT INTO order_items (order_id, sku, qty, unit_price_usd_cents) VALUES (?, 'SKU-X', 0, 100)",
                        (sample_oid[0],),
                    )
                    return False, "order_items.qty CHECK(qty > 0) not enforced"
                except sqlite3.IntegrityError:
                    pass
        finally:
            c.close()

    return True, "all v2 tables, UNIQUE, FK, CHECK, and schema_migrations v2 verified"


def check_quarantine_file(q_path: Path, expected_q: list[dict]) -> tuple[bool, str]:
    if not q_path.is_file():
        return False, f"{q_path.name} missing"
    raw = q_path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return False, "quarantine.jsonl must not have UTF-8 BOM"
    if b"\r\n" in raw:
        return False, "quarantine.jsonl must use LF line endings"
    lines = [ln for ln in raw.decode("utf-8").splitlines() if ln.strip()]
    if len(lines) != len(expected_q):
        return False, f"quarantine count mismatch: got={len(lines)}, expected={len(expected_q)}"
    parsed = []
    for idx, ln in enumerate(lines):
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError as exc:
            return False, f"line {idx} invalid JSON: {exc}"
        parsed.append(obj)

    for idx, (got, exp) in enumerate(zip(parsed, expected_q)):
        for k in ("order_id", "user_id", "reason"):
            if got.get(k) != exp[k]:
                return False, f"line {idx} field {k}: got={got.get(k)!r}, expected={exp[k]!r}"
        got_raw = got.get("raw_record")
        if not isinstance(got_raw, dict):
            return False, f"line {idx} raw_record is not an object"
        for k, v in exp["raw_record"].items():
            if got_raw.get(k) != v:
                return False, f"line {idx} raw_record.{k}: got={got_raw.get(k)!r}, expected={v!r}"
    return True, f"{len(expected_q)} quarantined orders matched exactly"


def snapshot_v2_state(db_path: Path) -> dict:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        users = conn.execute(
            "SELECT id, email, full_name, created_at FROM users ORDER BY id ASC"
        ).fetchall()
        orders = conn.execute(
            "SELECT id, user_id, status, total_usd_cents, created_at FROM orders ORDER BY id ASC"
        ).fetchall()
        items = sorted(
            conn.execute(
                "SELECT order_id, sku, qty, unit_price_usd_cents FROM order_items"
            ).fetchall()
        )
        migs = conn.execute(
            "SELECT version FROM schema_migrations ORDER BY version ASC"
        ).fetchall()
        fk = conn.execute("PRAGMA foreign_key_check").fetchall()
        return {
            "users": users,
            "orders": orders,
            "order_items": items,
            "migrations": [m[0] for m in migs],
            "fk_violations": fk,
            "total_orders_cents": sum(r[3] for r in orders),
            "total_items_cents": sum(r[2] * r[3] for r in items),
        }
    finally:
        conn.close()


def run_custom_cli_test(migrate_py: Path, workspace: Path) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory(prefix="t3_custom_") as tmp:
        td = Path(tmp)
        tmp_db = td / "custom.db"
        tmp_fx = td / "custom_fx.json"
        tmp_q = td / "nested" / "q.jsonl"

        tmp_fx.write_text(
            json.dumps({"USD": "1.00", "EUR": "1.12", "CAD": "0.735"}, indent=2) + "\n",
            encoding="utf-8",
        )
        conn = sqlite3.connect(str(tmp_db))
        try:
            conn.execute(
                "CREATE TABLE users_legacy (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, created_at TEXT)"
            )
            conn.execute(
                "CREATE TABLE orders_legacy (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, total_raw TEXT, items_json TEXT, created_at TEXT)"
            )
            conn.executemany(
                "INSERT INTO users_legacy VALUES (?, ?, ?, ?)",
                [
                    (10, "zoe@test.org", "Zoe One", "2026-02-01T00:00:00Z"),
                    (20, "  ZOE@TEST.ORG ", "Zoe Dup", "2026-02-02T00:00:00Z"),
                ],
            )
            conn.executemany(
                "INSERT INTO orders_legacy VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        501,
                        20,  # dup user -> remap to 10
                        "paid",
                        "CAD 10.00",
                        json.dumps([{"sku": "CAD-ITEM", "qty": 2, "unit_price": "CAD 5.00"}]),
                        "2026-02-03T00:00:00Z",
                    ),
                    (
                        502,
                        10,
                        "paid",
                        "EUR 10.00",
                        json.dumps([{"sku": "EUR-ITEM", "qty": 1, "unit_price": "\u20ac10.00"}]),
                        "2026-02-03T01:00:00Z",
                    ),
                    (
                        503,
                        777,  # orphan
                        "paid",
                        "$5.00",
                        json.dumps([{"sku": "ORPH", "qty": 1, "unit_price": "$5.00"}]),
                        "2026-02-03T02:00:00Z",
                    ),
                    (
                        504,
                        10,
                        "pending",
                        "CHF 5.00",
                        json.dumps([{"sku": "BAD-FX", "qty": 1, "unit_price": "CHF 5.00"}]),
                        "2026-02-03T03:00:00Z",
                    ),
                ],
            )
            conn.commit()
        finally:
            conn.close()

        expected = compute_expected_migration(tmp_db, tmp_fx)
        cmd = [
            sys.executable,
            str(migrate_py),
            "--db",
            str(tmp_db),
            "--fx",
            str(tmp_fx),
            "--quarantine",
            str(tmp_q),
        ]
        for run_no in (1, 2):
            proc = subprocess.run(cmd, cwd=str(workspace), capture_output=True, text=True, timeout=30, check=False)
            if proc.returncode != 0:
                return False, f"custom CLI run {run_no} failed (rc={proc.returncode}): {(proc.stderr or proc.stdout).strip()[-250:]}"

        snap = snapshot_v2_state(tmp_db)
        if snap["fk_violations"]:
            return False, f"custom DB FK violations: {snap['fk_violations']}"
        if snap["users"] != expected["users"]:
            return False, f"custom users mismatch: {snap['users']} != {expected['users']}"
        if snap["orders"] != expected["orders"]:
            return False, f"custom orders mismatch: {snap['orders']} != {expected['orders']}"
        if snap["order_items"] != expected["order_items"]:
            return False, f"custom items mismatch: {snap['order_items']} != {expected['order_items']}"
        q_ok, q_detail = check_quarantine_file(tmp_q, expected["quarantine"])
        if not q_ok:
            return False, f"custom quarantine: {q_detail}"
    return True, "custom CLI args + 2x idempotent run passed"


def verify(workspace: Path) -> dict:
    checks: list[dict] = []

    def add_check(name: str, passed: bool, group: str, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    try:
        db_path = workspace / "app.db"
        fx_path = workspace / "fx_rates.json"
        q_path = workspace / "output" / "quarantine.jsonl"
        migrate_py = workspace / "migrate.py"

        # PASS_TO_PASS
        ok, detail = check_legacy_intact(workspace)
        add_check("legacy_tables_and_fx_intact", ok, "pass_to_pass", detail)

        # FAIL_TO_PASS
        add_check(
            "migrate_script_exists",
            migrate_py.is_file(),
            "fail_to_pass",
            "found migrate.py" if migrate_py.is_file() else "migrate.py missing",
        )

        expected = compute_expected_migration(db_path, fx_path)

        schema_ok, schema_detail = inspect_v2_schema_and_constraints(db_path)
        add_check("v2_schema_constraints_and_fk", schema_ok, "fail_to_pass", schema_detail)

        if schema_ok:
            snap1 = snapshot_v2_state(db_path)

            users_ok = snap1["users"] == expected["users"]
            add_check(
                "users_deduplicated_canonical",
                users_ok,
                "fail_to_pass",
                f"{len(snap1['users'])} canonical users matched"
                if users_ok
                else f"got {len(snap1['users'])} users, expected {len(expected['users'])}",
            )

            orders_ok = (
                snap1["orders"] == expected["orders"]
                and snap1["total_orders_cents"] == expected["total_orders_cents"]
            )
            add_check(
                "orders_migrated_and_remapped",
                orders_ok,
                "fail_to_pass",
                f"{len(snap1['orders'])} orders, total_usd_cents={snap1['total_orders_cents']}"
                if orders_ok
                else f"orders mismatch: got count={len(snap1['orders'])} sum={snap1['total_orders_cents']}, expected count={len(expected['orders'])} sum={expected['total_orders_cents']}",
            )

            items_ok = (
                snap1["order_items"] == expected["order_items"]
                and snap1["total_items_cents"] == expected["total_items_cents"]
                and snap1["total_items_cents"] == snap1["total_orders_cents"]
            )
            add_check(
                "order_items_normalized_exact",
                items_ok,
                "fail_to_pass",
                f"{len(snap1['order_items'])} items, sum={snap1['total_items_cents']}"
                if items_ok
                else f"items mismatch: got count={len(snap1['order_items'])} sum={snap1['total_items_cents']}, expected count={len(expected['order_items'])} sum={expected['total_items_cents']}",
            )
        else:
            snap1 = None
            add_check("users_deduplicated_canonical", False, "fail_to_pass", "skipped: v2 schema missing/invalid")
            add_check("orders_migrated_and_remapped", False, "fail_to_pass", "skipped: v2 schema missing/invalid")
            add_check("order_items_normalized_exact", False, "fail_to_pass", "skipped: v2 schema missing/invalid")

        q_ok, q_detail = check_quarantine_file(q_path, expected["quarantine"])
        add_check("quarantine_jsonl_exact", q_ok, "fail_to_pass", q_detail)

        # Idempotent 2nd run check
        if migrate_py.is_file() and schema_ok and snap1 is not None:
            q_before = q_path.read_bytes() if q_path.is_file() else b""
            proc = subprocess.run(
                [sys.executable, str(migrate_py)],
                cwd=str(workspace),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if proc.returncode != 0:
                add_check(
                    "idempotent_second_run",
                    False,
                    "fail_to_pass",
                    f"2nd run exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()[-250:]}",
                )
            else:
                snap2 = snapshot_v2_state(db_path)
                q_after = q_path.read_bytes() if q_path.is_file() else b""
                idem_ok = (
                    snap2 == snap1
                    and len(snap2["fk_violations"]) == 0
                    and q_after == q_before
                    and check_quarantine_file(q_path, expected["quarantine"])[0]
                )
                add_check(
                    "idempotent_second_run",
                    idem_ok,
                    "fail_to_pass",
                    "2nd run exit 0 with zero drift across DB and quarantine"
                    if idem_ok
                    else f"state changed after 2nd run (orders={len(snap2['orders'])}, items={len(snap2['order_items'])})",
                )
        else:
            add_check("idempotent_second_run", False, "fail_to_pass", "skipped: migrate.py or v2 schema missing")

        # Custom CLI paths & unseen DB test
        if migrate_py.is_file():
            c_ok, c_detail = run_custom_cli_test(migrate_py, workspace)
            add_check("custom_cli_args_unseen_db", c_ok, "fail_to_pass", c_detail)
        else:
            add_check("custom_cli_args_unseen_db", False, "fail_to_pass", "migrate.py missing")

        error = None
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    total = len(checks)
    passed_cnt = sum(1 for c in checks if c["passed"])
    all_passed = error is None and total > 0 and passed_cnt == total
    score = round(passed_cnt / total, 4) if total > 0 and error is None else 0.0

    return {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": score,
        "fail_to_pass": {
            "passed": sum(1 for c in f2p if c["passed"]),
            "total": len(f2p),
        },
        "pass_to_pass": {
            "passed": sum(1 for c in p2p if c["passed"]),
            "total": len(p2p),
        },
        "checks": checks,
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}.")
    parser.add_argument("--workspace", required=True, help="Workspace directory to grade")
    args = parser.parse_args()
    result = verify(Path(args.workspace).resolve())
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
