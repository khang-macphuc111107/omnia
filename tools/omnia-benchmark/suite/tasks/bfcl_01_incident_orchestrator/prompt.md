# Task: Multi-Alert Operations Orchestration & Abstention (`bfcl_01_incident_orchestrator`)

You are the on-call SRE automation agent responding to active production alerts in this workspace.

## Environment & Rules

1. Use the audited operations CLI via `python opsctl.py <subcommand> ...` (see `README.md` for subcommand signatures).
2. **NEVER** modify `opsctl.py`, `.opsctl_state.db` directly, or any file under `config/`. Every operational query and action is cryptographically HMAC-chained inside `.opsctl_state.db` by `opsctl.py`.
3. Follow **strict causal discipline**: investigate every open alert thoroughly (`list-alerts`, `get-service-graph`, `get-metrics`, `get-deployments`, and `get-runbook` for every active alert code, plus any local config file referenced by a runbook) **before** executing any mutating command (`rollback-deploy`, `create-ticket`, `notify-oncall`).
4. Follow every runbook's **allowed and forbidden action policy** strictly:
   - Execute only the exact mutations required by the evidence and runbook.
   - **Abstain completely** from forbidden mutations (no rollbacks, tickets, or on-call pages when a runbook forbids them).
   - For any configuration-mismatch `P3` ticket required by a runbook, pass `--metadata-json` containing the exact JSON object keys `current_concurrency` (int), `recommended_concurrency` (int), and `config_file` (string path `"config/invoice_worker.json"`).

## Required Output Artifact

After completing your investigation and only the authorized remediation actions via `opsctl.py`, write `incident_resolution.json` in the workspace root matching the **exact** JSON schema below (no missing keys, no extra keys):

```json
{
  "schema_version": "1.0",
  "incidents": [
    {
      "alert_id": "<ALT-xxxx>",
      "alert_code": "<ALERT_CODE>",
      "reported_service": "<service from alert>",
      "root_cause_service": "<identified root-cause service>",
      "is_false_positive": false,
      "action_taken": "<one of: rollback_ticket_and_page | abstain_false_positive | file_p3_config_ticket>",
      "rollback_target_version": "<version string or null>",
      "ticket_id": "<exact ticket_id returned by opsctl create-ticket, or null>",
      "ticket_severity": "<P1 | P2 | P3 | null>",
      "notified_team": "<team name paged via notify-oncall, or null>",
      "runbook_citation": "<exact runbook_id returned by get-runbook>",
      "evidence_summary": "<concise factual summary citing observed metrics/deploy/config evidence>"
    }
  ],
  "summary": {
    "total_open_alerts_evaluated": 3,
    "rollbacks_executed": 0,
    "tickets_created": 0,
    "oncall_notifications_sent": 0,
    "abstained_alerts": ["<alert_id>"]
  }
}
```

### Schema Requirements
- `schema_version` MUST be `"1.0"`.
- `incidents` MUST contain one entry per **open** alert, sorted ascending by `alert_id`.
- `action_taken` MUST be one of:
  - `"rollback_ticket_and_page"`
  - `"abstain_false_positive"`
  - `"file_p3_config_ticket"`
- `runbook_citation` MUST be the exact `runbook_id` returned by `python opsctl.py get-runbook --alert-code <code>`.
- `ticket_id` MUST match the exact `ticket_id` returned by `opsctl.py create-ticket` (or `null` when abstaining).
- `summary.abstained_alerts` MUST be a sorted array of `alert_id` strings for which you abstained from all mutating actions.
- All summary counts MUST accurately match the actual operations performed.
