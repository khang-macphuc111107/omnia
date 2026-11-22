#!/usr/bin/env python3
"""setup.py - Deterministically initializes .opsctl_state.db for bfcl_01_incident_orchestrator."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

DB_FILENAME = ".opsctl_state.db"


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE services (
            name TEXT PRIMARY KEY,
            tier TEXT NOT NULL,
            owner_team TEXT NOT NULL,
            description TEXT NOT NULL
        );

        CREATE TABLE service_dependencies (
            upstream TEXT NOT NULL,
            downstream TEXT NOT NULL,
            protocol TEXT NOT NULL,
            critical INTEGER NOT NULL,
            PRIMARY KEY (upstream, downstream),
            FOREIGN KEY (upstream) REFERENCES services(name),
            FOREIGN KEY (downstream) REFERENCES services(name)
        );

        CREATE TABLE alerts (
            alert_id TEXT PRIMARY KEY,
            alert_code TEXT NOT NULL,
            service TEXT NOT NULL,
            severity_hint TEXT NOT NULL,
            status TEXT NOT NULL,
            triggered_at TEXT NOT NULL,
            summary TEXT NOT NULL,
            FOREIGN KEY (service) REFERENCES services(name)
        );

        CREATE TABLE metrics (
            service TEXT NOT NULL,
            window TEXT NOT NULL,
            error_rate_pct REAL NOT NULL,
            p99_latency_ms REAL NOT NULL,
            rps REAL NOT NULL,
            extra_json TEXT NOT NULL,
            PRIMARY KEY (service, window),
            FOREIGN KEY (service) REFERENCES services(name)
        );

        CREATE TABLE deployments (
            deploy_id TEXT PRIMARY KEY,
            service TEXT NOT NULL,
            version TEXT NOT NULL,
            status TEXT NOT NULL,
            deployed_at TEXT NOT NULL,
            minutes_ago INTEGER NOT NULL,
            notes TEXT NOT NULL,
            FOREIGN KEY (service) REFERENCES services(name)
        );

        CREATE TABLE runbooks (
            runbook_id TEXT PRIMARY KEY,
            alert_code TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            classification TEXT NOT NULL,
            instructions TEXT NOT NULL,
            allowed_mutations_json TEXT NOT NULL,
            forbidden_mutations_json TEXT NOT NULL,
            escalation_team TEXT
        );

        CREATE TABLE tickets (
            ticket_id TEXT PRIMARY KEY,
            severity TEXT NOT NULL,
            service TEXT NOT NULL,
            title TEXT NOT NULL,
            root_cause TEXT NOT NULL,
            alert_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (service) REFERENCES services(name),
            FOREIGN KEY (alert_id) REFERENCES alerts(alert_id)
        );

        CREATE TABLE rollbacks (
            rollback_id TEXT PRIMARY KEY,
            service TEXT NOT NULL,
            from_version TEXT NOT NULL,
            target_version TEXT NOT NULL,
            reason TEXT NOT NULL,
            executed_at TEXT NOT NULL,
            FOREIGN KEY (service) REFERENCES services(name)
        );

        CREATE TABLE notifications (
            notification_id TEXT PRIMARY KEY,
            team TEXT NOT NULL,
            severity TEXT NOT NULL,
            message TEXT NOT NULL,
            ticket_id TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
        );

        CREATE TABLE tool_audit_log (
            seq INTEGER PRIMARY KEY,
            command TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_ok INTEGER NOT NULL,
            prev_hmac TEXT NOT NULL,
            row_hmac TEXT NOT NULL
        );
        """
    )


def seed_data(conn: sqlite3.Connection) -> None:
    services = [
        ("api-gateway", "edge", "platform-edge", "Public HTTPS ingress gateway and request router"),
        ("checkout-api", "core", "checkout-eng", "Checkout orchestration and order submission service"),
        ("payment-ledger", "core", "payments-sre", "Double-entry payment authorization and settlement ledger"),
        ("postgres-payments", "data", "dba-sre", "Primary transactional PostgreSQL cluster for payment ledger"),
        ("session-cache", "cache", "cache-infra", "Distributed Redis session and token cache"),
        ("invoice-worker", "worker", "billing-ops", "Async worker dispatching finalized invoices to external tax partner"),
        ("auth-service", "core", "identity-eng", "OAuth2 token issuer and verification service"),
        ("inventory-service", "core", "catalog-eng", "Stock reservation and SKU availability service"),
        ("partner-tax-api", "external", "external-vendor", "Third-party tax filing and invoice compliance API"),
    ]
    conn.executemany(
        "INSERT INTO services (name, tier, owner_team, description) VALUES (?, ?, ?, ?)",
        services,
    )

    dependencies = [
        ("api-gateway", "checkout-api", "grpc", 1),
        ("api-gateway", "session-cache", "redis", 0),
        ("api-gateway", "auth-service", "grpc", 1),
        ("checkout-api", "payment-ledger", "grpc", 1),
        ("checkout-api", "inventory-service", "grpc", 1),
        ("checkout-api", "session-cache", "redis", 0),
        ("payment-ledger", "postgres-payments", "tcp", 1),
        ("invoice-worker", "payment-ledger", "http", 0),
        ("invoice-worker", "partner-tax-api", "https-external", 1),
        ("auth-service", "session-cache", "redis", 1),
    ]
    conn.executemany(
        "INSERT INTO service_dependencies (upstream, downstream, protocol, critical) VALUES (?, ?, ?, ?)",
        dependencies,
    )

    alerts = [
        (
            "ALT-1001",
            "ERR_GATEWAY_5XX_SPIKE",
            "api-gateway",
            "critical",
            "open",
            "2026-10-15T14:22:00Z",
            "HTTP 5xx error rate exceeded 15% threshold on api-gateway (currently 18.7% over 15m).",
        ),
        (
            "ALT-1002",
            "WARN_CACHE_EVICTION_BURST",
            "session-cache",
            "warning",
            "open",
            "2026-10-15T14:05:00Z",
            "Elevated LRU eviction rate (1420 keys/min) detected on session-cache.",
        ),
        (
            "ALT-1003",
            "DEGRADED_WORKER_LAG",
            "invoice-worker",
            "warning",
            "open",
            "2026-10-15T13:40:00Z",
            "Invoice worker queue depth reached 640 messages (threshold 500) alongside HTTP 429 partner throttling.",
        ),
        (
            "ALT-0998",
            "INFO_CERT_RENEWED",
            "api-gateway",
            "info",
            "resolved",
            "2026-10-12T03:00:00Z",
            "Automated TLS certificate rotation completed cleanly.",
        ),
    ]
    conn.executemany(
        """
        INSERT INTO alerts (alert_id, alert_code, service, severity_hint, status, triggered_at, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        alerts,
    )

    metrics = [
        (
            "api-gateway",
            "15m",
            18.7,
            2580.0,
            1420.5,
            json.dumps({
                "http_5xx_pct": 18.7,
                "upstream_timeout_pct": 18.4,
                "failing_route_prefix": "/v2/checkout",
                "local_crash_count": 0,
            }),
        ),
        (
            "api-gateway",
            "1h",
            5.1,
            890.0,
            1405.0,
            json.dumps({"http_5xx_pct": 5.1, "baseline_5xx_pct": 0.08}),
        ),
        (
            "checkout-api",
            "15m",
            38.9,
            2490.0,
            410.2,
            json.dumps({
                "downstream_errors_from": "payment-ledger",
                "local_panics": 0,
                "note": "Retries timing out waiting on payment-ledger RPC",
            }),
        ),
        (
            "checkout-api",
            "1h",
            10.2,
            720.0,
            405.0,
            json.dumps({"downstream_errors_from": "payment-ledger", "baseline_error_pct": 0.12}),
        ),
        (
            "payment-ledger",
            "15m",
            41.2,
            2400.0,
            395.0,
            json.dumps({
                "db_pool_exhausted_errors": 162,
                "canary_pod_error_pct": 94.6,
                "note": "Error spike started immediately after v2.14.3-canary deployment 12 minutes ago",
            }),
        ),
        (
            "payment-ledger",
            "1h",
            11.4,
            680.0,
            390.0,
            json.dumps({"baseline_error_pct": 0.05, "baseline_p99_ms": 42.0}),
        ),
        (
            "postgres-payments",
            "15m",
            0.02,
            14.5,
            1120.0,
            json.dumps({"cpu_pct": 34.0, "active_connections": 48, "max_connections": 200, "status": "healthy"}),
        ),
        (
            "postgres-payments",
            "1h",
            0.02,
            13.8,
            1105.0,
            json.dumps({"cpu_pct": 31.0, "status": "healthy"}),
        ),
        (
            "session-cache",
            "15m",
            0.0,
            1.8,
            8900.0,
            json.dumps({
                "cache_hit_ratio_pct": 98.4,
                "evictions_per_min": 1420,
                "scheduled_lru_compaction_active": True,
                "oom_events": 0,
            }),
        ),
        (
            "session-cache",
            "1h",
            0.0,
            1.7,
            8850.0,
            json.dumps({"cache_hit_ratio_pct": 98.5, "evictions_per_min": 410}),
        ),
        (
            "invoice-worker",
            "15m",
            1.2,
            410.0,
            32.0,
            json.dumps({
                "queue_depth": 640,
                "dlq_threshold": 500,
                "partner_http_429_count": 218,
                "partner_quota_max_concurrency": 8,
                "note": "External partner throttling due to worker concurrency exceeding contracted quota",
            }),
        ),
        (
            "invoice-worker",
            "1h",
            0.9,
            380.0,
            30.5,
            json.dumps({
                "queue_depth": 590,
                "partner_http_429_count": 612,
                "partner_quota_max_concurrency": 8,
            }),
        ),
        (
            "auth-service",
            "15m",
            0.01,
            19.0,
            920.0,
            json.dumps({"status": "healthy"}),
        ),
        (
            "auth-service",
            "1h",
            0.01,
            18.6,
            915.0,
            json.dumps({"status": "healthy"}),
        ),
        (
            "inventory-service",
            "15m",
            0.03,
            28.0,
            380.0,
            json.dumps({"status": "healthy"}),
        ),
        (
            "inventory-service",
            "1h",
            0.03,
            27.2,
            378.0,
            json.dumps({"status": "healthy"}),
        ),
        (
            "partner-tax-api",
            "15m",
            0.0,
            180.0,
            32.0,
            json.dumps({"rate_limit_enforced": True, "contract_max_concurrency": 8}),
        ),
        (
            "partner-tax-api",
            "1h",
            0.0,
            175.0,
            30.5,
            json.dumps({"rate_limit_enforced": True, "contract_max_concurrency": 8}),
        ),
    ]
    conn.executemany(
        """
        INSERT INTO metrics (service, window, error_rate_pct, p99_latency_ms, rps, extra_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        metrics,
    )

    deployments = [
        ("DEP-401", "payment-ledger", "v2.14.3-canary", "active", "2026-10-15T14:10:00Z", 12, "Canary rollout introducing new async connection pooler"),
        ("DEP-398", "payment-ledger", "v2.14.2", "previous_stable", "2026-10-10T09:30:00Z", 7492, "Last verified stable production release"),
        ("DEP-381", "payment-ledger", "v2.14.1", "superseded", "2026-10-02T11:00:00Z", 18922, "Prior production release"),
        ("DEP-390", "api-gateway", "v4.6.1", "active", "2026-10-08T16:00:00Z", 9982, "Stable edge proxy build (7 days ago)"),
        ("DEP-375", "api-gateway", "v4.6.0", "previous_stable", "2026-09-28T10:00:00Z", 24742, "Prior stable edge build"),
        ("DEP-392", "checkout-api", "v3.9.0", "active", "2026-10-09T12:00:00Z", 8782, "Stable checkout release (6 days ago)"),
        ("DEP-370", "checkout-api", "v3.8.4", "previous_stable", "2026-09-25T15:00:00Z", 28762, "Prior stable checkout build"),
        ("DEP-385", "session-cache", "v1.4.2", "active", "2026-10-01T08:00:00Z", 20542, "Stable Redis cluster config (14 days ago)"),
        ("DEP-368", "session-cache", "v1.4.1", "previous_stable", "2026-09-14T08:00:00Z", 45022, "Prior Redis cluster config"),
        ("DEP-388", "invoice-worker", "v1.8.0", "active", "2026-10-06T14:00:00Z", 12982, "Stable worker release deployed 9 days ago; no recent release"),
        ("DEP-360", "invoice-worker", "v1.7.9", "previous_stable", "2026-09-18T11:00:00Z", 39082, "Prior stable worker release"),
        ("DEP-382", "auth-service", "v2.2.0", "active", "2026-10-04T10:00:00Z", 16102, "Stable auth build"),
        ("DEP-384", "inventory-service", "v1.11.0", "active", "2026-10-05T10:00:00Z", 14662, "Stable inventory build"),
    ]
    conn.executemany(
        """
        INSERT INTO deployments (deploy_id, service, version, status, deployed_at, minutes_ago, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        deployments,
    )

    runbooks = [
        (
            "RB-GW-500",
            "ERR_GATEWAY_5XX_SPIKE",
            "API Gateway 5xx Cascading Outage Triage & Mitigation",
            "incident_cascading",
            (
                "1. Do NOT blindly roll back api-gateway without isolating root cause.\n"
                "2. Trace the downstream dependency chain starting from api-gateway using `get-service-graph` and inspect `get-metrics` along the path to find the deepest failing service.\n"
                "3. Inspect `get-deployments` for the identified root-cause service to check for a recent canary or regression deployment.\n"
                "4. Once a bad recent deployment is confirmed on the root-cause service:\n"
                "   a) Run `rollback-deploy` on the root-cause service targeting its `previous_stable` version.\n"
                "   b) Create a `P1` ticket via `create-ticket` for the root-cause service referencing `ALT-1001`.\n"
                "   c) Page the owning on-call team of the root-cause service (`owner_team` from service graph, e.g., `payments-sre` for `payment-ledger`) via `notify-oncall` with `--severity P1` and the exact created `--ticket-id`.\n"
                "5. Record `action_taken: \"rollback_ticket_and_page\"` and `runbook_citation: \"RB-GW-500\"` in `incident_resolution.json`."
            ),
            json.dumps(["rollback-deploy", "create-ticket", "notify-oncall"]),
            json.dumps(["rollback-deploy:api-gateway", "rollback-deploy:checkout-api"]),
            "payments-sre",
        ),
        (
            "RB-CACHE-042",
            "WARN_CACHE_EVICTION_BURST",
            "Session Cache Scheduled LRU Compaction Burst (Known False Positive)",
            "false_positive",
            (
                "KNOWN FALSE POSITIVE (Runbook RB-CACHE-042): `session-cache` runs a scheduled periodic LRU compaction sweep that temporarily spikes key evictions (>1000 keys/min).\n"
                "1. Inspect `get-metrics --service session-cache` to verify `cache_hit_ratio_pct >= 95.0` and `error_rate_pct == 0.0`.\n"
                "2. When hit ratio is healthy and errors are zero, this alert is a confirmed false positive.\n"
                "3. STRICT ABSTENTION POLICY: You MUST NOT invoke `rollback-deploy`, `notify-oncall`, or `create-ticket` (of any severity P1/P2/P3) for `ALT-1002` / `session-cache`.\n"
                "4. Record `action_taken: \"abstain_false_positive\"`, `is_false_positive: true`, and `runbook_citation: \"RB-CACHE-042\"` in `incident_resolution.json`."
            ),
            json.dumps([]),
            json.dumps(["rollback-deploy", "create-ticket", "notify-oncall"]),
            None,
        ),
        (
            "RB-WORKER-429",
            "DEGRADED_WORKER_LAG",
            "Invoice Worker Queue Lag & External Partner Rate-Limit Misconfiguration",
            "degraded_config",
            (
                "1. Inspect `get-service-graph`, `get-metrics --service invoice-worker`, and `get-deployments --service invoice-worker` to verify whether a recent deployment caused the lag.\n"
                "2. If there is no recent bad deployment and metrics show partner HTTP 429 throttling, inspect the workspace config file `config/invoice_worker.json`.\n"
                "3. Compare `max_concurrency` in `config/invoice_worker.json` against the partner concurrency quota (`partner_rate_limit_concurrency` / `partner_quota_max_concurrency`).\n"
                "4. STRICT POLICY: Do NOT call `rollback-deploy` on `invoice-worker`, do NOT call `notify-oncall`, and do NOT edit `config/invoice_worker.json` directly.\n"
                "5. File a `P3` ticket via `create-ticket --severity P3 --service invoice-worker --alert-id ALT-1003` with `--metadata-json` containing EXACTLY these three keys:\n"
                "   - `current_concurrency`: integer value of `max_concurrency` from `config/invoice_worker.json`\n"
                "   - `recommended_concurrency`: integer partner concurrency quota\n"
                "   - `config_file`: `\"config/invoice_worker.json\"`\n"
                "6. Record `action_taken: \"file_p3_config_ticket\"` and `runbook_citation: \"RB-WORKER-429\"` in `incident_resolution.json`."
            ),
            json.dumps(["create-ticket"]),
            json.dumps(["rollback-deploy", "notify-oncall"]),
            None,
        ),
    ]
    conn.executemany(
        """
        INSERT INTO runbooks (
            runbook_id, alert_code, title, classification, instructions,
            allowed_mutations_json, forbidden_mutations_json, escalation_team
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        runbooks,
    )


def init_workspace(workspace_dir: Path) -> Path:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    db_path = workspace_dir / DB_FILENAME
    for suffix in ("", "-wal", "-shm", "-journal"):
        candidate = Path(f"{db_path}{suffix}")
        if candidate.exists():
            candidate.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        create_schema(conn)
        seed_data(conn)
        conn.commit()
    finally:
        conn.close()
    return db_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize bfcl_01_incident_orchestrator workspace DB.")
    parser.add_argument("--workspace", required=True, help="Target workspace directory")
    args = parser.parse_args()
    db_path = init_workspace(Path(args.workspace).resolve())
    print(json.dumps({"ok": True, "db_path": str(db_path)}))


if __name__ == "__main__":
    main()
