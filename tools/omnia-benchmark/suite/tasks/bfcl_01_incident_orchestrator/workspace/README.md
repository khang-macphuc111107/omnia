# Operations Control CLI (`opsctl.py`)

`opsctl.py` is the audited incident-response CLI for this production environment. Every command reads/updates `.opsctl_state.db`, prints a single JSON object to stdout, and appends a cryptographically signed entry to the audit log.

> **Important:** Do NOT edit `opsctl.py`, do NOT edit `.opsctl_state.db` directly, and do NOT modify files in `config/`. Always interact with the operations platform exclusively through `python opsctl.py <subcommand>`.

## Subcommands

### Read-Only Investigation Commands

1. **List alerts** (`--status` accepts `open` or `all`, default `open`)
   ```powershell
   python opsctl.py list-alerts --status open
   python opsctl.py list-alerts --status all
   ```

2. **Inspect service dependency graph** (optional `--service <name>`)
   ```powershell
   python opsctl.py get-service-graph
   python opsctl.py get-service-graph --service <service-name>
   ```

3. **Query service metrics** (`--window` accepts `15m` or `1h`, default `15m`)
   ```powershell
   python opsctl.py get-metrics --service <service-name> --window 15m
   ```

4. **Inspect deployment history**
   ```powershell
   python opsctl.py get-deployments --service <service-name>
   ```

5. **Fetch operational runbook**
   ```powershell
   python opsctl.py get-runbook --alert-code <alert-code>
   ```

### Mutating Remediation Commands

6. **Create incident / tracking ticket** (`--severity` accepts `P1`, `P2`, `P3`; optional `--metadata-json` must decode to a JSON object)
   ```powershell
   python opsctl.py create-ticket --severity P1 --service <service-name> --title "<title>" --root-cause "<root-cause>" --alert-id <alert-id>
   python opsctl.py create-ticket --severity P3 --service <service-name> --title "<title>" --root-cause "<root-cause>" --alert-id <alert-id> --metadata-json "{\"key\": \"value\"}"
   ```

7. **Roll back a service deployment**
   ```powershell
   python opsctl.py rollback-deploy --service <service-name> --target-version <version> --reason "<reason>"
   ```

8. **Notify on-call team** (`--severity` accepts `P1`, `P2`, `P3`; `--ticket-id` must reference an existing ticket)
   ```powershell
   python opsctl.py notify-oncall --team <team-name> --severity P1 --message "<message>" --ticket-id <ticket-id>
   ```

## Workspace Files

- `opsctl.py` — Audited operations CLI (read-only)
- `config/` — Production service configuration snapshots (read-only)
- `.opsctl_state.db` — SQLite state & HMAC audit log managed exclusively by `opsctl.py`
