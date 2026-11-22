#!/usr/bin/env python3
"""Deterministic dataset generator for term_02_log_etl_pipeline."""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path


REGIONS = [
    ("ap-south", "Asia Pacific South", "Asia/Kolkata"),
    ("eu-west", "Europe West", "Europe/Dublin"),
    ("sa-east", "South America East", "America/Sao_Paulo"),
    ("us-east", "US East", "America/New_York"),
]

OFFSETS = [
    timezone.utc,
    timezone(timedelta(hours=7)),
    timezone(timedelta(hours=-5)),
    timezone(timedelta(hours=5, minutes=30)),
    timezone(timedelta(hours=-3)),
]

STATUS_POOL = [200, 200, 200, 200, 201, 204, 400, 404, 429, 499, 500, 502, 503, 504]


def format_timestamp(rng: random.Random, dt_utc: datetime, style: str, *, as_json: bool) -> str | int:
    ms = dt_utc.microsecond // 1000
    epoch_ms = int(dt_utc.timestamp()) * 1000 + ms
    if style == "epoch_ms":
        return epoch_ms if as_json else str(epoch_ms)
    if style == "iso_z_ms":
        return f"{dt_utc.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}Z"
    if style == "iso_z_sec":
        dt_sec = dt_utc.replace(microsecond=0)
        return dt_sec.strftime("%Y-%m-%dT%H:%M:%SZ")
    # ISO with explicit non-UTC offset
    tz = rng.choice(OFFSETS[1:])
    local_dt = dt_utc.astimezone(tz)
    offset_str = local_dt.strftime("%z")
    offset_colon = f"{offset_str[:3]}:{offset_str[3:]}"
    if ms > 0:
        return f"{local_dt.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}{offset_colon}"
    return f"{local_dt.strftime('%Y-%m-%dT%H:%M:%S')}{offset_colon}"


def generate_dataset(workspace: Path) -> None:
    data_dir = workspace / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20260201)

    # 1. Write regions.tsv
    tsv_lines = ["region_code\tregion_name\ttimezone"]
    for code, name, tz_name in REGIONS:
        tsv_lines.append(f"{code}\t{name}\t{tz_name}")
    with (data_dir / "regions.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(tsv_lines) + "\n")

    region_codes = [r[0] for r in REGIONS]
    users = [f"usr_{i:03d}" for i in range(1, 46)]
    styles = ["iso_z_ms", "iso_z_sec", "iso_offset", "epoch_ms"]
    base_jan = datetime(2026, 1, 10, 0, 0, 0, tzinfo=timezone.utc)
    base_feb = datetime(2026, 2, 1, 0, 0, 0, tzinfo=timezone.utc)

    # 2. Generate access_2026_01.jsonl (with UTF-8 BOM!)
    jsonl_lines: list[str] = []
    jan_valid_ids: list[str] = []

    # Pre-insert 2 malformed lines that use upcoming valid event_ids to prove malformed rows
    # do NOT poison seen_event_ids!
    jsonl_lines.append(
        json.dumps(
            {
                "event_id": "evt_jan_0005",
                "timestamp": "2026-01-10T01:00:00Z",
                "user_id": "usr_001",
                "region": "us-east",
                "latency_ms": -12.5,
                "status": 200,
            }
        )
    )
    jsonl_lines.append(
        json.dumps(
            {
                "event_id": "evt_jan_0010",
                "timestamp": "2026-01-10T02:00:00",  # naive timestamp -> malformed
                "user_id": "usr_002",
                "region": "eu-west",
                "latency_ms": 50.0,
                "status": 200,
            }
        )
    )

    for i in range(1, 161):
        eid = f"evt_jan_{i:04d}"
        jan_valid_ids.append(eid)
        region = region_codes[(i - 1) % len(region_codes)]
        user_id = rng.choice(users)
        ms_val = rng.choice([0, 125, 250, 500, 750])
        dt = base_jan + timedelta(minutes=i * 37, seconds=rng.randint(0, 59), microseconds=ms_val * 1000)
        style = styles[i % len(styles)]
        if style == "iso_z_sec":
            dt = dt.replace(microsecond=0)
        ts = format_timestamp(rng, dt, style, as_json=True)
        # Every 20th event is a clear high-latency anomaly (well above 3 * p50 ~ 300ms)
        if i % 20 == 0:
            latency = round(rng.randint(2800, 9600) * 0.25, 2)  # 700.00 .. 2400.00
        else:
            latency = round(rng.randint(100, 680) * 0.25, 2)  # 25.00 .. 170.00
        status = rng.choice(STATUS_POOL)
        rec = {
            "event_id": eid,
            "timestamp": ts,
            "user_id": user_id,
            "region": region,
            "latency_ms": latency,
            "status": status,
        }
        jsonl_lines.append(json.dumps(rec))

        # Inject blank line occasionally
        if i in (30, 95):
            jsonl_lines.append("")
            jsonl_lines.append("   ")

    # 12 intra-file valid duplicates (different latency/status so keeping FIRST matters!)
    for dup_idx in range(12):
        orig_id = jan_valid_ids[dup_idx * 10 + 2]
        dt = base_jan + timedelta(days=10, minutes=dup_idx * 5)
        dup_rec = {
            "event_id": orig_id,
            "timestamp": format_timestamp(rng, dt, "iso_z_ms", as_json=True),
            "user_id": "usr_dup",
            "region": "us-east",
            "latency_ms": 1999.0,  # would be anomaly if not deduplicated!
            "status": 503,
        }
        jsonl_lines.append(json.dumps(dup_rec))

    # 10 malformed / truncated / non-object JSON lines
    jsonl_lines.extend(
        [
            '{"event_id": "bad_trunc_1", "timestamp": "2026-01-12T00:00:00Z", "user_id":',
            'not valid json at all',
            '[1, 2, 3]',
            '"just a string"',
            '42',
            'null',
            '{"event_id": "bad_trunc_2", "latency_ms": NaN}',
            '{"event_id": "bad_brace", "status": 200',
            '{bad_key: 123}',
            'true',
        ]
    )

    # 9 semantically invalid JSON objects
    jsonl_lines.extend(
        [
            json.dumps({"event_id": "bad_sem_1", "timestamp": "2026-01-12T01:00:00Z", "region": "us-east", "latency_ms": 50.0, "status": 200}),  # missing user_id
            json.dumps({"event_id": "   ", "timestamp": "2026-01-12T01:05:00Z", "user_id": "usr_001", "region": "us-east", "latency_ms": 50.0, "status": 200}),  # empty event_id
            json.dumps({"event_id": 9999, "timestamp": "2026-01-12T01:10:00Z", "user_id": "usr_001", "region": "us-east", "latency_ms": 50.0, "status": 200}),  # non-str event_id
            json.dumps({"event_id": "bad_sem_4", "timestamp": "2026-01-12T01:15:00Z", "user_id": "usr_001", "region": "us-east", "latency_ms": -0.25, "status": 200}),  # negative latency
            json.dumps({"event_id": "bad_sem_5", "timestamp": "2026-01-12T01:20:00Z", "user_id": "usr_001", "region": "us-east", "latency_ms": True, "status": 200}),  # bool latency
            json.dumps({"event_id": "bad_sem_6", "timestamp": "2026-01-12T01:25:00Z", "user_id": "usr_001", "region": "aq-moon", "latency_ms": 45.0, "status": 200}),  # unknown region
            json.dumps({"event_id": "bad_sem_7", "timestamp": "2026-01-12T01:30:00", "user_id": "usr_001", "region": "eu-west", "latency_ms": 45.0, "status": 200}),  # naive timestamp
            json.dumps({"event_id": "bad_sem_8", "timestamp": "2026-01-12T01:35:00Z", "user_id": "usr_001", "region": "eu-west", "latency_ms": 45.0, "status": 99}),  # status < 100
            json.dumps({"event_id": "bad_sem_9", "timestamp": "2026-01-12T01:40:00Z", "user_id": "usr_001", "region": "eu-west", "latency_ms": 45.0, "status": False}),  # bool status
        ]
    )

    # Write access_2026_01.jsonl with UTF-8 BOM (\ufeff)
    with (data_dir / "access_2026_01.jsonl").open("w", encoding="utf-8-sig", newline="\n") as fh:
        fh.write("\n".join(jsonl_lines) + "\n")

    # 3. Generate access_2026_02.csv
    csv_lines: list[str] = ["event_id,timestamp,user_id,region,latency_ms,status"]
    feb_valid_ids: list[str] = []

    for i in range(1, 149):
        eid = f"evt_feb_{i:04d}"
        feb_valid_ids.append(eid)
        region = region_codes[(i + 1) % len(region_codes)]
        user_id = rng.choice(users)
        ms_val = rng.choice([0, 200, 400, 600, 800])
        dt = base_feb + timedelta(minutes=i * 41, seconds=rng.randint(0, 59), microseconds=ms_val * 1000)
        style = styles[(i + 1) % len(styles)]
        if style == "iso_z_sec":
            dt = dt.replace(microsecond=0)
        ts = str(format_timestamp(rng, dt, style, as_json=False))
        if i % 19 == 0:
            latency = round(rng.randint(2900, 9200) * 0.25, 2)  # 725.00 .. 2300.00
        else:
            latency = round(rng.randint(100, 660) * 0.25, 2)  # 25.00 .. 165.00
        status = rng.choice(STATUS_POOL)
        csv_lines.append(f"{eid},{ts},{user_id},{region},{latency:.2f},{status}")
        if i == 70:
            csv_lines.append("")

    # 8 cross-file duplicates referencing access_2026_01.jsonl
    for k in range(8):
        dup_id = jan_valid_ids[k * 15 + 4]
        csv_lines.append(f"{dup_id},1769990400000,usr_cross,ap-south,1850.00,500")

    # 4 intra-file duplicates referencing access_2026_02.csv
    for k in range(4):
        dup_id = feb_valid_ids[k * 20 + 3]
        csv_lines.append(f"{dup_id},2026-02-15T12:00:00Z,usr_intra,sa-east,2200.00,502")

    # 6 negative latencies
    csv_lines.extend(
        [
            "bad_csv_neg1,2026-02-02T01:00:00Z,usr_001,us-east,-1.00,200",
            "bad_csv_neg2,2026-02-02T02:00:00+07:00,usr_002,eu-west,-45.50,200",
            "bad_csv_neg3,1769994000000,usr_003,ap-south,-0.01,500",
            "bad_csv_neg4,2026-02-02T04:00:00-05:00,usr_004,sa-east,-100,200",
            "bad_csv_neg5,2026-02-02T05:00:00Z,usr_005,us-east,-999.99,404",
            "bad_csv_neg6,2026-02-02T06:00:00Z,usr_006,eu-west,NaN,200",
        ]
    )

    # 4 unknown regions
    csv_lines.extend(
        [
            "bad_csv_reg1,2026-02-03T01:00:00Z,usr_001,cn-north,55.00,200",
            "bad_csv_reg2,2026-02-03T02:00:00Z,usr_002,mars-1,65.00,200",
            "bad_csv_reg3,2026-02-03T03:00:00Z,usr_003,us-west-99,75.00,200",
            "bad_csv_reg4,2026-02-03T04:00:00Z,usr_004,,85.00,200",
        ]
    )

    # 4 bad timestamps / statuses
    csv_lines.extend(
        [
            "bad_csv_ts1,not-a-timestamp,usr_001,us-east,55.00,200",
            "bad_csv_ts2,2026-02-04T12:00:00,usr_002,eu-west,65.00,200",
            "bad_csv_st1,2026-02-04T13:00:00Z,usr_003,ap-south,75.00,abc",
            "bad_csv_st2,2026-02-04T14:00:00Z,usr_004,sa-east,85.00,600",
        ]
    )

    # 4 malformed column-count CSV rows
    csv_lines.extend(
        [
            "bad_csv_col1,2026-02-05T01:00:00Z,usr_001,us-east,55.00",
            "bad_csv_col2,2026-02-05T02:00:00Z,usr_002,eu-west,65.00,200,extra_col",
            "bad_csv_col3,only_two_cols",
            "bad_csv_col4,2026-02-05T04:00:00Z,usr_004,sa-east,85.00,200,x,y",
        ]
    )

    with (data_dir / "access_2026_02.csv").open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(csv_lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize term_02_log_etl_pipeline workspace.")
    parser.add_argument("--workspace", required=True, help="Target workspace directory")
    args = parser.parse_args()
    generate_dataset(Path(args.workspace).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
