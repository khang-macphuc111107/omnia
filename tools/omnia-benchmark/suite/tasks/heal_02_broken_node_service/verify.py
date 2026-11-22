#!/usr/bin/env python3
"""Verifier for heal_02_broken_node_service (Axis 7: Error Recovery & Self-Healing)."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

TASK_ID = "heal_02_broken_node_service"

EXPECTED_SAMPLE_IDS = ["evt-001", "evt-002", "evt-003", "evt-004", "evt-005", "evt-006"]
EXPECTED_ROUTES = {
    "order.created": {"channel": "orders", "priority": "high", "tag": "SALES"},
    "user.signup": {"channel": "users", "priority": "normal", "tag": "AUTH"},
    "file.indexed": {"channel": "storage", "priority": "low", "tag": "FS"},
}


def _find_node() -> str:
    node = shutil.which("node")
    if node:
        return node
    fallback = Path(r"C:\Program Files\nodejs\node.exe")
    if fallback.is_file():
        return str(fallback)
    raise FileNotFoundError("Could not locate node executable")


def _node_env(force_utf8_off: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    py_dir = str(Path(sys.executable).resolve().parent)
    env["PATH"] = py_dir + os.pathsep + env.get("PATH", "")
    env["PYTHON_BIN"] = sys.executable
    env["PYTHON"] = sys.executable
    if force_utf8_off:
        env["PYTHONUTF8"] = "0"
        env.pop("PYTHONIOENCODING", None)
    return env


def _run_node(
    workspace: Path,
    args: list[str],
    timeout: int = 30,
    force_utf8_off: bool = False,
) -> subprocess.CompletedProcess[str]:
    node_bin = _find_node()
    return subprocess.run(
        [node_bin, *args],
        cwd=str(workspace),
        env=_node_env(force_utf8_off=force_utf8_off),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _expected_transform(event: dict[str, Any]) -> dict[str, Any]:
    route = EXPECTED_ROUTES.get(
        event.get("type", ""),
        {"channel": "general", "priority": "normal", "tag": "GENERAL"},
    )
    msg = "" if event.get("message") is None else str(event.get("message"))
    src = "" if event.get("source_path") is None else str(event.get("source_path"))
    segs = [s for s in re.split(r"[\\/]+", src) if s] if src else []
    return {
        "id": str(event["id"]),
        "type": str(event["type"]),
        "channel": route["channel"],
        "priority": route["priority"],
        "tag": route["tag"],
        "message": msg,
        "message_length": len(msg),
        "source_path": src,
        "path_segments": segs,
        "formatted_label": f"[{route['tag']}] {event['id']}: {msg}",
        "amount": event.get("amount", None),
        "processed": True,
    }


def run_checks(workspace: Path) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add(name: str, group: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})

    # --- pass_to_pass checks ---
    sample_events: list[dict[str, Any]] = []
    try:
        sample_path = workspace / "data" / "sample_events.jsonl"
        if not sample_path.is_file():
            add("sample_data_intact", "pass_to_pass", False, "Missing data/sample_events.jsonl")
        else:
            lines = [ln.strip() for ln in sample_path.read_text(encoding="utf-8-sig").splitlines() if ln.strip()]
            sample_events = [json.loads(ln) for ln in lines]
            ids = [e.get("id") for e in sample_events]
            has_unicode = any("café" in str(e.get("message", "")) and "🚀" in str(e.get("message", "")) for e in sample_events)
            has_winpath = any("\\new\\" in str(e.get("source_path", "")) for e in sample_events)
            ok = ids == EXPECTED_SAMPLE_IDS and has_unicode and has_winpath
            add(
                "sample_data_intact",
                "pass_to_pass",
                ok,
                f"count={len(sample_events)}, ids_match={ids == EXPECTED_SAMPLE_IDS}, unicode={has_unicode}, winpath={has_winpath}",
            )
    except Exception as exc:
        add("sample_data_intact", "pass_to_pass", False, f"Exception: {exc}")

    try:
        pkg_path = workspace / "package.json"
        test_path = workspace / "test" / "bridge.test.mjs"
        readme_path = workspace / "README.md"
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        ok = pkg.get("type") == "module" and test_path.is_file() and readme_path.is_file()
        add(
            "package_is_esm_and_tests_present",
            "pass_to_pass",
            ok,
            f"type={pkg.get('type')!r}, test_exists={test_path.is_file()}, readme_exists={readme_path.is_file()}",
        )
    except Exception as exc:
        add("package_is_esm_and_tests_present", "pass_to_pass", False, f"Exception: {exc}")

    # --- fail_to_pass checks ---

    # 1. config/routes.json strict JSON validity
    try:
        routes_path = workspace / "config" / "routes.json"
        cfg = json.loads(routes_path.read_text(encoding="utf-8"))
        routes = cfg.get("routes", {})
        ok = (
            cfg.get("default_channel") == "general"
            and all(routes.get(k) == v for k, v in EXPECTED_ROUTES.items())
        )
        add("routes_json_valid", "fail_to_pass", ok, "config/routes.json valid strict JSON with expected routes")
    except Exception as exc:
        add("routes_json_valid", "fail_to_pass", False, f"Invalid JSON in config/routes.json: {exc}")

    # 2. Existing Node test suite passes
    try:
        res = _run_node(workspace, ["test/bridge.test.mjs"], timeout=30)
        ok = res.returncode == 0 and "PASS:" in res.stdout
        summary = (res.stdout + "\n" + res.stderr).strip().splitlines()
        tail = " | ".join(line.strip() for line in summary[-4:])
        add("node_unit_tests_pass", "fail_to_pass", ok, f"rc={res.returncode}; {tail}")
    except Exception as exc:
        add("node_unit_tests_pass", "fail_to_pass", False, f"Exception: {exc}")

    # 3. CLI end-to-end with sample_events.jsonl + stale lock reclamation + clean lock removal
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            stale_lock = tmp / "stale.bridge.lock"
            stale_lock.write_text(
                json.dumps({"pid": 9999999, "created_at": "2026-01-01T00:00:00Z"}) + "\n",
                encoding="utf-8",
            )
            out_file = tmp / "cli_out.jsonl"
            res = _run_node(
                workspace,
                [
                    "src/cli.mjs",
                    "--input",
                    "data/sample_events.jsonl",
                    "--output",
                    str(out_file),
                    "--lock",
                    str(stale_lock),
                ],
                timeout=30,
            )
            if res.returncode != 0:
                add("cli_sample_events_and_stale_lock", "fail_to_pass", False, f"CLI rc={res.returncode}: {res.stderr.strip()}")
            else:
                lock_removed = not stale_lock.exists()
                out_lines = [ln for ln in out_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
                records = [json.loads(ln) for ln in out_lines]
                by_id = {r["id"]: r for r in records}
                mismatches = []
                if len(records) != len(sample_events):
                    mismatches.append(f"expected {len(sample_events)} records, got {len(records)}")
                for ev in sample_events:
                    exp = _expected_transform(ev)
                    got = by_id.get(ev["id"])
                    if got != exp:
                        mismatches.append(f"id={ev['id']}: got={got} != exp={exp}")
                if not lock_removed:
                    mismatches.append("stale lock file was not removed after CLI exit")

                # Also verify default CLI invocation (no --lock flag) succeeds and leaves no .bridge.lock
                out_default = tmp / "cli_default.jsonl"
                res2 = _run_node(
                    workspace,
                    ["src/cli.mjs", "--input", "data/sample_events.jsonl", "--output", str(out_default)],
                    timeout=30,
                )
                if res2.returncode != 0:
                    mismatches.append(f"default CLI failed rc={res2.returncode}: {res2.stderr.strip()}")
                elif (workspace / ".bridge.lock").exists():
                    mismatches.append("default .bridge.lock was left behind after CLI exit")

                add(
                    "cli_sample_events_and_stale_lock",
                    "fail_to_pass",
                    len(mismatches) == 0,
                    "CLI reclaimed stale lock, removed lock on exit, and matched all 6 sample events"
                    if not mismatches
                    else "; ".join(mismatches[:3]),
                )
    except Exception as exc:
        add("cli_sample_events_and_stale_lock", "fail_to_pass", False, f"Exception: {exc}")

    # 4. Hidden integration test 1: Unicode + Windows backslash paths + >20KB multi-chunk payload with PYTHONUTF8=0
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            out_file = tmp / "unicode_out.jsonl"
            lock_file = tmp / "unicode.lock"
            script_file = tmp / "run_unicode.mjs"
            index_url = (workspace / "src" / "index.mjs").resolve().as_uri()
            script_file.write_text(
                f"""
import {{ EventBridge }} from {json.dumps(index_url)};

const longUnicode = 'café 東京 🚀 résumé — '.repeat(1200);
const events = [
  {{
    id: 'uni-1',
    type: 'order.created',
    message: 'café 東京 🚀 résumé',
    source_path: 'C:\\\\Users\\\\dev\\\\docs\\\\new\\\\test_file.txt',
    amount: 88.25
  }},
  {{
    id: 'uni-2',
    type: 'file.indexed',
    message: 'naïve façade — €100 日本語',
    source_path: 'D:\\\\archive\\\\2024\\\\tab_data\\\\new_index\\\\readme.md',
    amount: null
  }},
  {{
    id: 'uni-3',
    type: 'user.signup',
    message: longUnicode,
    source_path: 'C:\\\\temp\\\\normal/mixed\\\\next_dir\\\\file.bin',
    amount: 0
  }}
];

const bridge = new EventBridge({{
  lockPath: {json.dumps(str(lock_file))},
  outputPath: {json.dumps(str(out_file))},
  batchSize: 2
}});
await bridge.start();
try {{
  for (const ev of events) {{
    await bridge.enqueue(ev);
  }}
}} finally {{
  await bridge.stop();
}}
process.stdout.write(JSON.stringify({{ ok: true, count: events.length }}) + '\\n');
""",
                encoding="utf-8",
            )
            res = _run_node(workspace, [str(script_file)], timeout=30, force_utf8_off=True)
            if res.returncode != 0:
                add("hidden_unicode_and_windows_paths", "fail_to_pass", False, f"rc={res.returncode}: {res.stderr.strip()}")
            else:
                long_u = "café 東京 🚀 résumé — " * 1200
                expected_events = [
                    {
                        "id": "uni-1",
                        "type": "order.created",
                        "message": "café 東京 🚀 résumé",
                        "source_path": "C:\\Users\\dev\\docs\\new\\test_file.txt",
                        "amount": 88.25,
                    },
                    {
                        "id": "uni-2",
                        "type": "file.indexed",
                        "message": "naïve façade — €100 日本語",
                        "source_path": "D:\\archive\\2024\\tab_data\\new_index\\readme.md",
                        "amount": None,
                    },
                    {
                        "id": "uni-3",
                        "type": "user.signup",
                        "message": long_u,
                        "source_path": "C:\\temp\\normal/mixed\\next_dir\\file.bin",
                        "amount": 0,
                    },
                ]
                out_lines = [ln for ln in out_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
                records = [json.loads(ln) for ln in out_lines]
                errs = []
                if len(records) != len(expected_events):
                    errs.append(f"expected {len(expected_events)} lines, got {len(records)}")
                else:
                    for got, ev in zip(records, expected_events):
                        exp = _expected_transform(ev)
                        if got != exp:
                            errs.append(
                                f"id={ev['id']}: mismatch keys={[k for k in exp if got.get(k) != exp[k]]}"
                            )
                add(
                    "hidden_unicode_and_windows_paths",
                    "fail_to_pass",
                    len(errs) == 0,
                    "Unicode, nested Windows paths, and >20KB multi-chunk payload round-tripped cleanly under PYTHONUTF8=0"
                    if not errs
                    else "; ".join(errs),
                )
    except Exception as exc:
        add("hidden_unicode_and_windows_paths", "fail_to_pass", False, f"Exception: {exc}")

    # 5. Hidden integration test 2: Live PID lock protection + stale reclamation after process exit
    dummy_proc: subprocess.Popen[str] | None = None
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            lock_file = tmp / "live_test.lock"
            out_file = tmp / "live_test.jsonl"
            dummy_proc = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            lock_file.write_text(
                json.dumps({"pid": dummy_proc.pid, "created_at": "2026-11-22T00:00:00Z"}) + "\n",
                encoding="utf-8",
            )
            index_url = (workspace / "src" / "index.mjs").resolve().as_uri()
            probe_live = tmp / "probe_live.mjs"
            probe_live.write_text(
                f"""
import {{ EventBridge, BridgeLockError }} from {json.dumps(index_url)};

const bridge = new EventBridge({{
  lockPath: {json.dumps(str(lock_file))},
  outputPath: {json.dumps(str(out_file))}
}});
try {{
  await bridge.start();
  await bridge.stop();
  process.stdout.write(JSON.stringify({{ blocked: false }}) + '\\n');
}} catch (err) {{
  const isLockErr = err instanceof BridgeLockError || err?.name === 'BridgeLockError';
  process.stdout.write(JSON.stringify({{ blocked: isLockErr, name: err?.name, message: err?.message }}) + '\\n');
}}
""",
                encoding="utf-8",
            )
            res_live = _run_node(workspace, [str(probe_live)], timeout=20)
            if res_live.returncode != 0:
                add("hidden_live_lock_protection", "fail_to_pass", False, f"live probe rc={res_live.returncode}: {res_live.stderr.strip()}")
            else:
                live_info = json.loads(res_live.stdout.strip().splitlines()[-1])
                # Kill dummy process and wait for exit
                dummy_proc.terminate()
                dummy_proc.wait(timeout=10)
                dummy_proc = None

                # Now EventBridge MUST reclaim the dead PID's lock and succeed
                probe_dead = tmp / "probe_dead.mjs"
                probe_dead.write_text(
                    f"""
import fs from 'node:fs';
import {{ EventBridge }} from {json.dumps(index_url)};

const bridge = new EventBridge({{
  lockPath: {json.dumps(str(lock_file))},
  outputPath: {json.dumps(str(out_file))}
}});
await bridge.start();
const rec = await bridge.enqueue({{
  id: 'lock-ok',
  type: 'order.created',
  message: 'reclaimed',
  source_path: 'C:\\\\ok\\\\file.txt',
  amount: 1
}});
await bridge.stop();
process.stdout.write(JSON.stringify({{
  reclaimed: true,
  processed: rec.processed,
  lockRemoved: !fs.existsSync({json.dumps(str(lock_file))})
}}) + '\\n');
""",
                    encoding="utf-8",
                )
                res_dead = _run_node(workspace, [str(probe_dead)], timeout=20)
                if res_dead.returncode != 0:
                    add("hidden_live_lock_protection", "fail_to_pass", False, f"reclaim probe rc={res_dead.returncode}: {res_dead.stderr.strip()}")
                else:
                    dead_info = json.loads(res_dead.stdout.strip().splitlines()[-1])
                    ok = (
                        live_info.get("blocked") is True
                        and dead_info.get("reclaimed") is True
                        and dead_info.get("processed") is True
                        and dead_info.get("lockRemoved") is True
                    )
                    add(
                        "hidden_live_lock_protection",
                        "fail_to_pass",
                        ok,
                        f"live_blocked={live_info.get('blocked')}, reclaimed={dead_info.get('reclaimed')}, lock_removed={dead_info.get('lockRemoved')}",
                    )
    except Exception as exc:
        add("hidden_live_lock_protection", "fail_to_pass", False, f"Exception: {exc}")
    finally:
        if dummy_proc is not None:
            try:
                dummy_proc.kill()
                dummy_proc.wait(timeout=5)
            except Exception:
                pass

    # 6. Hidden integration test 3: 120 concurrent events + overlapping flushes stress test
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            lock_file = tmp / "stress120.lock"
            out_file = tmp / "stress120.jsonl"
            script_file = tmp / "run_stress.mjs"
            index_url = (workspace / "src" / "index.mjs").resolve().as_uri()
            script_file.write_text(
                f"""
import {{ EventBridge }} from {json.dumps(index_url)};

const bridge = new EventBridge({{
  lockPath: {json.dumps(str(lock_file))},
  outputPath: {json.dumps(str(out_file))},
  batchSize: 7
}});
await bridge.start();
try {{
  const promises = [];
  for (let i = 0; i < 120; i += 1) {{
    promises.push(
      bridge.enqueue({{
        id: `stress-${{String(i).padStart(3, '0')}}`,
        type: i % 3 === 0 ? 'order.created' : (i % 3 === 1 ? 'user.signup' : 'file.indexed'),
        message: `Payload #${{i}} café 🚀`,
        source_path: `C:\\\\stress\\\\new\\\\tab_${{i}}\\\\item.json`,
        amount: i * 1.5
      }})
    );
    if (i % 5 === 0) {{
      promises.push(bridge.flush());
    }}
  }}
  await Promise.all(promises);
  await bridge.flush();
}} finally {{
  await bridge.stop();
}}
process.stdout.write(JSON.stringify({{ done: true }}) + '\\n');
""",
                encoding="utf-8",
            )
            res = _run_node(workspace, [str(script_file)], timeout=45)
            if res.returncode != 0:
                add("hidden_concurrent_batch_stress", "fail_to_pass", False, f"rc={res.returncode}: {res.stderr.strip()}")
            else:
                raw_lines = [ln for ln in out_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
                parse_errors = 0
                ids: list[str] = []
                bad_paths = 0
                for ln in raw_lines:
                    try:
                        obj = json.loads(ln)
                        ids.append(obj.get("id"))
                        if not isinstance(obj.get("path_segments"), list) or len(obj["path_segments"]) != 5:
                            bad_paths += 1
                    except Exception:
                        parse_errors += 1
                expected_ids = {f"stress-{i:03d}" for i in range(120)}
                unique_ids = set(ids)
                lock_removed = not lock_file.exists()
                ok = (
                    parse_errors == 0
                    and len(raw_lines) == 120
                    and len(ids) == 120
                    and unique_ids == expected_ids
                    and bad_paths == 0
                    and lock_removed
                )
                add(
                    "hidden_concurrent_batch_stress",
                    "fail_to_pass",
                    ok,
                    f"lines={len(raw_lines)}/120, unique_ids={len(unique_ids)}/120, parse_errors={parse_errors}, bad_paths={bad_paths}, lock_removed={lock_removed}",
                )
    except Exception as exc:
        add("hidden_concurrent_batch_stress", "fail_to_pass", False, f"Exception: {exc}")

    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to task workspace directory")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    error: str | None = None
    checks: list[dict[str, Any]] = []

    try:
        if not workspace.is_dir():
            raise FileNotFoundError(f"Workspace directory not found: {workspace}")
        checks = run_checks(workspace)
    except Exception as exc:
        error = str(exc)

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    passed_total = sum(1 for c in checks if c["passed"])
    all_passed = error is None and total > 0 and passed_total == total
    score = round(passed_total / total, 4) if total > 0 and error is None else 0.0

    result = {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": 1.0 if all_passed else score,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": error,
    }
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
