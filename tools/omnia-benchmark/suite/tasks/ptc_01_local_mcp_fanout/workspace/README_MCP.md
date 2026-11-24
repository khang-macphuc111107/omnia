# Local Inventory MCP Server
Supports MCP JSON-RPC 2.0 over stdio (`initialize`, `tools/list`, `tools/call`):
- `list_regions()` -> `{regions: [...]}`
- `list_shards_page(region, cursor="")` -> `{shards: [...], next_cursor: str|null}`
- `get_shard_metrics(shard_id)` -> `{shard_id, service, status, p99_ms, error_rate_pct, alert_token}`
- `get_service_owner(service)` -> `{service, owner_team}`
- `verify_alert_hmac(shard_id, token)` -> `{valid: bool}`
Plus 13 auxiliary read-only telemetry tools (`diag_01`..`diag_13`).
