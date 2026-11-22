#!/usr/bin/env python3
"""State verification grader for term_02_log_etl_pipeline."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


TASK_ID = "term_02_log_etl_pipeline"
REQUIRED_FIELDS = ("event_id", "timestamp", "user_id", "region", "latency_ms", "status")
ANOMALY_HEADER = ["event_id", "timestamp_utc", "region", "user_id", "latency_ms", "status"]
DIGITS_RE = re.compile(r"^\d+$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def parse_timestamp_utc(raw: object) -> str | None:
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, int):
        if raw < 0:
            return None
        secs, millis = divmod(raw, 1000)
        try:
            dt = datetime.fromtimestamp(secs, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
        return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        if DIGITS_RE.match(s):
            ms_int = int(s)
            secs, millis = divmod(ms_int, 1000)
            try:
                dt = datetime.fromtimestamp(secs, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None
            return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"
        iso = s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s
        try:
            dt = datetime.fromisoformat(iso)
        except ValueError:
            return None
        if dt.tzinfo is None:
            return None
        dt_utc = dt.astimezone(timezone.utc)
        millis = dt_utc.microsecond // 1000
        return f"{dt_utc.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"
    return None


def parse_latency(raw: object) -> float | None:
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        try:
            val = float(s)
        except ValueError:
            return None
    elif isinstance(raw, (int, float)):
        val = float(raw)
    else:
        return None
    if not math.isfinite(val) or val < 0.0:
        return None
    return val


def parse_status(raw: object) -> int | None:
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, int):
        st = raw
    elif isinstance(raw, str):
        s = raw.strip()
        if not DIGITS_RE.match(s):
            return None
        st = int(s)
    else:
        return None
    return st if 100 <= st <= 599 else None


def nearest_rank(sorted_vals: list[float], p: int) -> float:
    n = len(sorted_vals)
    idx = math.ceil((p / 100.0) * n) - 1
    return sorted_vals[max(0, min(n - 1, idx))]


def reference_etl(input_dir: Path) -> tuple[dict, list[list[str]]]:
    regions_map: dict[str, str] = {}
    with (input_dir / "regions.tsv").open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for row in reader:
            code = (row.get("region_code") or "").strip()
            name = (row.get("region_name") or "").strip()
            if code:
                regions_map[code] = name

    files = sorted(
        (p for p in input_dir.iterdir() if p.is_file() and p.suffix in {".jsonl", ".csv"}),
        key=lambda p: p.name,
    )

    malformed_count = 0
    duplicate_count = 0
    seen_ids: set[str] = set()
    valid_events: list[dict] = []

    def validate_and_ingest(rec: dict) -> None:
        nonlocal malformed_count, duplicate_count
        if not all(k in rec for k in REQUIRED_FIELDS):
            malformed_count += 1
            return
        eid_raw = rec["event_id"]
        uid_raw = rec["user_id"]
        reg_raw = rec["region"]
        if not isinstance(eid_raw, str) or not isinstance(uid_raw, str) or not isinstance(reg_raw, str):
            malformed_count += 1
            return
        eid = eid_raw.strip()
        uid = uid_raw.strip()
        reg = reg_raw.strip()
        if not eid or not uid or reg not in regions_map:
            malformed_count += 1
            return
        ts_utc = parse_timestamp_utc(rec["timestamp"])
        latency = parse_latency(rec["latency_ms"])
        status = parse_status(rec["status"])
        if ts_utc is None or latency is None or status is None:
            malformed_count += 1
            return
        if eid in seen_ids:
            duplicate_count += 1
            return
        seen_ids.add(eid)
        valid_events.append(
            {
                "event_id": eid,
                "timestamp_utc": ts_utc,
                "region": reg,
                "user_id": uid,
                "latency_ms": latency,
                "status": status,
            }
        )

    for path in files:
        text = path.read_text(encoding="utf-8-sig")
        if path.suffix == ".jsonl":
            for raw_line in text.splitlines():
                if not raw_line.strip():
                    continue
                try:
                    obj = json.loads(raw_line)
                except json.JSONDecodeError:
                    malformed_count += 1
                    continue
                if not isinstance(obj, dict):
                    malformed_count += 1
                    continue
                validate_and_ingest(obj)
        elif path.suffix == ".csv":
            non_blank = [ln for ln in text.splitlines() if ln.strip()]
            if not non_blank:
                continue
            reader = csv.DictReader(io.StringIO("\n".join(non_blank)))
            for row in reader:
                if None in row or any(row.get(k) is None for k in REQUIRED_FIELDS):
                    malformed_count += 1
                    continue
                validate_and_ingest(row)

    by_region: dict[str, list[dict]] = defaultdict(list)
    for ev in valid_events:
        by_region[ev["region"]].append(ev)

    regions_summary: dict[str, dict] = {}
    region_raw_p50: dict[str, float] = {}
    for code in sorted(by_region.keys()):
        evs = by_region[code]
        lats = sorted(e["latency_ms"] for e in evs)
        p50 = nearest_rank(lats, 50)
        p95 = nearest_rank(lats, 95)
        p99 = nearest_rank(lats, 99)
        region_raw_p50[code] = p50
        errs = sum(1 for e in evs if e["status"] >= 500)
        regions_summary[code] = {
            "region_name": regions_map[code],
            "count": len(evs),
            "unique_users": len({e["user_id"] for e in evs}),
            "error_rate": round(errs / len(evs), 4),
            "p50_ms": round(p50, 2),
            "p95_ms": round(p95, 2),
            "p99_ms": round(p99, 2),
        }

    summary = {
        "total_valid_events": len(valid_events),
        "malformed_count": malformed_count,
        "duplicate_count": duplicate_count,
        "regions": regions_summary,
    }

    anomalies = [
        e for e in valid_events if e["latency_ms"] > 3.0 * region_raw_p50[e["region"]]
    ]
    anomalies.sort(key=lambda e: (e["timestamp_utc"], e["event_id"]))
    anomaly_rows = [
        [
            e["event_id"],
            e["timestamp_utc"],
            e["region"],
            e["user_id"],
            f"{e['latency_ms']:.2f}",
            str(e["status"]),
        ]
        for e in anomalies
    ]
    return summary, anomaly_rows


def check_summary(out_dir: Path, expected: dict) -> tuple[bool, str]:
    path = out_dir / "summary.json"
    if not path.is_file():
        return False, "summary.json missing"
    try:
        actual = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return False, f"invalid JSON: {exc}"
    if not isinstance(actual, dict):
        return False, "summary.json root is not an object"
    for key in ("total_valid_events", "malformed_count", "duplicate_count"):
        if actual.get(key) != expected[key]:
            return False, f"{key}: got={actual.get(key)!r}, expected={expected[key]!r}"
    act_reg = actual.get("regions")
    exp_reg = expected["regions"]
    if not isinstance(act_reg, dict):
        return False, "regions field is not a dict"
    if list(act_reg.keys()) != list(exp_reg.keys()):
        return False, f"region keys/order mismatch: got={list(act_reg.keys())}, expected={list(exp_reg.keys())}"
    for code, exp_metrics in exp_reg.items():
        got_metrics = act_reg.get(code)
        if not isinstance(got_metrics, dict):
            return False, f"region {code} entry is not a dict"
        for field, exp_val in exp_metrics.items():
            got_val = got_metrics.get(field)
            if isinstance(exp_val, float):
                if not isinstance(got_val, (int, float)) or abs(float(got_val) - exp_val) > 1e-6:
                    return False, f"regions[{code}].{field}: got={got_val!r}, expected={exp_val!r}"
            else:
                if got_val != exp_val:
                    return False, f"regions[{code}].{field}: got={got_val!r}, expected={exp_val!r}"
    return True, f"valid={expected['total_valid_events']}, malformed={expected['malformed_count']}, dup={expected['duplicate_count']}"


def check_anomalies(out_dir: Path, expected_rows: list[list[str]]) -> tuple[bool, str]:
    path = out_dir / "anomalies.csv"
    if not path.is_file():
        return False, "anomalies.csv missing"
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return False, "anomalies.csv must not have a UTF-8 BOM"
    if b"\r\n" in raw:
        return False, "anomalies.csv must use LF line endings"
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8"))))
    if not rows:
        return False, "anomalies.csv is empty"
    if rows[0] != ANOMALY_HEADER:
        return False, f"header mismatch: got={rows[0]}, expected={ANOMALY_HEADER}"
    data_rows = rows[1:]
    if len(data_rows) != len(expected_rows):
        return False, f"row count mismatch: got={len(data_rows)}, expected={len(expected_rows)}"
    for idx, (got, exp) in enumerate(zip(data_rows, expected_rows)):
        if got != exp:
            return False, f"row {idx} mismatch: got={got}, expected={exp}"
    return True, f"{len(expected_rows)} anomaly rows matched exactly"


def check_audit(out_dir: Path) -> tuple[bool, str]:
    audit_path = out_dir / "audit.sha256"
    anom_path = out_dir / "anomalies.csv"
    summ_path = out_dir / "summary.json"
    if not audit_path.is_file():
        return False, "audit.sha256 missing"
    if not anom_path.is_file() or not summ_path.is_file():
        return False, "anomalies.csv or summary.json missing"
    raw = audit_path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return False, "audit.sha256 must not have a UTF-8 BOM"
    if b"\r\n" in raw:
        return False, "audit.sha256 must use LF line endings"
    lines = [ln for ln in raw.decode("utf-8").splitlines() if ln]
    exp_anom = hashlib.sha256(anom_path.read_bytes()).hexdigest()
    exp_summ = hashlib.sha256(summ_path.read_bytes()).hexdigest()
    expected_lines = [
        f"{exp_anom}  anomalies.csv",
        f"{exp_summ}  summary.json",
    ]
    if lines != expected_lines:
        return False, f"audit.sha256 mismatch: got={lines!r}, expected={expected_lines!r}"
    return True, "both SHA-256 digests verified"


def build_hidden_dataset(hidden_in: Path) -> None:
    hidden_in.mkdir(parents=True, exist_ok=True)
    # Regions with UTF-8 BOM
    with (hidden_in / "regions.tsv").open("w", encoding="utf-8-sig", newline="\n") as fh:
        fh.write(
            "region_code\tregion_name\ttimezone\n"
            "ca-central\tCanada Central\tAmerica/Toronto\n"
            "de-frankfurt\tGermany Frankfurt\tEurope/Berlin\n"
            "jp-east\tJapan East\tAsia/Tokyo\n"
        )

    # 01_batch.csv (UTF-8 BOM)
    csv_01 = [
        "event_id,timestamp,user_id,region,latency_ms,status",
        # Malformed line reusing h_002 BEFORE valid h_002 appears
        "h_002,2026-03-01T00:00:00Z,u_bad,ca-central,-5.00,200",
        "h_001,2026-03-01T01:00:00+09:00,u1,ca-central,40.00,200",
        "h_002,2026-02-28T20:30:00.500-04:00,u2,ca-central,50.00,499",
        "h_003,1772326800250,u1,ca-central,60.00,500",
        "h_004,2026-03-01T03:00:00Z,u3,ca-central,250.00,503",  # anomaly (p50=55/50 -> > 3*p50)
        "h_005,2026-03-01T03:15:00Z,u4,ca-central,50.00,200",
        "h_006,2026-03-01T04:00:00Z,u9,jp-east,88.50,201",  # single-event region!
        "h_bad_extra,2026-03-01T04:10:00Z,u1,ca-central,10.00,200,EXTRA",
        "h_bad_reg,2026-03-01T04:12:00Z,u1,unknown-reg,10.00,200",
        "h_bad_inf,2026-03-01T04:15:00Z,u1,ca-central,inf,200",
    ]
    with (hidden_in / "01_batch.csv").open("w", encoding="utf-8-sig", newline="\n") as fh:
        fh.write("\n".join(csv_01) + "\n")

    # 02_batch.jsonl (UTF-8 BOM)
    jsonl_02 = [
        # Cross-file duplicate of h_001 from 01_batch.csv (must be skipped!)
        json.dumps({"event_id": "h_001", "timestamp": "2026-03-02T00:00:00Z", "user_id": "u_dup", "region": "de-frankfurt", "latency_ms": 9999.0, "status": 500}),
        json.dumps({"event_id": "h_010", "timestamp": 1772330400000, "user_id": "u5", "region": "de-frankfurt", "latency_ms": 100.0, "status": 200}),
        json.dumps({"event_id": "h_011", "timestamp": "2026-03-01T05:00:00+01:00", "user_id": "u6", "region": "de-frankfurt", "latency_ms": 110.0, "status": 499}),
        json.dumps({"event_id": "h_012", "timestamp": "2026-03-01T06:00:00.125Z", "user_id": "u5", "region": "de-frankfurt", "latency_ms": 120.0, "status": 502}),
        json.dumps({"event_id": "h_013", "timestamp": "2026-03-01T02:00:00Z", "user_id": "u7", "region": "de-frankfurt", "latency_ms": 500.0, "status": 200}),  # anomaly & earlier timestamp!
        # Intra-file duplicate
        json.dumps({"event_id": "h_010", "timestamp": "2026-03-01T07:00:00Z", "user_id": "u99", "region": "de-frankfurt", "latency_ms": 800.0, "status": 500}),
        # Malformed lines
        "{broken json",
        json.dumps({"event_id": "h_bad_naive", "timestamp": "2026-03-01T08:00:00", "user_id": "u5", "region": "de-frankfurt", "latency_ms": 10.0, "status": 200}),
        json.dumps({"event_id": "h_bad_bool", "timestamp": True, "user_id": "u5", "region": "de-frankfurt", "latency_ms": 10.0, "status": 200}),
        "   ",
    ]
    with (hidden_in / "02_batch.jsonl").open("w", encoding="utf-8-sig", newline="\n") as fh:
        fh.write("\n".join(jsonl_02) + "\n")

    # 03_batch.csv (cross-file duplicate of h_010 + valid event with tie timestamp to test event_id secondary sort)
    csv_03 = [
        "event_id,timestamp,user_id,region,latency_ms,status",
        "h_010,2026-03-03T00:00:00Z,u_dup3,ca-central,9000.00,500",
        "h_000_tie,2026-03-01T02:00:00.000Z,u8,de-frankfurt,480.00,200",  # same UTC ts as h_013, sorts BEFORE h_013!
    ]
    with (hidden_in / "03_batch.csv").open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(csv_03) + "\n")


def check_input_data_intact(workspace: Path) -> tuple[bool, str]:
    setup_script = Path(__file__).resolve().parent / "setup.py"
    with tempfile.TemporaryDirectory(prefix="t2_ref_") as tmp:
        ref_ws = Path(tmp)
        proc = subprocess.run(
            [sys.executable, str(setup_script), "--workspace", str(ref_ws)],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return False, f"reference setup failed: {proc.stderr}"
        for fname in ("regions.tsv", "access_2026_01.jsonl", "access_2026_02.csv"):
            ws_file = workspace / "data" / fname
            ref_file = ref_ws / "data" / fname
            if not ws_file.is_file():
                return False, f"data/{fname} missing"
            if hashlib.sha256(ws_file.read_bytes()).hexdigest() != hashlib.sha256(ref_file.read_bytes()).hexdigest():
                return False, f"data/{fname} was modified"
    return True, "all input data files intact"


def verify(workspace: Path) -> dict:
    checks: list[dict] = []

    def add_check(name: str, passed: bool, group: str, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    try:
        # PASS_TO_PASS
        ok, detail = check_input_data_intact(workspace)
        add_check("input_data_intact", ok, "pass_to_pass", detail)

        # FAIL_TO_PASS
        pipeline_py = workspace / "pipeline.py"
        add_check(
            "pipeline_script_exists",
            pipeline_py.is_file(),
            "fail_to_pass",
            "found pipeline.py" if pipeline_py.is_file() else "pipeline.py missing",
        )

        # Verify workspace/output against workspace/data
        exp_summary, exp_anomalies = reference_etl(workspace / "data")
        ws_out = workspace / "output"

        ok, detail = check_summary(ws_out, exp_summary)
        add_check("workspace_summary_json_exact", ok, "fail_to_pass", detail)

        ok, detail = check_anomalies(ws_out, exp_anomalies)
        add_check("workspace_anomalies_csv_exact", ok, "fail_to_pass", detail)

        ok, detail = check_audit(ws_out)
        add_check("workspace_audit_sha256_valid", ok, "fail_to_pass", detail)

        # Hidden unseen dataset execution
        with tempfile.TemporaryDirectory(prefix="t2_hidden_") as tmp:
            hidden_in = Path(tmp) / "in_data"
            hidden_out = Path(tmp) / "out_data"
            build_hidden_dataset(hidden_in)
            h_exp_summary, h_exp_anomalies = reference_etl(hidden_in)

            if pipeline_py.is_file():
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(pipeline_py),
                        "--input",
                        str(hidden_in),
                        "--output",
                        str(hidden_out),
                    ],
                    cwd=str(workspace),
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                run_ok = proc.returncode == 0
                run_detail = (
                    "exited 0"
                    if run_ok
                    else f"rc={proc.returncode}: {(proc.stderr or proc.stdout).strip()[-300:]}"
                )
            else:
                run_ok = False
                run_detail = "pipeline.py missing"
            add_check("hidden_dataset_execution", run_ok, "fail_to_pass", run_detail)

            ok, detail = check_summary(hidden_out, h_exp_summary) if run_ok else (False, "skipped: execution failed")
            add_check("hidden_summary_json_exact", ok, "fail_to_pass", detail)

            ok, detail = check_anomalies(hidden_out, h_exp_anomalies) if run_ok else (False, "skipped: execution failed")
            add_check("hidden_anomalies_csv_exact", ok, "fail_to_pass", detail)

            ok, detail = check_audit(hidden_out) if run_ok else (False, "skipped: execution failed")
            add_check("hidden_audit_sha256_valid", ok, "fail_to_pass", detail)

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
