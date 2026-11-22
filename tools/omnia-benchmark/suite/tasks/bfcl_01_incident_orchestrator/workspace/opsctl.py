#!/usr/bin/env python3
"""opsctl.py - Deterministic incident operations CLI backed by .opsctl_state.db."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import hmac
import json
import sqlite3
import sys
from collections import deque
from pathlib import Path
from typing import Any, NoReturn

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

DB_PATH = Path(__file__).resolve().parent / ".opsctl_state.db"
AUDIT_SECRET = b"bfcl01-opsctl-hmac-v1-9f3c7a12e84b6d05"
GENESIS_HMAC = "0" * 64


def emit_json(payload: dict[str, Any], exit_code: int = 0) -> NoReturn:
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    sys.exit(exit_code)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        emit_json({"ok": False, "error": "INVALID_ARGUMENTS", "detail": message}, exit_code=1)


def compute_row_hmac(
    seq: int,
    command: str,
    args_json: str,
    result_ok: int,
    prev_hmac: str,
) -> str:
    payload = f"{seq}|{command}|{args_json}|{result_ok}|{prev_hmac}".encode("utf-8")
    return hmac.new(AUDIT_SECRET, payload, hashlib.sha256).hexdigest()


def append_audit_log(
    conn: sqlite3.Connection,
    command: str,
    args_dict: dict[str, Any],
    result_ok: bool,
) -> int:
    row = conn.execute(
        "SELECT seq, row_hmac FROM tool_audit_log ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    if row is None:
        next_seq = 1
        prev_hmac = GENESIS_HMAC
    else:
        next_seq = int(row["seq"]) + 1
        prev_hmac = str(row["row_hmac"])
    args_json = json.dumps(args_dict, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    ok_int = 1 if result_ok else 0
    row_hmac = compute_row_hmac(next_seq, command, args_json, ok_int, prev_hmac)
    conn.execute(
        """
        INSERT INTO tool_audit_log (seq, command, args_json, result_ok, prev_hmac, row_hmac)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (next_seq, command, args_json, ok_int, prev_hmac, row_hmac),
    )
    return next_seq


def connect_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        emit_json(
            {
                "ok": False,
                "error": "STATE_DB_MISSING",
                "detail": f"Expected initialized state database at {DB_PATH}",
            },
            exit_code=1,
        )
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fail_with_audit(
    conn: sqlite3.Connection,
    command: str,
    args_dict: dict[str, Any],
    error_code: str,
    detail: str,
) -> NoReturn:
    conn.rollback()
    append_audit_log(conn, command, args_dict, result_ok=False)
    conn.commit()
    conn.close()
    emit_json({"ok": False, "error": error_code, "detail": detail}, exit_code=1)


def cmd_list_alerts(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {"status": args.status}
    if args.status == "open":
        rows = conn.execute(
            """
            SELECT alert_id, alert_code, service, severity_hint, status, triggered_at, summary
            FROM alerts WHERE status = 'open' ORDER BY alert_id ASC
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT alert_id, alert_code, service, severity_hint, status, triggered_at, summary
            FROM alerts ORDER BY alert_id ASC
            """
        ).fetchall()
    append_audit_log(conn, "list-alerts", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "list-alerts",
        "status_filter": args.status,
        "count": len(rows),
        "alerts": [dict(r) for r in rows],
    }


def cmd_get_service_graph(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict: dict[str, Any] = {}
    if args.service is not None:
        args_dict["service"] = args.service

    all_services = {
        r["name"]: dict(r)
        for r in conn.execute(
            "SELECT name, tier, owner_team, description FROM services ORDER BY name ASC"
        ).fetchall()
    }
    all_edges = [
        {
            "upstream": r["upstream"],
            "downstream": r["downstream"],
            "protocol": r["protocol"],
            "critical": bool(r["critical"]),
        }
        for r in conn.execute(
            "SELECT upstream, downstream, protocol, critical FROM service_dependencies ORDER BY upstream ASC, downstream ASC"
        ).fetchall()
    ]

    if args.service is None:
        append_audit_log(conn, "get-service-graph", args_dict, result_ok=True)
        conn.commit()
        return {
            "ok": True,
            "command": "get-service-graph",
            "services": list(all_services.values()),
            "edges": all_edges,
        }

    svc = args.service
    if svc not in all_services:
        fail_with_audit(conn, "get-service-graph", args_dict, "UNKNOWN_SERVICE", f"Unknown service: {svc}")

    upstream = [e for e in all_edges if e["downstream"] == svc]
    downstream = [e for e in all_edges if e["upstream"] == svc]

    visited = {svc}
    queue: deque[str] = deque([svc])
    transitive_edges: list[dict[str, Any]] = []
    while queue:
        cur = queue.popleft()
        for e in all_edges:
            if e["upstream"] == cur:
                transitive_edges.append(e)
                if e["downstream"] not in visited:
                    visited.add(e["downstream"])
                    queue.append(e["downstream"])

    append_audit_log(conn, "get-service-graph", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "get-service-graph",
        "service": all_services[svc],
        "upstream_dependents": upstream,
        "downstream_dependencies": downstream,
        "transitive_downstream_edges": transitive_edges,
        "reachable_services": [all_services[name] for name in sorted(visited)],
    }


def cmd_get_metrics(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {"service": args.service, "window": args.window}
    svc_row = conn.execute("SELECT name FROM services WHERE name = ?", (args.service,)).fetchone()
    if svc_row is None:
        fail_with_audit(conn, "get-metrics", args_dict, "UNKNOWN_SERVICE", f"Unknown service: {args.service}")

    row = conn.execute(
        """
        SELECT service, window, error_rate_pct, p99_latency_ms, rps, extra_json
        FROM metrics WHERE service = ? AND window = ?
        """,
        (args.service, args.window),
    ).fetchone()
    if row is None:
        fail_with_audit(
            conn,
            "get-metrics",
            args_dict,
            "METRICS_NOT_FOUND",
            f"No metrics for service={args.service} window={args.window}",
        )

    append_audit_log(conn, "get-metrics", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "get-metrics",
        "service": row["service"],
        "window": row["window"],
        "error_rate_pct": row["error_rate_pct"],
        "p99_latency_ms": row["p99_latency_ms"],
        "rps": row["rps"],
        "details": json.loads(row["extra_json"]),
    }


def cmd_get_deployments(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {"service": args.service}
    svc_row = conn.execute("SELECT name FROM services WHERE name = ?", (args.service,)).fetchone()
    if svc_row is None:
        fail_with_audit(conn, "get-deployments", args_dict, "UNKNOWN_SERVICE", f"Unknown service: {args.service}")

    rows = conn.execute(
        """
        SELECT deploy_id, service, version, status, deployed_at, minutes_ago, notes
        FROM deployments WHERE service = ? ORDER BY minutes_ago ASC, deploy_id DESC
        """,
        (args.service,),
    ).fetchall()
    append_audit_log(conn, "get-deployments", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "get-deployments",
        "service": args.service,
        "deployments": [dict(r) for r in rows],
    }


def cmd_get_runbook(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {"alert_code": args.alert_code}
    row = conn.execute(
        """
        SELECT runbook_id, alert_code, title, classification, instructions,
               allowed_mutations_json, forbidden_mutations_json, escalation_team
        FROM runbooks WHERE alert_code = ?
        """,
        (args.alert_code,),
    ).fetchone()
    if row is None:
        fail_with_audit(
            conn,
            "get-runbook",
            args_dict,
            "RUNBOOK_NOT_FOUND",
            f"No runbook registered for alert_code={args.alert_code}",
        )

    append_audit_log(conn, "get-runbook", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "get-runbook",
        "runbook_id": row["runbook_id"],
        "alert_code": row["alert_code"],
        "title": row["title"],
        "classification": row["classification"],
        "instructions": row["instructions"],
        "allowed_mutations": json.loads(row["allowed_mutations_json"]),
        "forbidden_mutations": json.loads(row["forbidden_mutations_json"]),
        "escalation_team": row["escalation_team"],
    }


def cmd_create_ticket(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    metadata_obj: dict[str, Any] = {}
    raw_meta = args.metadata_json
    args_dict: dict[str, Any] = {
        "severity": args.severity,
        "service": args.service,
        "title": args.title,
        "root_cause": args.root_cause,
        "alert_id": args.alert_id,
    }
    if raw_meta is not None:
        try:
            parsed = json.loads(raw_meta)
        except json.JSONDecodeError as exc:
            args_dict["metadata_json"] = raw_meta
            fail_with_audit(
                conn,
                "create-ticket",
                args_dict,
                "INVALID_METADATA_JSON",
                f"--metadata-json must be valid JSON: {exc}",
            )
        if not isinstance(parsed, dict):
            args_dict["metadata_json"] = raw_meta
            fail_with_audit(
                conn,
                "create-ticket",
                args_dict,
                "INVALID_METADATA_JSON",
                "--metadata-json must decode to a JSON object",
            )
        metadata_obj = parsed
        args_dict["metadata_json"] = json.dumps(metadata_obj, sort_keys=True, separators=(",", ":"))

    if not args.title.strip():
        fail_with_audit(conn, "create-ticket", args_dict, "EMPTY_TITLE", "--title must not be empty")
    if not args.root_cause.strip():
        fail_with_audit(conn, "create-ticket", args_dict, "EMPTY_ROOT_CAUSE", "--root-cause must not be empty")

    svc_row = conn.execute("SELECT name FROM services WHERE name = ?", (args.service,)).fetchone()
    if svc_row is None:
        fail_with_audit(conn, "create-ticket", args_dict, "UNKNOWN_SERVICE", f"Unknown service: {args.service}")

    alert_row = conn.execute("SELECT alert_id FROM alerts WHERE alert_id = ?", (args.alert_id,)).fetchone()
    if alert_row is None:
        fail_with_audit(conn, "create-ticket", args_dict, "UNKNOWN_ALERT_ID", f"Unknown alert_id: {args.alert_id}")

    count_row = conn.execute("SELECT COUNT(*) AS cnt FROM tickets").fetchone()
    ticket_id = f"INC-{int(count_row['cnt']) + 1:04d}"
    created_at = utc_now_iso()
    canonical_meta = json.dumps(metadata_obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    conn.execute(
        """
        INSERT INTO tickets (ticket_id, severity, service, title, root_cause, alert_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            ticket_id,
            args.severity,
            args.service,
            args.title.strip(),
            args.root_cause.strip(),
            args.alert_id,
            canonical_meta,
            created_at,
        ),
    )
    append_audit_log(conn, "create-ticket", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "create-ticket",
        "ticket": {
            "ticket_id": ticket_id,
            "severity": args.severity,
            "service": args.service,
            "title": args.title.strip(),
            "root_cause": args.root_cause.strip(),
            "alert_id": args.alert_id,
            "metadata": metadata_obj,
            "created_at": created_at,
        },
    }


def cmd_rollback_deploy(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {
        "service": args.service,
        "target_version": args.target_version,
        "reason": args.reason,
    }
    if not args.reason.strip():
        fail_with_audit(conn, "rollback-deploy", args_dict, "EMPTY_REASON", "--reason must not be empty")

    svc_row = conn.execute("SELECT name FROM services WHERE name = ?", (args.service,)).fetchone()
    if svc_row is None:
        fail_with_audit(conn, "rollback-deploy", args_dict, "UNKNOWN_SERVICE", f"Unknown service: {args.service}")

    active_row = conn.execute(
        "SELECT deploy_id, version FROM deployments WHERE service = ? AND status = 'active'",
        (args.service,),
    ).fetchone()
    if active_row is None:
        fail_with_audit(
            conn,
            "rollback-deploy",
            args_dict,
            "NO_ACTIVE_DEPLOYMENT",
            f"Service {args.service} has no active deployment",
        )

    target_row = conn.execute(
        "SELECT deploy_id, version, status FROM deployments WHERE service = ? AND version = ?",
        (args.service, args.target_version),
    ).fetchone()
    if target_row is None:
        fail_with_audit(
            conn,
            "rollback-deploy",
            args_dict,
            "UNKNOWN_TARGET_VERSION",
            f"Version {args.target_version} does not exist in deployment history for {args.service}",
        )
    if target_row["status"] == "active":
        fail_with_audit(
            conn,
            "rollback-deploy",
            args_dict,
            "ALREADY_ACTIVE",
            f"Version {args.target_version} is already active for {args.service}",
        )

    count_row = conn.execute("SELECT COUNT(*) AS cnt FROM rollbacks").fetchone()
    rollback_id = f"RBK-{int(count_row['cnt']) + 1:04d}"
    executed_at = utc_now_iso()
    from_version = str(active_row["version"])

    conn.execute(
        "UPDATE deployments SET status = 'rolled_back' WHERE deploy_id = ?",
        (active_row["deploy_id"],),
    )
    conn.execute(
        "UPDATE deployments SET status = 'active' WHERE deploy_id = ?",
        (target_row["deploy_id"],),
    )
    conn.execute(
        """
        INSERT INTO rollbacks (rollback_id, service, from_version, target_version, reason, executed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (rollback_id, args.service, from_version, args.target_version, args.reason.strip(), executed_at),
    )
    append_audit_log(conn, "rollback-deploy", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "rollback-deploy",
        "rollback": {
            "rollback_id": rollback_id,
            "service": args.service,
            "from_version": from_version,
            "target_version": args.target_version,
            "reason": args.reason.strip(),
            "executed_at": executed_at,
        },
    }


def cmd_notify_oncall(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    args_dict = {
        "team": args.team,
        "severity": args.severity,
        "message": args.message,
        "ticket_id": args.ticket_id,
    }
    if not args.team.strip():
        fail_with_audit(conn, "notify-oncall", args_dict, "EMPTY_TEAM", "--team must not be empty")
    if not args.message.strip():
        fail_with_audit(conn, "notify-oncall", args_dict, "EMPTY_MESSAGE", "--message must not be empty")

    ticket_row = conn.execute(
        "SELECT ticket_id FROM tickets WHERE ticket_id = ?",
        (args.ticket_id,),
    ).fetchone()
    if ticket_row is None:
        fail_with_audit(
            conn,
            "notify-oncall",
            args_dict,
            "UNKNOWN_TICKET_ID",
            f"Ticket {args.ticket_id} does not exist; create a ticket before paging on-call",
        )

    count_row = conn.execute("SELECT COUNT(*) AS cnt FROM notifications").fetchone()
    notification_id = f"NTF-{int(count_row['cnt']) + 1:04d}"
    sent_at = utc_now_iso()

    conn.execute(
        """
        INSERT INTO notifications (notification_id, team, severity, message, ticket_id, sent_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (notification_id, args.team.strip(), args.severity, args.message.strip(), args.ticket_id, sent_at),
    )
    append_audit_log(conn, "notify-oncall", args_dict, result_ok=True)
    conn.commit()
    return {
        "ok": True,
        "command": "notify-oncall",
        "notification": {
            "notification_id": notification_id,
            "team": args.team.strip(),
            "severity": args.severity,
            "message": args.message.strip(),
            "ticket_id": args.ticket_id,
            "sent_at": sent_at,
        },
    }


def build_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(
        prog="opsctl.py",
        description="Incident operations CLI with audited state persistence.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_alerts = sub.add_parser("list-alerts", help="List active or all alerts.")
    p_alerts.add_argument("--status", choices=["open", "all"], default="open")

    p_graph = sub.add_parser("get-service-graph", help="Inspect service dependency topology.")
    p_graph.add_argument("--service", default=None)

    p_metrics = sub.add_parser("get-metrics", help="Fetch service error/latency/operational metrics.")
    p_metrics.add_argument("--service", required=True)
    p_metrics.add_argument("--window", choices=["15m", "1h"], default="15m")

    p_deploys = sub.add_parser("get-deployments", help="Inspect deployment history for a service.")
    p_deploys.add_argument("--service", required=True)

    p_runbook = sub.add_parser("get-runbook", help="Fetch operational runbook for an alert code.")
    p_runbook.add_argument("--alert-code", required=True)

    p_ticket = sub.add_parser("create-ticket", help="Create an incident or follow-up ticket.")
    p_ticket.add_argument("--severity", choices=["P1", "P2", "P3"], required=True)
    p_ticket.add_argument("--service", required=True)
    p_ticket.add_argument("--title", required=True)
    p_ticket.add_argument("--root-cause", required=True)
    p_ticket.add_argument("--alert-id", required=True)
    p_ticket.add_argument("--metadata-json", default=None)

    p_rollback = sub.add_parser("rollback-deploy", help="Roll back a service deployment to a prior version.")
    p_rollback.add_argument("--service", required=True)
    p_rollback.add_argument("--target-version", required=True)
    p_rollback.add_argument("--reason", required=True)

    p_notify = sub.add_parser("notify-oncall", help="Page an on-call team for an incident ticket.")
    p_notify.add_argument("--team", required=True)
    p_notify.add_argument("--severity", choices=["P1", "P2", "P3"], required=True)
    p_notify.add_argument("--message", required=True)
    p_notify.add_argument("--ticket-id", required=True)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    conn = connect_db()
    try:
        dispatch = {
            "list-alerts": cmd_list_alerts,
            "get-service-graph": cmd_get_service_graph,
            "get-metrics": cmd_get_metrics,
            "get-deployments": cmd_get_deployments,
            "get-runbook": cmd_get_runbook,
            "create-ticket": cmd_create_ticket,
            "rollback-deploy": cmd_rollback_deploy,
            "notify-oncall": cmd_notify_oncall,
        }
        result = dispatch[args.command](conn, args)
    finally:
        conn.close()
    emit_json(result, exit_code=0)


if __name__ == "__main__":
    main()
