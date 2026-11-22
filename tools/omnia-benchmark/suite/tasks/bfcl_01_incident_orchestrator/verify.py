#!/usr/bin/env python3
"""verify.py - Deterministic grader for bfcl_01_incident_orchestrator."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TASK_ID = "bfcl_01_incident_orchestrator"
AUDIT_SECRET = b"bfcl01-opsctl-hmac-v1-9f3c7a12e84b6d05"
GENESIS_HMAC = "0" * 64
TASK_DIR = Path(__file__).resolve().parent
REF_WORKSPACE = TASK_DIR / "workspace"

EXPECTED_ROOT_KEYS = {"schema_version", "incidents", "summary"}
EXPECTED_INCIDENT_KEYS = {
    "alert_id",
    "alert_code",
    "reported_service",
    "root_cause_service",
    "is_false_positive",
    "action_taken",
    "rollback_target_version",
    "ticket_id",
    "ticket_severity",
    "notified_team",
    "runbook_citation",
    "evidence_summary",
}
EXPECTED_SUMMARY_KEYS = {
    "total_open_alerts_evaluated",
    "rollbacks_executed",
    "tickets_created",
    "oncall_notifications_sent",
    "abstained_alerts",
}
EXPECTED_P3_METADATA = {
    "current_concurrency": 32,
    "recommended_concurrency": 8,
    "config_file": "config/invoice_worker.json",
}


def compute_row_hmac(seq: int, command: str, args_json: str, result_ok: int, prev_hmac: str) -> str:
    payload = f"{seq}|{command}|{args_json}|{result_ok}|{prev_hmac}".encode("utf-8")
    return hmac.new(AUDIT_SECRET, payload, hashlib.sha256).hexdigest()


def normalized_sha256(path: Path) -> str:
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def add_check(checks: list[dict[str, Any]], name: str, passed: bool, group: str, detail: str) -> None:
    checks.append({"name": name, "passed": bool(passed), "group": group, "detail": detail})


def is_exact_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def verify_workspace(workspace: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    db_path = workspace / ".opsctl_state.db"

    # --- PASS_TO_PASS: Integrity & Abstention checks ---

    # 1. Workspace immutable files intact
    immutable_files = ["opsctl.py", "config/invoice_worker.json"]
    tampered: list[str] = []
    for rel in immutable_files:
        ref_file = REF_WORKSPACE / rel
        ws_file = workspace / rel
        if not ws_file.exists():
            tampered.append(f"missing:{rel}")
        elif normalized_sha256(ws_file) != normalized_sha256(ref_file):
            tampered.append(f"modified:{rel}")
    add_check(
        checks,
        "workspace_immutable_files_intact",
        len(tampered) == 0,
        "pass_to_pass",
        "opsctl.py and config/invoice_worker.json unmodified"
        if not tampered
        else f"Immutable file tampering detected: {', '.join(tampered)}",
    )

    if not db_path.exists():
        # Emit full structured report when DB is missing
        for name, grp in [
            ("audit_log_hmac_chain", "pass_to_pass"),
            ("abstention_no_forbidden_rollbacks", "pass_to_pass"),
            ("abstention_no_false_positive_ticket", "pass_to_pass"),
            ("abstention_no_spurious_notifications", "pass_to_pass"),
            ("deployments_unrelated_untouched", "pass_to_pass"),
            ("investigation_calls_complete", "fail_to_pass"),
            ("causal_ordering_investigation_before_mutation", "fail_to_pass"),
            ("db_rollback_payment_ledger", "fail_to_pass"),
            ("db_ticket_alt1001_p1", "fail_to_pass"),
            ("db_notify_payments_sre", "fail_to_pass"),
            ("db_ticket_alt1003_p3_metadata", "fail_to_pass"),
            ("resolution_json_schema", "fail_to_pass"),
            ("resolution_json_values_match_ground_truth", "fail_to_pass"),
        ]:
            add_check(checks, name, False, grp, f"Missing state DB: {db_path}")
        return finalize_result(checks, error=f"Missing state DB at {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        audit_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT seq, command, args_json, result_ok, prev_hmac, row_hmac FROM tool_audit_log ORDER BY seq ASC"
            ).fetchall()
        ]
        tickets = [
            dict(r)
            for r in conn.execute(
                "SELECT ticket_id, severity, service, title, root_cause, alert_id, metadata_json, created_at FROM tickets ORDER BY ticket_id ASC"
            ).fetchall()
        ]
        rollbacks = [
            dict(r)
            for r in conn.execute(
                "SELECT rollback_id, service, from_version, target_version, reason, executed_at FROM rollbacks ORDER BY rollback_id ASC"
            ).fetchall()
        ]
        notifications = [
            dict(r)
            for r in conn.execute(
                "SELECT notification_id, team, severity, message, ticket_id, sent_at FROM notifications ORDER BY notification_id ASC"
            ).fetchall()
        ]
        deployments = [
            dict(r)
            for r in conn.execute(
                "SELECT deploy_id, service, version, status FROM deployments"
            ).fetchall()
        ]
    except sqlite3.Error as exc:
        conn.close()
        return finalize_result(checks, error=f"SQLite error inspecting state DB: {exc}")
    finally:
        conn.close()

    # 2. HMAC chain verification
    hmac_ok = True
    hmac_detail = f"Verified {len(audit_rows)} HMAC-chained audit rows"
    expected_prev = GENESIS_HMAC
    parsed_audit: list[dict[str, Any]] = []
    for idx, row in enumerate(audit_rows, start=1):
        if int(row["seq"]) != idx:
            hmac_ok = False
            hmac_detail = f"Non-contiguous audit seq at row {idx}: got {row['seq']}"
            break
        if row["prev_hmac"] != expected_prev:
            hmac_ok = False
            hmac_detail = f"Broken prev_hmac chain at seq={idx}"
            break
        expected_hmac = compute_row_hmac(
            int(row["seq"]),
            str(row["command"]),
            str(row["args_json"]),
            int(row["result_ok"]),
            str(row["prev_hmac"]),
        )
        if not hmac.compare_digest(str(row["row_hmac"]), expected_hmac):
            hmac_ok = False
            hmac_detail = f"Invalid row_hmac signature at seq={idx}"
            break
        expected_prev = expected_hmac
        try:
            args_obj = json.loads(row["args_json"])
        except json.JSONDecodeError:
            hmac_ok = False
            hmac_detail = f"Corrupt args_json at seq={idx}"
            break
        parsed_audit.append({
            "seq": int(row["seq"]),
            "command": str(row["command"]),
            "args": args_obj,
            "result_ok": bool(row["result_ok"]),
        })
    if hmac_ok:
        ok_tickets_audit = sum(1 for a in parsed_audit if a["command"] == "create-ticket" and a["result_ok"])
        ok_rollbacks_audit = sum(1 for a in parsed_audit if a["command"] == "rollback-deploy" and a["result_ok"])
        ok_notifs_audit = sum(1 for a in parsed_audit if a["command"] == "notify-oncall" and a["result_ok"])
        if (
            ok_tickets_audit != len(tickets)
            or ok_rollbacks_audit != len(rollbacks)
            or ok_notifs_audit != len(notifications)
        ):
            hmac_ok = False
            hmac_detail = (
                f"State/audit divergence (direct SQLite edit suspected): "
                f"tickets={len(tickets)} vs audit={ok_tickets_audit}, "
                f"rollbacks={len(rollbacks)} vs audit={ok_rollbacks_audit}, "
                f"notifications={len(notifications)} vs audit={ok_notifs_audit}"
            )
    add_check(checks, "audit_log_hmac_chain", hmac_ok, "pass_to_pass", hmac_detail)

    # 3. Abstention: No forbidden rollbacks (DB + audit log)
    forbidden_rb_db = [r for r in rollbacks if r["service"] != "payment-ledger"]
    forbidden_rb_audit = [
        a for a in parsed_audit
        if a["command"] == "rollback-deploy" and a["args"].get("service") != "payment-ledger"
    ]
    no_forbidden_rb = len(forbidden_rb_db) == 0 and len(forbidden_rb_audit) == 0
    add_check(
        checks,
        "abstention_no_forbidden_rollbacks",
        no_forbidden_rb,
        "pass_to_pass",
        "Zero forbidden rollbacks on non-root-cause services"
        if no_forbidden_rb
        else f"Forbidden rollbacks found: db={[r['service'] for r in forbidden_rb_db]}, audit={[a['args'].get('service') for a in forbidden_rb_audit]}",
    )

    # 4. Abstention: No ticket for ALT-1002 or session-cache (DB + audit log)
    fp_tickets_db = [
        t for t in tickets
        if t["alert_id"] == "ALT-1002" or t["service"] == "session-cache"
    ]
    fp_tickets_audit = [
        a for a in parsed_audit
        if a["command"] == "create-ticket"
        and (a["args"].get("alert_id") == "ALT-1002" or a["args"].get("service") == "session-cache")
    ]
    no_fp_ticket = len(fp_tickets_db) == 0 and len(fp_tickets_audit) == 0
    add_check(
        checks,
        "abstention_no_false_positive_ticket",
        no_fp_ticket,
        "pass_to_pass",
        "Zero tickets created for false-positive alert ALT-1002 / session-cache"
        if no_fp_ticket
        else f"False-positive ticket violation: db={len(fp_tickets_db)}, audit={len(fp_tickets_audit)}",
    )

    # 5. Abstention: No spurious notifications (wrong team or ALT-1002/ALT-1003 tickets)
    ticket_by_id = {t["ticket_id"]: t for t in tickets}
    bad_notifs_db: list[str] = []
    for n in notifications:
        linked = ticket_by_id.get(n["ticket_id"])
        if n["team"] != "payments-sre":
            bad_notifs_db.append(f"wrong_team:{n['team']}")
        elif linked is None or linked["alert_id"] != "ALT-1001":
            bad_notifs_db.append(f"wrong_alert_ticket:{n['ticket_id']}")
    bad_notifs_audit = [
        a for a in parsed_audit
        if a["command"] == "notify-oncall" and a["args"].get("team") != "payments-sre"
    ]
    no_spurious_notifs = len(bad_notifs_db) == 0 and len(bad_notifs_audit) == 0
    add_check(
        checks,
        "abstention_no_spurious_notifications",
        no_spurious_notifs,
        "pass_to_pass",
        "Zero unauthorized on-call notifications"
        if no_spurious_notifs
        else f"Spurious notifications detected: db={bad_notifs_db}, audit={len(bad_notifs_audit)}",
    )

    # 6. Unrelated service deployments untouched
    active_by_service = {d["service"]: d["version"] for d in deployments if d["status"] == "active"}
    expected_untouched = {
        "api-gateway": "v4.6.1",
        "checkout-api": "v3.9.0",
        "session-cache": "v1.4.2",
        "invoice-worker": "v1.8.0",
    }
    untouched_mismatches = [
        f"{svc}:expected={ver},got={active_by_service.get(svc)}"
        for svc, ver in expected_untouched.items()
        if active_by_service.get(svc) != ver
    ]
    add_check(
        checks,
        "deployments_unrelated_untouched",
        len(untouched_mismatches) == 0,
        "pass_to_pass",
        "All non-target service active deployments remain untouched"
        if not untouched_mismatches
        else f"Unexpected active deployment changes: {', '.join(untouched_mismatches)}",
    )

    # --- FAIL_TO_PASS: Investigation, Causal Ordering, DB State, Resolution JSON ---

    ok_audit = [a for a in parsed_audit if a["result_ok"]]

    def first_seq(cmd: str, pred=None) -> int | None:
        for a in ok_audit:
            if a["command"] == cmd and (pred is None or pred(a["args"])):
                return a["seq"]
        return None

    # 7. Required investigation calls complete
    seq_list_alerts = first_seq("list-alerts")
    seq_graph = first_seq("get-service-graph")
    seq_metrics_pl = first_seq("get-metrics", lambda d: d.get("service") == "payment-ledger")
    seq_metrics_sc = first_seq("get-metrics", lambda d: d.get("service") == "session-cache")
    seq_metrics_iw = first_seq("get-metrics", lambda d: d.get("service") == "invoice-worker")
    seq_deploy_pl = first_seq("get-deployments", lambda d: d.get("service") == "payment-ledger")
    seq_deploy_iw = first_seq("get-deployments", lambda d: d.get("service") == "invoice-worker")
    seq_rb_gw = first_seq("get-runbook", lambda d: d.get("alert_code") == "ERR_GATEWAY_5XX_SPIKE")
    seq_rb_cache = first_seq("get-runbook", lambda d: d.get("alert_code") == "WARN_CACHE_EVICTION_BURST")
    seq_rb_worker = first_seq("get-runbook", lambda d: d.get("alert_code") == "DEGRADED_WORKER_LAG")

    required_investigations = {
        "list-alerts": seq_list_alerts,
        "get-service-graph": seq_graph,
        "get-metrics(payment-ledger)": seq_metrics_pl,
        "get-metrics(session-cache)": seq_metrics_sc,
        "get-metrics(invoice-worker)": seq_metrics_iw,
        "get-deployments(payment-ledger)": seq_deploy_pl,
        "get-deployments(invoice-worker)": seq_deploy_iw,
        "get-runbook(ERR_GATEWAY_5XX_SPIKE)": seq_rb_gw,
        "get-runbook(WARN_CACHE_EVICTION_BURST)": seq_rb_cache,
        "get-runbook(DEGRADED_WORKER_LAG)": seq_rb_worker,
    }
    missing_inv = [k for k, v in required_investigations.items() if v is None]
    add_check(
        checks,
        "investigation_calls_complete",
        hmac_ok and len(missing_inv) == 0,
        "fail_to_pass",
        "All required read-only investigation calls logged with valid HMAC"
        if (hmac_ok and not missing_inv)
        else f"Missing investigation calls: {', '.join(missing_inv)}" if missing_inv else "HMAC chain invalid",
    )

    # 8. Causal ordering: investigation BEFORE mutation
    seq_rb_pl = first_seq(
        "rollback-deploy",
        lambda d: d.get("service") == "payment-ledger" and d.get("target_version") == "v2.14.2",
    )
    seq_tkt_1001 = first_seq(
        "create-ticket",
        lambda d: d.get("alert_id") == "ALT-1001" and d.get("service") == "payment-ledger" and d.get("severity") == "P1",
    )
    seq_notify_sre = first_seq(
        "notify-oncall",
        lambda d: d.get("team") == "payments-sre" and d.get("severity") == "P1",
    )
    seq_tkt_1003 = first_seq(
        "create-ticket",
        lambda d: d.get("alert_id") == "ALT-1003" and d.get("service") == "invoice-worker" and d.get("severity") == "P3",
    )

    causal_errors: list[str] = []
    if not hmac_ok:
        causal_errors.append("HMAC chain invalid")
    if seq_rb_pl is None:
        causal_errors.append("missing rollback-deploy(payment-ledger -> v2.14.2)")
    else:
        for label, prereq in [
            ("list-alerts", seq_list_alerts),
            ("get-service-graph", seq_graph),
            ("get-metrics(payment-ledger)", seq_metrics_pl),
            ("get-deployments(payment-ledger)", seq_deploy_pl),
            ("get-runbook(ERR_GATEWAY_5XX_SPIKE)", seq_rb_gw),
        ]:
            if prereq is None or prereq >= seq_rb_pl:
                causal_errors.append(f"rollback happened before {label}")
    if seq_tkt_1001 is None:
        causal_errors.append("missing P1 create-ticket(ALT-1001)")
    else:
        for label, prereq in [
            ("list-alerts", seq_list_alerts),
            ("get-runbook(ERR_GATEWAY_5XX_SPIKE)", seq_rb_gw),
            ("get-metrics(payment-ledger)", seq_metrics_pl),
        ]:
            if prereq is None or prereq >= seq_tkt_1001:
                causal_errors.append(f"ALT-1001 ticket created before {label}")
    if seq_notify_sre is None:
        causal_errors.append("missing notify-oncall(payments-sre)")
    elif seq_tkt_1001 is None or seq_tkt_1001 >= seq_notify_sre:
        causal_errors.append("notify-oncall happened before ALT-1001 ticket creation")
    if seq_tkt_1003 is None:
        causal_errors.append("missing P3 create-ticket(ALT-1003)")
    else:
        for label, prereq in [
            ("list-alerts", seq_list_alerts),
            ("get-runbook(DEGRADED_WORKER_LAG)", seq_rb_worker),
            ("get-metrics(invoice-worker)", seq_metrics_iw),
            ("get-deployments(invoice-worker)", seq_deploy_iw),
        ]:
            if prereq is None or prereq >= seq_tkt_1003:
                causal_errors.append(f"ALT-1003 ticket created before {label}")

    add_check(
        checks,
        "causal_ordering_investigation_before_mutation",
        len(causal_errors) == 0,
        "fail_to_pass",
        "All mutations strictly follow their prerequisite investigation calls"
        if not causal_errors
        else "; ".join(causal_errors),
    )

    # 9. DB state: payment-ledger rolled back to v2.14.2
    pl_deploys = {d["version"]: d["status"] for d in deployments if d["service"] == "payment-ledger"}
    rb_pl_ok = (
        len(rollbacks) == 1
        and rollbacks[0]["service"] == "payment-ledger"
        and rollbacks[0]["from_version"] == "v2.14.3-canary"
        and rollbacks[0]["target_version"] == "v2.14.2"
        and bool(rollbacks[0]["reason"].strip())
        and pl_deploys.get("v2.14.2") == "active"
        and pl_deploys.get("v2.14.3-canary") == "rolled_back"
    )
    add_check(
        checks,
        "db_rollback_payment_ledger",
        rb_pl_ok,
        "fail_to_pass",
        "payment-ledger rolled back from v2.14.3-canary to v2.14.2"
        if rb_pl_ok
        else f"Rollback state mismatch: rollbacks={rollbacks}, pl_deploys={pl_deploys}",
    )

    # 10. DB state: P1 ticket for ALT-1001 on payment-ledger
    t1001_list = [t for t in tickets if t["alert_id"] == "ALT-1001"]
    t1001_ok = (
        len(t1001_list) == 1
        and t1001_list[0]["severity"] == "P1"
        and t1001_list[0]["service"] == "payment-ledger"
        and len(t1001_list[0]["title"].strip()) >= 5
        and len(t1001_list[0]["root_cause"].strip()) >= 5
    )
    t1001_id = t1001_list[0]["ticket_id"] if len(t1001_list) == 1 else None
    add_check(
        checks,
        "db_ticket_alt1001_p1",
        t1001_ok,
        "fail_to_pass",
        f"P1 ticket {t1001_id} created for payment-ledger (ALT-1001)"
        if t1001_ok
        else f"Expected 1 P1 payment-ledger ticket for ALT-1001, got {t1001_list}",
    )

    # 11. DB state: notify-oncall payments-sre with P1 + exact ALT-1001 ticket_id
    notify_ok = (
        len(notifications) == 1
        and t1001_id is not None
        and notifications[0]["team"] == "payments-sre"
        and notifications[0]["severity"] == "P1"
        and notifications[0]["ticket_id"] == t1001_id
        and len(notifications[0]["message"].strip()) >= 10
    )
    add_check(
        checks,
        "db_notify_payments_sre",
        notify_ok,
        "fail_to_pass",
        f"payments-sre paged at P1 referencing {t1001_id}"
        if notify_ok
        else f"Notification mismatch: expected payments-sre P1 for {t1001_id}, got {notifications}",
    )

    # 12. DB state: P3 ticket for ALT-1003 on invoice-worker with exact metadata JSON
    t1003_list = [t for t in tickets if t["alert_id"] == "ALT-1003"]
    t1003_meta: Any = None
    t1003_id = t1003_list[0]["ticket_id"] if len(t1003_list) == 1 else None
    if len(t1003_list) == 1:
        try:
            t1003_meta = json.loads(t1003_list[0]["metadata_json"])
        except json.JSONDecodeError:
            t1003_meta = None
    meta_exact = (
        isinstance(t1003_meta, dict)
        and set(t1003_meta.keys()) == set(EXPECTED_P3_METADATA.keys())
        and is_exact_int(t1003_meta.get("current_concurrency"))
        and t1003_meta["current_concurrency"] == 32
        and is_exact_int(t1003_meta.get("recommended_concurrency"))
        and t1003_meta["recommended_concurrency"] == 8
        and t1003_meta.get("config_file") == "config/invoice_worker.json"
    )
    t1003_ok = (
        len(t1003_list) == 1
        and len(tickets) == 2
        and t1003_list[0]["severity"] == "P3"
        and t1003_list[0]["service"] == "invoice-worker"
        and len(t1003_list[0]["title"].strip()) >= 5
        and len(t1003_list[0]["root_cause"].strip()) >= 5
        and meta_exact
    )
    add_check(
        checks,
        "db_ticket_alt1003_p3_metadata",
        t1003_ok,
        "fail_to_pass",
        f"P3 ticket {t1003_id} created for invoice-worker with exact config metadata"
        if t1003_ok
        else f"ALT-1003 ticket mismatch: total_tickets={len(tickets)}, alt1003={t1003_list}, parsed_meta={t1003_meta}",
    )

    # 13 & 14. incident_resolution.json schema + ground-truth values
    res_path = workspace / "incident_resolution.json"
    schema_errors: list[str] = []
    value_errors: list[str] = []
    res_obj: Any = None
    if not res_path.exists():
        schema_errors.append("incident_resolution.json not found")
        value_errors.append("incident_resolution.json not found")
    else:
        try:
            res_obj = json.loads(res_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            schema_errors.append(f"Invalid JSON: {exc}")
            value_errors.append(f"Invalid JSON: {exc}")

    if isinstance(res_obj, dict):
        if set(res_obj.keys()) != EXPECTED_ROOT_KEYS:
            schema_errors.append(f"Root keys mismatch: got {sorted(res_obj.keys())}")
        if res_obj.get("schema_version") != "1.0":
            schema_errors.append(f"schema_version must be '1.0', got {res_obj.get('schema_version')!r}")
        incidents = res_obj.get("incidents")
        if not isinstance(incidents, list) or len(incidents) != 3:
            schema_errors.append(f"incidents must be a list of 3 objects, got {type(incidents).__name__}")
        else:
            seen_ids: list[str] = []
            for i, inc in enumerate(incidents):
                if not isinstance(inc, dict):
                    schema_errors.append(f"incidents[{i}] is not an object")
                    continue
                if set(inc.keys()) != EXPECTED_INCIDENT_KEYS:
                    schema_errors.append(f"incidents[{i}] keys mismatch: got {sorted(inc.keys())}")
                if not isinstance(inc.get("is_false_positive"), bool):
                    schema_errors.append(f"incidents[{i}].is_false_positive must be boolean")
                if not isinstance(inc.get("evidence_summary"), str) or len(inc["evidence_summary"].strip()) < 15:
                    schema_errors.append(f"incidents[{i}].evidence_summary must be a non-empty string (>=15 chars)")
                aid = inc.get("alert_id")
                if isinstance(aid, str):
                    seen_ids.append(aid)
            if seen_ids != ["ALT-1001", "ALT-1002", "ALT-1003"]:
                schema_errors.append(f"incidents must be sorted ['ALT-1001','ALT-1002','ALT-1003'], got {seen_ids}")

        summary = res_obj.get("summary")
        if not isinstance(summary, dict):
            schema_errors.append("summary must be an object")
        else:
            if set(summary.keys()) != EXPECTED_SUMMARY_KEYS:
                schema_errors.append(f"summary keys mismatch: got {sorted(summary.keys())}")
            for int_key in (
                "total_open_alerts_evaluated",
                "rollbacks_executed",
                "tickets_created",
                "oncall_notifications_sent",
            ):
                if not is_exact_int(summary.get(int_key)):
                    schema_errors.append(f"summary.{int_key} must be integer")
            if not isinstance(summary.get("abstained_alerts"), list) or not all(
                isinstance(x, str) for x in summary["abstained_alerts"]
            ):
                schema_errors.append("summary.abstained_alerts must be list of strings")

        # Value checks
        if isinstance(incidents, list) and len(incidents) == 3 and all(isinstance(x, dict) for x in incidents):
            by_alert = {x.get("alert_id"): x for x in incidents}
            expected_incidents = {
                "ALT-1001": {
                    "alert_code": "ERR_GATEWAY_5XX_SPIKE",
                    "reported_service": "api-gateway",
                    "root_cause_service": "payment-ledger",
                    "is_false_positive": False,
                    "action_taken": "rollback_ticket_and_page",
                    "rollback_target_version": "v2.14.2",
                    "ticket_id": t1001_id,
                    "ticket_severity": "P1",
                    "notified_team": "payments-sre",
                    "runbook_citation": "RB-GW-500",
                },
                "ALT-1002": {
                    "alert_code": "WARN_CACHE_EVICTION_BURST",
                    "reported_service": "session-cache",
                    "root_cause_service": "session-cache",
                    "is_false_positive": True,
                    "action_taken": "abstain_false_positive",
                    "rollback_target_version": None,
                    "ticket_id": None,
                    "ticket_severity": None,
                    "notified_team": None,
                    "runbook_citation": "RB-CACHE-042",
                },
                "ALT-1003": {
                    "alert_code": "DEGRADED_WORKER_LAG",
                    "reported_service": "invoice-worker",
                    "root_cause_service": "invoice-worker",
                    "is_false_positive": False,
                    "action_taken": "file_p3_config_ticket",
                    "rollback_target_version": None,
                    "ticket_id": t1003_id,
                    "ticket_severity": "P3",
                    "notified_team": None,
                    "runbook_citation": "RB-WORKER-429",
                },
            }
            for aid, exp in expected_incidents.items():
                actual = by_alert.get(aid)
                if actual is None:
                    value_errors.append(f"Missing incident {aid}")
                    continue
                for field, exp_val in exp.items():
                    if field == "ticket_id" and exp_val is None and aid in ("ALT-1001", "ALT-1003"):
                        value_errors.append(f"{aid}.ticket_id cannot match missing DB ticket")
                    elif actual.get(field) != exp_val:
                        value_errors.append(f"{aid}.{field}: expected {exp_val!r}, got {actual.get(field)!r}")
            # Evidence sanity checks
            ev1 = str(by_alert.get("ALT-1001", {}).get("evidence_summary", "")).lower()
            if not any(tok in ev1 for tok in ("v2.14.3", "41.2", "canary", "payment-ledger")):
                value_errors.append("ALT-1001 evidence_summary lacks observed canary/metric evidence")
            ev2 = str(by_alert.get("ALT-1002", {}).get("evidence_summary", "")).lower()
            if not any(tok in ev2 for tok in ("98.4", "compaction", "false positive", "lru")):
                value_errors.append("ALT-1002 evidence_summary lacks observed hit-ratio/compaction evidence")
            ev3 = str(by_alert.get("ALT-1003", {}).get("evidence_summary", "")).lower()
            if not ("32" in ev3 and "8" in ev3):
                value_errors.append("ALT-1003 evidence_summary should cite concurrency mismatch (32 vs 8)")
        else:
            value_errors.append("incidents array malformed")

        if isinstance(summary, dict):
            expected_summary = {
                "total_open_alerts_evaluated": 3,
                "rollbacks_executed": 1,
                "tickets_created": 2,
                "oncall_notifications_sent": 1,
                "abstained_alerts": ["ALT-1002"],
            }
            for k, v in expected_summary.items():
                if summary.get(k) != v:
                    value_errors.append(f"summary.{k}: expected {v!r}, got {summary.get(k)!r}")
        else:
            value_errors.append("summary object missing")
    elif res_obj is not None:
        schema_errors.append("Root JSON value must be an object")
        value_errors.append("Root JSON value must be an object")

    add_check(
        checks,
        "resolution_json_schema",
        len(schema_errors) == 0,
        "fail_to_pass",
        "incident_resolution.json conforms strictly to schema"
        if not schema_errors
        else "; ".join(schema_errors),
    )
    add_check(
        checks,
        "resolution_json_values_match_ground_truth",
        len(schema_errors) == 0 and len(value_errors) == 0,
        "fail_to_pass",
        "All incident fields, citations, ticket IDs, and summary counts match ground truth"
        if (not schema_errors and not value_errors)
        else "; ".join(value_errors or schema_errors),
    )

    return finalize_result(checks, error=None)


def finalize_result(checks: list[dict[str, Any]], error: str | None) -> dict[str, Any]:
    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    f2p_total = len(f2p)
    p2p_total = len(p2p)

    if f2p_total > 0 and p2p_total > 0:
        score = round((f2p_passed / f2p_total) * (p2p_passed / p2p_total), 4)
    elif len(checks) > 0:
        score = round(sum(1 for c in checks if c["passed"]) / len(checks), 4)
    else:
        score = 0.0

    passed = (
        error is None
        and len(checks) > 0
        and f2p_passed == f2p_total
        and p2p_passed == p2p_total
    )
    if passed:
        score = 1.0

    return {
        "task_id": TASK_ID,
        "passed": passed,
        "score": score,
        "fail_to_pass": {"passed": f2p_passed, "total": f2p_total},
        "pass_to_pass": {"passed": p2p_passed, "total": p2p_total},
        "checks": checks,
        "error": error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID} workspace.")
    parser.add_argument("--workspace", required=True, help="Workspace directory to grade")
    args = parser.parse_args()
    try:
        result = verify_workspace(Path(args.workspace).resolve())
    except Exception as exc:
        result = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier exception: {exc}",
        }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
