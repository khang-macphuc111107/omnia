import hashlib, json, sys
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
