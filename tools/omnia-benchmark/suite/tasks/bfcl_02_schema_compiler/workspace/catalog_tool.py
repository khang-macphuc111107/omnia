#!/usr/bin/env python3
"""catalog_tool.py - Paginated inventory & FX CLI with deterministic 429 rate-limits,
HMAC-chained audit log, and strict Draft-07-style schema validation.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import hmac
import json
import math
import re
import sqlite3
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, NoReturn

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

DB_PATH = Path(__file__).resolve().parent / ".catalog_state.db"
AUDIT_SECRET = b"bfcl02-catalog-hmac-v1-4c8e2f91b7a05d3e"
GENESIS_HMAC = "0" * 64

VALID_PRODUCT_CURSORS = ("p1", "p2", "p3")
VALID_WAREHOUSE_CURSORS = ("w1", "w2")
VALID_SUPPLIER_CURSORS = ("s1", "s2")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UTC_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SKU_RE = re.compile(r"^SKU-\d{3}$")
SUP_RE = re.compile(r"^SUP-\d{2}$")

ROOT_KEYS = {
    "schema_version",
    "as_of_date",
    "generated_at",
    "base_currency",
    "items",
    "summary",
}
ITEM_KEYS = {
    "product_id",
    "name",
    "supplier_id",
    "supplier_status",
    "supplier_risk",
    "currency",
    "unit_price",
    "expected_stock",
    "physical_stock",
    "discrepancy_units",
    "status",
    "physical_value_usd",
    "discrepancy_value_usd",
}
SUMMARY_KEYS = {
    "active_product_count",
    "excluded_inactive_count",
    "match_count",
    "shortage_count",
    "surplus_count",
    "supplier_risk_count",
    "total_expected_units",
    "total_physical_units",
    "total_physical_value_usd",
    "net_discrepancy_value_usd",
}


def emit_json(payload: dict[str, Any], exit_code: int = 0) -> NoReturn:
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    sys.exit(exit_code)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        emit_json({"ok": False, "error": "INVALID_ARGUMENTS", "detail": message}, exit_code=1)


def compute_row_hmac(seq: int, command: str, args_json: str, result_ok: int, prev_hmac: str) -> str:
    payload = f"{seq}|{command}|{args_json}|{result_ok}|{prev_hmac}".encode("utf-8")
    return hmac.new(AUDIT_SECRET, payload, hashlib.sha256).hexdigest()


def append_audit_log(
    conn: sqlite3.Connection,
    command: str,
    args_dict: dict[str, Any],
    result_ok: bool,
) -> int:
    row = conn.execute(
        "SELECT seq, row_hmac FROM tool_audit_log ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    if row is None:
        next_seq = 1
        prev_hmac = GENESIS_HMAC
    else:
        next_seq = int(row["seq"]) + 1
        prev_hmac = str(row["row_hmac"])
    args_json = json.dumps(args_dict, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    ok_int = 1 if result_ok else 0
    row_hmac = compute_row_hmac(next_seq, command, args_json, ok_int, prev_hmac)
    conn.execute(
        """
        INSERT INTO tool_audit_log (seq, command, args_json, result_ok, prev_hmac, row_hmac)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (next_seq, command, args_json, ok_int, prev_hmac, row_hmac),
    )
    return next_seq


def connect_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        emit_json(
            {
                "ok": False,
                "error": "STATE_DB_MISSING",
                "detail": f"Expected initialized state database at {DB_PATH}",
            },
            exit_code=1,
        )
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fail_with_audit(
    conn: sqlite3.Connection,
    command: str,
    args_dict: dict[str, Any],
    payload: dict[str, Any],
) -> NoReturn:
    conn.rollback()
    append_audit_log(conn, command, args_dict, result_ok=False)
    conn.commit()
    conn.close()
    emit_json(payload, exit_code=1)


def check_deterministic_rate_limit(
    conn: sqlite3.Connection,
    endpoint: str,
    cursor: str,
    args_dict: dict[str, Any],
) -> None:
    row = conn.execute(
        "SELECT trigger_count FROM rate_limit_state WHERE endpoint = ? AND cursor = ?",
        (endpoint, cursor),
    ).fetchone()
    if row is None:
        return
    current_count = int(row["trigger_count"])
    conn.execute(
        "UPDATE rate_limit_state SET trigger_count = ? WHERE endpoint = ? AND cursor = ?",
        (current_count + 1, endpoint, cursor),
    )
    if current_count == 0:
        append_audit_log(conn, endpoint, args_dict, result_ok=False)
        conn.commit()
        conn.close()
        emit_json(
            {
                "ok": False,
                "error": "RATE_LIMITED",
                "http_status": 429,
                "retryable": True,
                "retry_after_ms": 50,
                "endpoint": endpoint,
                "cursor": cursor,
                "message": f"Transient rate limit on page {cursor}; retry the same cursor.",
            },
            exit_code=1,
        )


def is_exact_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def is_exact_number(val: Any) -> bool:
    if isinstance(val, bool):
        return False
    if isinstance(val, int):
        return True
    if isinstance(val, float):
        return math.isfinite(val)
    return False


def has_at_most_2dp(val: Any) -> bool:
    if not is_exact_number(val):
        return False
    try:
        dec = Decimal(str(val))
    except InvalidOperation:
        return False
    return dec == dec.quantize(Decimal("0.01"))


def validate_reconciliation_schema(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["Root payload must be a JSON object"]

    missing_root = sorted(ROOT_KEYS - set(payload.keys()))
    extra_root = sorted(set(payload.keys()) - ROOT_KEYS)
    if missing_root:
        errors.append(f"Root missing required properties: {missing_root}")
    if extra_root:
        errors.append(f"Root has forbidden additional properties: {extra_root}")

    if payload.get("schema_version") != "1.0":
        errors.append(f"schema_version must be exactly '1.0', got {payload.get('schema_version')!r}")

    as_of = payload.get("as_of_date")
    if not isinstance(as_of, str) or not DATE_RE.match(as_of):
        errors.append(f"as_of_date must match YYYY-MM-DD, got {as_of!r}")
    else:
        try:
            datetime.date.fromisoformat(as_of)
        except ValueError:
            errors.append(f"as_of_date is not a valid calendar date: {as_of!r}")

    gen_at = payload.get("generated_at")
    if not isinstance(gen_at, str) or not UTC_TS_RE.match(gen_at):
        errors.append(f"generated_at must match ISO-8601 UTC YYYY-MM-DDTHH:MM:SSZ, got {gen_at!r}")
    else:
        try:
            datetime.datetime.fromisoformat(gen_at.replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"generated_at is not a valid UTC datetime: {gen_at!r}")

    if payload.get("base_currency") != "USD":
        errors.append(f"base_currency must be 'USD', got {payload.get('base_currency')!r}")

    items = payload.get("items")
    if not isinstance(items, list) or len(items) == 0:
        errors.append("items must be a non-empty array")
    else:
        product_ids: list[str] = []
        for idx, item in enumerate(items):
            prefix = f"items[{idx}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            missing_i = sorted(ITEM_KEYS - set(item.keys()))
            extra_i = sorted(set(item.keys()) - ITEM_KEYS)
            if missing_i:
                errors.append(f"{prefix} missing required properties: {missing_i}")
            if extra_i:
                errors.append(f"{prefix} has forbidden additional properties: {extra_i}")

            pid = item.get("product_id")
            if not isinstance(pid, str) or not SKU_RE.match(pid):
                errors.append(f"{prefix}.product_id must match ^SKU-\\d{{3}}$, got {pid!r}")
            else:
                product_ids.append(pid)

            name = item.get("name")
            if not isinstance(name, str) or len(name.strip()) == 0:
                errors.append(f"{prefix}.name must be a non-empty string")

            sid = item.get("supplier_id")
            if not isinstance(sid, str) or not SUP_RE.match(sid):
                errors.append(f"{prefix}.supplier_id must match ^SUP-\\d{{2}}$, got {sid!r}")

            s_status = item.get("supplier_status")
            if s_status not in ("active", "suspended"):
                errors.append(f"{prefix}.supplier_status must be 'active' or 'suspended', got {s_status!r}")

            if not isinstance(item.get("supplier_risk"), bool):
                errors.append(f"{prefix}.supplier_risk must be a boolean")

            currency = item.get("currency")
            if currency not in ("USD", "EUR", "GBP", "JPY"):
                errors.append(f"{prefix}.currency must be one of USD|EUR|GBP|JPY, got {currency!r}")

            unit_price = item.get("unit_price")
            if not is_exact_number(unit_price) or unit_price <= 0:
                errors.append(f"{prefix}.unit_price must be a number > 0, got {unit_price!r}")

            for int_field in ("expected_stock", "physical_stock"):
                v = item.get(int_field)
                if not is_exact_int(v) or v < 0:
                    errors.append(f"{prefix}.{int_field} must be an integer >= 0, got {v!r}")

            if not is_exact_int(item.get("discrepancy_units")):
                errors.append(f"{prefix}.discrepancy_units must be an integer")

            status = item.get("status")
            if status not in ("match", "shortage", "surplus"):
                errors.append(f"{prefix}.status must be one of match|shortage|surplus, got {status!r}")

            pv = item.get("physical_value_usd")
            if not is_exact_number(pv) or pv < 0 or not has_at_most_2dp(pv):
                errors.append(f"{prefix}.physical_value_usd must be a number >= 0 with <= 2 decimals, got {pv!r}")

            dv = item.get("discrepancy_value_usd")
            if not is_exact_number(dv) or not has_at_most_2dp(dv):
                errors.append(f"{prefix}.discrepancy_value_usd must be a number with <= 2 decimals, got {dv!r}")

        if len(product_ids) == len(items):
            if len(set(product_ids)) != len(product_ids):
                errors.append("items contains duplicate product_id values")
            elif product_ids != sorted(product_ids):
                errors.append("items must be sorted lexicographically ascending by product_id")

    summary = payload.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
    else:
        missing_s = sorted(SUMMARY_KEYS - set(summary.keys()))
        extra_s = sorted(set(summary.keys()) - SUMMARY_KEYS)
        if missing_s:
            errors.append(f"summary missing required properties: {missing_s}")
        if extra_s:
            errors.append(f"summary has forbidden additional properties: {extra_s}")

        for int_field in (
            "active_product_count",
            "excluded_inactive_count",
            "match_count",
            "shortage_count",
            "surplus_count",
            "supplier_risk_count",
            "total_expected_units",
            "total_physical_units",
        ):
            v = summary.get(int_field)
            if not is_exact_int(v) or v < 0:
                errors.append(f"summary.{int_field} must be an integer >= 0, got {v!r}")

        tpv = summary.get("total_physical_value_usd")
        if not is_exact_number(tpv) or tpv < 0 or not has_at_most_2dp(tpv):
            errors.append(f"summary.total_physical_value_usd must be a number >= 0 with <= 2 decimals, got {tpv!r}")

        ndv = summary.get("net_discrepancy_value_usd")
        if not is_exact_number(ndv) or not has_at_most_2dp(ndv):
            errors.append(f"summary.net_discrepancy_value_usd must be a number with <= 2 decimals, got {ndv!r}")

    return errors


def cmd_list_products(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    cursor = args.cursor
    args_dict = {"cursor": cursor}
    if cursor not in VALID_PRODUCT_CURSORS:
        fail_with_audit(
            conn,
            "list-products",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_CURSOR",
                "detail": f"Invalid cursor {cursor!r}; valid cursors are {list(VALID_PRODUCT_CURSORS)}",
            },
        )
    check_deterministic_rate_limit(conn, "list-products", cursor, args_dict)

    rows = conn.execute(
        """
        SELECT product_id, name, currency, unit_price, expected_stock, supplier_id, active
        FROM products WHERE page_cursor = ? ORDER BY page_order ASC
        """,
        (cursor,),
    ).fetchall()
    next_map = {"p1": "p2", "p2": "p3", "p3": None}
    items = [
        {
            "product_id": r["product_id"],
            "name": r["name"],
            "currency": r["currency"],
            "unit_price": float(Decimal(r["unit_price"])),
            "expected_stock": int(r["expected_stock"]),
            "supplier_id": r["supplier_id"],
            "active": bool(r["active"]),
        }
        for r in rows
    ]
    append_audit_log(conn, "list-products", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "list-products",
        "cursor": cursor,
        "next_cursor": next_map[cursor],
        "count": len(items),
        "products": items,
    }


def cmd_list_warehouses(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    cursor = args.cursor
    args_dict = {"cursor": cursor}
    if cursor not in VALID_WAREHOUSE_CURSORS:
        fail_with_audit(
            conn,
            "list-warehouses",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_CURSOR",
                "detail": f"Invalid cursor {cursor!r}; valid cursors are {list(VALID_WAREHOUSE_CURSORS)}",
            },
        )
    check_deterministic_rate_limit(conn, "list-warehouses", cursor, args_dict)

    wh_rows = conn.execute(
        """
        SELECT warehouse_id, name, region
        FROM warehouses WHERE page_cursor = ? ORDER BY page_order ASC
        """,
        (cursor,),
    ).fetchall()
    warehouses = []
    for wh in wh_rows:
        stock_rows = conn.execute(
            """
            SELECT product_id, quantity
            FROM warehouse_stock WHERE warehouse_id = ? ORDER BY product_id ASC
            """,
            (wh["warehouse_id"],),
        ).fetchall()
        warehouses.append(
            {
                "warehouse_id": wh["warehouse_id"],
                "name": wh["name"],
                "region": wh["region"],
                "inventory": {r["product_id"]: int(r["quantity"]) for r in stock_rows},
            }
        )
    next_map = {"w1": "w2", "w2": None}
    append_audit_log(conn, "list-warehouses", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "list-warehouses",
        "cursor": cursor,
        "next_cursor": next_map[cursor],
        "count": len(warehouses),
        "warehouses": warehouses,
    }


def cmd_list_suppliers(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    cursor = args.cursor
    args_dict = {"cursor": cursor}
    if cursor not in VALID_SUPPLIER_CURSORS:
        fail_with_audit(
            conn,
            "list-suppliers",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_CURSOR",
                "detail": f"Invalid cursor {cursor!r}; valid cursors are {list(VALID_SUPPLIER_CURSORS)}",
            },
        )
    rows = conn.execute(
        """
        SELECT supplier_id, name, country, status, lead_time_days
        FROM suppliers WHERE page_cursor = ? ORDER BY page_order ASC
        """,
        (cursor,),
    ).fetchall()
    next_map = {"s1": "s2", "s2": None}
    suppliers = [
        {
            "supplier_id": r["supplier_id"],
            "name": r["name"],
            "country": r["country"],
            "status": r["status"],
            "lead_time_days": int(r["lead_time_days"]),
        }
        for r in rows
    ]
    append_audit_log(conn, "list-suppliers", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "list-suppliers",
        "cursor": cursor,
        "next_cursor": next_map[cursor],
        "count": len(suppliers),
        "suppliers": suppliers,
    }


def cmd_get_fx_rates(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    as_of = args.as_of
    args_dict = {"as_of": as_of}
    if not DATE_RE.match(as_of):
        fail_with_audit(
            conn,
            "get-fx-rates",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_DATE_FORMAT",
                "detail": f"--as-of must match YYYY-MM-DD, got {as_of!r}",
            },
        )
    try:
        datetime.date.fromisoformat(as_of)
    except ValueError:
        fail_with_audit(
            conn,
            "get-fx-rates",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_DATE",
                "detail": f"--as-of is not a valid calendar date: {as_of!r}",
            },
        )

    rows = conn.execute(
        "SELECT currency, rate_to_usd, published_at FROM fx_rates WHERE as_of_date = ? ORDER BY currency ASC",
        (as_of,),
    ).fetchall()
    if not rows:
        fail_with_audit(
            conn,
            "get-fx-rates",
            args_dict,
            {
                "ok": False,
                "error": "FX_DATE_NOT_FOUND",
                "detail": f"No FX rates available for as_of={as_of}",
            },
        )

    rates = {r["currency"]: float(Decimal(r["rate_to_usd"])) for r in rows}
    published_at = rows[0]["published_at"]
    append_audit_log(conn, "get-fx-rates", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "get-fx-rates",
        "as_of_date": as_of,
        "base_currency": "USD",
        "published_at": published_at,
        "rates_to_usd": rates,
    }


def cmd_submit_reconciliation(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    payload_path = Path(args.payload_file)
    args_dict = {"payload_file": str(args.payload_file)}
    if not payload_path.exists() or not payload_path.is_file():
        fail_with_audit(
            conn,
            "submit-reconciliation",
            args_dict,
            {
                "ok": False,
                "error": "PAYLOAD_FILE_NOT_FOUND",
                "detail": f"Payload file does not exist: {payload_path}",
            },
        )

    try:
        raw_text = payload_path.read_text(encoding="utf-8")
        payload = json.loads(raw_text)
    except (OSError, json.JSONDecodeError) as exc:
        fail_with_audit(
            conn,
            "submit-reconciliation",
            args_dict,
            {
                "ok": False,
                "error": "INVALID_JSON",
                "detail": f"Failed to read/parse JSON payload: {exc}",
            },
        )

    violations = validate_reconciliation_schema(payload)
    if violations:
        fail_with_audit(
            conn,
            "submit-reconciliation",
            args_dict,
            {
                "ok": False,
                "error": "SCHEMA_VALIDATION_FAILED",
                "violation_count": len(violations),
                "violations": violations,
            },
        )

    count_row = conn.execute("SELECT COUNT(*) AS cnt FROM reconciliation_submissions").fetchone()
    submission_id = f"SUB-{int(count_row['cnt']) + 1:04d}"
    submitted_at = utc_now_iso()
    canonical_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    conn.execute(
        """
        INSERT INTO reconciliation_submissions (submission_id, submitted_at, payload_json)
        VALUES (?, ?, ?)
        """,
        (submission_id, submitted_at, canonical_payload),
    )
    append_audit_log(conn, "submit-reconciliation", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "submit-reconciliation",
        "submission_id": submission_id,
        "submitted_at": submitted_at,
        "schema_valid": True,
        "item_count": len(payload["items"]),
    }


def build_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(
        prog="catalog_tool.py",
        description="Paginated inventory catalog, FX, and reconciliation submission CLI.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_prod = sub.add_parser("list-products", help="List paginated products.")
    p_prod.add_argument("--cursor", default="p1")

    p_wh = sub.add_parser("list-warehouses", help="List paginated warehouse stock snapshots.")
    p_wh.add_argument("--cursor", default="w1")

    p_sup = sub.add_parser("list-suppliers", help="List paginated supplier statuses.")
    p_sup.add_argument("--cursor", default="s1")

    p_fx = sub.add_parser("get-fx-rates", help="Fetch FX conversion rates to USD for a date.")
    p_fx.add_argument("--as-of", required=True)

    p_sub = sub.add_parser("submit-reconciliation", help="Validate schema and submit reconciliation payload.")
    p_sub.add_argument("--payload-file", required=True)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    conn = connect_db()
    try:
        dispatch = {
            "list-products": cmd_list_products,
            "list-warehouses": cmd_list_warehouses,
            "list-suppliers": cmd_list_suppliers,
            "get-fx-rates": cmd_get_fx_rates,
            "submit-reconciliation": cmd_submit_reconciliation,
        }
        result = dispatch[args.command](conn, args)
    finally:
        conn.close()
    emit_json(result, exit_code=0)


if __name__ == "__main__":
    main()
