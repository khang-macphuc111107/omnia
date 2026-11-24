# Task: Complete Stateful Dynamic-Tool MCP Settlement Workflow

`policy_mcp_server.py` is a local JSON-RPC 2.0 stdio MCP server implementing dynamic tool registration (`notifications/tools/list_changed`):
1. Initially `tools/list` exposes `get_auth_challenge()` and `authenticate_session(proof_hex)`.
2. Calling `authenticate_session(proof_hex=sha256(challenge + ":ok"))` unlocks `list_batches()`, `fetch_batch_items(batch_id)` (strict integer `batch_id`), and `submit_settlement(batch_id, net_cents)` (both strict `int` — rejects `float` or strings!).
3. Drive `policy_mcp_server.py` (over MCP or programmatic stdio script), reconcile all batches (computing `net_cents = sum(credits) - sum(debits)` per batch), submit every batch, and save the returned receipts into `settlement_out.json`:
`{"authenticated": true, "batches": [{"batch_id": int, "net_cents": int, "receipt": str}, ...]}` sorted by `batch_id`.
Do not edit `policy_mcp_server.py`.
