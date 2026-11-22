#!/usr/bin/env python3
"""Deterministic cross-runtime verifier for refact_02_polyglot_config_v2."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

TASK_ID = "refact_02_polyglot_config_v2"
UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
OCCURRED_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
EXPECTED_V2_KEYS = {
    "schema_version",
    "event_id",
    "event_type",
    "occurred_at",
    "tags",
    "payload",
    "checksum",
}


def _find_node() -> str:
    found = shutil.which("node")
    if found:
        return found
    win_default = Path(r"C:\Program Files\nodejs\node.exe")
    if win_default.is_file():
        return str(win_default)
    raise FileNotFoundError("Node.js executable not found in PATH or C:\\Program Files\\nodejs\\node.exe")


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _compute_checksum(env_without_checksum: dict[str, Any]) -> str:
    clean = {k: v for k, v in env_without_checksum.items() if k != "checksum"}
    return _sha256_hex(_canonical_json(clean))


def _ts_to_occurred_at(ts: int | float) -> str:
    ms = round(ts * 1000)
    dt = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _expected_upgrade_v1(v1: dict[str, Any]) -> dict[str, Any]:
    event_type = v1["type"]
    occurred_at = _ts_to_occurred_at(v1["timestamp_sec"])
    raw_tags = v1.get("tags_csv", "")
    tags = sorted({tok.strip() for tok in raw_tags.split(",") if tok.strip()})
    payload = v1["payload"]
    existing_id = v1.get("event_id")
    if isinstance(existing_id, str) and existing_id.strip():
        event_id = existing_id
    else:
        seed = {
            "event_type": event_type,
            "occurred_at": occurred_at,
            "payload": payload,
            "tags": tags,
        }
        event_id = "v1-" + _sha256_hex(_canonical_json(seed))[:16]
    unsigned = {
        "schema_version": 2,
        "event_id": event_id,
        "event_type": event_type,
        "occurred_at": occurred_at,
        "tags": tags,
        "payload": payload,
    }
    unsigned["checksum"] = _compute_checksum(unsigned)
    return unsigned


def _run_py_cli(workspace: Path, cli_args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(workspace)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-m", "py_service.cli", *cli_args],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )


def _run_js_cli(workspace: Path, node_exe: str, cli_args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    return subprocess.run(
        [node_exe, str(workspace / "js_client" / "src" / "cli.mjs"), *cli_args],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )


def _assert_valid_v2_dict(obj: dict[str, Any], *, require_uuid4: bool = False) -> str | None:
    if set(obj.keys()) != EXPECTED_V2_KEYS:
        return f"Expected keys {sorted(EXPECTED_V2_KEYS)}, got {sorted(obj.keys())}"
    if type(obj["schema_version"]) is not int or obj["schema_version"] != 2:
        return f"schema_version must be int 2, got {obj['schema_version']!r}"
    if not isinstance(obj["event_id"], str) or not obj["event_id"].strip():
        return f"Invalid event_id: {obj['event_id']!r}"
    if require_uuid4 and not UUID_V4_RE.match(obj["event_id"]):
        return f"event_id is not lowercase UUIDv4: {obj['event_id']!r}"
    if not isinstance(obj["event_type"], str) or not obj["event_type"].strip():
        return f"Invalid event_type: {obj['event_type']!r}"
    if not isinstance(obj["occurred_at"], str) or not OCCURRED_AT_RE.match(obj["occurred_at"]):
        return f"Invalid occurred_at format: {obj['occurred_at']!r}"
    if not isinstance(obj["tags"], list) or obj["tags"] != sorted(set(obj["tags"])):
        return f"Invalid tags: {obj['tags']!r}"
    if not isinstance(obj["payload"], dict):
        return f"Invalid payload type: {type(obj['payload']).__name__}"
    expected_ck = _compute_checksum(obj)
    if obj["checksum"] != expected_ck:
        return f"Checksum mismatch: got {obj['checksum']}, expected {expected_ck}"
    return None


# ---------------- pass_to_pass checks ----------------


def check_py_unit_tests(workspace: Path, _node: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(workspace)
    env["PYTHONUTF8"] = "1"
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", "py_service/test_events.py", "-v"],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    if proc.returncode == 0:
        return True, "py_service/test_events.py passed"
    return False, f"Python unittest failed (rc={proc.returncode}): {(proc.stderr or proc.stdout).strip()[-400:]}"


def check_js_unit_tests(workspace: Path, node_exe: str) -> tuple[bool, str]:
    proc = subprocess.run(
        [node_exe, str(workspace / "js_client" / "test" / "events.test.mjs")],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    if proc.returncode == 0:
        return True, "js_client/test/events.test.mjs passed"
    return False, f"Node test failed (rc={proc.returncode}): {(proc.stderr or proc.stdout).strip()[-400:]}"


def check_py_ingest_v1_fixture_basic(workspace: Path, _node: str) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "py_out.jsonl"
        proc = _run_py_cli(
            workspace,
            ["ingest", "--input", str(workspace / "fixtures" / "v1_events.jsonl"), "--output", str(out_path)],
        )
        if proc.returncode != 0:
            return False, f"py ingest failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
        lines = [l for l in out_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) != 4:
            return False, f"Expected 4 lines, got {len(lines)}"
        objs = [json.loads(l) for l in lines]
        if objs[0]["payload"]["user"] != "alice" or objs[1]["payload"]["city"] != "café 東京":
            return False, "Payload data altered during py ingest"
        return True, "Python ingest processes v1_events.jsonl preserving all 4 payloads"


def check_js_ingest_v1_fixture_basic(workspace: Path, node_exe: str) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "js_out.jsonl"
        proc = _run_js_cli(
            workspace,
            node_exe,
            ["ingest", "--input", str(workspace / "fixtures" / "v1_events.jsonl"), "--output", str(out_path)],
        )
        if proc.returncode != 0:
            return False, f"js ingest failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
        lines = [l for l in out_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) != 4:
            return False, f"Expected 4 lines, got {len(lines)}"
        objs = [json.loads(l) for l in lines]
        if objs[0]["payload"]["user"] != "alice" or objs[1]["payload"]["city"] != "café 東京":
            return False, "Payload data altered during js ingest"
        return True, "Node.js ingest processes v1_events.jsonl preserving all 4 payloads"


def check_py_emit_cli_basic(workspace: Path, _node: str) -> tuple[bool, str]:
    proc = _run_py_cli(
        workspace,
        ["emit", "--type", "order.created", "--tags", "web,priority", "--payload-json", '{"amount":42}', "--timestamp-sec", "1710506096"],
    )
    if proc.returncode != 0:
        return False, f"py emit failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
    obj = json.loads(proc.stdout.strip())
    if obj.get("payload") != {"amount": 42}:
        return False, f"Unexpected payload: {obj}"
    return True, "Python emit CLI outputs valid JSON"


def check_js_emit_cli_basic(workspace: Path, node_exe: str) -> tuple[bool, str]:
    proc = _run_js_cli(
        workspace,
        node_exe,
        ["emit", "--type", "order.created", "--tags", "web,priority", "--payload-json", '{"amount":42}', "--timestamp-sec", "1710506096"],
    )
    if proc.returncode != 0:
        return False, f"js emit failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
    obj = json.loads(proc.stdout.strip())
    if obj.get("payload") != {"amount": 42}:
        return False, f"Unexpected payload: {obj}"
    return True, "Node.js emit CLI outputs valid JSON"


# ---------------- fail_to_pass checks ----------------


def check_py_emit_v2_and_cross_verify(workspace: Path, node_exe: str) -> tuple[bool, str]:
    proc = _run_py_cli(
        workspace,
        [
            "emit",
            "--type",
            "billing.charge",
            "--tags",
            " zeta , alpha, zeta , ",
            "--payload-json",
            '{"z":1,"a":"café 東京"}',
            "--timestamp-sec",
            "1710506096.25",
        ],
    )
    if proc.returncode != 0:
        return False, f"py emit failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
    line = proc.stdout.strip()
    try:
        obj = json.loads(line)
    except Exception as exc:
        return False, f"Invalid JSON from py emit: {exc}"
    err = _assert_valid_v2_dict(obj, require_uuid4=True)
    if err:
        return False, err
    if obj["event_type"] != "billing.charge":
        return False, f"Bad event_type: {obj['event_type']}"
    if obj["occurred_at"] != "2024-03-15T12:34:56.250Z":
        return False, f"Bad occurred_at: {obj['occurred_at']}"
    if obj["tags"] != ["alpha", "zeta"]:
        return False, f"Bad tags: {obj['tags']}"
    if line != _canonical_json(obj):
        return False, f"py emit output is not canonical compact UTF-8 JSON: {line}"

    with tempfile.TemporaryDirectory() as tmp:
        ev_file = Path(tmp) / "py_emit.jsonl"
        ev_file.write_text(line + "\n", encoding="utf-8", newline="\n")
        v_py = _run_py_cli(workspace, ["verify", "--input", str(ev_file)])
        if v_py.returncode != 0:
            return False, f"py verify rejected py emit output: {v_py.stderr.strip()}"
        v_js = _run_js_cli(workspace, node_exe, ["verify", "--input", str(ev_file)])
        if v_js.returncode != 0:
            return False, f"js verify rejected py emit output: {v_js.stderr.strip()}"
    return True, "Python emit produces valid canonical v2 envelope verified by both Python and Node.js"


def check_js_emit_v2_and_cross_verify(workspace: Path, node_exe: str) -> tuple[bool, str]:
    proc = _run_js_cli(
        workspace,
        node_exe,
        [
            "emit",
            "--type",
            "billing.charge",
            "--tags",
            " zeta , alpha, zeta , ",
            "--payload-json",
            '{"z":1,"a":"café 東京"}',
            "--timestamp-sec",
            "1710506096.25",
        ],
    )
    if proc.returncode != 0:
        return False, f"js emit failed: {(proc.stderr or proc.stdout).strip()[-300:]}"
    line = proc.stdout.strip()
    try:
        obj = json.loads(line)
    except Exception as exc:
        return False, f"Invalid JSON from js emit: {exc}"
    err = _assert_valid_v2_dict(obj, require_uuid4=True)
    if err:
        return False, err
    if obj["event_type"] != "billing.charge":
        return False, f"Bad event_type: {obj['event_type']}"
    if obj["occurred_at"] != "2024-03-15T12:34:56.250Z":
        return False, f"Bad occurred_at: {obj['occurred_at']}"
    if obj["tags"] != ["alpha", "zeta"]:
        return False, f"Bad tags: {obj['tags']}"
    if line != _canonical_json(obj):
        return False, f"js emit output is not canonical compact UTF-8 JSON: {line}"

    with tempfile.TemporaryDirectory() as tmp:
        ev_file = Path(tmp) / "js_emit.jsonl"
        ev_file.write_text(line + "\n", encoding="utf-8", newline="\n")
        v_js = _run_js_cli(workspace, node_exe, ["verify", "--input", str(ev_file)])
        if v_js.returncode != 0:
            return False, f"js verify rejected js emit output: {v_js.stderr.strip()}"
        v_py = _run_py_cli(workspace, ["verify", "--input", str(ev_file)])
        if v_py.returncode != 0:
            return False, f"py verify rejected js emit output: {v_py.stderr.strip()}"
    return True, "Node.js emit produces valid canonical v2 envelope verified by both Node.js and Python"


def check_cross_runtime_unicode_nested_checksum_parity(workspace: Path, node_exe: str) -> tuple[bool, str]:
    payload_str = '{"z":1,"note":"café 東京 résumé","a":{"d":[true,null,{"y":2,"x":1}],"b":19.99,"c":{"k2":"β","k1":"α"}}}'
    cli_args = [
        "emit",
        "--type",
        "sync.nested",
        "--tags",
        "東京,café,alpha,café",
        "--payload-json",
        payload_str,
        "--timestamp-sec",
        "1742042096.5",
        "--event-id",
        "fixed-parity-001",
    ]
    p_py = _run_py_cli(workspace, cli_args)
    p_js = _run_js_cli(workspace, node_exe, cli_args)
    if p_py.returncode != 0:
        return False, f"py emit failed: {p_py.stderr.strip()}"
    if p_js.returncode != 0:
        return False, f"js emit failed: {p_js.stderr.strip()}"

    py_line = p_py.stdout.strip()
    js_line = p_js.stdout.strip()
    py_obj = json.loads(py_line)
    js_obj = json.loads(js_line)

    err_py = _assert_valid_v2_dict(py_obj)
    if err_py:
        return False, f"Python output invalid: {err_py}"
    err_js = _assert_valid_v2_dict(js_obj)
    if err_js:
        return False, f"Node.js output invalid: {err_js}"
    if py_obj["event_id"] != "fixed-parity-001" or js_obj["event_id"] != "fixed-parity-001":
        return False, f"--event-id not honored: py={py_obj['event_id']}, js={js_obj['event_id']}"
    if py_line != js_line:
        return False, f"Cross-runtime canonical output mismatch:\nPY: {py_line}\nJS: {js_line}"
    if py_obj["checksum"] != js_obj["checksum"]:
        return False, f"Checksum mismatch: py={py_obj['checksum']} vs js={js_obj['checksum']}"
    return True, f"Python and Node.js produced bit-for-bit identical canonical Unicode+nested v2 JSON (checksum={py_obj['checksum'][:16]}...)"


def check_dual_read_v1_fixture_bit_identical(workspace: Path, node_exe: str) -> tuple[bool, str]:
    fixture = workspace / "fixtures" / "v1_events.jsonl"
    raw_v1 = [json.loads(l) for l in fixture.read_text(encoding="utf-8").splitlines() if l.strip()]
    expected_lines = [_canonical_json(_expected_upgrade_v1(ev)) for ev in raw_v1]

    with tempfile.TemporaryDirectory() as tmp:
        py_out = Path(tmp) / "py_v2.jsonl"
        js_out = Path(tmp) / "js_v2.jsonl"

        r_py = _run_py_cli(workspace, ["ingest", "--input", str(fixture), "--output", str(py_out)])
        r_js = _run_js_cli(workspace, node_exe, ["ingest", "--input", str(fixture), "--output", str(js_out)])
        if r_py.returncode != 0:
            return False, f"py ingest failed: {r_py.stderr.strip()}"
        if r_js.returncode != 0:
            return False, f"js ingest failed: {r_js.stderr.strip()}"

        py_bytes = py_out.read_bytes()
        js_bytes = js_out.read_bytes()
        if py_bytes != js_bytes:
            return False, (
                "Python and Node.js upgraded v1_events.jsonl are NOT bit-for-bit identical!\n"
                f"PY: {py_bytes.decode('utf-8', errors='replace')[:300]}\n"
                f"JS: {js_bytes.decode('utf-8', errors='replace')[:300]}"
            )

        actual_lines = [l for l in py_bytes.decode("utf-8").splitlines() if l.strip()]
        if actual_lines != expected_lines:
            for idx, (act, exp) in enumerate(zip(actual_lines, expected_lines)):
                if act != exp:
                    return False, f"Fixture line {idx + 1} mismatch:\nGOT: {act}\nEXP: {exp}"
            return False, f"Line count mismatch: got {len(actual_lines)}, expected {len(expected_lines)}"

        v_py = _run_py_cli(workspace, ["verify", "--input", str(py_out)])
        v_js = _run_js_cli(workspace, node_exe, ["verify", "--input", str(py_out)])
        if v_py.returncode != 0 or v_js.returncode != 0:
            return False, f"verify failed on upgraded fixture: py={v_py.stderr.strip()} js={v_js.stderr.strip()}"
    return True, "Python and Node.js produce bit-for-bit identical upgraded v2 JSONL for fixtures/v1_events.jsonl"


def check_dual_read_mixed_v1_v2_stream(workspace: Path, node_exe: str) -> tuple[bool, str]:
    v1_a = {
        "type": "sensor.reading",
        "timestamp_sec": 1735689600.007,
        "tags_csv": " edge , iot, edge,  α ",
        "payload": {"temp": 21.5, "loc": {"zone": "東京", "floor": 3}},
    }
    v1_b = {
        "schema_version": 1,
        "event_id": "legacy-keep-77",
        "type": "job.done",
        "timestamp_sec": 1735690000,
        "tags_csv": "batch",
        "payload": {"ok": True},
    }
    v2_existing_unsigned = {
        "schema_version": 2,
        "event_id": "550e8400-e29b-41d4-a716-446655440000",
        "event_type": "user.updated",
        "occurred_at": "2026-01-02T03:04:05.678Z",
        "tags": ["crm", "sync"],
        "payload": {"name": "José", "roles": ["admin", "ops"]},
    }
    v2_existing = dict(v2_existing_unsigned)
    v2_existing["checksum"] = _compute_checksum(v2_existing_unsigned)

    expected_lines = [
        _canonical_json(_expected_upgrade_v1(v1_a)),
        _canonical_json(_expected_upgrade_v1(v1_b)),
        _canonical_json(v2_existing),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        mixed_in = Path(tmp) / "mixed.jsonl"
        py_out = Path(tmp) / "py_mixed.jsonl"
        js_out = Path(tmp) / "js_mixed.jsonl"
        mixed_in.write_text(
            "\n".join([json.dumps(v1_a, ensure_ascii=False), json.dumps(v1_b, ensure_ascii=False), _canonical_json(v2_existing)]) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        r_py = _run_py_cli(workspace, ["ingest", "--input", str(mixed_in), "--output", str(py_out)])
        r_js = _run_js_cli(workspace, node_exe, ["ingest", "--input", str(mixed_in), "--output", str(js_out)])
        if r_py.returncode != 0:
            return False, f"py ingest failed on mixed stream: {r_py.stderr.strip()}"
        if r_js.returncode != 0:
            return False, f"js ingest failed on mixed stream: {r_js.stderr.strip()}"

        py_bytes = py_out.read_bytes()
        js_bytes = js_out.read_bytes()
        if py_bytes != js_bytes:
            return False, "Python and Node.js outputs differ on mixed v1+v2 stream"

        actual_lines = [l for l in py_bytes.decode("utf-8").splitlines() if l.strip()]
        if actual_lines != expected_lines:
            return False, f"Mixed stream upgraded lines differ from spec:\nGOT: {actual_lines}\nEXP: {expected_lines}"

        if _run_py_cli(workspace, ["verify", "--input", str(py_out)]).returncode != 0:
            return False, "py verify rejected mixed ingest output"
        if _run_js_cli(workspace, node_exe, ["verify", "--input", str(js_out)]).returncode != 0:
            return False, "js verify rejected mixed ingest output"
    return True, "Mixed v1+v2 stream ingested bit-for-bit identically by both Python and Node.js"


def check_reject_tampered_checksum_both_runtimes(workspace: Path, node_exe: str) -> tuple[bool, str]:
    valid_unsigned = {
        "schema_version": 2,
        "event_id": "550e8400-e29b-41d4-a716-446655440001",
        "event_type": "payment.settled",
        "occurred_at": "2026-03-15T12:34:56.000Z",
        "tags": ["finance"],
        "payload": {"amount": 100},
    }
    valid_signed = dict(valid_unsigned)
    valid_signed["checksum"] = _compute_checksum(valid_unsigned)
    tampered = dict(valid_signed)
    tampered["payload"] = {"amount": 999999}  # tampered after signing!

    with tempfile.TemporaryDirectory() as tmp:
        good_file = Path(tmp) / "valid.jsonl"
        bad_file = Path(tmp) / "tampered.jsonl"
        dummy_out = Path(tmp) / "out.jsonl"
        good_file.write_text(_canonical_json(valid_signed) + "\n", encoding="utf-8", newline="\n")
        bad_file.write_text(_canonical_json(tampered) + "\n", encoding="utf-8", newline="\n")

        # Positive control: valid v2 envelope must first be accepted by both runtimes
        if _run_py_cli(workspace, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: py verify rejected valid v2 envelope"
        if _run_js_cli(workspace, node_exe, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: js verify rejected valid v2 envelope"

        checks = [
            ("py verify", _run_py_cli(workspace, ["verify", "--input", str(bad_file)])),
            ("py ingest", _run_py_cli(workspace, ["ingest", "--input", str(bad_file), "--output", str(dummy_out)])),
            ("js verify", _run_js_cli(workspace, node_exe, ["verify", "--input", str(bad_file)])),
            ("js ingest", _run_js_cli(workspace, node_exe, ["ingest", "--input", str(bad_file), "--output", str(dummy_out)])),
        ]
        failures = [label for label, proc in checks if proc.returncode == 0]
        if failures:
            return False, f"Tampered checksum was NOT rejected by: {', '.join(failures)}"
    return True, "Valid v2 accepted and tampered checksum rejected by both Python and Node.js (verify & ingest)"


def check_reject_invalid_schema_version_and_raw_v1_on_verify(workspace: Path, node_exe: str) -> tuple[bool, str]:
    valid_base = {
        "schema_version": 2,
        "event_id": "550e8400-e29b-41d4-a716-446655440002",
        "event_type": "x.test",
        "occurred_at": "2026-03-15T12:34:56.000Z",
        "tags": ["a"],
        "payload": {"k": 1},
    }
    valid_base["checksum"] = _compute_checksum(valid_base)

    bad_cases = []
    for bad_ver in (3, "2", True):
        env_obj = {
            "schema_version": bad_ver,
            "event_id": "550e8400-e29b-41d4-a716-446655440002",
            "event_type": "x.test",
            "occurred_at": "2026-03-15T12:34:56.000Z",
            "tags": ["a"],
            "payload": {"k": 1},
        }
        env_obj["checksum"] = _compute_checksum(env_obj)
        bad_cases.append((f"schema_version={bad_ver!r}", _canonical_json(env_obj)))

    with tempfile.TemporaryDirectory() as tmp:
        good_file = Path(tmp) / "valid_v2.jsonl"
        good_file.write_text(_canonical_json(valid_base) + "\n", encoding="utf-8", newline="\n")
        if _run_py_cli(workspace, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: py verify rejected valid v2 envelope"
        if _run_js_cli(workspace, node_exe, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: js verify rejected valid v2 envelope"

        dummy_out = Path(tmp) / "out.jsonl"
        for label, line in bad_cases:
            f = Path(tmp) / "bad_ver.jsonl"
            f.write_text(line + "\n", encoding="utf-8", newline="\n")
            for tag, proc in [
                ("py verify", _run_py_cli(workspace, ["verify", "--input", str(f)])),
                ("py ingest", _run_py_cli(workspace, ["ingest", "--input", str(f), "--output", str(dummy_out)])),
                ("js verify", _run_js_cli(workspace, node_exe, ["verify", "--input", str(f)])),
                ("js ingest", _run_js_cli(workspace, node_exe, ["ingest", "--input", str(f), "--output", str(dummy_out)])),
            ]:
                if proc.returncode == 0:
                    return False, f"{tag} accepted invalid {label}"

        # Raw v1 fixture must be rejected by strict v2 `verify`
        fixture = workspace / "fixtures" / "v1_events.jsonl"
        if _run_py_cli(workspace, ["verify", "--input", str(fixture)]).returncode == 0:
            return False, "py verify accepted raw v1 fixture instead of requiring v2"
        if _run_js_cli(workspace, node_exe, ["verify", "--input", str(fixture)]).returncode == 0:
            return False, "js verify accepted raw v1 fixture instead of requiring v2"

    return True, "Invalid schema_version (3, '2', true) and raw v1 on verify rejected by both runtimes"


def check_reject_malformed_occurred_at_and_bad_types(workspace: Path, node_exe: str) -> tuple[bool, str]:
    base = {
        "schema_version": 2,
        "event_id": "550e8400-e29b-41d4-a716-446655440003",
        "event_type": "x.test",
        "occurred_at": "2026-03-15T12:34:56.000Z",
        "tags": ["a", "b"],
        "payload": {"ok": True},
    }
    valid_base = dict(base)
    valid_base["checksum"] = _compute_checksum(base)

    mutations: list[tuple[str, dict[str, Any]]] = [
        ("non-UTC offset occurred_at", {**base, "occurred_at": "2026-03-15T12:34:56.000+02:00"}),
        ("invalid calendar date occurred_at", {**base, "occurred_at": "2026-02-30T12:00:00.000Z"}),
        ("missing millis occurred_at", {**base, "occurred_at": "2026-03-15T12:34:56Z"}),
        ("array payload", {**base, "payload": [1, 2, 3]}),
        ("string tags", {**base, "tags": "a,b"}),
        ("unsorted tags", {**base, "tags": ["z", "a"]}),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        good_file = Path(tmp) / "good.jsonl"
        good_file.write_text(_canonical_json(valid_base) + "\n", encoding="utf-8", newline="\n")
        if _run_py_cli(workspace, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: py verify rejected valid v2 envelope"
        if _run_js_cli(workspace, node_exe, ["verify", "--input", str(good_file)]).returncode != 0:
            return False, "Positive control failed: js verify rejected valid v2 envelope"

        for label, mutated in mutations:
            signed = dict(mutated)
            signed["checksum"] = _compute_checksum(mutated)
            f = Path(tmp) / "bad.jsonl"
            f.write_text(_canonical_json(signed) + "\n", encoding="utf-8", newline="\n")
            if _run_py_cli(workspace, ["verify", "--input", str(f)]).returncode == 0:
                return False, f"py verify accepted malformed v2 case: {label}"
            if _run_js_cli(workspace, node_exe, ["verify", "--input", str(f)]).returncode == 0:
                return False, f"js verify accepted malformed v2 case: {label}"
    return True, "Valid v2 accepted and malformed occurred_at, non-object payload, and invalid/unsorted tags rejected by both runtimes"


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verifier for {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to workspace directory")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    checks_spec: list[tuple[str, str, Any]] = [
        ("py_unit_tests", "pass_to_pass", check_py_unit_tests),
        ("js_unit_tests", "pass_to_pass", check_js_unit_tests),
        ("py_ingest_v1_fixture_basic", "pass_to_pass", check_py_ingest_v1_fixture_basic),
        ("js_ingest_v1_fixture_basic", "pass_to_pass", check_js_ingest_v1_fixture_basic),
        ("py_emit_cli_basic", "pass_to_pass", check_py_emit_cli_basic),
        ("js_emit_cli_basic", "pass_to_pass", check_js_emit_cli_basic),
        ("py_emit_v2_and_cross_verify", "fail_to_pass", check_py_emit_v2_and_cross_verify),
        ("js_emit_v2_and_cross_verify", "fail_to_pass", check_js_emit_v2_and_cross_verify),
        ("cross_runtime_unicode_nested_checksum_parity", "fail_to_pass", check_cross_runtime_unicode_nested_checksum_parity),
        ("dual_read_v1_fixture_bit_identical", "fail_to_pass", check_dual_read_v1_fixture_bit_identical),
        ("dual_read_mixed_v1_v2_stream", "fail_to_pass", check_dual_read_mixed_v1_v2_stream),
        ("reject_tampered_checksum_both_runtimes", "fail_to_pass", check_reject_tampered_checksum_both_runtimes),
        ("reject_invalid_schema_version_and_raw_v1_on_verify", "fail_to_pass", check_reject_invalid_schema_version_and_raw_v1_on_verify),
        ("reject_malformed_occurred_at_and_bad_types", "fail_to_pass", check_reject_malformed_occurred_at_and_bad_types),
    ]

    results: list[dict[str, Any]] = []
    top_error: str | None = None

    try:
        if not workspace.is_dir():
            raise FileNotFoundError(f"Workspace directory does not exist: {workspace}")
        node_exe = _find_node()

        for name, group, fn in checks_spec:
            try:
                ok, detail = fn(workspace, node_exe)
            except Exception as exc:
                ok, detail = False, f"Verifier exception: {type(exc).__name__}: {exc}"
            results.append(
                {
                    "name": name,
                    "passed": bool(ok),
                    "group": group,
                    "detail": detail,
                }
            )
    except Exception as exc:
        top_error = f"{type(exc).__name__}: {exc}"

    f2p = [c for c in results if c["group"] == "fail_to_pass"]
    p2p = [c for c in results if c["group"] == "pass_to_pass"]
    total = len(results)
    passed_count = sum(1 for c in results if c["passed"])
    all_passed = top_error is None and total > 0 and passed_count == total
    score = 1.0 if all_passed else (round(passed_count / total, 4) if total > 0 else 0.0)

    payload = {
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
        "checks": results,
        "error": top_error,
    }
    print(json.dumps(payload, indent=2))
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
