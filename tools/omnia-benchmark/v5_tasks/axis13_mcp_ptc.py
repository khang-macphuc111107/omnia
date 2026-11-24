"""Suite v5 Axis 13 (MCP + PTC Code Mode Multi-Tool Composition) task builders.

Creates 3 deterministic zero-network tasks under D:\\Omnia\\tools\\omnia-benchmark\\suite\\tasks\\:
  1. ptc_01_local_mcp_fanout     — Local stdio MCP server (18 tools, paginated shards + HMAC tokens)
  2. ptc_02_code_mode_batch      — 64-service polyglot graph & api_v1->api_v2 batch codemod
  3. ptc_03_mcp_schema_elicit    — Stateful stdio MCP server w/ dynamic tools/list_changed & strict schema
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path


def _w(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _task_meta(tid: str, title: str, langs: list[str], setup_script: str | None = None) -> str:
    return json.dumps({
        "id": tid,
        "axis": 13,
        "axis_name": "MCP & PTC Code Mode Multi-Tool Composition",
        "title": title,
        "difficulty": "hard",
        "languages": langs,
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "mcp_ptc_composition",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": setup_script,
        "verify_script": "verify.py",
    }, indent=2) + "\n"


def build_ptc_01(tasks_dir: Path) -> dict:
    tid = "ptc_01_local_mcp_fanout"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Local stdio MCP 18-tool paginated shard aggregation & HMAC alert verification",
        ["python", "json"],
        setup_script="setup.py",
    ))
    _w(tdir / "prompt.md", """# Task: Aggregate Multi-Region Shard Telemetry via Local Stdio MCP Server

This workspace includes a zero-network local JSON-RPC 2.0 **stdio MCP server** (`mcp_inventory_server.py`, also declared in `.mcp.json`).
It exposes 18 tools including `list_regions`, `list_shards_page(region, cursor)`, `get_shard_metrics(shard_id)`, `get_service_owner(service)`, `verify_alert_hmac(shard_id, token)`, and 13 noise/auxiliary diagnostic tools.

Using either your MCP client OR a programmatic script (`run_code` / Python JSON-RPC stdio client driving `python mcp_inventory_server.py`):
1. Enumerate ALL regions and ALL paginated shards (`list_shards_page` until `next_cursor is null`).
2. Fetch metrics for every shard and verify alert HMAC tokens (`verify_alert_hmac`).
3. Filter ONLY **active SLA breaches**: `verified_hmac == true` AND (`p99_ms > 250` OR `error_rate_pct >= 2.5`) AND `status != "maintenance"`.
4. Write `breach_report.json` in the workspace root with schema:
```json
{
  "total_regions": int,
  "total_shards_scanned": int,
  "breaches": [
    {"shard_id": str, "region": str, "service": str, "owner_team": str, "p99_ms": int, "error_rate_pct": float}
  ]
}
```
Sort `breaches` ascending by `shard_id`. Do NOT modify `mcp_inventory_server.py` or `data/inventory.db`.
""")

    _w(ws / ".mcp.json", json.dumps({
        "mcpServers": {
            "inventory": {
                "command": "python",
                "args": ["-B", "mcp_inventory_server.py"],
            }
        }
    }, indent=2) + "\n")

    _w(ws / "README_MCP.md", """# Local Inventory MCP Server
Supports MCP JSON-RPC 2.0 over stdio (`initialize`, `tools/list`, `tools/call`):
- `list_regions()` -> `{regions: [...]}`
- `list_shards_page(region, cursor="")` -> `{shards: [...], next_cursor: str|null}`
- `get_shard_metrics(shard_id)` -> `{shard_id, service, status, p99_ms, error_rate_pct, alert_token}`
- `get_service_owner(service)` -> `{service, owner_team}`
- `verify_alert_hmac(shard_id, token)` -> `{valid: bool}`
Plus 13 auxiliary read-only telemetry tools (`diag_01`..`diag_13`).
""")

    _w(ws / "mcp_inventory_server.py", r'''import hashlib, hmac, json, sqlite3, sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "inventory.db"
AUDIT_PATH = Path(__file__).resolve().parent / "data" / "mcp_audit.jsonl"
HMAC_KEY = b"dummy_fixture_mcp_hmac_key_v5"

AUX_TOOLS = [
    {"name": f"diag_{i:02d}_probe", "description": f"Auxiliary diagnostic probe {i}", "inputSchema": {"type": "object", "properties": {"target": {"type": "string"}}}}
    for i in range(1, 14)
]

TOOLS = [
    {"name": "list_regions", "description": "List all telemetry regions", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_shards_page", "description": "Paginated shards for a region (page size 4)", "inputSchema": {"type": "object", "properties": {"region": {"type": "string"}, "cursor": {"type": "string"}}, "required": ["region"]}},
    {"name": "get_shard_metrics", "description": "Fetch metrics for one shard_id", "inputSchema": {"type": "object", "properties": {"shard_id": {"type": "string"}}, "required": ["shard_id"]}},
    {"name": "get_service_owner", "description": "Look up owning team for a service", "inputSchema": {"type": "object", "properties": {"service": {"type": "string"}}, "required": ["service"]}},
    {"name": "verify_alert_hmac", "description": "Verify alert HMAC token for shard_id", "inputSchema": {"type": "object", "properties": {"shard_id": {"type": "string"}, "token": {"type": "string"}}, "required": ["shard_id", "token"]}},
] + AUX_TOOLS

def _log(tool: str, args: dict) -> None:
    with open(AUDIT_PATH, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"tool": tool, "args": args}) + "\n")

def call_tool(name: str, args: dict) -> dict:
    _log(name, args)
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    try:
        if name == "list_regions":
            rows = [r[0] for r in con.execute("SELECT DISTINCT region FROM shards ORDER BY region")]
            return {"regions": rows}
        if name == "list_shards_page":
            region = str(args["region"])
            off = int(args.get("cursor") or 0)
            rows = [r[0] for r in con.execute("SELECT shard_id FROM shards WHERE region=? ORDER BY shard_id LIMIT 4 OFFSET ?", (region, off))]
            nxt = str(off + 4) if len(rows) == 4 else None
            return {"shards": rows, "next_cursor": nxt}
        if name == "get_shard_metrics":
            row = con.execute("SELECT * FROM shards WHERE shard_id=?", (str(args["shard_id"]),)).fetchone()
            if not row:
                raise ValueError("unknown shard")
            return dict(row)
        if name == "get_service_owner":
            row = con.execute("SELECT owner_team FROM owners WHERE service=?", (str(args["service"]),)).fetchone()
            return {"service": args["service"], "owner_team": row[0] if row else "unknown"}
        if name == "verify_alert_hmac":
            expected = hmac.new(HMAC_KEY, str(args["shard_id"]).encode(), hashlib.sha256).hexdigest()[:16]
            return {"valid": hmac.compare_digest(str(args["token"]), expected)}
        if name.startswith("diag_"):
            return {"status": "noop", "probe": name}
        raise ValueError(f"unknown tool: {name}")
    finally:
        con.close()

def main() -> int:
    for raw in sys.stdin:
        s = raw.strip()
        if not s:
            continue
        req = json.loads(s)
        rid = req.get("id")
        method = req.get("method", "")
        if method == "initialize":
            resp = {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2026-07-28", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "inventory-mcp", "version": "1.0"}}}
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            resp = {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
        elif method == "tools/call":
            p = req.get("params") or {}
            try:
                out = call_tool(p["name"], p.get("arguments") or {})
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": json.dumps(out)}], "isError": False}}
            except Exception as exc:
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True}}
        else:
            resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}}
        if rid is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''')

    _w(tdir / "setup.py", r'''import argparse, hashlib, hmac, sqlite3
from pathlib import Path

HMAC_KEY = b"dummy_fixture_mcp_hmac_key_v5"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    data_dir = ws / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db = data_dir / "inventory.db"
    if db.exists():
        db.unlink()
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE owners (service TEXT PRIMARY KEY, owner_team TEXT)")
    con.execute("CREATE TABLE shards (shard_id TEXT PRIMARY KEY, region TEXT, service TEXT, status TEXT, p99_ms INTEGER, error_rate_pct REAL, alert_token TEXT)")
    owners = [("payments", "team-fin"), ("ledger", "team-core"), ("gateway", "team-edge"), ("search", "team-idx")]
    con.executemany("INSERT INTO owners VALUES (?, ?)", owners)
    regions = ["ap-se-1", "eu-west-1", "us-east-1", "us-west-2"]
    rows = []
    idx = 0
    for r in regions:
        for j in range(6):  # 24 shards total -> 2 pages per region!
            idx += 1
            sid = f"sh-{r}-{j:02d}"
            svc = owners[idx % 4][0]
            status = "maintenance" if (idx in (4, 15)) else "active"
            p99 = 320 if (idx % 5 == 0) else 140
            err = 3.1 if (idx % 7 == 0) else 0.4
            tok = hmac.new(HMAC_KEY, sid.encode(), hashlib.sha256).hexdigest()[:16]
            if idx in (10, 21):  # forged HMAC token -> must be excluded!
                tok = "00000000deadbeef"
            rows.append((sid, r, svc, status, p99, err, tok))
    con.executemany("INSERT INTO shards VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''')

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for ptc_01_local_mcp_fanout."""
from __future__ import annotations
import argparse, hashlib, hmac, json, sqlite3
from pathlib import Path

TASK_ID = "ptc_01_local_mcp_fanout"
HMAC_KEY = b"dummy_fixture_mcp_hmac_key_v5"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    rep_path = ws / "breach_report.json"
    audit_path = ws / "data" / "mcp_audit.jsonl"
    checks.append({"name": "report_exists", "passed": rep_path.exists(), "detail": "exists" if rep_path.exists() else "missing breach_report.json"})
    audit_lines = audit_path.read_text(encoding="utf-8").splitlines() if audit_path.exists() else []
    tools_called = {json.loads(ln)["tool"] for ln in audit_lines if ln.strip()}
    checks.append({"name": "mcp_server_queried", "passed": {"list_regions", "list_shards_page", "get_shard_metrics", "verify_alert_hmac"}.issubset(tools_called) and len(audit_lines) >= 20, "detail": f"calls={len(audit_lines)} tools={sorted(tools_called)}"})

    if rep_path.exists():
        try:
            got = json.loads(rep_path.read_text(encoding="utf-8"))
            con = sqlite3.connect(str(ws / "data" / "inventory.db"))
            con.row_factory = sqlite3.Row
            owners = dict(con.execute("SELECT service, owner_team FROM owners").fetchall())
            shards = [dict(r) for r in con.execute("SELECT * FROM shards ORDER BY shard_id")]
            con.close()
            exp_breaches = []
            for s in shards:
                tok_ok = hmac.compare_digest(s["alert_token"], hmac.new(HMAC_KEY, s["shard_id"].encode(), hashlib.sha256).hexdigest()[:16])
                if tok_ok and s["status"] != "maintenance" and (s["p99_ms"] > 250 or s["error_rate_pct"] >= 2.5):
                    exp_breaches.append({
                        "shard_id": s["shard_id"], "region": s["region"], "service": s["service"],
                        "owner_team": owners[s["service"]], "p99_ms": s["p99_ms"], "error_rate_pct": s["error_rate_pct"],
                    })
            checks.append({"name": "counts_exact", "passed": got.get("total_regions") == 4 and got.get("total_shards_scanned") == 24, "detail": repr((got.get("total_regions"), got.get("total_shards_scanned")))})
            checks.append({"name": "breaches_exact", "passed": got.get("breaches") == exp_breaches, "detail": f"got={len(got.get('breaches') or [])} exp={len(exp_breaches)}"})
        except Exception as exc:
            checks.append({"name": "report_parse", "passed": False, "detail": str(exc)})
    else:
        checks.append({"name": "counts_exact", "passed": False, "detail": "no report"})
        checks.append({"name": "breaches_exact", "passed": False, "detail": "no report"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        import subprocess, sys
        proc = subprocess.Popen([sys.executable, "-B", "mcp_inventory_server.py"], cwd=str(ws_dir), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        rid = 0
        def rpc(method, params=None):
            nonlocal rid
            rid += 1
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline())["result"]
        def tcall(name, args):
            res = rpc("tools/call", {"name": name, "arguments": args})
            return json.loads(res["content"][0]["text"])
        rpc("initialize", {})
        regions = tcall("list_regions", {})["regions"]
        shards = []
        for reg in regions:
            cur = ""
            while True:
                pg = tcall("list_shards_page", {"region": reg, "cursor": cur})
                shards.extend((reg, sid) for sid in pg["shards"])
                if not pg["next_cursor"]:
                    break
                cur = pg["next_cursor"]
        breaches = []
        for reg, sid in sorted(shards, key=lambda x: x[1]):
            m = tcall("get_shard_metrics", {"shard_id": sid})
            ok_h = tcall("verify_alert_hmac", {"shard_id": sid, "token": m["alert_token"]})["valid"]
            if ok_h and m["status"] != "maintenance" and (m["p99_ms"] > 250 or m["error_rate_pct"] >= 2.5):
                own = tcall("get_service_owner", {"service": m["service"]})["owner_team"]
                breaches.append({"shard_id": sid, "region": reg, "service": m["service"], "owner_team": own, "p99_ms": m["p99_ms"], "error_rate_pct": m["error_rate_pct"]})
        proc.stdin.close()
        proc.wait(timeout=10)
        _w(ws_dir / "breach_report.json", json.dumps({"total_regions": len(regions), "total_shards_scanned": len(shards), "breaches": breaches}, indent=2) + "\n")

    return {"id": tid, "apply_ref": apply_ref}


def build_ptc_02(tasks_dir: Path) -> dict:
    tid = "ptc_02_code_mode_batch"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "64-service graph cycle detection & batch api_v1->api_v2 manifest codemod",
        ["python", "json"],
    ))
    _w(tdir / "prompt.md", """# Task: Batch Migrate 64 Service Manifests & Build Dependency Cycle Index

The `services/` directory contains 64 JSON manifests (`svc_00.json` .. `svc_63.json`).
Using programmatic batch execution (`run_code` or Python):
1. In every `services/svc_*.json`, migrate `"api_version": "v1"` -> `"v2"`, replace URL prefix `"/api/v1/"` -> `"/api/v2/"` in `"endpoint"`, and compute `"spec_sha256"` = SHA-256 hex of `f"{id}:{endpoint}:{tier}"` (leave `"v2"` services' endpoint untouched if already v2, still ensuring `"spec_sha256"` matches the new formula!).
2. Detect all service IDs participating in ANY directed dependency cycle across `"depends_on"` edges, and list `"in_cycle": sorted(cycle_ids)` plus `"topo_order"` (or `"acyclic_count"`) in `registry/index.json`:
```json
{
  "total_services": 64,
  "migrated_from_v1": int,
  "cycle_nodes": [sorted service ids],
  "by_tier": {"critical": int, "standard": int},
  "checksums": {"svc_00": str, ...}
}
```
Make `python -m unittest discover -s tests` pass without modifying `tests/`.
""")

    for i in range(64):
        sid = f"svc_{i:02d}"
        is_v1 = (i % 3 != 0)
        deps = []
        if i > 0 and i not in (12, 13, 14, 40, 41):
            deps = [f"svc_{i-1:02d}"]
        elif i == 12:
            deps = ["svc_13"]
        elif i == 13:
            deps = ["svc_14"]
        elif i == 14:
            deps = ["svc_12"]
        elif i == 40:
            deps = ["svc_41"]
        elif i == 41:
            deps = ["svc_40"]
        _w(ws / "services" / f"{sid}.json", json.dumps({
            "id": sid,
            "tier": "critical" if i % 4 == 0 else "standard",
            "api_version": "v1" if is_v1 else "v2",
            "endpoint": f"/api/{'v1' if is_v1 else 'v2'}/{sid}/invoke",
            "depends_on": deps,
            "spec_sha256": "stale",
        }, indent=2) + "\n")
    _w(ws / "registry" / "index.json", json.dumps({"total_services": 0}, indent=2) + "\n")
    _w(ws / "tests" / "test_registry.py", """import json, unittest
from pathlib import Path

class PublicRegistryTests(unittest.TestCase):
    def test_index_count(self):
        idx = json.loads(Path("registry/index.json").read_text(encoding="utf-8"))
        self.assertEqual(idx.get("total_services"), 64)
        self.assertEqual(sorted(idx.get("cycle_nodes", [])), ["svc_12", "svc_13", "svc_14", "svc_40", "svc_41"])
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for ptc_02_code_mode_batch."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

TASK_ID = "ptc_02_code_mode_batch"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    pub = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_tests", "passed": pub.returncode == 0, "detail": "ok" if pub.returncode == 0 else pub.stderr[-300:]})

    all_ok = True
    bad = []
    exp_checksums = {}
    for i in range(64):
        sid = f"svc_{i:02d}"
        d = json.loads((ws / "services" / f"{sid}.json").read_text(encoding="utf-8"))
        exp_ep = f"/api/v2/{sid}/invoke"
        exp_sha = hashlib.sha256(f"{sid}:{exp_ep}:{d['tier']}".encode()).hexdigest()
        exp_checksums[sid] = exp_sha
        if d.get("api_version") != "v2" or d.get("endpoint") != exp_ep or d.get("spec_sha256") != exp_sha:
            all_ok = False
            bad.append(sid)
    checks.append({"name": "all_64_migrated_and_hashed", "passed": all_ok, "detail": f"bad={bad[:5]}"})

    idx = json.loads((ws / "registry" / "index.json").read_text(encoding="utf-8"))
    exp_mig = sum(1 for i in range(64) if i % 3 != 0)
    checks.append({"name": "index_fields_exact", "passed": (
        idx.get("total_services") == 64
        and idx.get("migrated_from_v1") == exp_mig
        and sorted(idx.get("cycle_nodes", [])) == ["svc_12", "svc_13", "svc_14", "svc_40", "svc_41"]
        and idx.get("by_tier") == {"critical": 16, "standard": 48}
        and idx.get("checksums") == exp_checksums
    ), "detail": repr({k: idx.get(k) for k in ("total_services", "migrated_from_v1", "cycle_nodes", "by_tier")})})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        import hashlib
        graph = {}
        mig = 0
        tiers = {"critical": 0, "standard": 0}
        checksums = {}
        for p in sorted((ws_dir / "services").glob("svc_*.json")):
            d = json.loads(p.read_text(encoding="utf-8"))
            if d["api_version"] == "v1":
                mig += 1
            d["api_version"] = "v2"
            if d["endpoint"].startswith("/api/v1/"):
                d["endpoint"] = "/api/v2/" + d["endpoint"][len("/api/v1/"):]
            sha = hashlib.sha256(f"{d['id']}:{d['endpoint']}:{d['tier']}".encode()).hexdigest()
            d["spec_sha256"] = sha
            p.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8", newline="\n")
            graph[d["id"]] = d["depends_on"]
            tiers[d["tier"]] += 1
            checksums[d["id"]] = sha
        # Detect nodes in cycles (can reach themselves in >=1 step)
        cycle_nodes = []
        for start in sorted(graph):
            seen = set()
            stack = list(graph[start])
            while stack:
                cur = stack.pop()
                if cur == start:
                    cycle_nodes.append(start)
                    break
                if cur not in seen:
                    seen.add(cur)
                    stack.extend(graph.get(cur, []))
        _w(ws_dir / "registry" / "index.json", json.dumps({
            "total_services": len(graph), "migrated_from_v1": mig,
            "cycle_nodes": sorted(cycle_nodes), "by_tier": tiers, "checksums": checksums,
        }, indent=2) + "\n")

    return {"id": tid, "apply_ref": apply_ref}


def build_ptc_03(tasks_dir: Path) -> dict:
    tid = "ptc_03_mcp_schema_elicit"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Stateful stdio MCP server w/ dynamic tool unlock & strict integer schema settlement",
        ["python", "json"],
    ))
    _w(tdir / "prompt.md", """# Task: Complete Stateful Dynamic-Tool MCP Settlement Workflow

`policy_mcp_server.py` is a local JSON-RPC 2.0 stdio MCP server implementing dynamic tool registration (`notifications/tools/list_changed`):
1. Initially `tools/list` exposes `get_auth_challenge()` and `authenticate_session(proof_hex)`.
2. Calling `authenticate_session(proof_hex=sha256(challenge + ":ok"))` unlocks `list_batches()`, `fetch_batch_items(batch_id)` (strict integer `batch_id`), and `submit_settlement(batch_id, net_cents)` (both strict `int` — rejects `float` or strings!).
3. Drive `policy_mcp_server.py` (over MCP or programmatic stdio script), reconcile all batches (computing `net_cents = sum(credits) - sum(debits)` per batch), submit every batch, and save the returned receipts into `settlement_out.json`:
`{"authenticated": true, "batches": [{"batch_id": int, "net_cents": int, "receipt": str}, ...]}` sorted by `batch_id`.
Do not edit `policy_mcp_server.py`.
""")

    _w(ws / ".mcp.json", json.dumps({
        "mcpServers": {"settlement": {"command": "python", "args": ["-B", "policy_mcp_server.py"]}}
    }, indent=2) + "\n")

    _w(ws / "policy_mcp_server.py", r'''import hashlib, json, sys
from pathlib import Path

AUDIT = Path(__file__).resolve().parent / "settlement_audit.jsonl"
CHALLENGE = "chal-v5-20261124"
BATCHES = {
    101: {"credits": [1500, 2200, 300], "debits": [400, 100]},
    102: {"credits": [9000], "debits": [1250, 750]},
    103: {"credits": [500, 500], "debits": [1200]},
    104: {"credits": [4200, 800, 1000], "debits": [500, 500, 1000]},
}

def main() -> int:
    authed = False
    submitted = {}
    for raw in sys.stdin:
        s = raw.strip()
        if not s:
            continue
        req = json.loads(s)
        rid = req.get("id")
        method = req.get("method", "")
        if method == "initialize":
            resp = {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2026-07-28", "capabilities": {"tools": {"listChanged": True}}, "serverInfo": {"name": "settlement-mcp", "version": "1.0"}}}
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            tools = [
                {"name": "get_auth_challenge", "description": "Get challenge string", "inputSchema": {"type": "object", "properties": {}}},
                {"name": "authenticate_session", "description": "Unlock settlement tools with sha256(challenge + ':ok')", "inputSchema": {"type": "object", "properties": {"proof_hex": {"type": "string"}}, "required": ["proof_hex"]}},
            ]
            if authed:
                tools.extend([
                    {"name": "list_batches", "description": "List batch IDs", "inputSchema": {"type": "object", "properties": {}}},
                    {"name": "fetch_batch_items", "description": "Fetch credits and debits for integer batch_id", "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "integer"}}, "required": ["batch_id"]}},
                    {"name": "submit_settlement", "description": "Submit integer net_cents for integer batch_id", "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "integer"}, "net_cents": {"type": "integer"}}, "required": ["batch_id", "net_cents"]}},
                ])
            resp = {"jsonrpc": "2.0", "id": rid, "result": {"tools": tools}}
        elif method == "tools/call":
            p = req.get("params") or {}
            name = p.get("name", "")
            args = p.get("arguments") or {}
            with open(AUDIT, "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps({"tool": name, "args": args}) + "\n")
            try:
                if name == "get_auth_challenge":
                    out = {"challenge": CHALLENGE}
                elif name == "authenticate_session":
                    exp = hashlib.sha256(f"{CHALLENGE}:ok".encode()).hexdigest()
                    if args.get("proof_hex") != exp:
                        raise ValueError("invalid proof_hex")
                    authed = True
                    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}) + "\n")
                    sys.stdout.flush()
                    out = {"authenticated": True}
                elif not authed:
                    raise PermissionError("session not authenticated")
                elif name == "list_batches":
                    out = {"batch_ids": sorted(BATCHES)}
                elif name == "fetch_batch_items":
                    bid = args.get("batch_id")
                    if type(bid) is not int or bid not in BATCHES:
                        raise TypeError("batch_id must be valid integer")
                    out = {"batch_id": bid, **BATCHES[bid]}
                elif name == "submit_settlement":
                    bid = args.get("batch_id")
                    net = args.get("net_cents")
                    if type(bid) is not int or type(net) is not int:
                        raise TypeError("strict integer schema violation")
                    exp_net = sum(BATCHES[bid]["credits"]) - sum(BATCHES[bid]["debits"])
                    if net != exp_net:
                        raise ValueError(f"mismatch net_cents for {bid}")
                    rec = hashlib.sha256(f"settled:{bid}:{net}".encode()).hexdigest()[:16]
                    submitted[bid] = rec
                    out = {"batch_id": bid, "net_cents": net, "receipt": rec}
                else:
                    raise ValueError(f"unknown tool: {name}")
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": json.dumps(out)}], "isError": False}}
            except Exception as exc:
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True}}
        else:
            resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}}
        if rid is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''')

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for ptc_03_mcp_schema_elicit."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

TASK_ID = "ptc_03_mcp_schema_elicit"
BATCHES = {
    101: (3500,), 102: (7000,), 103: (-200,), 104: (4000,),
}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    out_p = ws / "settlement_out.json"
    aud_p = ws / "settlement_audit.jsonl"
    aud = [json.loads(ln) for ln in aud_p.read_text(encoding="utf-8").splitlines() if ln.strip()] if aud_p.exists() else []
    called = {x["tool"] for x in aud}
    checks.append({"name": "mcp_workflow_executed", "passed": {"get_auth_challenge", "authenticate_session", "list_batches", "fetch_batch_items", "submit_settlement"}.issubset(called), "detail": repr(sorted(called))})

    if out_p.exists():
        got = json.loads(out_p.read_text(encoding="utf-8"))
        exp = [
            {"batch_id": bid, "net_cents": vals[0], "receipt": hashlib.sha256(f"settled:{bid}:{vals[0]}".encode()).hexdigest()[:16]}
            for bid, vals in sorted(BATCHES.items())
        ]
        checks.append({"name": "settlement_exact", "passed": got.get("authenticated") is True and got.get("batches") == exp, "detail": repr(got)})
    else:
        checks.append({"name": "settlement_exact", "passed": False, "detail": "missing settlement_out.json"})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        import hashlib, subprocess, sys
        proc = subprocess.Popen([sys.executable, "-B", "policy_mcp_server.py"], cwd=str(ws_dir), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        rid = 0
        def rpc(method, params=None):
            nonlocal rid
            rid += 1
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
            proc.stdin.flush()
            while True:
                msg = json.loads(proc.stdout.readline())
                if "id" in msg:
                    return msg["result"]
        def tcall(name, args):
            return json.loads(rpc("tools/call", {"name": name, "arguments": args})["content"][0]["text"])
        rpc("initialize", {})
        ch = tcall("get_auth_challenge", {})["challenge"]
        tcall("authenticate_session", {"proof_hex": hashlib.sha256(f"{ch}:ok".encode()).hexdigest()})
        bids = tcall("list_batches", {})["batch_ids"]
        out = []
        for bid in sorted(bids):
            it = tcall("fetch_batch_items", {"batch_id": bid})
            net = sum(it["credits"]) - sum(it["debits"])
            out.append(tcall("submit_settlement", {"batch_id": bid, "net_cents": net}))
        proc.stdin.close()
        proc.wait(timeout=10)
        _w(ws_dir / "settlement_out.json", json.dumps({"authenticated": True, "batches": out}, indent=2) + "\n")

    return {"id": tid, "apply_ref": apply_ref}
