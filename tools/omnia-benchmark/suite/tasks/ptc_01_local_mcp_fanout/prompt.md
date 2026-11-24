# Task: Aggregate Multi-Region Shard Telemetry via Local Stdio MCP Server

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
