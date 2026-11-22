#!/usr/bin/env python3
"""Deterministic legacy SQLite database generator for term_03_sqlite_migration."""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
from decimal import Decimal
from pathlib import Path


FX_RATES = {
    "USD": "1.00",
    "EUR": "1.08",
    "GBP": "1.27",
    "JPY": "0.0065",
}

LEGACY_USERS = [
    # 19 canonical users + 7 case/whitespace duplicates (total 26 rows)
    (1, "alice.chen@acme.io", "Alice Chen", "2025-01-05T09:00:00Z"),
    (2, "bob.patel@acme.io", "Bob Patel", "2025-01-06T10:15:00Z"),
    (3, "carol.diaz@acme.io", "Carol Diaz", "2025-01-07T11:30:00Z"),
    (4, "david.kim@acme.io", "David Kim", "2025-01-08T12:00:00Z"),
    (5, "elena.rossi@acme.io", "Elena Rossi", "2025-01-09T14:20:00Z"),
    (6, "farid.hassan@acme.io", "Farid Hassan", "2025-01-10T16:45:00Z"),
    (7, "grace.liu@acme.io", "Grace Liu", "2025-01-11T08:10:00Z"),
    (8, "  Alice.Chen@ACME.IO  ", "Alice Chen (Dup 1)", "2025-01-12T09:00:00Z"),  # dup of 1
    (9, "henry.novak@acme.io", "Henry Novak", "2025-01-13T10:00:00Z"),
    (10, "irene.sato@acme.io", "Irene Sato", "2025-01-14T11:00:00Z"),
    (11, "BOB.PATEL@acme.io", "Bob Patel Dup", "2025-01-15T12:00:00Z"),  # dup of 2
    (12, "jack.miller@acme.io", "Jack Miller", "2025-01-16T13:00:00Z"),
    (13, "kate.okafor@acme.io", "Kate Okafor", "2025-01-17T14:00:00Z"),
    (14, "\tcarol.diaz@ACME.io ", "Carol Diaz Dup", "2025-01-18T15:00:00Z"),  # dup of 3
    (15, "liam.walsh@acme.io", "Liam Walsh", "2025-01-19T16:00:00Z"),
    (16, "maya.singh@acme.io", "Maya Singh", "2025-01-20T17:00:00Z"),
    (17, "noah.berg@acme.io", "Noah Berg", "2025-01-21T08:30:00Z"),
    (18, "olivia.grant@acme.io", "Olivia Grant", "2025-01-22T09:30:00Z"),
    (19, "ALICE.CHEN@acme.io\t", "Alice Chen (Dup 2)", "2025-01-23T10:30:00Z"),  # dup of 1
    (20, "paul.costa@acme.io", "Paul Costa", "2025-01-24T11:30:00Z"),
    (21, "quinn.park@acme.io", "Quinn Park", "2025-01-25T12:30:00Z"),
    (22, "  David.Kim@acme.io", "David Kim Dup", "2025-01-26T13:30:00Z"),  # dup of 4
    (23, "rosa.silva@acme.io", "Rosa Silva", "2025-01-27T14:30:00Z"),
    (24, "sam.alvarez@acme.io", "Sam Alvarez", "2025-01-28T15:30:00Z"),
    (25, "ELENA.ROSSI@ACME.IO ", "Elena Rossi Dup", "2025-01-29T16:30:00Z"),  # dup of 5
    (26, "  grace.liu@ACME.io  ", "Grace Liu Dup", "2025-01-30T17:30:00Z"),  # dup of 7
]

DUPLICATE_USER_IDS = [8, 11, 14, 19, 22, 25, 26]
CANONICAL_USER_IDS = [1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13, 15, 16, 17, 18, 20, 21, 23, 24]


def format_price(currency: str, amount: Decimal, variant: int) -> str:
    if currency == "USD":
        if variant == 0:
            return f"${amount:,.2f}"
        if variant == 1:
            return f"USD {amount:,.2f}"
        # Bare numeric string (defaults to USD)
        return f"{int(amount)}" if amount == int(amount) else f"{amount:,.2f}"
    if currency == "EUR":
        return f"EUR {amount:,.2f}" if variant % 2 == 0 else f"\u20ac{amount:,.2f}"
    if currency == "GBP":
        return f"GBP {amount:,.2f}" if variant % 2 == 0 else f"\u00a3{amount:,.2f}"
    if currency == "JPY":
        return f"JPY {int(amount)}" if variant % 2 == 0 else f"\u00a5{int(amount):,}"
    raise ValueError(f"unsupported currency: {currency}")


def generate_workspace(workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20260303)

    # Write fx_rates.json
    with (workspace / "fx_rates.json").open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(FX_RATES, fh, indent=2)
        fh.write("\n")

    db_path = workspace / "app.db"
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE users_legacy (
                id INTEGER PRIMARY KEY,
                email TEXT,
                full_name TEXT,
                created_at TEXT
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE orders_legacy (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                status TEXT,
                total_raw TEXT,
                items_json TEXT,
                created_at TEXT
            )
            """
        )

        cur.executemany(
            "INSERT INTO users_legacy (id, email, full_name, created_at) VALUES (?, ?, ?, ?)",
            LEGACY_USERS,
        )

        catalog_by_currency = {
            "USD": [
                ("SKU-LAPTOP-14", Decimal("1250.50")),
                ("SKU-DOCK-PRO", Decimal("189.00")),
                ("SKU-CABLE-USBC", Decimal("15.99")),
                ("SKU-STAND-ALU", Decimal("45.00")),
                ("SKU-MONITOR-27", Decimal("499.95")),
            ],
            "EUR": [
                ("SKU-KEYB-MECH", Decimal("89.90")),
                ("SKU-MOUSE-ERG", Decimal("49.50")),
                ("SKU-HEADSET-NC", Decimal("129.99")),
                ("SKU-HUB-THUNDER", Decimal("64.25")),
            ],
            "GBP": [
                ("SKU-BAG-TECH", Decimal("42.00")),
                ("SKU-WEBCAM-4K", Decimal("79.95")),
                ("SKU-LIGHT-BAR", Decimal("34.50")),
                ("SKU-MIC-USB", Decimal("95.00")),
            ],
            "JPY": [
                ("SKU-NOTE-GRID", Decimal("250")),    # 250 * 0.0065 * 100 = 162.5 -> ROUND_HALF_UP=163!
                ("SKU-PEN-FOUNT", Decimal("1550")),   # 1550 * 0.0065 * 100 = 1007.5 -> ROUND_HALF_UP=1008!
                ("SKU-DESK-MAT", Decimal("3800")),
                ("SKU-CHAIR-LUM", Decimal("15000")),
            ],
        }

        currencies = ["USD", "EUR", "GBP", "JPY"]
        statuses = ["paid", "paid", "paid", "shipped", "pending", "refunded"]
        orders_rows: list[tuple[int, int, str, str, str, str]] = []

        # Build 44 valid orders + 8 quarantined orders (total 52 rows, IDs 101..152)
        orphan_order_ids = {105, 114, 123, 132, 141, 149}
        bad_json_order_id = 128
        bad_item_order_id = 146

        orphan_uids = [901, 902, 903, 904, 905, 906]
        orphan_idx = 0
        dup_assign_counter = 0

        for order_id in range(101, 153):
            day = 1 + ((order_id - 101) % 28)
            hour = (order_id * 3) % 24
            created_at = f"2026-01-{day:02d}T{hour:02d}:15:00Z"

            if order_id in orphan_order_ids:
                uid = orphan_uids[orphan_idx]
                orphan_idx += 1
                items = [{"sku": "SKU-ORPHAN-1", "qty": 2, "unit_price": "$25.00"}]
                orders_rows.append(
                    (order_id, uid, "paid", "$50.00", json.dumps(items), created_at)
                )
                continue

            if order_id == bad_json_order_id:
                orders_rows.append(
                    (
                        order_id,
                        4,
                        "pending",
                        "$99.00",
                        '[{"sku": "SKU-TRUNC", "qty": 1, "unit_price": "$99.00"',  # truncated JSON
                        created_at,
                    )
                )
                continue

            if order_id == bad_item_order_id:
                bad_items = [{"sku": "SKU-BAD-QTY", "qty": 0, "unit_price": "$19.99"}]
                orders_rows.append(
                    (order_id, 6, "pending", "$0.00", json.dumps(bad_items), created_at)
                )
                continue

            # Valid order: ~14 of them reference duplicate user IDs!
            if dup_assign_counter < 14 and (order_id % 3 == 0):
                uid = DUPLICATE_USER_IDS[dup_assign_counter % len(DUPLICATE_USER_IDS)]
                dup_assign_counter += 1
            else:
                uid = CANONICAL_USER_IDS[(order_id - 101) % len(CANONICAL_USER_IDS)]

            # Ensure order 101 explicitly tests bare USD + comma USD, and order 104 tests JPY 250 (.5 half-up tie!)
            if order_id == 101:
                items_spec = [("USD", "SKU-LAPTOP-14", 1, Decimal("1250.50"), 0), ("USD", "SKU-STAND-ALU", 2, Decimal("45.00"), 2)]
                currency = "USD"
            elif order_id == 104:
                items_spec = [("JPY", "SKU-NOTE-GRID", 3, Decimal("250"), 1), ("JPY", "SKU-PEN-FOUNT", 1, Decimal("1550"), 0)]
                currency = "JPY"
            else:
                currency = currencies[(order_id - 101) % len(currencies)]
                pool = catalog_by_currency[currency]
                n_items = rng.randint(1, 3)
                chosen = rng.sample(pool, k=n_items)
                items_spec = [
                    (currency, sku, rng.randint(1, 4), price, rng.randint(0, 2))
                    for sku, price in chosen
                ]

            items_payload = []
            raw_sum = Decimal("0")
            for cur_code, sku, qty, price, variant in items_spec:
                raw_sum += price * qty
                items_payload.append(
                    {
                        "sku": sku,
                        "qty": qty,
                        "unit_price": format_price(cur_code, price, variant),
                    }
                )
            total_raw = format_price(currency, raw_sum, 0)
            status = statuses[(order_id - 101) % len(statuses)]
            orders_rows.append(
                (order_id, uid, status, total_raw, json.dumps(items_payload), created_at)
            )

        cur.executemany(
            """
            INSERT INTO orders_legacy (id, user_id, status, total_raw, items_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            orders_rows,
        )
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize term_03_sqlite_migration workspace.")
    parser.add_argument("--workspace", required=True, help="Target workspace directory")
    args = parser.parse_args()
    generate_workspace(Path(args.workspace).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
