"""SQLite storage probe for Omnia schema v19 native continuation roots.

The JSON probes in ``verify-run-control-schema.py`` and
``verify-run-control-contract.py`` prove the portable envelope contract.  This
probe exercises the checked-in SQLite DDL as a real database and catches a
different class of regressions: a missing v15/v16/v17 object, a broken
foreign-key scope guard, duplicate receipt acceptance, mutable audit rows,
invalid continuation roots, dependency cycles, or data that is lost after
close/reopen.

This is deliberately a storage/DDL probe.  It does not claim that the Rust
native migrator, Tauri IPC commands, provider gateway, or packaged Windows
runtime compiled or executed; those require the native toolchain and their own
integration gate.

Run from the repository root with::

    python scripts/verify-run-control-storage.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "docs" / "storage-schema.sql"
V15_MARKER = "-- Omnia schema v15: durable run-control resolutions, checkpoints,"
V16_MARKER = "-- Omnia schema v16: authoritative goals, tasks, and starter workflows."
V17_MARKER = "-- Omnia schema v17: authoritative-root state-anchor stream guards."
V18_MARKER = "-- Omnia schema v18: immutable authoritative-root mutation receipts."
V19_MARKER = "-- Omnia schema v19: terminal task dependency insertion guards."
V20_MARKER = "-- Omnia schema v20: immutable provider-definition revisions."

EXPECTED_TABLES = {
    "run_control_operations",
    "run_control_operation_events",
    "run_checkpoints",
    "continuation_intents",
    "message_revisions",
}
EXPECTED_INDEXES = {
    "run_control_operations_idempotency_idx",
    "run_control_operations_scope_idx",
    "run_control_operation_events_lookup_idx",
    "run_checkpoints_idempotency_idx",
    "run_checkpoints_run_idx",
    "run_checkpoints_scope_idx",
    "continuation_intents_idempotency_idx",
    "continuation_intents_scope_idx",
    "message_revisions_idempotency_idx",
    "message_revisions_message_idx",
    "message_revisions_scope_idx",
}
EXPECTED_TRIGGERS = {
    "run_control_operations_scope_guard_insert",
    "run_control_operations_immutable_update",
    "run_control_operations_immutable_delete",
    "run_control_operation_events_immutable_update",
    "run_control_operation_events_immutable_delete",
    "run_checkpoints_scope_guard_insert",
    "run_checkpoints_immutable_update",
    "run_checkpoints_immutable_delete",
    "continuation_intents_scope_guard_insert",
    "continuation_intents_immutable_update",
    "continuation_intents_immutable_delete",
    "message_revisions_scope_guard_insert",
    "message_revisions_immutable_update",
    "message_revisions_immutable_delete",
    "goals_scope_guard_insert",
    "goals_current_revision_insert_guard",
    "goals_scope_guard_update",
    "goals_current_revision_guard",
    "goals_immutable_delete_guard",
    "goal_revisions_scope_guard_insert",
    "goal_revisions_immutable_update",
    "goal_revisions_immutable_delete",
    "tasks_scope_guard_insert",
    "tasks_current_revision_insert_guard",
    "tasks_scope_guard_update",
    "tasks_current_revision_guard",
    "tasks_immutable_delete_guard",
    "task_revisions_scope_guard_insert",
    "task_revisions_immutable_update",
    "task_revisions_immutable_delete",
    "task_dependencies_scope_guard_insert",
    "task_dependencies_immutable_update",
    "task_dependencies_immutable_delete",
    "starter_workflows_scope_guard_insert",
    "starter_workflows_current_revision_insert_guard",
    "starter_workflows_scope_guard_update",
    "starter_workflows_current_revision_guard",
    "starter_workflows_immutable_delete_guard",
    "starter_workflow_revisions_scope_guard_insert",
    "starter_workflow_revisions_immutable_update",
    "starter_workflow_revisions_immutable_delete",
}

EXPECTED_V16_TABLES = {
    "goals",
    "goal_revisions",
    "tasks",
    "task_revisions",
    "task_dependencies",
    "starter_workflows",
    "starter_workflow_revisions",
}

EXPECTED_V16_INDEXES = {
    "goals_profile_idx",
    "goals_project_idx",
    "goals_conversation_idx",
    "goals_revision_idx",
    "goals_state_revision_idx",
    "goal_revisions_goal_idx",
    "goal_revisions_state_idx",
    "tasks_profile_idx",
    "tasks_goal_idx",
    "tasks_project_idx",
    "tasks_conversation_idx",
    "tasks_revision_idx",
    "tasks_state_revision_idx",
    "task_revisions_task_idx",
    "task_revisions_state_idx",
    "task_dependencies_from_idx",
    "task_dependencies_to_idx",
    "starter_workflows_profile_idx",
    "starter_workflows_project_idx",
    "starter_workflows_conversation_idx",
    "starter_workflows_revision_idx",
    "starter_workflows_state_revision_idx",
    "starter_workflow_revisions_workflow_idx",
    "starter_workflow_revisions_state_idx",
}
EXPECTED_AUTHORITATIVE_COUNTS = {
    "goals": 1,
    "goal_revisions": 1,
    "tasks": 4,
    "task_revisions": 2,
    "task_dependencies": 1,
    "starter_workflows": 1,
    "starter_workflow_revisions": 1,
}
EXPECTED_V17_TRIGGERS = {
    "goals_state_revision_scope_guard_insert",
    "goals_state_revision_scope_guard_update",
    "goal_revisions_state_revision_scope_guard_insert",
    "tasks_state_revision_scope_guard_insert",
    "tasks_state_revision_scope_guard_update",
    "task_revisions_state_revision_scope_guard_insert",
    "starter_workflows_state_revision_scope_guard_insert",
    "starter_workflows_state_revision_scope_guard_update",
    "starter_workflow_revisions_state_revision_scope_guard_insert",
}
EXPECTED_V18_TABLES = {
    "authoritative_root_mutation_receipts",
}
EXPECTED_V18_INDEXES = {
    "authoritative_root_receipts_root_idx",
    "authoritative_root_receipts_revision_idx",
}
EXPECTED_V18_TRIGGERS = {
    "authoritative_root_receipts_scope_guard_insert",
    "authoritative_root_receipts_immutable_update",
    "authoritative_root_receipts_immutable_delete",
}
EXPECTED_V19_TRIGGERS = {
    "task_dependencies_scope_guard_insert",
}

PROFILE = "profile_storage_probe"
OTHER_PROFILE = "profile_storage_probe_other"
PROVIDER = "provider_storage_probe"
CONVERSATION = "conversation_storage_probe"
OTHER_CONVERSATION = "conversation_storage_probe_other"
BRANCH = "branch_storage_probe"
OTHER_BRANCH = "branch_storage_probe_other"
RUN = "run_storage_probe"
ATTEMPT = "attempt_storage_probe"
MESSAGE = "message_storage_probe"
STATE_STREAM = "stream_storage_probe"
STATE_REVISION = "state_revision_probe"
OTHER_STATE_STREAM = "stream_storage_probe_other"
OTHER_STATE_REVISION = "state_revision_storage_probe_other"

HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64

GOAL = "goal_" + "a" * 32
OTHER_GOAL = "goal_" + "b" * 32
GOAL_REVISION = "goal_revision_" + "c" * 32
TASK = "task_" + "d" * 32
OTHER_TASK = "task_" + "e" * 32
TERMINAL_SOURCE_TASK = "task_" + "8" * 32
TERMINAL_TARGET_TASK = "task_" + "9" * 32
TASK_REVISION = "task_revision_" + "f" * 32
OTHER_TASK_REVISION = "task_revision_" + "1" * 32
TASK_DEPENDENCY = "task_dependency_" + "2" * 32
STARTER_WORKFLOW = "starter_workflow_" + "3" * 32
OTHER_STARTER_WORKFLOW = "starter_workflow_" + "4" * 32
STARTER_WORKFLOW_REVISION = "starter_workflow_revision_" + "5" * 32
ROOT_RECEIPT = "root_receipt_" + "6" * 32
ROOT_RECEIPT_DUPLICATE = "root_receipt_" + "7" * 32
ROOT_RECEIPT_ROLLBACK = "root_receipt_" + "8" * 32


class VerificationError(AssertionError):
    """A concise CI-facing assertion failure."""


def fail(message: str) -> NoReturn:
    raise VerificationError(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def load_sql() -> str:
    try:
        return SQL_PATH.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"unable to read {SQL_PATH}: {error}")


def sqlite_objects(connection: sqlite3.Connection, object_type: str) -> set[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'",
        (object_type,),
    )
    return {str(row[0]) for row in rows}


def expect_integrity_error(action: Any, label: str) -> None:
    try:
        action()
    except (sqlite3.IntegrityError, sqlite3.OperationalError):
        return
    fail(f"{label} was accepted")


def seed_parent_graph(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO app_profiles "
        "(id, display_name, created_at_ms, updated_at_ms, settings_json) "
        "VALUES (?, ?, 1, 1, '{}')",
        (PROFILE, "Storage probe profile"),
    )
    connection.execute(
        "INSERT INTO app_profiles "
        "(id, display_name, created_at_ms, updated_at_ms, settings_json) "
        "VALUES (?, ?, 1, 1, '{}')",
        (OTHER_PROFILE, "Storage probe other profile"),
    )
    connection.execute(
        "INSERT INTO provider_profiles "
        "(id, profile_id, provider_type, display_name, normalized_base_url, "
        "credential_ref, auth_scheme, config_json, egress_policy_json, enabled, "
        "created_at_ms, updated_at_ms) "
        "VALUES (?, ?, 'openai-compatible', ?, 'https://provider.invalid/v1', "
        "'opaque:storage-probe', 'bearer', '{}', '{}', 1, 1, 1)",
        (PROVIDER, PROFILE, "Storage probe provider"),
    )
    connection.execute(
        "INSERT INTO conversations "
        "(id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES (?, ?, 'Storage probe', 1, 1, '{}')",
        (CONVERSATION, PROFILE),
    )
    connection.execute(
        "INSERT INTO conversations "
        "(id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES (?, ?, 'Other storage probe', 1, 1, '{}')",
        (OTHER_CONVERSATION, OTHER_PROFILE),
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, created_at_ms) "
        "VALUES (?, ?, 1)",
        (BRANCH, CONVERSATION),
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, created_at_ms) "
        "VALUES (?, ?, 1)",
        (OTHER_BRANCH, OTHER_CONVERSATION),
    )
    connection.execute(
        "INSERT INTO generations "
        "(id, conversation_id, branch_id, provider_profile_id, model_id, state, "
        "request_parameters_json, created_at_ms) "
        "VALUES (?, ?, ?, ?, 'storage-model', 'queued', '{}', 1)",
        (RUN, CONVERSATION, BRANCH, PROVIDER),
    )
    connection.execute(
        "INSERT INTO run_attempts "
        "(id, generation_id, ordinal, provider_profile_id, model_id, state, "
        "accepted_by_provider, idempotency_supported, created_at_ms) "
        "VALUES (?, ?, 1, ?, 'storage-model', 'created', 'false', 0, 1)",
        (ATTEMPT, RUN, PROVIDER),
    )
    connection.execute(
        "INSERT INTO messages "
        "(id, conversation_id, branch_id, role, status, sequence_no, content_json, "
        "content_text, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES (?, ?, ?, 'user', 'complete', 0, '[]', 'probe', 1, 1, '{}')",
        (MESSAGE, CONVERSATION, BRANCH),
    )


def operation_json(operation_id: str, idempotency_key: str) -> str:
    # Metadata-only by construction: no prompt, response, credentials, bytes,
    # cookies, provider body, or local path is included in the receipt.
    return json.dumps(
        {
            "schemaVersion": 2,
            "operationId": operation_id,
            "kind": "continue",
            "operationState": "resolved",
            "conversationId": CONVERSATION,
            "branchId": BRANCH,
            "stateBase": {"mode": "current-state"},
            "activeRunPolicy": "queue-after-terminal",
            "actor": {"kind": "user", "id": "storage-probe"},
            "continuationIntent": "unfinished-answer",
            "idempotencyKey": idempotency_key,
            "createdAt": "2026-09-11T00:00:00Z",
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def insert_operation(connection: sqlite3.Connection) -> None:
    operation_id = "operation_storage_probe"
    idem = "operation-idempotency-storage-probe"
    connection.execute(
        "INSERT INTO run_control_operations "
        "(operation_id, profile_id, conversation_id, branch_id, idempotency_key_hash, "
        "canonical_payload_hash, operation_json, operation_state, created_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', 1)",
        (operation_id, PROFILE, CONVERSATION, BRANCH, HASH_A, HASH_B, operation_json(operation_id, idem)),
    )
    connection.execute(
        "INSERT INTO run_control_operation_events "
        "(event_id, operation_id, operation_state, result_json, created_at_ms) "
        "VALUES ('event_storage_probe_resolved', ?, 'resolved', ?, 1)",
        (operation_id, json.dumps({"operationId": operation_id, "canonicalPayloadHash": HASH_B})),
    )


def seed_state_revision_graph(connection: sqlite3.Connection) -> None:
    """Seed state revisions used by checkpoint scope guards.

    Checkpoint rows intentionally do not carry a SQL foreign key to the
    immutable state graph, so the DDL trigger must prove stream scope itself.
    Keep both an owned revision and a sibling-profile revision in the probe to
    exercise the positive and negative paths.
    """
    connection.execute(
        "INSERT INTO state_revision_streams "
        "(id, profile_id, conversation_id, branch_id, created_at_ms) "
        "VALUES (?, ?, ?, ?, 1)",
        (STATE_STREAM, PROFILE, CONVERSATION, BRANCH),
    )
    connection.execute(
        "INSERT INTO state_revisions "
        "(id, stream_id, kind, status, branch_sequence, watermark_json, "
        "actor_json, causation_json, manifest_json, authority_json, "
        "routing_cache_json, state_digest, canonicalization_revision, created_at_ms) "
        "VALUES (?, ?, 'root', 'accepted', 0, '{}', '{}', '{}', '{}', '{}', '{}', ?, "
        "'state-revision-c14n-v1', 2)",
        (STATE_REVISION, STATE_STREAM, HASH_A),
    )
    connection.execute(
        "INSERT INTO state_revision_streams "
        "(id, profile_id, conversation_id, branch_id, created_at_ms) "
        "VALUES (?, ?, ?, ?, 1)",
        (OTHER_STATE_STREAM, OTHER_PROFILE, OTHER_CONVERSATION, OTHER_BRANCH),
    )
    connection.execute(
        "INSERT INTO state_revisions "
        "(id, stream_id, kind, status, branch_sequence, watermark_json, "
        "actor_json, causation_json, manifest_json, authority_json, "
        "routing_cache_json, state_digest, canonicalization_revision, created_at_ms) "
        "VALUES (?, ?, 'root', 'accepted', 0, '{}', '{}', '{}', '{}', '{}', '{}', ?, "
        "'state-revision-c14n-v1', 2)",
        (OTHER_STATE_REVISION, OTHER_STATE_STREAM, HASH_B),
    )


def insert_checkpoint(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO run_checkpoints "
        "(checkpoint_id, profile_id, run_id, attempt_id, conversation_id, branch_id, "
        "state_revision_id, status, disposition, cursor, partial_output_policy, "
        "frozen_provider_input_id, provider_acceptance, pending_reconciliation_ids_json, "
        "lease_epoch, telemetry_watermark, content_hash, idempotency_key_hash, created_at_ms) "
        "VALUES ('checkpoint_storage_probe', ?, ?, ?, ?, ?, ?, "
        "'paused', 'cooperative-checkpoint', 4, 'durable-only', NULL, 'accepted', '[]', "
        "2, 8, ?, ?, 2)",
        (PROFILE, RUN, ATTEMPT, CONVERSATION, BRANCH, STATE_REVISION, HASH_C, HASH_A),
    )


def insert_continuation(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO continuation_intents "
        "(intent_id, profile_id, conversation_id, branch_id, root_kind, root_id, "
        "intent_kind, state_revision_id, execution_mode, model_profile_id, effort, "
        "allowed_tool_ids_json, budget_json, loop_guard_json, approval_policy_revision, "
        "idempotency_key_hash, canonical_payload_hash, created_at_ms) "
        "VALUES ('intent_storage_probe', ?, ?, ?, 'run', ?, 'unfinished-answer', "
        "'state_revision_probe', 'execute', NULL, 'deep', '[]', '{}', ?, NULL, ?, ?, 3)",
        (
            PROFILE,
            CONVERSATION,
            BRANCH,
            RUN,
            json.dumps({"chainId": "chain-storage-probe", "duplicateSignature": HASH_A, "maxAutomaticSegments": 3}),
            HASH_B,
            HASH_C,
        ),
    )


def insert_message_revision(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO message_revisions "
        "(revision_id, profile_id, conversation_id, branch_id, message_id, kind, effect, "
        "parent_revision_id, source_cursor, destination_branch_id, content_hash, "
        "redaction_class, idempotency_key_hash, created_at_ms) "
        "VALUES ('revision_storage_probe', ?, ?, ?, ?, 'user', 'retry-current-state', "
        "NULL, 0, NULL, ?, 'metadata-only', ?, 4)",
        (PROFILE, CONVERSATION, BRANCH, MESSAGE, HASH_A, HASH_B),
    )


def insert_authoritative_roots(connection: sqlite3.Connection) -> None:
    """Create one valid native goal/task/workflow lineage.

    Root rows are inserted with a NULL current revision, then immutable
    revision rows are appended, and only then is the root pointer advanced.
    This is the supported bootstrap order and exercises the current-revision
    scope guards without trusting renderer-provided cross-root revision IDs.
    """
    connection.execute(
        "INSERT INTO goals "
        "(id, profile_id, conversation_id, branch_id, state_revision_id, status, "
        "title, acceptance_criteria_json, roadmap_json, metadata_json, "
        "canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, 'active', 'Storage probe goal', '[]', '{}', '{}', ?, 10, 10)",
        (GOAL, PROFILE, CONVERSATION, BRANCH, STATE_REVISION, HASH_A),
    )
    connection.execute(
        "INSERT INTO goal_revisions "
        "(revision_id, goal_id, revision_no, payload_json, content_sha256, "
        "state_revision_id, created_at_ms) "
        "VALUES (?, ?, 1, '{\"title\":\"Storage probe goal\"}', ?, ?, 11)",
        (GOAL_REVISION, GOAL, HASH_A, STATE_REVISION),
    )
    connection.execute(
        "UPDATE goals SET current_revision_id = ?, updated_at_ms = 12 WHERE id = ?",
        (GOAL_REVISION, GOAL),
    )

    connection.execute(
        "INSERT INTO tasks "
        "(id, profile_id, goal_id, conversation_id, branch_id, state_revision_id, "
        "status, title, metadata_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, 'ready', 'Storage probe task', '{}', ?, 20, 20)",
        (TASK, PROFILE, GOAL, CONVERSATION, BRANCH, STATE_REVISION, HASH_B),
    )
    connection.execute(
        "INSERT INTO tasks "
        "(id, profile_id, goal_id, conversation_id, branch_id, state_revision_id, "
        "status, title, metadata_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', 'Storage probe dependency', '{}', ?, 21, 21)",
        (OTHER_TASK, PROFILE, GOAL, CONVERSATION, BRANCH, STATE_REVISION, HASH_C),
    )
    connection.execute(
        "INSERT INTO tasks "
        "(id, profile_id, goal_id, conversation_id, branch_id, state_revision_id, "
        "status, title, metadata_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, 'completed', 'Terminal source probe', '{}', ?, 26, 26)",
        (TERMINAL_SOURCE_TASK, PROFILE, GOAL, CONVERSATION, BRANCH, STATE_REVISION, HASH_A),
    )
    connection.execute(
        "INSERT INTO tasks "
        "(id, profile_id, goal_id, conversation_id, branch_id, state_revision_id, "
        "status, title, metadata_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, 'archived', 'Terminal target probe', '{}', ?, 27, 27)",
        (TERMINAL_TARGET_TASK, PROFILE, GOAL, CONVERSATION, BRANCH, STATE_REVISION, HASH_B),
    )
    connection.execute(
        "INSERT INTO task_revisions "
        "(revision_id, task_id, revision_no, payload_json, content_sha256, "
        "state_revision_id, created_at_ms) "
        "VALUES (?, ?, 1, '{\"title\":\"Storage probe task\"}', ?, ?, 22)",
        (TASK_REVISION, TASK, HASH_B, STATE_REVISION),
    )
    connection.execute(
        "INSERT INTO task_revisions "
        "(revision_id, task_id, revision_no, payload_json, content_sha256, "
        "state_revision_id, created_at_ms) "
        "VALUES (?, ?, 1, '{\"title\":\"Storage probe dependency\"}', ?, ?, 23)",
        (OTHER_TASK_REVISION, OTHER_TASK, HASH_C, STATE_REVISION),
    )
    connection.execute(
        "UPDATE tasks SET current_revision_id = ?, updated_at_ms = 24 WHERE id = ?",
        (TASK_REVISION, TASK),
    )
    connection.execute(
        "UPDATE tasks SET current_revision_id = ?, updated_at_ms = 25 WHERE id = ?",
        (OTHER_TASK_REVISION, OTHER_TASK),
    )
    connection.execute(
        "INSERT INTO task_dependencies "
        "(id, profile_id, from_task_id, to_task_id, dependency_kind, created_at_ms) "
        "VALUES (?, ?, ?, ?, 'blocks', 26)",
        (TASK_DEPENDENCY, PROFILE, TASK, OTHER_TASK),
    )

    connection.execute(
        "INSERT INTO starter_workflows "
        "(id, profile_id, conversation_id, branch_id, state_revision_id, status, enabled, "
        "name, title, definition_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, 'active', 1, 'storage_probe', 'Storage probe workflow', '{}', ?, 30, 30)",
        (STARTER_WORKFLOW, PROFILE, CONVERSATION, BRANCH, STATE_REVISION, HASH_A),
    )
    connection.execute(
        "INSERT INTO starter_workflow_revisions "
        "(revision_id, starter_workflow_id, revision_no, definition_json, "
        "content_sha256, state_revision_id, created_at_ms) "
        "VALUES (?, ?, 1, '{\"steps\":[]}', ?, ?, 31)",
        (STARTER_WORKFLOW_REVISION, STARTER_WORKFLOW, HASH_A, STATE_REVISION),
    )
    connection.execute(
        "UPDATE starter_workflows SET current_revision_id = ?, updated_at_ms = 32 WHERE id = ?",
        (STARTER_WORKFLOW_REVISION, STARTER_WORKFLOW),
    )


def verify_authoritative_roots(connection: sqlite3.Connection) -> dict[str, Any]:
    insert_authoritative_roots(connection)

    # A root may not be born already pointing at another root's immutable
    # revision.  These are direct-SQL probes for the INSERT guards added in v16.
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO goals "
            "(id, profile_id, current_revision_id, status, title, "
            "acceptance_criteria_json, roadmap_json, metadata_json, "
            "canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, 'active', 'invalid', '[]', '{}', '{}', ?, 40, 40)",
            (OTHER_GOAL, PROFILE, GOAL_REVISION, HASH_B),
        ),
        "cross-root goal current revision pointer",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO tasks "
            "(id, profile_id, goal_id, current_revision_id, status, title, metadata_json, "
            "canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, 'ready', 'invalid', '{}', ?, 41, 41)",
            ("task_" + "6" * 32, PROFILE, GOAL, TASK_REVISION, HASH_A),
        ),
        "cross-root task current revision pointer",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO starter_workflows "
            "(id, profile_id, current_revision_id, status, enabled, name, title, "
            "definition_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, 'active', 1, 'invalid', 'invalid', '{}', ?, 42, 42)",
            (OTHER_STARTER_WORKFLOW, PROFILE, STARTER_WORKFLOW_REVISION, HASH_B),
        ),
        "cross-root workflow current revision pointer",
    )

    # v17 anchors are optional, but when present they must resolve to the
    # exact profile/conversation/branch stream of the lifecycle root.  State
    # revision streams are always conversation+branch scoped, so a global or
    # half-scoped lifecycle root may not carry a non-null state anchor.  The
    # sibling revision was seeded under a different profile and must never be
    # accepted merely because the state-revision row exists.
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO goals "
            "(id, profile_id, conversation_id, branch_id, state_revision_id, status, "
            "title, acceptance_criteria_json, roadmap_json, metadata_json, "
            "canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, ?, 'active', 'invalid anchor', '[]', '{}', '{}', ?, 44, 44)",
            (OTHER_GOAL, PROFILE, CONVERSATION, BRANCH, OTHER_STATE_REVISION, HASH_B),
        ),
        "cross-stream goal state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO goals "
            "(id, profile_id, state_revision_id, status, title, "
            "acceptance_criteria_json, roadmap_json, metadata_json, "
            "canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, 'active', 'invalid global anchor', '[]', '{}', '{}', ?, 44, 44)",
            (OTHER_GOAL, PROFILE, STATE_REVISION, HASH_B),
        ),
        "global goal state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO goals "
            "(id, profile_id, conversation_id, state_revision_id, status, title, "
            "acceptance_criteria_json, roadmap_json, metadata_json, "
            "canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, 'active', 'invalid half-scoped anchor', '[]', '{}', '{}', ?, 44, 44)",
            (OTHER_GOAL, PROFILE, CONVERSATION, STATE_REVISION, HASH_B),
        ),
        "half-scoped goal state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO tasks "
            "(id, profile_id, goal_id, conversation_id, branch_id, state_revision_id, "
            "status, title, metadata_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, 'ready', 'invalid anchor', '{}', ?, 45, 45)",
            ("task_" + "6" * 32, PROFILE, GOAL, CONVERSATION, BRANCH, OTHER_STATE_REVISION, HASH_A),
        ),
        "cross-stream task state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO starter_workflows "
            "(id, profile_id, conversation_id, branch_id, state_revision_id, status, enabled, "
            "name, title, definition_json, canonical_payload_sha256, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, ?, 'active', 1, 'invalid_anchor', 'invalid anchor', '{}', ?, 46, 46)",
            (OTHER_STARTER_WORKFLOW, PROFILE, CONVERSATION, BRANCH, OTHER_STATE_REVISION, HASH_B),
        ),
        "cross-stream starter workflow state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO goal_revisions "
            "(revision_id, goal_id, revision_no, payload_json, content_sha256, state_revision_id, created_at_ms) "
            "VALUES (?, ?, 2, '{\"title\":\"invalid anchor\"}', ?, ?, 47)",
            ("goal_revision_" + "7" * 32, GOAL, HASH_B, OTHER_STATE_REVISION),
        ),
        "cross-stream goal revision state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO task_revisions "
            "(revision_id, task_id, revision_no, payload_json, content_sha256, state_revision_id, created_at_ms) "
            "VALUES (?, ?, 2, '{\"title\":\"invalid anchor\"}', ?, ?, 48)",
            ("task_revision_" + "7" * 32, TASK, HASH_A, OTHER_STATE_REVISION),
        ),
        "cross-stream task revision state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO starter_workflow_revisions "
            "(revision_id, starter_workflow_id, revision_no, definition_json, content_sha256, "
            "state_revision_id, created_at_ms) "
            "VALUES (?, ?, 2, '{\"steps\":[]}', ?, ?, 49)",
            ("starter_workflow_revision_" + "7" * 32, STARTER_WORKFLOW, HASH_B, OTHER_STATE_REVISION),
        ),
        "cross-stream starter workflow revision state anchor",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE goals SET state_revision_id = ? WHERE id = ?",
            (OTHER_STATE_REVISION, GOAL),
        ),
        "goal state anchor scope mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE tasks SET state_revision_id = ? WHERE id = ?",
            (OTHER_STATE_REVISION, TASK),
        ),
        "task state anchor scope mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE starter_workflows SET state_revision_id = ? WHERE id = ?",
            (OTHER_STATE_REVISION, STARTER_WORKFLOW),
        ),
        "starter workflow state anchor scope mutation",
    )

    # Revision rows are immutable, roots are lifecycle records, and task
    # dependency graphs must remain acyclic for executable blocks/requires.
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE goal_revisions SET payload_json = '{}' WHERE revision_id = ?",
            (GOAL_REVISION,),
        ),
        "goal revision mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "DELETE FROM tasks WHERE id = ?",
            (TASK,),
        ),
        "task lifecycle deletion",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO task_dependencies "
            "(id, profile_id, from_task_id, to_task_id, dependency_kind, created_at_ms) "
            "VALUES (?, ?, ?, ?, 'requires', 43)",
            ("task_dependency_" + "7" * 32, PROFILE, OTHER_TASK, TASK),
        ),
        "task dependency cycle",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO task_dependencies "
            "(id, profile_id, from_task_id, to_task_id, dependency_kind, created_at_ms) "
            "VALUES (?, ?, ?, ?, 'requires', 44)",
            ("task_dependency_" + "8" * 32, PROFILE, TERMINAL_SOURCE_TASK, OTHER_TASK),
        ),
        "terminal task dependency source",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO task_dependencies "
            "(id, profile_id, from_task_id, to_task_id, dependency_kind, created_at_ms) "
            "VALUES (?, ?, ?, ?, 'blocks', 45)",
            ("task_dependency_" + "9" * 32, PROFILE, TASK, TERMINAL_TARGET_TASK),
        ),
        "terminal task dependency target",
    )

    return {
        "goalTaskWorkflowLineage": "pass",
        "currentRevisionInsertGuards": "pass",
        "stateAnchorScopeGuards": "pass",
        "immutableRevisionGuards": "pass",
        "dependencyCycleGuard": "pass",
        "terminalDependencyGuards": "pass",
    }


def insert_authoritative_root_receipt(
    connection: sqlite3.Connection,
    *,
    receipt_id: str,
    idempotency_key_hash: str,
    root_kind: str = "goal",
    operation_kind: str = "goal.create",
    root_id: str = GOAL,
    revision_id: str | None = GOAL_REVISION,
    canonical_payload_sha256: str = HASH_A,
    scope_json: str | None = None,
    result_json: str | None = None,
    receipt_sha256: str = HASH_C,
    created_at_ms: int = 50,
) -> None:
    """Insert one redacted v18 receipt using the probe's valid defaults."""
    if scope_json is None:
        scope_json = json.dumps(
            {
                "profileId": PROFILE,
                "projectId": None,
                "conversationId": CONVERSATION,
                "branchId": BRANCH,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    if result_json is None:
        result_json = json.dumps(
            {
                "rootId": root_id,
                "revisionId": revision_id,
                "replayed": False,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    connection.execute(
        "INSERT INTO authoritative_root_mutation_receipts "
        "(receipt_id, profile_id, idempotency_key_hash, root_kind, operation_kind, "
        "root_id, revision_id, canonical_payload_sha256, scope_json, result_json, "
        "receipt_sha256, created_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            receipt_id,
            PROFILE,
            idempotency_key_hash,
            root_kind,
            operation_kind,
            root_id,
            revision_id,
            canonical_payload_sha256,
            scope_json,
            result_json,
            receipt_sha256,
            created_at_ms,
        ),
    )


def verify_authoritative_root_receipts(connection: sqlite3.Connection) -> dict[str, Any]:
    """Exercise v18 idempotency, scope, redaction, and immutability guards."""
    insert_authoritative_root_receipt(
        connection,
        receipt_id=ROOT_RECEIPT,
        idempotency_key_hash=HASH_A,
    )
    row = connection.execute(
        "SELECT receipt_id, profile_id, idempotency_key_hash, root_kind, operation_kind, "
        "root_id, revision_id, canonical_payload_sha256, scope_json, result_json, "
        "receipt_sha256, created_at_ms "
        "FROM authoritative_root_mutation_receipts WHERE receipt_id = ?",
        (ROOT_RECEIPT,),
    ).fetchone()
    check(row is not None, "valid authoritative-root receipt was not persisted")
    check(row[1] == PROFILE, "receipt profile scope was not persisted")
    check(row[3:7] == ("goal", "goal.create", GOAL, GOAL_REVISION),
          "receipt root/revision identity was not persisted")

    # The address is the native idempotency boundary.  DDL can reject a
    # duplicate address, while payload-drift comparison remains a native API
    # responsibility and is intentionally not inferred from SQLite alone.
    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id=ROOT_RECEIPT_DUPLICATE,
            idempotency_key_hash=HASH_A,
            canonical_payload_sha256=HASH_B,
            created_at_ms=51,
        ),
        "duplicate authoritative-root receipt address",
    )

    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "9" * 32,
            idempotency_key_hash=HASH_B,
            root_kind="goal",
            operation_kind="task.create",
            created_at_ms=52,
        ),
        "authoritative-root receipt operation scope",
    )
    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "a1" * 16,
            idempotency_key_hash=HASH_C,
            root_kind="goal",
            operation_kind="goal.create",
            root_id=GOAL,
            revision_id=TASK_REVISION,
            created_at_ms=53,
        ),
        "cross-root authoritative-root receipt revision",
    )
    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "b1" * 16,
            idempotency_key_hash="d" * 64,
            root_id="goal_" + "f" * 32,
            created_at_ms=54,
        ),
        "nonexistent authoritative-root receipt root",
    )
    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "c1" * 16,
            idempotency_key_hash="e" * 64,
            scope_json="[]",
            created_at_ms=55,
        ),
        "non-object authoritative-root receipt scope",
    )
    expect_integrity_error(
        lambda: insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "d1" * 16,
            idempotency_key_hash="f" * 64,
            result_json="[]",
            created_at_ms=56,
        ),
        "non-object authoritative-root receipt result",
    )
    # The helper always uses PROFILE, so exercise cross-profile explicitly to
    # make sure the scope guard checks the profile on the referenced root.
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO authoritative_root_mutation_receipts "
            "(receipt_id, profile_id, idempotency_key_hash, root_kind, operation_kind, "
            "root_id, revision_id, canonical_payload_sha256, scope_json, result_json, "
            "receipt_sha256, created_at_ms) VALUES (?, ?, ?, 'goal', 'goal.create', ?, ?, ?, ?, ?, ?, 58)",
            (
                "root_receipt_" + "f1" * 16,
                OTHER_PROFILE,
                "2" * 64,
                GOAL,
                GOAL_REVISION,
                HASH_A,
                json.dumps({"profileId": OTHER_PROFILE}, separators=(",", ":")),
                json.dumps({"rootId": GOAL}, separators=(",", ":")),
                HASH_C,
            ),
        ),
        "cross-profile authoritative-root receipt scope",
    )

    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE authoritative_root_mutation_receipts SET receipt_sha256 = ? "
            "WHERE receipt_id = ?",
            (HASH_B, ROOT_RECEIPT),
        ),
        "authoritative-root receipt mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "DELETE FROM authoritative_root_mutation_receipts WHERE receipt_id = ?",
            (ROOT_RECEIPT,),
        ),
        "authoritative-root receipt deletion",
    )

    # A failed native transaction must not leave a receipt that could later be
    # mistaken for a committed mutation after an IPC retry.
    connection.commit()
    before = connection.execute(
        "SELECT COUNT(*) FROM authoritative_root_mutation_receipts"
    ).fetchone()[0]
    connection.execute("BEGIN")
    try:
        insert_authoritative_root_receipt(
            connection,
            receipt_id=ROOT_RECEIPT_ROLLBACK,
            idempotency_key_hash="3" * 64,
            created_at_ms=59,
        )
        insert_authoritative_root_receipt(
            connection,
            receipt_id="root_receipt_" + "9a" * 16,
            idempotency_key_hash="3" * 64,
            canonical_payload_sha256=HASH_B,
            created_at_ms=60,
        )
    except sqlite3.IntegrityError:
        connection.rollback()
    else:
        connection.rollback()
        fail("authoritative-root receipt rollback probe did not hit uniqueness")
    after = connection.execute(
        "SELECT COUNT(*) FROM authoritative_root_mutation_receipts"
    ).fetchone()[0]
    check(before == after == 1, "failed receipt transaction leaked an authoritative-root receipt")

    return {
        "receiptInserted": True,
        "duplicateAddressRejected": True,
        "scopeGuardsRejected": True,
        "immutableReceiptRejected": True,
        "receiptRollbackVerified": True,
    }


def verify_runtime(connection: sqlite3.Connection) -> dict[str, Any]:
    seed_parent_graph(connection)
    seed_state_revision_graph(connection)
    insert_operation(connection)
    insert_checkpoint(connection)
    insert_continuation(connection)
    insert_message_revision(connection)
    authoritative = verify_authoritative_roots(connection)
    receipts = verify_authoritative_root_receipts(connection)
    connection.commit()

    # Idempotency is profile-scoped and must reject a duplicate receipt before
    # any second operation/checkpoint/intent/revision is created.
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO run_control_operations "
            "(operation_id, profile_id, conversation_id, branch_id, idempotency_key_hash, "
            "canonical_payload_hash, operation_json, operation_state, created_at_ms) "
            "VALUES ('operation_storage_probe_2', ?, ?, ?, ?, ?, '{}', 'resolved', 5)",
            (PROFILE, CONVERSATION, BRANCH, HASH_A, HASH_C),
        ),
        "duplicate operation idempotency receipt",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO run_control_operation_events "
            "(event_id, operation_id, operation_state, result_json, created_at_ms) "
            "VALUES ('event_storage_probe_duplicate', 'operation_storage_probe', 'resolved', '{}', 5)"
        ),
        "duplicate operation lifecycle state",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE run_control_operations SET operation_state = 'applied' "
            "WHERE operation_id = 'operation_storage_probe'"
        ),
        "operation receipt mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "DELETE FROM run_control_operation_events "
            "WHERE event_id = 'event_storage_probe_resolved'"
        ),
        "operation event deletion",
    )

    # Scope guards must reject cross-profile, cross-conversation and
    # cross-run/attempt references, even when foreign keys themselves exist.
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO run_control_operations "
            "(operation_id, profile_id, conversation_id, branch_id, idempotency_key_hash, "
            "canonical_payload_hash, operation_json, operation_state, created_at_ms) "
            "VALUES ('operation_scope_probe', ?, ?, ?, ?, ?, '{}', 'resolved', 6)",
            (PROFILE, OTHER_CONVERSATION, OTHER_BRANCH, HASH_C, HASH_A),
        ),
        "cross-profile operation scope",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO run_checkpoints "
            "(checkpoint_id, profile_id, run_id, conversation_id, branch_id, state_revision_id, "
            "status, disposition, cursor, pending_reconciliation_ids_json, content_hash, "
            "idempotency_key_hash, created_at_ms) "
            "VALUES ('checkpoint_scope_probe', ?, ?, ?, ?, 'state_revision_scope', 'paused', "
            "'held', 1, '[]', ?, ?, 6)",
            (PROFILE, RUN, OTHER_CONVERSATION, OTHER_BRANCH, HASH_A, HASH_B),
        ),
        "cross-conversation checkpoint scope",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO run_checkpoints "
            "(checkpoint_id, profile_id, run_id, conversation_id, branch_id, state_revision_id, "
            "status, disposition, cursor, pending_reconciliation_ids_json, content_hash, "
            "idempotency_key_hash, created_at_ms) "
            "VALUES ('checkpoint_revision_scope_probe', ?, ?, ?, ?, ?, 'paused', "
            "'held', 1, '[]', ?, ?, 6)",
            (PROFILE, RUN, CONVERSATION, BRANCH, OTHER_STATE_REVISION, HASH_A, HASH_C),
        ),
        "cross-conversation checkpoint state revision scope",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "INSERT INTO message_revisions "
            "(revision_id, profile_id, conversation_id, branch_id, message_id, kind, effect, "
            "source_cursor, destination_branch_id, content_hash, redaction_class, "
            "idempotency_key_hash, created_at_ms) "
            "VALUES ('revision_scope_probe', ?, ?, ?, ?, 'user', 'edit-as-branch', 0, ?, ?, 'probe', ?, 6)",
            (PROFILE, CONVERSATION, BRANCH, MESSAGE, OTHER_BRANCH, HASH_C, HASH_A),
        ),
        "cross-conversation revision destination scope",
    )

    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE run_checkpoints SET status = 'resuming' "
            "WHERE checkpoint_id = 'checkpoint_storage_probe'"
        ),
        "checkpoint mutation",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "DELETE FROM continuation_intents WHERE intent_id = 'intent_storage_probe'"
        ),
        "continuation intent deletion",
    )
    expect_integrity_error(
        lambda: connection.execute(
            "UPDATE message_revisions SET effect = 'edit-draft' "
            "WHERE revision_id = 'revision_storage_probe'"
        ),
        "message revision mutation",
    )

    # A failed transaction must not leak a partial receipt.  Rollback is
    # especially important when a renderer retries a timed-out IPC request.
    connection.commit()
    before = connection.execute("SELECT COUNT(*) FROM run_control_operations").fetchone()[0]
    connection.execute("BEGIN")
    try:
        connection.execute(
            "INSERT INTO run_control_operations "
            "(operation_id, profile_id, conversation_id, branch_id, idempotency_key_hash, "
            "canonical_payload_hash, operation_json, operation_state, created_at_ms) "
            "VALUES ('operation_rollback_probe', ?, ?, ?, ?, ?, '{}', 'resolved', 7)",
            (PROFILE, CONVERSATION, BRANCH, HASH_C, HASH_A),
        )
        # The same idempotency hash must abort the transaction.
        connection.execute(
            "INSERT INTO run_control_operations "
            "(operation_id, profile_id, conversation_id, branch_id, idempotency_key_hash, "
            "canonical_payload_hash, operation_json, operation_state, created_at_ms) "
            "VALUES ('operation_rollback_probe_2', ?, ?, ?, ?, ?, '{}', 'resolved', 8)",
            (PROFILE, CONVERSATION, BRANCH, HASH_C, HASH_B),
        )
    except sqlite3.IntegrityError:
        connection.rollback()
    else:
        connection.rollback()
        fail("rollback probe did not encounter the expected uniqueness violation")
    after = connection.execute("SELECT COUNT(*) FROM run_control_operations").fetchone()[0]
    check(before == after, "failed transaction leaked a run-control operation")

    counts = {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in sorted(EXPECTED_TABLES | EXPECTED_V16_TABLES | EXPECTED_V18_TABLES)
    }
    check(counts["run_control_operations"] == 1, "unexpected operation receipt count")
    check(counts["run_control_operation_events"] == 1, "unexpected operation event count")
    check(counts["run_checkpoints"] == 1, "unexpected checkpoint count")
    check(counts["continuation_intents"] == 1, "unexpected continuation intent count")
    check(counts["message_revisions"] == 1, "unexpected message revision count")
    check(
        counts["authoritative_root_mutation_receipts"] == 1,
        "unexpected authoritative-root receipt count",
    )
    for table, expected_count in EXPECTED_AUTHORITATIVE_COUNTS.items():
        check(
            counts[table] == expected_count,
            f"unexpected authoritative-root count for {table}: {counts[table]} != {expected_count}",
        )
    return {
        "countsBeforeReopen": counts,
        "idempotencyRejected": True,
        "scopeGuardsRejected": True,
        "immutableReceiptsRejected": True,
        "rollbackVerified": True,
        "authoritativeRoots": authoritative,
        "authoritativeRootReceipts": receipts,
    }


def verify() -> dict[str, Any]:
    sql = load_sql()
    check(V15_MARKER in sql, "v15 run-control marker is missing from storage schema")
    check(V16_MARKER in sql, "v16 authoritative-root marker is missing from storage schema")
    check(V17_MARKER in sql, "v17 authoritative-root hardening marker is missing from storage schema")
    check(V18_MARKER in sql, "v18 authoritative-root receipt marker is missing from storage schema")
    check(V19_MARKER in sql, "v19 terminal dependency marker is missing from storage schema")
    check(V20_MARKER in sql, "v20 provider-definition revision marker is missing from storage schema")
    prefix, v15_and_v16 = sql.split(V15_MARKER, 1)
    v15_block, v16_suffix = v15_and_v16.split(V16_MARKER, 1)
    v16_block, v17_and_v18 = v16_suffix.split(V17_MARKER, 1)
    v17_block, v18_and_v19 = v17_and_v18.split(V18_MARKER, 1)
    v18_block, v19_and_v20 = v18_and_v19.split(V19_MARKER, 1)
    v19_block, v20_suffix = v19_and_v20.split(V20_MARKER, 1)
    check("CREATE TABLE run_control_operations" in v15_block, "v15 suffix is missing operation table DDL")
    check("CREATE TABLE goals" in v16_block, "v16 suffix is missing goal table DDL")
    check("CREATE TRIGGER goals_state_revision_scope_guard_insert" in v17_block,
          "v17 suffix is missing authoritative state-anchor trigger DDL")
    check("CREATE TABLE authoritative_root_mutation_receipts" in v18_block,
          "v18 suffix is missing authoritative-root receipt table DDL")
    check("DROP TRIGGER IF EXISTS task_dependencies_scope_guard_insert" in v19_block,
          "v19 suffix is missing dependency trigger replacement DDL")
    check("task dependency source is terminal" in v19_block,
          "v19 suffix is missing terminal source guard")
    check("task dependency target is terminal" in v19_block,
          "v19 suffix is missing terminal target guard")
    check("CREATE TABLE provider_definition_revisions" in v20_suffix,
          "v20 suffix is missing provider-definition revision table DDL")

    # First prove that v15 can be applied after the pre-v15 schema statements,
    # then run the same DDL against a file-backed database for reopen evidence.
    incremental = sqlite3.connect(":memory:")
    incremental.execute("PRAGMA foreign_keys = ON")
    incremental.execute("PRAGMA trusted_schema = OFF")
    try:
        incremental.executescript(prefix)
        incremental.executescript(V15_MARKER + v15_block)
        incremental.executescript(V16_MARKER + v16_block)
        incremental.executescript(V17_MARKER + v17_block)
        incremental.executescript(V18_MARKER + v18_block)
        incremental.executescript(V19_MARKER + v19_block)
        incremental.executescript(V20_MARKER + v20_suffix)
    except sqlite3.DatabaseError as error:
        fail(f"incremental pre-v15 + v15 DDL failed: {error}")
    finally:
        incremental.close()

    with tempfile.TemporaryDirectory(prefix="omnia-run-control-") as directory:
        database_path = Path(directory) / "profile.sqlite"
        connection = sqlite3.connect(database_path)
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA trusted_schema = OFF")
        try:
            try:
                connection.executescript(sql)
            except sqlite3.DatabaseError as error:
                fail(f"full storage schema failed: {error}")

            missing_tables = sorted(
                (EXPECTED_TABLES | EXPECTED_V16_TABLES | EXPECTED_V18_TABLES)
                - sqlite_objects(connection, "table")
            )
            missing_indexes = sorted(
                (EXPECTED_INDEXES | EXPECTED_V16_INDEXES | EXPECTED_V18_INDEXES)
                - sqlite_objects(connection, "index")
            )
            missing_triggers = sorted(
                (EXPECTED_TRIGGERS | EXPECTED_V17_TRIGGERS | EXPECTED_V18_TRIGGERS | EXPECTED_V19_TRIGGERS)
                - sqlite_objects(connection, "trigger")
            )
            check(not missing_tables, f"run-control tables missing: {missing_tables}")
            check(not missing_indexes, f"run-control indexes missing: {missing_indexes}")
            check(not missing_triggers, f"run-control triggers missing: {missing_triggers}")

            runtime = verify_runtime(connection)
            connection.close()

            reopened = sqlite3.connect(database_path)
            reopened.execute("PRAGMA foreign_keys = ON")
            reopened_counts = {
                table: int(reopened.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in sorted(EXPECTED_TABLES | EXPECTED_V16_TABLES | EXPECTED_V18_TABLES)
            }
            check(reopened_counts == runtime["countsBeforeReopen"], "receipt rows were not durable across reopen")
            check(
                reopened.execute(
                    "SELECT operation_state FROM run_control_operations WHERE operation_id = 'operation_storage_probe'"
                ).fetchone()[0]
                == "resolved",
                "resolved operation could not be replayed after reopen",
            )
            receipt_row = reopened.execute(
                "SELECT root_kind, operation_kind, root_id, revision_id "
                "FROM authoritative_root_mutation_receipts WHERE receipt_id = ?",
                (ROOT_RECEIPT,),
            ).fetchone()
            check(
                receipt_row == ("goal", "goal.create", GOAL, GOAL_REVISION),
                "authoritative-root receipt could not be replayed after reopen",
            )
            reopened.close()
        finally:
            try:
                connection.close()
            except Exception:
                pass

    forbidden_names = {
        "credential",
        "credentialref",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "cookie",
        "cookies",
        "promptbody",
        "responsebody",
        "reasoningbody",
        "attachmentbytes",
        "filebytes",
        "absolutepath",
        "rawurl",
        "requestbody",
    }
    # Comments explain the redaction boundary and legitimately mention words
    # such as "credential" or "cookie".  Scan executable SQL only so this
    # check is about persisted identifiers/columns rather than prose.
    sql_without_comments = "\n".join(
        line.split("--", 1)[0]
        for line in (v15_block + v16_block + v17_block + v18_block + v19_block).splitlines()
    )
    lowered = sql_without_comments.lower()
    leaked = sorted(name for name in forbidden_names if name in lowered)
    check(not leaked, f"v15 SQL exposes forbidden raw/secret column names: {leaked}")

    return {
        "storageSchema": str(SQL_PATH.relative_to(ROOT)),
        "v15Marker": V15_MARKER,
        "v16Marker": V16_MARKER,
        "v17Marker": V17_MARKER,
        "v18Marker": V18_MARKER,
        "v19Marker": V19_MARKER,
        "v20Marker": V20_MARKER,
        "tables": sorted(EXPECTED_TABLES | EXPECTED_V16_TABLES | EXPECTED_V18_TABLES),
        "indexes": sorted(EXPECTED_INDEXES | EXPECTED_V16_INDEXES | EXPECTED_V18_INDEXES),
        "triggers": sorted(EXPECTED_TRIGGERS | EXPECTED_V17_TRIGGERS | EXPECTED_V18_TRIGGERS | EXPECTED_V19_TRIGGERS),
        "incrementalDdl": "pass",
        "fileBackedReopen": "pass",
        "nativeRuntime": "not-tested-by-this-probe",
        "runtime": runtime,
    }


def main() -> int:
    try:
        result = verify()
    except VerificationError as error:
        print(f"RUN_CONTROL_STORAGE_VERIFY: FAIL: {error}", file=sys.stderr)
        return 1
    print("RUN_CONTROL_STORAGE_VERIFY: PASS")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
