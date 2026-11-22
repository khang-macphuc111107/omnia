#!/usr/bin/env python3
"""verify.py - Deterministic grader for bfcl_02_schema_compiler."""

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
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TASK_ID = "bfcl_02_schema_compiler"
AUDIT_SECRET = b"bfcl02-catalog-hmac-v1-4c8e2f91b7a05d3e"
GENESIS_HMAC = "0" * 64
TASK_DIR = Path(__file__).resolve().parent
REF_WORKSPACE = TASK_DIR / "workspace"

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

# Pristine ground-truth dataset (matches setup.py exactly)
GT_SUPPLIERS = [
    ("SUP-01", "Nordic Components AB", "SE", "active", 7, "s1", 1),
    ("SUP-02", "Thames Precision Ltd", "GB", "suspended", 21, "s1", 2),
    ("SUP-03", "Kyoto MicroDevices KK", "JP", "active", 14, "s2", 1),
    ("SUP-04", "Pacific Logic Corp", "US", "suspended", 10, "s2", 2),
]

GT_PRODUCTS = [
    ("SKU-104", "Optical Sensor Module", "EUR", "13.00", 20, "SUP-01", 1, "p1", 1),
    ("SKU-101", "USB-C PD Controller", "USD", "18.50", 50, "SUP-04", 1, "p1", 2),
    ("SKU-109", "Thermal Interface Pad", "JPY", "1500.00", 40, "SUP-03", 1, "p1", 3),
    ("SKU-107", "Legacy RS-232 Bridge", "USD", "29.99", 15, "SUP-04", 0, "p1", 4),
    ("SKU-112", "NVMe Heatsink Fin", "GBP", "22.50", 30, "SUP-02", 1, "p2", 1),
    ("SKU-102", "DIN Rail Power Supply", "EUR", "64.00", 12, "SUP-01", 1, "p2", 2),
    ("SKU-106", "Ceramic Resonator 16MHz", "JPY", "250.00", 100, "SUP-03", 1, "p2", 3),
    ("SKU-110", "Shielded Ethernet Coupler", "USD", "12.75", 60, "SUP-04", 1, "p2", 4),
    ("SKU-103", "Precision Torque Driver", "GBP", "35.00", 25, "SUP-02", 1, "p3", 1),
    ("SKU-108", "CAN Bus Transceiver IC", "EUR", "11.00", 45, "SUP-01", 1, "p3", 2),
    ("SKU-111", "High-Temp Silicone Ribbon", "JPY", "850.00", 35, "SUP-03", 1, "p3", 3),
    ("SKU-105", "Aluminum Enclosure IP67", "USD", "54.25", 18, "SUP-01", 1, "p3", 4),
]

GT_WAREHOUSES = [
    ("WH-EAST", "North America East Hub", "US-EAST", "w1", 1),
    ("WH-EU", "Europe Rotterdam Hub", "EU-WEST", "w1", 2),
    ("WH-APAC", "Asia-Pacific Osaka Hub", "AP-EAST", "w2", 1),
]

GT_WAREHOUSE_STOCK = [
    ("WH-EAST", "SKU-101", 28),
    ("WH-EAST", "SKU-102", 7),
    ("WH-EAST", "SKU-103", 10),
    ("WH-EAST", "SKU-104", 9),
    ("WH-EAST", "SKU-105", 10),
    ("WH-EAST", "SKU-106", 45),
    ("WH-EAST", "SKU-107", 6),
    ("WH-EAST", "SKU-108", 20),
    ("WH-EAST", "SKU-109", 15),
    ("WH-EAST", "SKU-110", 30),
    ("WH-EAST", "SKU-111", 12),
    ("WH-EAST", "SKU-112", 14),
    ("WH-EU", "SKU-101", 12),
    ("WH-EU", "SKU-102", 5),
    ("WH-EU", "SKU-103", 8),
    ("WH-EU", "SKU-104", 6),
    ("WH-EU", "SKU-105", 8),
    ("WH-EU", "SKU-106", 30),
    ("WH-EU", "SKU-107", 4),
    ("WH-EU", "SKU-108", 16),
    ("WH-EU", "SKU-109", 10),
    ("WH-EU", "SKU-110", 20),
    ("WH-EU", "SKU-111", 15),
    ("WH-EU", "SKU-112", 11),
    ("WH-APAC", "SKU-101", 10),
    ("WH-APAC", "SKU-102", 3),
    ("WH-APAC", "SKU-103", 4),
    ("WH-APAC", "SKU-104", 4),
    ("WH-APAC", "SKU-106", 28),
    ("WH-APAC", "SKU-107", 5),
    ("WH-APAC", "SKU-108", 8),
    ("WH-APAC", "SKU-109", 15),
    ("WH-APAC", "SKU-110", 15),
    ("WH-APAC", "SKU-111", 5),
    ("WH-APAC", "SKU-112", 5),
]

GT_FX_RATES = [
    ("2026-10-01", "EUR", "1.085", "2026-10-01T00:00:00Z"),
    ("2026-10-01", "GBP", "1.27", "2026-10-01T00:00:00Z"),
    ("2026-10-01", "JPY", "0.0067", "2026-10-01T00:00:00Z"),
    ("2026-10-01", "USD", "1.0", "2026-10-01T00:00:00Z"),
]


def compute_row_hmac(seq: int, command: str, args_json: str, result_ok: int, prev_hmac: str) -> str:
    payload = f"{seq}|{command}|{args_json}|{result_ok}|{prev_hmac}".encode("utf-8")
    return hmac.new(AUDIT_SECRET, payload, hashlib.sha256).hexdigest()


def normalized_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def add_check(checks: list[dict[str, Any]], name: str, passed: bool, group: str, detail: str) -> None:
    checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})


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


def to_decimal_strict(val: Any) -> Decimal | None:
    if not is_exact_number(val):
        return None
    try:
        return Decimal(str(val))
    except InvalidOperation:
        return None


def has_at_most_2dp(val: Any) -> bool:
    dec = to_decimal_strict(val)
    if dec is None:
        return False
    return dec == dec.quantize(Decimal("0.01"))


def quantize_half_up(d: Decimal) -> Decimal:
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def compute_ground_truth() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    sup_map = {row[0]: row[3] for row in GT_SUPPLIERS}
    fx_map = {row[1]: Decimal(row[2]) for row in GT_FX_RATES}
    stock_totals: dict[str, int] = {}
    for _, sku, qty in GT_WAREHOUSE_STOCK:
        stock_totals[sku] = stock_totals.get(sku, 0) + qty

    active_items: list[dict[str, Any]] = []
    excluded_inactive = 0

    for pid, name, currency, price_str, exp_stock, sup_id, active_int, _, _ in GT_PRODUCTS:
        if not active_int:
            excluded_inactive += 1
            continue
        phys = stock_totals.get(pid, 0)
        disc = phys - exp_stock
        if disc == 0:
            status = "match"
        elif disc < 0:
            status = "shortage"
        else:
            status = "surplus"

        sup_status = sup_map[sup_id]
        sup_risk = sup_status == "suspended"
        unit_price = Decimal(price_str)
        fx = fx_map[currency]
        phys_usd = quantize_half_up(Decimal(phys) * unit_price * fx)
        disc_usd = quantize_half_up(Decimal(disc) * unit_price * fx)

        active_items.append(
            {
                "product_id": pid,
                "name": name,
                "supplier_id": sup_id,
                "supplier_status": sup_status,
                "supplier_risk": sup_risk,
                "currency": currency,
                "unit_price": unit_price,
                "expected_stock": exp_stock,
                "physical_stock": phys,
                "discrepancy_units": disc,
                "status": status,
                "physical_value_usd": phys_usd,
                "discrepancy_value_usd": disc_usd,
            }
        )

    active_items.sort(key=lambda x: x["product_id"])

    summary = {
        "active_product_count": len(active_items),
        "excluded_inactive_count": excluded_inactive,
        "match_count": sum(1 for x in active_items if x["status"] == "match"),
        "shortage_count": sum(1 for x in active_items if x["status"] == "shortage"),
        "surplus_count": sum(1 for x in active_items if x["status"] == "surplus"),
        "supplier_risk_count": sum(1 for x in active_items if x["supplier_risk"]),
        "total_expected_units": sum(x["expected_stock"] for x in active_items),
        "total_physical_units": sum(x["physical_stock"] for x in active_items),
        "total_physical_value_usd": quantize_half_up(
            sum((x["physical_value_usd"] for x in active_items), Decimal("0.00"))
        ),
        "net_discrepancy_value_usd": quantize_half_up(
            sum((x["discrepancy_value_usd"] for x in active_items), Decimal("0.00"))
        ),
    }
    return active_items, summary


def validate_strict_schema(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["Root payload must be a JSON object"]

    if set(payload.keys()) != ROOT_KEYS:
        errors.append(f"Root keys mismatch: expected {sorted(ROOT_KEYS)}, got {sorted(payload.keys())}")
    if payload.get("schema_version") != "1.0":
        errors.append(f"schema_version must be '1.0', got {payload.get('schema_version')!r}")
    if payload.get("as_of_date") != "2026-10-01":
        errors.append(f"as_of_date must be '2026-10-01', got {payload.get('as_of_date')!r}")

    gen_at = payload.get("generated_at")
    if not isinstance(gen_at, str) or not UTC_TS_RE.match(gen_at):
        errors.append(f"generated_at must match ISO-8601 UTC YYYY-MM-DDTHH:MM:SSZ, got {gen_at!r}")
    else:
        try:
            datetime.datetime.fromisoformat(gen_at.replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"generated_at invalid UTC datetime: {gen_at!r}")

    if payload.get("base_currency") != "USD":
        errors.append(f"base_currency must be 'USD', got {payload.get('base_currency')!r}")

    items = payload.get("items")
    if not isinstance(items, list) or len(items) == 0:
        errors.append("items must be a non-empty list")
    else:
        pids: list[str] = []
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"items[{idx}] must be an object")
                continue
            if set(item.keys()) != ITEM_KEYS:
                errors.append(f"items[{idx}] keys mismatch: got {sorted(item.keys())}")
            pid = item.get("product_id")
            if not isinstance(pid, str) or not SKU_RE.match(pid):
                errors.append(f"items[{idx}].product_id invalid: {pid!r}")
            else:
                pids.append(pid)
            if not isinstance(item.get("name"), str) or not item["name"].strip():
                errors.append(f"items[{idx}].name invalid")
            if not isinstance(item.get("supplier_id"), str) or not SUP_RE.match(item["supplier_id"]):
                errors.append(f"items[{idx}].supplier_id invalid")
            if item.get("supplier_status") not in ("active", "suspended"):
                errors.append(f"items[{idx}].supplier_status invalid")
            if not isinstance(item.get("supplier_risk"), bool):
                errors.append(f"items[{idx}].supplier_risk must be bool")
            if item.get("currency") not in ("USD", "EUR", "GBP", "JPY"):
                errors.append(f"items[{idx}].currency invalid")
            up = item.get("unit_price")
            if not is_exact_number(up) or up <= 0:
                errors.append(f"items[{idx}].unit_price invalid")
            for k in ("expected_stock", "physical_stock"):
                if not is_exact_int(item.get(k)) or item[k] < 0:
                    errors.append(f"items[{idx}].{k} invalid")
            if not is_exact_int(item.get("discrepancy_units")):
                errors.append(f"items[{idx}].discrepancy_units invalid")
            if item.get("status") not in ("match", "shortage", "surplus"):
                errors.append(f"items[{idx}].status invalid")
            if not is_exact_number(item.get("physical_value_usd")) or item["physical_value_usd"] < 0 or not has_at_most_2dp(item["physical_value_usd"]):
                errors.append(f"items[{idx}].physical_value_usd invalid")
            if not is_exact_number(item.get("discrepancy_value_usd")) or not has_at_most_2dp(item["discrepancy_value_usd"]):
                errors.append(f"items[{idx}].discrepancy_value_usd invalid")
        if len(pids) == len(items):
            if len(set(pids)) != len(pids):
                errors.append("Duplicate product_id in items")
            elif pids != sorted(pids):
                errors.append("items not sorted lexicographically ascending by product_id")

    summary = payload.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
    else:
        if set(summary.keys()) != SUMMARY_KEYS:
            errors.append(f"summary keys mismatch: got {sorted(summary.keys())}")
        for k in (
            "active_product_count",
            "excluded_inactive_count",
            "match_count",
            "shortage_count",
            "surplus_count",
            "supplier_risk_count",
            "total_expected_units",
            "total_physical_units",
        ):
            if not is_exact_int(summary.get(k)) or summary[k] < 0:
                errors.append(f"summary.{k} invalid")
        if not is_exact_number(summary.get("total_physical_value_usd")) or summary["total_physical_value_usd"] < 0 or not has_at_most_2dp(summary["total_physical_value_usd"]):
            errors.append("summary.total_physical_value_usd invalid")
        if not is_exact_number(summary.get("net_discrepancy_value_usd")) or not has_at_most_2dp(summary["net_discrepancy_value_usd"]):
            errors.append("summary.net_discrepancy_value_usd invalid")

    return errors


def verify_workspace(workspace: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    db_path = workspace / ".catalog_state.db"

    # --- PASS_TO_PASS: Integrity checks ---
    immutable_files = ["catalog_tool.py", "schema_spec.json"]
    tampered: list[str] = []
    for rel in immutable_files:
        ref_file = REF_WORKSPACE / rel
        ws_file = workspace / rel
        if not ws_file.exists():
            tampered.append(f"missing:{rel}")
        elif normalized_sha256(ws_file) != normalized_sha256(ref_file):
            tampered.append(f"modified:{rel}")
    add_check(
        checks,
        "workspace_immutable_files_intact",
        len(tampered) == 0,
        "pass_to_pass",
        "catalog_tool.py and schema_spec.json unmodified"
        if not tampered
        else f"Immutable file tampering detected: {', '.join(tampered)}",
    )

    if not db_path.exists():
        for name, grp in [
            ("audit_log_hmac_chain", "pass_to_pass"),
            ("source_tables_untouched", "pass_to_pass"),
            ("all_paginated_endpoints_fetched", "fail_to_pass"),
            ("deterministic_429_retries_handled", "fail_to_pass"),
            ("submission_exists_and_ordered", "fail_to_pass"),
            ("reconciliation_file_matches_submission", "fail_to_pass"),
            ("strict_schema_compliance", "fail_to_pass"),
            ("inactive_product_exclusion", "fail_to_pass"),
            ("item_reconciliation_ground_truth", "fail_to_pass"),
            ("summary_aggregates_ground_truth", "fail_to_pass"),
        ]:
            add_check(checks, name, False, grp, f"Missing state DB: {db_path}")
        return finalize_result(checks, error=f"Missing state DB at {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        audit_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT seq, command, args_json, result_ok, prev_hmac, row_hmac FROM tool_audit_log ORDER BY seq ASC"
            ).fetchall()
        ]
        submissions = [
            dict(r)
            for r in conn.execute(
                "SELECT submission_id, submitted_at, payload_json FROM reconciliation_submissions ORDER BY submission_id ASC"
            ).fetchall()
        ]
        rl_rows = {
            (r["endpoint"], r["cursor"]): int(r["trigger_count"])
            for r in conn.execute("SELECT endpoint, cursor, trigger_count FROM rate_limit_state").fetchall()
        }
        db_suppliers = sorted(
            tuple(r)
            for r in conn.execute(
                "SELECT supplier_id, name, country, status, lead_time_days, page_cursor, page_order FROM suppliers"
            ).fetchall()
        )
        db_products = sorted(
            tuple(r)
            for r in conn.execute(
                "SELECT product_id, name, currency, unit_price, expected_stock, supplier_id, active, page_cursor, page_order FROM products"
            ).fetchall()
        )
        db_warehouses = sorted(
            tuple(r)
            for r in conn.execute(
                "SELECT warehouse_id, name, region, page_cursor, page_order FROM warehouses"
            ).fetchall()
        )
        db_stock = sorted(
            tuple(r)
            for r in conn.execute(
                "SELECT warehouse_id, product_id, quantity FROM warehouse_stock"
            ).fetchall()
        )
        db_fx = sorted(
            tuple(r)
            for r in conn.execute(
                "SELECT as_of_date, currency, rate_to_usd, published_at FROM fx_rates"
            ).fetchall()
        )
    except sqlite3.Error as exc:
        conn.close()
        return finalize_result(checks, error=f"SQLite error inspecting state DB: {exc}")
    finally:
        conn.close()

    # 2. HMAC audit chain verification + submission count consistency
    hmac_ok = True
    hmac_detail = f"Verified {len(audit_rows)} HMAC-chained audit rows"
    expected_prev = GENESIS_HMAC
    parsed_audit: list[dict[str, Any]] = []
    for idx, row in enumerate(audit_rows, start=1):
        if int(row["seq"]) != idx:
            hmac_ok = False
            hmac_detail = f"Non-contiguous audit seq at row {idx}: got {row['seq']}"
            break
        if row["prev_hmac"] != expected_prev:
            hmac_ok = False
            hmac_detail = f"Broken prev_hmac chain at seq={idx}"
            break
        expected_hmac = compute_row_hmac(
            int(row["seq"]),
            str(row["command"]),
            str(row["args_json"]),
            int(row["result_ok"]),
            str(row["prev_hmac"]),
        )
        if not hmac.compare_digest(str(row["row_hmac"]), expected_hmac):
            hmac_ok = False
            hmac_detail = f"Invalid row_hmac signature at seq={idx}"
            break
        expected_prev = expected_hmac
        try:
            args_obj = json.loads(row["args_json"])
        except json.JSONDecodeError:
            hmac_ok = False
            hmac_detail = f"Corrupt args_json at seq={idx}"
            break
        parsed_audit.append({
            "seq": int(row["seq"]),
            "command": str(row["command"]),
            "args": args_obj,
            "result_ok": bool(row["result_ok"]),
        })

    if hmac_ok:
        ok_subs_audit = sum(1 for a in parsed_audit if a["command"] == "submit-reconciliation" and a["result_ok"])
        if ok_subs_audit != len(submissions):
            hmac_ok = False
            hmac_detail = f"Submission/audit divergence: db={len(submissions)} vs audit={ok_subs_audit}"
    add_check(checks, "audit_log_hmac_chain", hmac_ok, "pass_to_pass", hmac_detail)

    # 3. Source tables untouched
    source_diffs: list[str] = []
    if db_suppliers != sorted(GT_SUPPLIERS):
        source_diffs.append("suppliers")
    if db_products != sorted(GT_PRODUCTS):
        source_diffs.append("products")
    if db_warehouses != sorted(GT_WAREHOUSES):
        source_diffs.append("warehouses")
    if db_stock != sorted(GT_WAREHOUSE_STOCK):
        source_diffs.append("warehouse_stock")
    if db_fx != sorted(GT_FX_RATES):
        source_diffs.append("fx_rates")
    add_check(
        checks,
        "source_tables_untouched",
        len(source_diffs) == 0,
        "pass_to_pass",
        "All source catalog/warehouse/supplier/FX tables match pristine state"
        if not source_diffs
        else f"Source table tampering detected: {', '.join(source_diffs)}",
    )

    # --- FAIL_TO_PASS: Pagination, 429 retry, submission, schema, ground-truth math ---

    def find_seqs(cmd: str, pred, ok_only: bool | None = None) -> list[int]:
        out: list[int] = []
        for a in parsed_audit:
            if a["command"] != cmd:
                continue
            if ok_only is True and not a["result_ok"]:
                continue
            if ok_only is False and a["result_ok"]:
                continue
            if pred(a["args"]):
                out.append(a["seq"])
        return out

    required_fetches = [
        ("list-products(p1)", "list-products", lambda d: d.get("cursor") == "p1"),
        ("list-products(p2)", "list-products", lambda d: d.get("cursor") == "p2"),
        ("list-products(p3)", "list-products", lambda d: d.get("cursor") == "p3"),
        ("list-warehouses(w1)", "list-warehouses", lambda d: d.get("cursor") == "w1"),
        ("list-warehouses(w2)", "list-warehouses", lambda d: d.get("cursor") == "w2"),
        ("list-suppliers(s1)", "list-suppliers", lambda d: d.get("cursor") == "s1"),
        ("list-suppliers(s2)", "list-suppliers", lambda d: d.get("cursor") == "s2"),
        ("get-fx-rates(2026-10-01)", "get-fx-rates", lambda d: d.get("as_of") == "2026-10-01"),
    ]
    missing_fetches: list[str] = []
    first_fetch_seqs: list[int] = []
    for label, cmd, pred in required_fetches:
        seqs = find_seqs(cmd, pred, ok_only=True)
        if not seqs:
            missing_fetches.append(label)
        else:
            first_fetch_seqs.append(seqs[0])
    all_fetched = hmac_ok and len(missing_fetches) == 0
    add_check(
        checks,
        "all_paginated_endpoints_fetched",
        all_fetched,
        "fail_to_pass",
        "All product/warehouse/supplier cursors and FX rates fetched successfully"
        if all_fetched
        else f"Missing fetches: {', '.join(missing_fetches)}" if missing_fetches else "HMAC chain invalid",
    )

    # 5. Deterministic 429 retries handled on BOTH list-products(p3) and list-warehouses(w2)
    retry_issues: list[str] = []
    for endpoint, cursor in (("list-products", "p3"), ("list-warehouses", "w2")):
        fail_seqs = find_seqs(endpoint, lambda d, c=cursor: d.get("cursor") == c, ok_only=False)
        ok_seqs = find_seqs(endpoint, lambda d, c=cursor: d.get("cursor") == c, ok_only=True)
        tc = rl_rows.get((endpoint, cursor), 0)
        if not fail_seqs:
            retry_issues.append(f"{endpoint}({cursor}): 429 was never triggered")
        elif not ok_seqs:
            retry_issues.append(f"{endpoint}({cursor}): never succeeded after 429")
        elif not any(ok_s > fail_seqs[0] for ok_s in ok_seqs):
            retry_issues.append(f"{endpoint}({cursor}): success did not follow 429")
        if tc < 2:
            retry_issues.append(f"{endpoint}({cursor}): rate_limit_state.trigger_count={tc} (<2)")
    retries_ok = hmac_ok and len(retry_issues) == 0
    add_check(
        checks,
        "deterministic_429_retries_handled",
        retries_ok,
        "fail_to_pass",
        "Both transient 429 endpoints (list-products p3 & list-warehouses w2) triggered and succeeded on retry"
        if retries_ok
        else "; ".join(retry_issues) if retry_issues else "HMAC chain invalid",
    )

    # 6. Submission exists and happened AFTER all required fetches
    sub_ok_seqs = find_seqs("submit-reconciliation", lambda d: True, ok_only=True)
    sub_ordered = False
    sub_detail = "No valid submission found"
    latest_sub_payload: Any = None
    if not submissions or not sub_ok_seqs:
        sub_detail = "No accepted submit-reconciliation record in .catalog_state.db"
    elif not all_fetched:
        sub_detail = "Cannot verify ordering because some required fetch calls are missing"
    else:
        latest_sub_seq = sub_ok_seqs[-1]
        max_fetch_seq = max(first_fetch_seqs)
        if latest_sub_seq > max_fetch_seq:
            sub_ordered = True
            sub_detail = (
                f"Submission {submissions[-1]['submission_id']} recorded at seq={latest_sub_seq} "
                f"after all fetches completed (max_fetch_seq={max_fetch_seq})"
            )
        else:
            sub_detail = f"Latest submission seq={latest_sub_seq} did not follow all fetches (max_fetch_seq={max_fetch_seq})"
        try:
            latest_sub_payload = json.loads(submissions[-1]["payload_json"])
        except json.JSONDecodeError as exc:
            sub_ordered = False
            sub_detail = f"Stored submission JSON corrupted: {exc}"
    add_check(checks, "submission_exists_and_ordered", sub_ordered, "fail_to_pass", sub_detail)

    # 7. reconciliation.json exists and matches latest DB submission
    rec_path = workspace / "reconciliation.json"
    file_matches = False
    file_detail = ""
    file_payload: Any = None
    if not rec_path.exists():
        file_detail = "reconciliation.json not found in workspace root"
    else:
        try:
            file_payload = json.loads(rec_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            file_detail = f"reconciliation.json unreadable/invalid JSON: {exc}"
        else:
            if latest_sub_payload is None:
                file_detail = "No accepted DB submission to compare reconciliation.json against"
            elif file_payload == latest_sub_payload:
                file_matches = True
                file_detail = "reconciliation.json matches latest accepted DB submission exactly"
            else:
                file_detail = "reconciliation.json differs from latest accepted DB submission"
    add_check(checks, "reconciliation_file_matches_submission", file_matches, "fail_to_pass", file_detail)

    # Evaluate payload (prefer DB submission if present, else file_payload)
    target_payload = latest_sub_payload if latest_sub_payload is not None else file_payload

    # 8. Strict schema compliance
    if target_payload is None:
        schema_errors = ["No reconciliation payload available"]
    else:
        schema_errors = validate_strict_schema(target_payload)
    add_check(
        checks,
        "strict_schema_compliance",
        len(schema_errors) == 0,
        "fail_to_pass",
        "Payload conforms strictly to Draft-07 schema (exact keys, types, enums, UTC timestamp, sorted SKUs)"
        if not schema_errors
        else "; ".join(schema_errors[:8]),
    )

    gt_items, gt_summary = compute_ground_truth()

    # 9. Inactive product exclusion
    excl_ok = False
    excl_detail = "No reconciliation payload available"
    if isinstance(target_payload, dict) and isinstance(target_payload.get("items"), list) and isinstance(target_payload.get("summary"), dict):
        item_ids = [x.get("product_id") for x in target_payload["items"] if isinstance(x, dict)]
        excl_cnt = target_payload["summary"].get("excluded_inactive_count")
        if "SKU-107" in item_ids:
            excl_detail = "Inactive/discontinued product SKU-107 was NOT excluded from items"
        elif len(item_ids) != len(gt_items):
            excl_detail = f"Expected {len(gt_items)} active items, got {len(item_ids)}"
        elif not is_exact_int(excl_cnt) or excl_cnt != gt_summary["excluded_inactive_count"]:
            excl_detail = f"summary.excluded_inactive_count expected {gt_summary['excluded_inactive_count']}, got {excl_cnt!r}"
        else:
            excl_ok = True
            excl_detail = "Inactive SKU-107 excluded from items and summary.excluded_inactive_count == 1"
    add_check(checks, "inactive_product_exclusion", excl_ok, "fail_to_pass", excl_detail)

    # 10. Per-item ground truth math & fields
    item_errors: list[str] = []
    if not isinstance(target_payload, dict) or not isinstance(target_payload.get("items"), list):
        item_errors.append("Missing items array")
    else:
        actual_by_id = {
            x.get("product_id"): x
            for x in target_payload["items"]
            if isinstance(x, dict) and isinstance(x.get("product_id"), str)
        }
        if len(actual_by_id) != len(gt_items):
            item_errors.append(f"Expected {len(gt_items)} active SKUs, got {len(actual_by_id)}")
        for exp in gt_items:
            pid = exp["product_id"]
            act = actual_by_id.get(pid)
            if act is None:
                item_errors.append(f"Missing active SKU {pid}")
                continue
            for str_bool_int_key in (
                "name",
                "supplier_id",
                "supplier_status",
                "supplier_risk",
                "currency",
                "expected_stock",
                "physical_stock",
                "discrepancy_units",
                "status",
            ):
                if act.get(str_bool_int_key) != exp[str_bool_int_key]:
                    item_errors.append(
                        f"{pid}.{str_bool_int_key}: expected {exp[str_bool_int_key]!r}, got {act.get(str_bool_int_key)!r}"
                    )
            for dec_key in ("unit_price", "physical_value_usd", "discrepancy_value_usd"):
                act_dec = to_decimal_strict(act.get(dec_key))
                if act_dec is None or act_dec != exp[dec_key]:
                    item_errors.append(
                        f"{pid}.{dec_key}: expected {exp[dec_key]}, got {act.get(dec_key)!r}"
                    )
    add_check(
        checks,
        "item_reconciliation_ground_truth",
        len(schema_errors) == 0 and len(item_errors) == 0,
        "fail_to_pass",
        f"All {len(gt_items)} active SKUs match exact stock, status, supplier_risk, and ROUND_HALF_UP USD valuation"
        if (not schema_errors and not item_errors)
        else "; ".join((item_errors or schema_errors)[:8]),
    )

    # 11. Summary aggregates ground truth
    sum_errors: list[str] = []
    if not isinstance(target_payload, dict) or not isinstance(target_payload.get("summary"), dict):
        sum_errors.append("Missing summary object")
    else:
        act_sum = target_payload["summary"]
        for int_key in (
            "active_product_count",
            "excluded_inactive_count",
            "match_count",
            "shortage_count",
            "surplus_count",
            "supplier_risk_count",
            "total_expected_units",
            "total_physical_units",
        ):
            if not is_exact_int(act_sum.get(int_key)) or act_sum[int_key] != gt_summary[int_key]:
                sum_errors.append(f"summary.{int_key}: expected {gt_summary[int_key]}, got {act_sum.get(int_key)!r}")
        for dec_key in ("total_physical_value_usd", "net_discrepancy_value_usd"):
            act_dec = to_decimal_strict(act_sum.get(dec_key))
            if act_dec is None or act_dec != gt_summary[dec_key]:
                sum_errors.append(f"summary.{dec_key}: expected {gt_summary[dec_key]}, got {act_sum.get(dec_key)!r}")
    add_check(
        checks,
        "summary_aggregates_ground_truth",
        len(schema_errors) == 0 and len(sum_errors) == 0,
        "fail_to_pass",
        "All 10 summary aggregate fields match exact ground truth"
        if (not schema_errors and not sum_errors)
        else "; ".join((sum_errors or schema_errors)[:8]),
    )

    return finalize_result(checks, error=None)


def finalize_result(checks: list[dict[str, Any]], error: str | None) -> dict[str, Any]:
    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    f2p_total = len(f2p)
    p2p_total = len(p2p)

    if f2p_total > 0 and p2p_total > 0:
        score = round((f2p_passed / f2p_total) * (p2p_passed / p2p_total), 4)
    elif len(checks) > 0:
        score = round(sum(1 for c in checks if c["passed"]) / len(checks), 4)
    else:
        score = 0.0

    passed = (
        error is None
        and len(checks) > 0
        and f2p_passed == f2p_total
        and p2p_passed == p2p_total
    )
    if passed:
        score = 1.0

    return {
        "task_id": TASK_ID,
        "passed": passed,
        "score": score,
        "fail_to_pass": {"passed": f2p_passed, "total": f2p_total},
        "pass_to_pass": {"passed": p2p_passed, "total": p2p_total},
        "checks": checks,
        "error": error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID} workspace.")
    parser.add_argument("--workspace", required=True, help="Workspace directory to grade")
    args = parser.parse_args()
    try:
        result = verify_workspace(Path(args.workspace).resolve())
    except Exception as exc:
        result = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier exception: {exc}",
        }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
