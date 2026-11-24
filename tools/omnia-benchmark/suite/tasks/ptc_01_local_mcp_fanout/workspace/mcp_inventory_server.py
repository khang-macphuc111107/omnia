import hashlib, hmac, json, sqlite3, sys
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
