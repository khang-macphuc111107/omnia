#!/usr/bin/env python3
"""setup.py - Deterministically initializes .catalog_state.db for bfcl_02_schema_compiler."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

DB_FILENAME = ".catalog_state.db"


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE suppliers (
            supplier_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            country TEXT NOT NULL,
            status TEXT NOT NULL,
            lead_time_days INTEGER NOT NULL,
            page_cursor TEXT NOT NULL,
            page_order INTEGER NOT NULL
        );

        CREATE TABLE products (
            product_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            currency TEXT NOT NULL,
            unit_price TEXT NOT NULL,
            expected_stock INTEGER NOT NULL,
            supplier_id TEXT NOT NULL,
            active INTEGER NOT NULL,
            page_cursor TEXT NOT NULL,
            page_order INTEGER NOT NULL,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id)
        );

        CREATE TABLE warehouses (
            warehouse_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            region TEXT NOT NULL,
            page_cursor TEXT NOT NULL,
            page_order INTEGER NOT NULL
        );

        CREATE TABLE warehouse_stock (
            warehouse_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            PRIMARY KEY (warehouse_id, product_id),
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(warehouse_id),
            FOREIGN KEY (product_id) REFERENCES products(product_id)
        );

        CREATE TABLE fx_rates (
            as_of_date TEXT NOT NULL,
            currency TEXT NOT NULL,
            rate_to_usd TEXT NOT NULL,
            published_at TEXT NOT NULL,
            PRIMARY KEY (as_of_date, currency)
        );

        CREATE TABLE rate_limit_state (
            endpoint TEXT NOT NULL,
            cursor TEXT NOT NULL,
            trigger_count INTEGER NOT NULL,
            PRIMARY KEY (endpoint, cursor)
        );

        CREATE TABLE reconciliation_submissions (
            submission_id TEXT PRIMARY KEY,
            submitted_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE tool_audit_log (
            seq INTEGER PRIMARY KEY,
            command TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_ok INTEGER NOT NULL,
            prev_hmac TEXT NOT NULL,
            row_hmac TEXT NOT NULL
        );
        """
    )


def seed_data(conn: sqlite3.Connection) -> None:
    suppliers = [
        ("SUP-01", "Nordic Components AB", "SE", "active", 7, "s1", 1),
        ("SUP-02", "Thames Precision Ltd", "GB", "suspended", 21, "s1", 2),
        ("SUP-03", "Kyoto MicroDevices KK", "JP", "active", 14, "s2", 1),
        ("SUP-04", "Pacific Logic Corp", "US", "suspended", 10, "s2", 2),
    ]
    conn.executemany(
        """
        INSERT INTO suppliers (supplier_id, name, country, status, lead_time_days, page_cursor, page_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        suppliers,
    )

    products = [
        # Page p1
        ("SKU-104", "Optical Sensor Module", "EUR", "13.00", 20, "SUP-01", 1, "p1", 1),
        ("SKU-101", "USB-C PD Controller", "USD", "18.50", 50, "SUP-04", 1, "p1", 2),
        ("SKU-109", "Thermal Interface Pad", "JPY", "1500.00", 40, "SUP-03", 1, "p1", 3),
        ("SKU-107", "Legacy RS-232 Bridge", "USD", "29.99", 15, "SUP-04", 0, "p1", 4),
        # Page p2
        ("SKU-112", "NVMe Heatsink Fin", "GBP", "22.50", 30, "SUP-02", 1, "p2", 1),
        ("SKU-102", "DIN Rail Power Supply", "EUR", "64.00", 12, "SUP-01", 1, "p2", 2),
        ("SKU-106", "Ceramic Resonator 16MHz", "JPY", "250.00", 100, "SUP-03", 1, "p2", 3),
        ("SKU-110", "Shielded Ethernet Coupler", "USD", "12.75", 60, "SUP-04", 1, "p2", 4),
        # Page p3 (triggers deterministic 429 on first call)
        ("SKU-103", "Precision Torque Driver", "GBP", "35.00", 25, "SUP-02", 1, "p3", 1),
        ("SKU-108", "CAN Bus Transceiver IC", "EUR", "11.00", 45, "SUP-01", 1, "p3", 2),
        ("SKU-111", "High-Temp Silicone Ribbon", "JPY", "850.00", 35, "SUP-03", 1, "p3", 3),
        ("SKU-105", "Aluminum Enclosure IP67", "USD", "54.25", 18, "SUP-01", 1, "p3", 4),
    ]
    conn.executemany(
        """
        INSERT INTO products (
            product_id, name, currency, unit_price, expected_stock,
            supplier_id, active, page_cursor, page_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        products,
    )

    warehouses = [
        ("WH-EAST", "North America East Hub", "US-EAST", "w1", 1),
        ("WH-EU", "Europe Rotterdam Hub", "EU-WEST", "w1", 2),
        ("WH-APAC", "Asia-Pacific Osaka Hub", "AP-EAST", "w2", 1),
    ]
    conn.executemany(
        """
        INSERT INTO warehouses (warehouse_id, name, region, page_cursor, page_order)
        VALUES (?, ?, ?, ?, ?)
        """,
        warehouses,
    )

    warehouse_stock = [
        # WH-EAST
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
        # WH-EU
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
        # WH-APAC (note: SKU-105 intentionally omitted -> 0 units in WH-APAC)
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
    conn.executemany(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)",
        warehouse_stock,
    )

    fx_rates = [
        ("2026-10-01", "USD", "1.0", "2026-10-01T00:00:00Z"),
        ("2026-10-01", "EUR", "1.085", "2026-10-01T00:00:00Z"),
        ("2026-10-01", "GBP", "1.27", "2026-10-01T00:00:00Z"),
        ("2026-10-01", "JPY", "0.0067", "2026-10-01T00:00:00Z"),
    ]
    conn.executemany(
        "INSERT INTO fx_rates (as_of_date, currency, rate_to_usd, published_at) VALUES (?, ?, ?, ?)",
        fx_rates,
    )

    rate_limits = [
        ("list-products", "p3", 0),
        ("list-warehouses", "w2", 0),
    ]
    conn.executemany(
        "INSERT INTO rate_limit_state (endpoint, cursor, trigger_count) VALUES (?, ?, ?)",
        rate_limits,
    )


def init_workspace(workspace_dir: Path) -> Path:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    db_path = workspace_dir / DB_FILENAME
    for suffix in ("", "-wal", "-shm", "-journal"):
        candidate = Path(f"{db_path}{suffix}")
        if candidate.exists():
            candidate.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        create_schema(conn)
        seed_data(conn)
        conn.commit()
    finally:
        conn.close()
    return db_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize bfcl_02_schema_compiler workspace DB.")
    parser.add_argument("--workspace", required=True, help="Target workspace directory")
    args = parser.parse_args()
    db_path = init_workspace(Path(args.workspace).resolve())
    print(json.dumps({"ok": True, "db_path": str(db_path)}))


if __name__ == "__main__":
    main()
