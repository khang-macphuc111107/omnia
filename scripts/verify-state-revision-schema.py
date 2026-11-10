"""Independent SQLite verifier for Omnia schema v11-v14 storage contracts.

This verifier deliberately does not import the Rust migration code.  It executes
the checked-in SQL contract the same way a small external recovery/upgrade tool
would, then checks a fresh profile and each state-revision/provider-lineage
migration as a separate upgrade fixture.  The v11 graph, v12 journal, v13
operation-fact, and v14 provider-attempt-lineage tails are intentionally
verified independently so an older database cannot appear current merely
because the full fresh schema was executed in one pass.

Run from the repository root with::

    python scripts/verify-state-revision-schema.py

The output is intentionally compact and suitable for CI logs.  A non-zero exit
status means that at least one storage contract assertion failed.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from typing import Iterable, NoReturn


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "docs" / "storage-schema.sql"
RECEIPT_SCHEMA_PATH = ROOT / "docs" / "omnia-ultra" / "schemas" / "state-revision-receipt.schema.json"
STATE_REVISION_MARKER = "-- Omnia schema v11: immutable state-revision graph and branch-head CAS."
STATE_REVISION_JOURNAL_MARKER = "-- Omnia schema v12: append-only state-revision mutation journal."
STATE_REVISION_OPERATION_FACT_MARKER = (
    "-- Omnia schema v13: immutable state-revision operation facts."
)
PROVIDER_ATTEMPT_LINEAGE_MARKER = (
    "-- Omnia schema v14: immutable provider-attempt lineage facts."
)
RUN_CONTROL_MARKER = "-- Omnia schema v15: durable run-control resolutions, checkpoints,"
STATE_REVISION_MIGRATION_ID = "0011_state_revision_graph_cas"
STATE_REVISION_MIGRATION_APP_VERSION = "0.10.0"
STATE_REVISION_JOURNAL_MIGRATION_ID = "0012_state_revision_journal"
STATE_REVISION_JOURNAL_MIGRATION_APP_VERSION = "0.11.0"
STATE_REVISION_OPERATION_FACT_MIGRATION_ID = "0013_state_revision_operation_facts"
STATE_REVISION_OPERATION_FACT_MIGRATION_APP_VERSION = "0.12.0"
PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID = "0014_provider_attempt_lineage_facts"
PROVIDER_ATTEMPT_LINEAGE_MIGRATION_APP_VERSION = "0.13.0"

STATE_REVISION_RECEIPT_BASE_FIELDS = {
    "schemaVersion",
    "outcome",
    "revisionId",
    "streamId",
    "acceptedHeadStateRevisionId",
    "expectedHeadStateRevisionId",
    "branchSequence",
    "canonicalPayloadHash",
}
STATE_REVISION_RECEIPT_CURSOR_FIELDS = {
    "journalEpoch",
    "journalSequence",
    "journalEventId",
}
STATE_REVISION_RECEIPT_COMPLETE_FIELDS = (
    STATE_REVISION_RECEIPT_BASE_FIELDS | STATE_REVISION_RECEIPT_CURSOR_FIELDS
)

EXPECTED_V11_TABLES = {
    "state_revision_streams",
    "state_revisions",
    "state_revision_parents",
    "state_revision_edges",
    "state_revision_heads",
    "state_revision_idempotency",
}

EXPECTED_V11_TRIGGERS = {
    "state_revision_streams_scope_guard_insert",
    "state_revision_streams_immutable_update",
    "state_revision_streams_immutable_delete",
    "state_revisions_scope_guard_insert",
    "state_revisions_immutable_update",
    "state_revisions_immutable_delete",
    "state_revisions_root_uniqueness_guard_insert",
    "state_revision_parents_scope_guard_insert",
    "state_revision_parents_immutable_update",
    "state_revision_parents_immutable_delete",
    "state_revision_edges_scope_guard_insert",
    "state_revision_edges_immutable_update",
    "state_revision_edges_immutable_delete",
    "state_revision_heads_scope_guard_insert",
    "state_revision_heads_scope_guard_update",
    "state_revision_heads_stream_immutable_update",
    "state_revision_idempotency_scope_guard_insert",
    "state_revision_idempotency_immutable_update",
    "state_revision_idempotency_immutable_delete",
}

EXPECTED_V11_INDEXES = {
    "state_revision_streams_scope_idx",
    "state_revisions_stream_sequence_idx",
    "state_revisions_stream_status_idx",
    "state_revision_parents_parent_idx",
    "state_revision_edges_from_idx",
    "state_revision_edges_to_idx",
    "state_revision_idempotency_result_idx",
}

EXPECTED_V12_TABLES = {
    "state_revision_journals",
    "state_revision_events",
}

EXPECTED_V12_TRIGGERS = {
    "state_revision_journals_immutable_update",
    "state_revision_journals_immutable_delete",
    "state_revision_events_append_only_update",
    "state_revision_events_append_only_delete",
    "state_revision_events_scope_guard",
    "state_revision_events_sequence_guard",
}

EXPECTED_V12_INDEXES = {
    "state_revision_events_replay_idx",
    "state_revision_events_revision_idx",
}

EXPECTED_V13_TABLES = {"state_revision_operation_facts"}

EXPECTED_V13_TRIGGERS = {
    "state_revision_operation_facts_scope_guard_insert",
    "state_revision_operation_facts_immutable_update",
    "state_revision_operation_facts_immutable_delete",
}

EXPECTED_V13_INDEXES = {
    "state_revision_operation_facts_coverage_idx",
}

# v14 is intentionally a separate additive fact table.  Keep this inventory
# explicit: a verifier that only checks the table name would miss a dropped
# immutability/scope trigger and could falsely bless a migration that loses
# provenance at dispatch time.
EXPECTED_V14_TABLES = {"provider_attempt_lineage_facts"}
EXPECTED_V14_TRIGGERS = {
    "provider_attempt_lineage_facts_scope_guard_insert",
    "provider_attempt_lineage_facts_immutable_update",
    "provider_attempt_lineage_facts_immutable_delete",
}
EXPECTED_V14_INDEXES = {
    "provider_attempt_lineage_facts_attempt_idx",
    "provider_attempt_lineage_facts_run_idx",
    "provider_attempt_lineage_facts_provider_idx",
}
EXPECTED_V14_COLUMNS = (
    "id",
    "schema_version",
    "frozen_provider_input_id",
    "run_id",
    "attempt_id",
    "provider_profile_id",
    "model_id",
    "provider_definition_schema_version",
    "provider_definition_sha256",
    "endpoint_fingerprint_sha256",
    "adapter_revision",
    "catalog_snapshot_id",
    "catalog_snapshot_sha256",
    "model_descriptor_revision_id",
    "model_descriptor_sha256",
    "model_capability_snapshot_id",
    "model_capability_snapshot_sha256",
    "route_revision_id",
    "routing_decision_receipt_id",
    "retry_policy_revision_id",
    "cache_policy_revision_id",
    "cache_plan_id",
    "price_snapshot_id",
    "price_snapshot_sha256",
    "parameter_profile_revision_id",
    "resolved_parameters_sha256",
    "requested_effort",
    "effective_effort",
    "context_manifest_id",
    "context_manifest_sha256",
    "authority_continuity_record_id",
    "data_classification_revision_id",
    "input_content_sha256",
    "lineage_sha256",
    "created_at_ms",
)

EXPECTED_STATE_REVISION_EVENT_PAYLOAD_KEYS = {
    "schemaVersion",
    "streamId",
    "stateRevisionId",
    "kind",
    "status",
    "branchSequence",
    "observedHeadStateRevisionId",
    "expectedHeadStateRevisionId",
    "acceptedHeadStateRevisionId",
    "canonicalPayloadHash",
    "idempotencyKeyHash",
    "operationId",
    "watermarkHash",
    "actorHash",
    "causationHash",
    "manifestHash",
    "authorityHash",
    "routingCacheHash",
    "causalCursorHash",
    "policyRevisionId",
}


class VerificationError(AssertionError):
    """A contract assertion with a user-facing failure message."""


def verify_receipt_schema_document() -> None:
    """Check the checked-in receipt schema's own immutable contract metadata."""
    try:
        document = json.loads(RECEIPT_SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"state-revision receipt schema could not be loaded: {error}")
    check(
        document.get("$id") == "https://omnia.local/schemas/state-revision-receipt.schema.json",
        "state-revision receipt schema has an unexpected $id",
    )
    check(
        document.get("additionalProperties") is False,
        "state-revision receipt schema must reject unknown fields",
    )
    check(
        document.get("properties", {}).get("schemaVersion", {}).get("const") == 1,
        "state-revision receipt schemaVersion must be 1",
    )
    check(
        document.get("properties", {}).get("outcome", {}).get("const") == "applied",
        "stored state-revision receipt outcome must be applied",
    )
    properties = document.get("properties", {})
    check(
        set(properties) == STATE_REVISION_RECEIPT_COMPLETE_FIELDS,
        "state-revision receipt schema properties drifted",
    )
    one_of = document.get("oneOf")
    check(isinstance(one_of, list) and len(one_of) == 2, "state-revision receipt schema must expose complete/legacy variants")
    required_variants = [set(variant.get("required", [])) for variant in one_of]
    check(
        STATE_REVISION_RECEIPT_COMPLETE_FIELDS in required_variants,
        "state-revision complete receipt variant required fields drifted",
    )
    check(
        STATE_REVISION_RECEIPT_BASE_FIELDS in required_variants,
        "state-revision legacy receipt variant required fields drifted",
    )
    legacy_variant = next(
        variant for variant in one_of if set(variant.get("required", [])) == STATE_REVISION_RECEIPT_BASE_FIELDS
    )
    legacy_exclusion = legacy_variant.get("not", {}).get("anyOf", [])
    check(
        {frozenset(item.get("required", [])) for item in legacy_exclusion}
        == {frozenset({field}) for field in STATE_REVISION_RECEIPT_CURSOR_FIELDS},
        "state-revision legacy receipt variant must forbid partial journal cursors",
    )
    check(
        properties.get("journalSequence", {}).get("type") == "integer"
        and properties.get("journalSequence", {}).get("minimum") == 1,
        "state-revision journalSequence must be a positive integer",
    )


def receipt_shape(receipt: object, *, allow_legacy: bool) -> str:
    """Return the receipt variant after enforcing exact fields and no partial cursor."""
    check(isinstance(receipt, dict), "state-revision receipt must decode to an object")
    fields = set(receipt)
    if fields == STATE_REVISION_RECEIPT_COMPLETE_FIELDS:
        return "complete"
    if allow_legacy and fields == STATE_REVISION_RECEIPT_BASE_FIELDS:
        return "legacy-partial"
    unknown = sorted(fields - STATE_REVISION_RECEIPT_COMPLETE_FIELDS)
    missing = sorted(STATE_REVISION_RECEIPT_COMPLETE_FIELDS - fields)
    fail(
        "state-revision receipt fields drifted: "
        f"unknown={unknown!r}, missing={missing!r}; journal cursor fields are all-or-none"
    )


def verify_receipt_values(receipt: object, *, allow_legacy: bool, expected_stream: str,
                          expected_revision: str, expected_hash: str,
                          expected_sequence: int) -> str:
    """Validate the redacted receipt fields that native replay must cross-check."""
    variant = receipt_shape(receipt, allow_legacy=allow_legacy)
    assert isinstance(receipt, dict)
    check(receipt["schemaVersion"] == 1, "state-revision receipt schemaVersion drifted")
    check(receipt["outcome"] == "applied", "state-revision receipt outcome drifted")
    check(receipt["streamId"] == expected_stream, "state-revision receipt stream mismatch")
    check(receipt["revisionId"] == expected_revision, "state-revision receipt revision mismatch")
    check(receipt["canonicalPayloadHash"] == expected_hash, "state-revision receipt canonical payload hash mismatch")
    check(
        isinstance(receipt["branchSequence"], int)
        and not isinstance(receipt["branchSequence"], bool)
        and receipt["branchSequence"] == expected_sequence
        and receipt["branchSequence"] >= 0,
        "state-revision receipt branch sequence mismatch",
    )
    for field in ("acceptedHeadStateRevisionId", "expectedHeadStateRevisionId"):
        check(receipt[field] is None or (isinstance(receipt[field], str) and bool(receipt[field])),
              f"state-revision receipt {field} must be null or a non-empty ID")
    check(
        isinstance(expected_hash, str)
        and len(expected_hash) == 64
        and all(char in "0123456789abcdef" for char in expected_hash),
        "state-revision receipt canonical payload hash must be lower-case SHA-256",
    )
    if variant == "complete":
        check(isinstance(receipt["journalEpoch"], str) and bool(receipt["journalEpoch"]),
              "state-revision receipt journal epoch must be a non-empty ID")
        check(isinstance(receipt["journalEventId"], str) and bool(receipt["journalEventId"]),
              "state-revision receipt journal event ID must be a non-empty ID")
        check(
            isinstance(receipt["journalSequence"], int)
            and not isinstance(receipt["journalSequence"], bool)
            and receipt["journalSequence"] >= 1,
            "state-revision receipt journal sequence must be a positive integer",
        )
    return variant


def expect_receipt_error(receipt: object, *, allow_legacy: bool, label: str) -> None:
    """Assert that an intentionally malformed receipt fails closed."""
    try:
        receipt_shape(receipt, allow_legacy=allow_legacy)
    except VerificationError:
        return
    fail(f"{label}: malformed receipt unexpectedly passed")


def fail(message: str) -> NoReturn:
    raise VerificationError(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def open_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA trusted_schema = OFF")
    return connection


def object_rows(connection: sqlite3.Connection) -> set[tuple[str, str, str | None]]:
    rows = connection.execute(
        "SELECT type, name, sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall()
    return {(str(kind), str(name), sql) for kind, name, sql in rows}


def object_names(connection: sqlite3.Connection, kind: str) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite_%'",
            (kind,),
        ).fetchall()
    }


def assert_health(
    connection: sqlite3.Connection,
    label: str,
    *,
    include_journal: bool = True,
    include_operation_facts: bool = False,
    include_provider_lineage: bool = False,
) -> None:
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    check(not foreign_key_violations, f"{label}: foreign_key_check returned {foreign_key_violations}")
    integrity = connection.execute("PRAGMA quick_check").fetchone()
    check(integrity == ("ok",), f"{label}: quick_check returned {integrity}")
    expected_tables = (
        EXPECTED_V11_TABLES
        | (EXPECTED_V12_TABLES if include_journal else set())
        | (EXPECTED_V13_TABLES if include_operation_facts else set())
        | (EXPECTED_V14_TABLES if include_provider_lineage else set())
    )
    expected_triggers = (
        EXPECTED_V11_TRIGGERS
        | (EXPECTED_V12_TRIGGERS if include_journal else set())
        | (EXPECTED_V13_TRIGGERS if include_operation_facts else set())
        | (EXPECTED_V14_TRIGGERS if include_provider_lineage else set())
    )
    expected_indexes = (
        EXPECTED_V11_INDEXES
        | (EXPECTED_V12_INDEXES if include_journal else set())
        | (EXPECTED_V13_INDEXES if include_operation_facts else set())
        | (EXPECTED_V14_INDEXES if include_provider_lineage else set())
    )
    check(
        expected_tables <= object_names(connection, "table"),
        f"{label}: missing state-revision table(s): {sorted(expected_tables - object_names(connection, 'table'))}",
    )
    check(
        expected_triggers <= object_names(connection, "trigger"),
        f"{label}: missing state-revision trigger(s): {sorted(expected_triggers - object_names(connection, 'trigger'))}",
    )
    check(
        expected_indexes <= object_names(connection, "index"),
        f"{label}: missing state-revision index(es): {sorted(expected_indexes - object_names(connection, 'index'))}",
    )


def state_revision_schema_tail(schema: str) -> str:
    parts = schema.split(STATE_REVISION_MARKER, 1)
    check(len(parts) == 2, "storage-schema.sql is missing the v11 marker")
    tail = parts[1].split(STATE_REVISION_JOURNAL_MARKER, 1)
    check(len(tail) == 2, "storage-schema.sql is missing the v12 marker")
    return tail[0]


def state_revision_journal_schema_tail(schema: str) -> str:
    parts = schema.split(STATE_REVISION_JOURNAL_MARKER, 1)
    check(len(parts) == 2, "storage-schema.sql is missing the v12 marker")
    tail = parts[1].split(STATE_REVISION_OPERATION_FACT_MARKER, 1)
    check(len(tail) == 2, "storage-schema.sql is missing the v13 marker")
    return tail[0]


def state_revision_operation_fact_schema_tail(schema: str) -> str:
    parts = schema.split(STATE_REVISION_OPERATION_FACT_MARKER, 1)
    check(len(parts) == 2, "storage-schema.sql is missing the v13 marker")
    tail = parts[1].split(PROVIDER_ATTEMPT_LINEAGE_MARKER, 1)
    check(len(tail) == 2, "storage-schema.sql is missing the v14 marker")
    return tail[0]


def provider_attempt_lineage_schema_tail(schema: str) -> str:
    """Return only the additive v14 provider-lineage SQL section.

    Keeping this split in the independent verifier is important: executing the
    full current schema against a v13 fixture would make the migration appear
    to work even when the native marker boundaries accidentally include v14
    objects in the v13 migration.
    """
    parts = schema.split(PROVIDER_ATTEMPT_LINEAGE_MARKER, 1)
    check(len(parts) == 2, "storage-schema.sql is missing the v14 marker")
    tail = parts[1].split(RUN_CONTROL_MARKER, 1)
    check(len(tail) == 2, "storage-schema.sql is missing the v15 marker")
    return tail[0]


def is_lower_hex_sha256(value: object) -> bool:
    """Return whether *value* is exactly a lower-case SHA-256 digest."""
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def prepare_v10_fixture(schema_v10: str) -> sqlite3.Connection:
    connection = open_connection()
    connection.executescript(schema_v10)
    # The application seeds this row before migrations run.  Keep the fixture
    # minimal while still satisfying the current schema_meta contract.
    connection.execute(
        "INSERT INTO app_profiles (id, display_name, created_at_ms, updated_at_ms, settings_json) "
        "VALUES ('profile_default', 'Local profile', 1, 1, '{}')"
    )
    connection.execute(
        "INSERT INTO schema_meta ("
        "singleton, schema_version, min_app_version, created_at_ms, "
        "updated_at_ms, profile_id, encryption_key_version"
        ") VALUES (1, 10, '0.9.0', 1, 1, 'profile_default', 1)"
    )
    connection.execute("PRAGMA user_version = 10")
    connection.commit()
    check(
        connection.execute("PRAGMA user_version").fetchone() == (10,),
        "v10 fixture did not retain PRAGMA user_version=10",
    )
    check(
        connection.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (10,),
        "v10 fixture did not retain schema_meta.schema_version=10",
    )
    return connection


def prepare_v11_fixture(schema_v10: str, state_revision_tail: str) -> sqlite3.Connection:
    """Create a committed v11 fixture before the v12 journal migration."""
    connection = prepare_v10_fixture(schema_v10)
    connection.executescript(state_revision_tail)
    connection.execute("UPDATE schema_meta SET schema_version = 11, min_app_version = '0.10.0' WHERE singleton = 1")
    connection.execute(
        "INSERT INTO schema_migrations (migration_id, checksum_sha256, started_at_ms, completed_at_ms, duration_ms, app_version) "
        "VALUES (?1, ?2, 2, 2, 0, ?3)",
        (
            STATE_REVISION_MIGRATION_ID,
            hashlib.sha256(state_revision_tail.encode("utf-8")).hexdigest(),
            STATE_REVISION_MIGRATION_APP_VERSION,
        ),
    )
    connection.execute("PRAGMA user_version = 11")
    connection.commit()
    assert_health(connection, "v11 fixture", include_journal=False)
    check(connection.execute("PRAGMA user_version").fetchone() == (11,), "v11 fixture did not retain PRAGMA user_version=11")
    check(
        connection.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone() == (11,),
        "v11 fixture did not retain schema_meta.schema_version=11",
    )
    return connection


def migration_sql(state_tail: str, checksum: str, *, fail_after: bool = False) -> str:
    # This mirrors apply_v11's transaction body.  The production migrator sets
    # PRAGMA user_version only after the transaction commits, so this helper does
    # the same in the success path below.
    body = [
        "BEGIN",
        state_tail,
        "UPDATE schema_meta SET schema_version = 11, min_app_version = '0.10.0', updated_at_ms = 2 WHERE singleton = 1",
        "INSERT INTO schema_migrations (migration_id, checksum_sha256, started_at_ms, completed_at_ms, duration_ms, app_version) "
        f"VALUES ('{STATE_REVISION_MIGRATION_ID}', '{checksum}', 2, 2, 0, '{STATE_REVISION_MIGRATION_APP_VERSION}')",
    ]
    if fail_after:
        body.append("INSERT INTO state_revision_table_that_must_not_exist VALUES (1)")
    else:
        body.append("COMMIT")
    return ";\n".join(body) + ";\n"


def verify_migration(schema_v10: str, state_tail: str) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    checksum = hashlib.sha256(state_tail.encode("utf-8")).hexdigest()

    migrated = prepare_v10_fixture(schema_v10)
    migrated.executescript(migration_sql(state_tail, checksum))
    migrated.execute("PRAGMA user_version = 11")
    migrated.commit()
    assert_health(migrated, "migrated v10->v11", include_journal=False)
    check(migrated.execute("PRAGMA user_version").fetchone() == (11,), "migrated user_version != 11")
    check(
        migrated.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (11,),
        "migrated schema_meta.schema_version != 11",
    )
    receipt = migrated.execute(
        "SELECT migration_id, checksum_sha256, app_version, completed_at_ms "
        "FROM schema_migrations WHERE migration_id = ?1",
        (STATE_REVISION_MIGRATION_ID,),
    ).fetchone()
    check(
        receipt == (STATE_REVISION_MIGRATION_ID, checksum, STATE_REVISION_MIGRATION_APP_VERSION, 2),
        f"migration receipt mismatch: {receipt!r}",
    )

    rollback = prepare_v10_fixture(schema_v10)
    try:
        rollback.executescript(migration_sql(state_tail, checksum, fail_after=True))
    except sqlite3.DatabaseError:
        # The native migrator rolls back the transaction on any error.  Python's
        # sqlite3 leaves a failed explicit transaction open, so make the same
        # rollback boundary explicit before inspecting the fixture.
        rollback.rollback()
    else:
        fail("intentional migration failure unexpectedly committed")
    check(
        rollback.execute("PRAGMA user_version").fetchone() == (10,),
        "failed migration changed PRAGMA user_version",
    )
    check(
        rollback.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (10,),
        "failed migration changed schema_meta",
    )
    check(
        not (EXPECTED_V11_TABLES & object_names(rollback, "table")),
        "failed migration left v11 tables behind",
    )
    check(
        not (EXPECTED_V12_TABLES | EXPECTED_V13_TABLES) & object_names(rollback, "table"),
        "failed migration left v12/v13 tables behind",
    )
    check(
        rollback.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1", (STATE_REVISION_MIGRATION_ID,)
        ).fetchone()
        == (0,),
        "failed migration left a v11 migration receipt behind",
    )
    assert_health_without_v11(rollback, "rolled-back v10->v11")
    return migrated, rollback


def journal_migration_sql(journal_tail: str, checksum: str, *, fail_after: bool = False) -> str:
    """Mirror the native v11 -> v12 journal migration transaction."""
    # Existing v11 streams predate the journal.  The native migration creates
    # one metadata row per stream with legacy-partial coverage, but intentionally
    # does not fabricate historical events.  Keep the fixture deterministic (the
    # production code uses UUID epochs) so the verifier can assert exact rows.
    legacy_reason = "state-revision journal introduced after existing stream history"
    body = [
        "BEGIN",
        journal_tail,
        "INSERT INTO state_revision_journals (\n"
        "    stream_id, schema_version, journal_epoch, coverage, coverage_reason, created_at_ms\n"
        ")\n"
        "SELECT stream.id, 1, 'legacy_state_journal_epoch_' || stream.id,\n"
        f"       'legacy-partial', '{legacy_reason}', MAX(stream.created_at_ms, 1)\n"
        "FROM state_revision_streams stream\n"
        "WHERE NOT EXISTS (\n"
        "    SELECT 1 FROM state_revision_journals journal\n"
        "    WHERE journal.stream_id = stream.id\n"
        ")",
        "UPDATE schema_meta SET schema_version = 12, min_app_version = '0.11.0', updated_at_ms = 3 WHERE singleton = 1",
        "INSERT INTO schema_migrations (migration_id, checksum_sha256, started_at_ms, completed_at_ms, duration_ms, app_version) "
        f"VALUES ('{STATE_REVISION_JOURNAL_MIGRATION_ID}', '{checksum}', 3, 3, 0, '{STATE_REVISION_JOURNAL_MIGRATION_APP_VERSION}')",
    ]
    if fail_after:
        body.append("INSERT INTO state_revision_journal_table_that_must_not_exist VALUES (1)")
    else:
        body.append("COMMIT")
    return ";\n".join(body) + ";\n"


def verify_journal_migration(
    schema_v10: str,
    state_revision_tail: str,
    journal_tail: str,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    checksum = hashlib.sha256(journal_tail.encode("utf-8")).hexdigest()

    migrated = prepare_v11_fixture(schema_v10, state_revision_tail)
    # Existing v11 streams are deliberately not given fabricated historical
    # events.  The migration creates legacy-partial journal metadata only.
    seed_scope_fixture(migrated)
    migrated.executescript(journal_migration_sql(journal_tail, checksum))
    migrated.execute("PRAGMA user_version = 12")
    migrated.commit()
    assert_health(migrated, "migrated v11->v12")
    check(migrated.execute("PRAGMA user_version").fetchone() == (12,), "migrated user_version != 12")
    check(
        migrated.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone() == (12,),
        "migrated schema_meta.schema_version != 12",
    )
    receipt = migrated.execute(
        "SELECT migration_id, checksum_sha256, app_version, completed_at_ms "
        "FROM schema_migrations WHERE migration_id = ?1",
        (STATE_REVISION_JOURNAL_MIGRATION_ID,),
    ).fetchone()
    check(
        receipt == (STATE_REVISION_JOURNAL_MIGRATION_ID, checksum, STATE_REVISION_JOURNAL_MIGRATION_APP_VERSION, 3),
        f"v12 migration receipt mismatch: {receipt!r}",
    )
    legacy_rows = migrated.execute(
        "SELECT stream_id, coverage, coverage_reason FROM state_revision_journals ORDER BY stream_id"
    ).fetchall()
    check(len(legacy_rows) == 2, f"v12 migration created unexpected journal rows: {legacy_rows!r}")
    check(all(row[1] == "legacy-partial" and row[2] for row in legacy_rows), f"legacy journal coverage drifted: {legacy_rows!r}")
    check(migrated.execute("SELECT COUNT(*) FROM state_revision_events").fetchone() == (0,), "v12 migration fabricated historical events")

    # A v11 idempotency row has no historical journal event to point at.  The
    # compatibility contract permits the exact base receipt on a
    # legacy-partial stream, but never a partial cursor.  This is the only
    # circumstance in which a stored v1 receipt may omit journal fields.
    insert_revision(migrated, "rev_legacy_receipt", "stream_cas_1", sequence=0)
    migrated.execute(
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_legacy_receipt', branch_sequence = 0 "
        "WHERE stream_id = 'stream_cas_1'"
    )
    legacy_receipt_json = json.dumps(
        {
            "schemaVersion": 1,
            "outcome": "applied",
            "revisionId": "rev_legacy_receipt",
            "streamId": "stream_cas_1",
            "acceptedHeadStateRevisionId": "rev_legacy_receipt",
            "expectedHeadStateRevisionId": None,
            "branchSequence": 0,
            "canonicalPayloadHash": "3" * 64,
        },
        separators=(",", ":"),
    )
    migrated.execute(
        "INSERT INTO state_revision_idempotency ("
        "stream_id, idempotency_key_hash, canonical_payload_hash, result_revision_id, receipt_json, created_at_ms"
        ") VALUES ('stream_cas_1', ?1, ?2, 'rev_legacy_receipt', ?3, 4)",
        ("4" * 64, "3" * 64, legacy_receipt_json),
    )
    legacy_receipt = json.loads(legacy_receipt_json)
    check(
        verify_receipt_values(
            legacy_receipt,
            allow_legacy=True,
            expected_stream="stream_cas_1",
            expected_revision="rev_legacy_receipt",
            expected_hash="3" * 64,
            expected_sequence=0,
        )
        == "legacy-partial",
        "legacy-partial receipt must use the cursor-less compatibility variant",
    )
    expect_receipt_error(
        {**legacy_receipt, "journalSequence": 1},
        allow_legacy=True,
        label="legacy partial journal cursor",
    )
    expect_receipt_error(
        {**legacy_receipt, "diagnostic": "unexpected"},
        allow_legacy=True,
        label="legacy receipt unknown field",
    )

    # A fresh v12 stream must be bootstrapped with exactly one complete journal
    # metadata row.  The schema itself cannot create this row (it is a native
    # transaction concern), so exercise the SQL contract with the same shape as
    # ensure_state_revision_journal().
    fresh_stream = "stream_cas_fresh"
    migrated.execute(
        "INSERT INTO conversations (id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES ('conversation_cas_fresh', 'profile_cas', 'CAS fresh', 20, 20, '{}')"
    )
    migrated.execute(
        "INSERT INTO conversation_branches (id, conversation_id, name, created_at_ms) "
        "VALUES ('branch_cas_fresh', 'conversation_cas_fresh', 'main', 20)"
    )
    migrated.execute(
        "INSERT INTO state_revision_streams (id, profile_id, project_id, conversation_id, branch_id, created_at_ms) "
        "VALUES (?1, 'profile_cas', NULL, 'conversation_cas_fresh', 'branch_cas_fresh', 20)",
        (fresh_stream,),
    )
    migrated.execute(
        "INSERT INTO state_revision_journals (stream_id, schema_version, journal_epoch, coverage, coverage_reason, created_at_ms) "
        "VALUES (?1, 1, 'journal_epoch_fresh', 'complete', NULL, 20)",
        (fresh_stream,),
    )
    check(
        migrated.execute(
            "SELECT coverage, coverage_reason FROM state_revision_journals WHERE stream_id = ?1", (fresh_stream,)
        ).fetchone()
        == ("complete", None),
        "fresh stream journal metadata must be complete with no coverage reason",
    )

    # Journal metadata and event rows are append-only, scoped, and sequence
    # guarded.  These checks cover direct recovery/import writes as well as the
    # native append path's invariants.
    insert_revision(migrated, "rev_cas_fresh", fresh_stream, sequence=0)
    event_payload = json.dumps(
        {
            "schemaVersion": 1,
            "streamId": fresh_stream,
            "stateRevisionId": "rev_cas_fresh",
            "kind": "root",
            "status": "accepted",
            "branchSequence": 0,
            "observedHeadStateRevisionId": None,
            "expectedHeadStateRevisionId": None,
            "acceptedHeadStateRevisionId": "rev_cas_fresh",
            "canonicalPayloadHash": "a" * 64,
            "idempotencyKeyHash": "b" * 64,
            "operationId": None,
            "watermarkHash": "c" * 64,
            "actorHash": "d" * 64,
            "causationHash": "e" * 64,
            "manifestHash": "f" * 64,
            "authorityHash": "0" * 64,
            "routingCacheHash": "1" * 64,
            "causalCursorHash": "2" * 64,
            "policyRevisionId": "policy-v1",
        },
        separators=(",", ":"),
    )
    migrated.execute(
        "INSERT INTO state_revision_events ("
        "id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, "
        "revision_id, payload_json, occurred_at_ms, committed_at_ms"
        ") VALUES ('event_cas_fresh', 1, ?1, 1, 'state.revision_appended', 'harness', 'inspector', 'normal', "
        "'rev_cas_fresh', ?2, 20, 20)",
        (fresh_stream, event_payload),
    )
    parsed_event_payload = json.loads(event_payload)
    check(
        set(parsed_event_payload) == EXPECTED_STATE_REVISION_EVENT_PAYLOAD_KEYS,
        "state-revision journal payload keys drifted",
    )
    check(
        not ({"rawBody", "providerBody", "credential", "cookie", "absolutePath", "fileBytes"}
             & {str(key) for key in parsed_event_payload}),
        "state-revision journal payload contains a forbidden raw/secret field",
    )
    for digest_field in [
        "canonicalPayloadHash",
        "idempotencyKeyHash",
        "watermarkHash",
        "actorHash",
        "causationHash",
        "manifestHash",
        "authorityHash",
        "routingCacheHash",
        "causalCursorHash",
    ]:
        digest = parsed_event_payload[digest_field]
        check(
            isinstance(digest, str) and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest),
            f"state-revision journal {digest_field} must be a lower-case SHA-256 digest",
        )
    expect_database_error(
        migrated,
        "INSERT INTO state_revision_events (id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, revision_id, payload_json, occurred_at_ms, committed_at_ms) "
        "VALUES ('event_cas_gap', 1, ?1, 3, 'state.revision_appended', 'harness', 'inspector', 'normal', 'rev_cas_fresh', '{}', 21, 21)",
        (fresh_stream,),
        label="journal sequence gap",
    )
    for statement, label in [
        ("UPDATE state_revision_journals SET coverage = 'complete' WHERE stream_id = ?1", "journal metadata update"),
        ("DELETE FROM state_revision_journals WHERE stream_id = ?1", "journal metadata delete"),
        ("UPDATE state_revision_events SET payload_json = '{}' WHERE id = 'event_cas_fresh'", "journal event update"),
        ("DELETE FROM state_revision_events WHERE id = 'event_cas_fresh'", "journal event delete"),
    ]:
        expect_database_error(migrated, statement, (fresh_stream,), label=label)
    expect_database_error(
        migrated,
        "INSERT INTO state_revision_events (id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, revision_id, payload_json, occurred_at_ms, committed_at_ms) "
        "VALUES ('event_cas_cross', 1, ?1, 1, 'state.revision_appended', 'harness', 'inspector', 'normal', 'rev_cas_0', '{}', 21, 21)",
        (fresh_stream,),
        label="cross-stream journal event",
    )
    check(
        migrated.execute("SELECT sequence_no FROM state_revision_events WHERE stream_id = ?1", (fresh_stream,)).fetchall()
        == [(1,)],
        "journal event sequence changed after rejected writes",
    )
    assert_health(migrated, "v12 journal constraint fixture")

    # The append path's six mutation areas are one atomic unit: revision,
    # parent, causal edge, idempotency receipt, accepted-head projection and
    # journal event.  Simulate a late journal failure after all preceding
    # writes and prove that SQLite rolls every write back while preserving the
    # pre-existing root fact and its event.
    atomic_stream = "stream_cas_atomic"
    migrated.execute(
        "INSERT INTO conversations (id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES ('conversation_cas_atomic', 'profile_cas', 'CAS atomic', 30, 30, '{}')"
    )
    migrated.execute(
        "INSERT INTO conversation_branches (id, conversation_id, name, created_at_ms) "
        "VALUES ('branch_cas_atomic', 'conversation_cas_atomic', 'main', 30)"
    )
    migrated.execute(
        "INSERT INTO state_revision_streams (id, profile_id, project_id, conversation_id, branch_id, created_at_ms) "
        "VALUES (?1, 'profile_cas', NULL, 'conversation_cas_atomic', 'branch_cas_atomic', 30)",
        (atomic_stream,),
    )
    migrated.execute(
        "INSERT INTO state_revision_heads (stream_id, accepted_revision_id, branch_sequence, updated_at_ms) "
        "VALUES (?1, NULL, 0, 30)",
        (atomic_stream,),
    )
    migrated.execute(
        "INSERT INTO state_revision_journals (stream_id, schema_version, journal_epoch, coverage, coverage_reason, created_at_ms) "
        "VALUES (?1, 1, 'journal_epoch_atomic', 'complete', NULL, 30)",
        (atomic_stream,),
    )
    insert_revision(migrated, "rev_cas_atomic_root", atomic_stream, sequence=0, state_digest="a" * 64)
    migrated.execute(
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_atomic_root', branch_sequence = 0 "
        "WHERE stream_id = ?1",
        (atomic_stream,),
    )
    migrated.execute(
        "INSERT INTO state_revision_idempotency (stream_id, idempotency_key_hash, canonical_payload_hash, result_revision_id, receipt_json, created_at_ms) "
        "VALUES (?1, ?2, ?3, 'rev_cas_atomic_root', ?4, 30)",
        (
            atomic_stream,
            "c" * 64,
            "a" * 64,
            json.dumps(
                {
                    "schemaVersion": 1,
                    "outcome": "applied",
                    "revisionId": "rev_cas_atomic_root",
                    "streamId": atomic_stream,
                    "acceptedHeadStateRevisionId": "rev_cas_atomic_root",
                    "expectedHeadStateRevisionId": None,
                    "branchSequence": 0,
                    "canonicalPayloadHash": "a" * 64,
                    "journalEpoch": "journal_epoch_atomic",
                    "journalSequence": 1,
                    "journalEventId": "event_cas_atomic_root",
                },
                separators=(",", ":"),
            ),
        ),
    )
    migrated.execute(
        "INSERT INTO state_revision_events (id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, revision_id, payload_json, occurred_at_ms, committed_at_ms) "
        "VALUES ('event_cas_atomic_root', 1, ?1, 1, 'state.revision_appended', 'harness', 'inspector', 'normal', 'rev_cas_atomic_root', ?2, 30, 30)",
        (
            atomic_stream,
            make_journal_event_payload(
                atomic_stream,
                "rev_cas_atomic_root",
                kind="root",
                status="accepted",
                branch_sequence=0,
                observed=None,
                expected=None,
                accepted="rev_cas_atomic_root",
                canonical_hash="a" * 64,
                idempotency_hash="c" * 64,
            ),
        ),
    )
    migrated.commit()
    before_atomic = {
        "state_revisions": migrated.execute(
            "SELECT COUNT(*) FROM state_revisions WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_parents": migrated.execute(
            "SELECT COUNT(*) "
            "FROM state_revision_parents parent "
            "JOIN state_revisions revision "
            "  ON revision.id = parent.revision_id "
            "WHERE revision.stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_edges": migrated.execute(
            "SELECT COUNT(*) "
            "FROM state_revision_edges edge "
            "JOIN state_revisions revision "
            "  ON revision.id = edge.from_revision_id "
            "WHERE revision.stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_idempotency": migrated.execute(
            "SELECT COUNT(*) FROM state_revision_idempotency WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_events": migrated.execute(
            "SELECT COUNT(*) FROM state_revision_events WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
    }
    before_atomic_head = migrated.execute(
        "SELECT accepted_revision_id, branch_sequence FROM state_revision_heads WHERE stream_id = ?1",
        (atomic_stream,),
    ).fetchone()
    try:
        migrated.execute("BEGIN")
        insert_revision(
            migrated,
            "rev_cas_atomic_child",
            atomic_stream,
            kind="continuation",
            sequence=1,
            observed="rev_cas_atomic_root",
            expected="rev_cas_atomic_root",
            state_digest="b" * 64,
        )
        migrated.execute(
            "INSERT INTO state_revision_parents (revision_id, parent_revision_id, ordinal) "
            "VALUES ('rev_cas_atomic_child', 'rev_cas_atomic_root', 0)"
        )
        migrated.execute(
            "INSERT INTO state_revision_edges (id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms) "
            "VALUES ('edge_cas_atomic_child', 'continues-from', 'rev_cas_atomic_child', 'rev_cas_atomic_root', 'op_cas_atomic_child', '{}', 'policy-v1', 31)"
        )
        migrated.execute(
            "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_atomic_child', branch_sequence = 1, updated_at_ms = 31 "
            "WHERE stream_id = ?1",
            (atomic_stream,),
        )
        migrated.execute(
            "INSERT INTO state_revision_idempotency (stream_id, idempotency_key_hash, canonical_payload_hash, result_revision_id, receipt_json, created_at_ms) "
            "VALUES (?1, ?2, ?3, 'rev_cas_atomic_child', ?4, 31)",
            (
                atomic_stream,
                "d" * 64,
                "b" * 64,
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "outcome": "applied",
                        "revisionId": "rev_cas_atomic_child",
                        "streamId": atomic_stream,
                        "acceptedHeadStateRevisionId": "rev_cas_atomic_child",
                    "expectedHeadStateRevisionId": "rev_cas_atomic_root",
                    "branchSequence": 1,
                    "canonicalPayloadHash": "b" * 64,
                    "journalEpoch": "journal_epoch_atomic",
                    "journalSequence": 2,
                    "journalEventId": "event_cas_atomic_child",
                },
                    separators=(",", ":"),
                ),
            ),
        )
        # Existing sequence 1 means sequence 3 is an intentional late failure;
        # the sequence guard fires only after all other mutation areas exist.
        migrated.execute(
            "INSERT INTO state_revision_events (id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, revision_id, payload_json, occurred_at_ms, committed_at_ms) "
            "VALUES ('event_cas_atomic_child', 1, ?1, 3, 'state.revision_appended', 'harness', 'inspector', 'normal', 'rev_cas_atomic_child', '{}', 31, 31)",
            (atomic_stream,),
        )
    except sqlite3.DatabaseError:
        migrated.rollback()
    else:
        fail("late journal failure unexpectedly committed the atomic mutation")
    after_atomic = {
        "state_revisions": migrated.execute(
            "SELECT COUNT(*) FROM state_revisions WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_parents": migrated.execute(
            "SELECT COUNT(*) "
            "FROM state_revision_parents parent "
            "JOIN state_revisions revision "
            "  ON revision.id = parent.revision_id "
            "WHERE revision.stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_edges": migrated.execute(
            "SELECT COUNT(*) "
            "FROM state_revision_edges edge "
            "JOIN state_revisions revision "
            "  ON revision.id = edge.from_revision_id "
            "WHERE revision.stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_idempotency": migrated.execute(
            "SELECT COUNT(*) FROM state_revision_idempotency WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
        "state_revision_events": migrated.execute(
            "SELECT COUNT(*) FROM state_revision_events WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()[0],
    }
    check(after_atomic == before_atomic, f"late journal failure left partial mutation rows: {after_atomic!r}")
    check(
        migrated.execute(
            "SELECT accepted_revision_id, branch_sequence FROM state_revision_heads WHERE stream_id = ?1",
            (atomic_stream,),
        ).fetchone()
        == before_atomic_head,
        "late journal failure changed the accepted-head projection",
    )
    check(
        migrated.execute(
            "SELECT 1 FROM state_revisions WHERE id = 'rev_cas_atomic_child'"
        ).fetchone()
        is None,
        "late journal failure left the child revision behind",
    )
    assert_health(migrated, "v12 atomic rollback fixture")

    rollback = prepare_v11_fixture(schema_v10, state_revision_tail)
    seed_scope_fixture(rollback)
    try:
        rollback.executescript(journal_migration_sql(journal_tail, checksum, fail_after=True))
    except sqlite3.DatabaseError:
        rollback.rollback()
    else:
        fail("intentional v12 migration failure unexpectedly committed")
    check(rollback.execute("PRAGMA user_version").fetchone() == (11,), "failed v12 migration changed PRAGMA user_version")
    check(
        rollback.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone() == (11,),
        "failed v12 migration changed schema_meta",
    )
    check(not (EXPECTED_V12_TABLES & object_names(rollback, "table")), "failed v12 migration left journal tables behind")
    check(
        rollback.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1", (STATE_REVISION_JOURNAL_MIGRATION_ID,)
        ).fetchone()
        == (0,),
        "failed v12 migration left a v12 migration receipt behind",
    )
    assert_health(rollback, "rolled-back v11->v12", include_journal=False)
    return migrated, rollback


def prepare_v12_fixture(
    schema_v10: str,
    state_revision_tail: str,
    journal_tail: str,
) -> sqlite3.Connection:
    """Create a committed v12 fixture without running the v12 assertions."""
    checksum = hashlib.sha256(journal_tail.encode("utf-8")).hexdigest()
    connection = prepare_v11_fixture(schema_v10, state_revision_tail)
    seed_scope_fixture(connection)
    connection.executescript(journal_migration_sql(journal_tail, checksum))
    connection.execute("PRAGMA user_version = 12")
    connection.commit()
    assert_health(connection, "v12 fixture")
    check(
        connection.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (12,),
        "v12 fixture did not retain schema_meta.schema_version=12",
    )
    return connection


def sql_literal(value: object) -> str:
    """Encode a small migration-fixture value as a safe SQLite literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def operation_fact_migration_sql(
    operation_fact_tail: str,
    fact_rows: Iterable[tuple[str, str | None, str | None, str | None, str]],
    checksum: str,
    *,
    fail_after: bool = False,
) -> str:
    """Mirror the native v12 -> v13 operation-fact migration transaction."""
    body = ["BEGIN", operation_fact_tail]
    for revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage in fact_rows:
        body.append(
            "INSERT INTO state_revision_operation_facts ("
            "revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage, created_at_ms"
            ") VALUES ("
            f"{sql_literal(revision_id)}, {sql_literal(operation_id)}, "
            f"{sql_literal(causal_cursor_json)}, {sql_literal(policy_revision_id)}, "
            f"{sql_literal(coverage)}, 4)"
        )
    body.extend(
        [
            "UPDATE schema_meta SET schema_version = 13, min_app_version = '0.12.0', updated_at_ms = 4 WHERE singleton = 1",
            "INSERT INTO schema_migrations (migration_id, checksum_sha256, started_at_ms, completed_at_ms, duration_ms, app_version) "
            f"VALUES ('{STATE_REVISION_OPERATION_FACT_MIGRATION_ID}', '{checksum}', 4, 4, 0, '{STATE_REVISION_OPERATION_FACT_MIGRATION_APP_VERSION}')",
        ]
    )
    if fail_after:
        body.append("INSERT INTO state_revision_operation_fact_table_that_must_not_exist VALUES (1)")
    else:
        body.append("COMMIT")
    return ";\n".join(body) + ";\n"


def canonical_json_object(value: object) -> bool:
    """Match the native migration's valid-object-and-canonical JSON check."""
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(parsed, dict):
        return False
    # serde_json serializes object maps in their canonical BTreeMap order in
    # the native build (the crate's `preserve_order` feature is not enabled).
    # Match that byte-level writer contract here instead of accepting the
    # historical insertion order supplied by SQLite fixtures.  A migration
    # must not claim a cursor is recoverable when native replay would mark it
    # legacy-partial solely because object keys are arranged differently.
    return json.dumps(parsed, separators=(",", ":"), ensure_ascii=False, sort_keys=True) == value


def infer_operation_fact_rows(
    connection: sqlite3.Connection,
) -> list[tuple[str, str | None, str | None, str | None, str]]:
    """Infer the exact v13 migration output without inventing historical facts."""
    revisions = connection.execute(
        "SELECT id FROM state_revisions ORDER BY created_at_ms, id"
    ).fetchall()
    inferred: list[tuple[str, str | None, str | None, str | None, str]] = []
    for (revision_id,) in revisions:
        edge_rows = connection.execute(
            "SELECT operation_id, causal_cursor_json, policy_revision_id "
            "FROM state_revision_edges "
            "WHERE from_revision_id = ?1 "
            "ORDER BY created_at_ms, id",
            (revision_id,),
        ).fetchall()
        recovered: tuple[str | None, str, str] | None = None
        if edge_rows:
            first = tuple(edge_rows[0])
            if (
                all(tuple(candidate) == first for candidate in edge_rows)
                and canonical_json_object(first[1])
                and isinstance(first[2], str)
                and 1 <= len(first[2]) <= 256
            ):
                recovered = first  # type: ignore[assignment]
        if recovered is None:
            inferred.append((str(revision_id), None, None, None, "legacy-partial"))
        else:
            operation_id, causal_cursor_json, policy_revision_id = recovered
            inferred.append(
                (
                    str(revision_id),
                    operation_id,
                    causal_cursor_json,
                    policy_revision_id,
                    "complete",
                )
            )
    return inferred


def verify_operation_fact_migration(
    schema_v10: str,
    state_revision_tail: str,
    journal_tail: str,
    operation_fact_tail: str,
    migrated_v12: sqlite3.Connection,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    """Verify v13 backfill, immutable constraints, and transactional rollback."""
    checksum = hashlib.sha256(operation_fact_tail.encode("utf-8")).hexdigest()

    # Add one recoverable edge, one conflicting operation history, and one
    # non-object cursor before v13.  The migration must preserve uncertainty
    # as legacy-partial rather than fabricating metadata.
    # `verify_journal_migration` deliberately starts from a minimal v11
    # fixture.  Create an explicit root in the same stream before adding the
    # v13 migration cases; referring to the `rev_cas_2` helper row from the
    # separate v11 constraint fixture would incorrectly exercise the real
    # cross-stream/missing-parent guard instead of the operation-fact rules.
    insert_revision(
        migrated_v12,
        "rev_fact_root",
        "stream_cas_2",
        kind="root",
        sequence=0,
        state_digest="9" * 64,
    )
    insert_revision(
        migrated_v12,
        "rev_fact_complete",
        "stream_cas_2",
        kind="continuation",
        sequence=1,
        state_digest="a" * 64,
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_complete', 'continues-from', 'rev_fact_complete', 'rev_fact_root', "
        "'op_fact_complete', '{\"journalSequence\":1}', 'policy-v13', 40)"
    )
    insert_revision(
        migrated_v12,
        "rev_fact_conflict",
        "stream_cas_2",
        kind="continuation",
        sequence=2,
        state_digest="b" * 64,
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_conflict_a', 'continues-from', 'rev_fact_conflict', 'rev_fact_complete', "
        "'op_fact_a', '{}', 'policy-v13', 41)"
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_conflict_b', 'derives-selected-delta-from', 'rev_fact_conflict', 'rev_fact_root', "
        "'op_fact_b', '{}', 'policy-v13', 42)"
    )
    insert_revision(
        migrated_v12,
        "rev_fact_invalid_cursor",
        "stream_cas_2",
        kind="continuation",
        sequence=3,
        state_digest="c" * 64,
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_invalid_cursor', 'continues-from', 'rev_fact_invalid_cursor', 'rev_fact_conflict', "
        "'op_fact_invalid', '[]', 'policy-v13', 43)"
    )
    insert_revision(
        migrated_v12,
        "rev_fact_optional_operation",
        "stream_cas_2",
        kind="continuation",
        sequence=4,
        state_digest="e" * 64,
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_optional_operation', 'continues-from', 'rev_fact_optional_operation', 'rev_fact_invalid_cursor', "
        "NULL, '{\"journalSequence\":2}', 'policy-v13', 44)"
    )
    insert_revision(
        migrated_v12,
        "rev_fact_noncanonical_cursor",
        "stream_cas_2",
        kind="continuation",
        sequence=5,
        state_digest="f" * 64,
    )
    migrated_v12.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_fact_noncanonical_cursor', 'continues-from', 'rev_fact_noncanonical_cursor', 'rev_fact_optional_operation', "
        "'op_fact_noncanonical', '{\"b\":2,\"a\":1}', 'policy-v13', 45)"
    )
    migrated_v12.commit()

    expected_rows = infer_operation_fact_rows(migrated_v12)
    migrated_v12.executescript(
        operation_fact_migration_sql(operation_fact_tail, expected_rows, checksum)
    )
    migrated_v12.execute("PRAGMA user_version = 13")
    migrated_v12.commit()
    assert_health(migrated_v12, "migrated v12->v13", include_operation_facts=True)
    check(migrated_v12.execute("PRAGMA user_version").fetchone() == (13,), "migrated v13 user_version != 13")
    check(
        migrated_v12.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (13,),
        "migrated v13 schema_meta.schema_version != 13",
    )
    receipt = migrated_v12.execute(
        "SELECT migration_id, checksum_sha256, app_version, completed_at_ms "
        "FROM schema_migrations WHERE migration_id = ?1",
        (STATE_REVISION_OPERATION_FACT_MIGRATION_ID,),
    ).fetchone()
    check(
        receipt
        == (
            STATE_REVISION_OPERATION_FACT_MIGRATION_ID,
            checksum,
            STATE_REVISION_OPERATION_FACT_MIGRATION_APP_VERSION,
            4,
        ),
        f"v13 migration receipt mismatch: {receipt!r}",
    )

    revision_count = migrated_v12.execute("SELECT COUNT(*) FROM state_revisions").fetchone()[0]
    fact_count = migrated_v12.execute("SELECT COUNT(*) FROM state_revision_operation_facts").fetchone()[0]
    check(fact_count == revision_count, f"v13 operation-fact count mismatch: revisions={revision_count}, facts={fact_count}")
    actual_rows = migrated_v12.execute(
        "SELECT revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage "
        "FROM state_revision_operation_facts ORDER BY revision_id"
    ).fetchall()
    check(
        actual_rows == sorted(expected_rows),
        "v13 operation-fact backfill differs from recoverable edge metadata",
    )
    check(
        migrated_v12.execute(
            "SELECT operation_id, causal_cursor_json, policy_revision_id, coverage "
            "FROM state_revision_operation_facts WHERE revision_id = 'rev_fact_complete'"
        ).fetchone()
        == ("op_fact_complete", '{"journalSequence":1}', "policy-v13", "complete"),
        "v13 recoverable operation fact metadata drifted",
    )
    for revision_id in (
        "rev_fact_root",
        "rev_fact_conflict",
        "rev_fact_invalid_cursor",
        "rev_fact_noncanonical_cursor",
    ):
        check(
            migrated_v12.execute(
                "SELECT operation_id, causal_cursor_json, policy_revision_id, coverage "
                "FROM state_revision_operation_facts WHERE revision_id = ?1",
                (revision_id,),
            ).fetchone()
            == (None, None, None, "legacy-partial"),
            f"v13 legacy operation fact fabricated metadata for {revision_id}",
        )
    check(
        migrated_v12.execute(
            "SELECT operation_id, causal_cursor_json, policy_revision_id, coverage "
            "FROM state_revision_operation_facts WHERE revision_id = 'rev_fact_optional_operation'"
        ).fetchone()
        == (None, '{"journalSequence":2}', "policy-v13", "complete"),
        "v13 nullable operation_id should remain recoverable when cursor and policy metadata agree",
    )

    expect_database_error(
        migrated_v12,
        "INSERT INTO state_revision_operation_facts (revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage, created_at_ms) "
        "VALUES ('missing_fact_revision', 'op', '{}', 'policy-v13', 'complete', 5)",
        label="v13 operation fact missing revision",
    )
    expect_database_error(
        migrated_v12,
        "INSERT INTO state_revision_operation_facts (revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage, created_at_ms) "
        "VALUES ('rev_fact_complete', 'op', NULL, 'policy-v13', 'complete', 5)",
        label="v13 incomplete operation fact cursor",
    )
    expect_database_error(
        migrated_v12,
        "INSERT INTO state_revision_operation_facts (revision_id, operation_id, causal_cursor_json, policy_revision_id, coverage, created_at_ms) "
        "VALUES ('rev_fact_complete', 'op', '{}', NULL, 'complete', 5)",
        label="v13 incomplete operation fact policy",
    )
    expect_database_error(
        migrated_v12,
        "UPDATE state_revision_operation_facts SET coverage = 'legacy-partial' WHERE revision_id = 'rev_fact_complete'",
        label="v13 operation fact immutable update",
    )
    expect_database_error(
        migrated_v12,
        "DELETE FROM state_revision_operation_facts WHERE revision_id = 'rev_fact_complete'",
        label="v13 operation fact immutable delete",
    )
    check(
        migrated_v12.execute("SELECT COUNT(*) FROM state_revision_operation_facts").fetchone()
        == (revision_count,),
        "rejected v13 operation-fact writes changed row count",
    )
    migrated_v12.commit()

    rollback = prepare_v12_fixture(schema_v10, state_revision_tail, journal_tail)
    insert_revision(rollback, "rev_fact_rollback", "stream_cas_1", sequence=0, state_digest="d" * 64)
    rollback.commit()
    rollback_facts = infer_operation_fact_rows(rollback)
    before_rollback = {
        "schema_version": rollback.execute(
            "SELECT schema_version FROM schema_meta WHERE singleton = 1"
        ).fetchone()[0],
        "revision_count": rollback.execute("SELECT COUNT(*) FROM state_revisions").fetchone()[0],
        "journal_count": rollback.execute("SELECT COUNT(*) FROM state_revision_journals").fetchone()[0],
        "event_count": rollback.execute("SELECT COUNT(*) FROM state_revision_events").fetchone()[0],
    }
    try:
        rollback.executescript(
            operation_fact_migration_sql(
                operation_fact_tail,
                rollback_facts,
                checksum,
                fail_after=True,
            )
        )
    except sqlite3.DatabaseError:
        rollback.rollback()
    else:
        fail("intentional v13 migration failure unexpectedly committed")
    check(rollback.execute("PRAGMA user_version").fetchone() == (12,), "failed v13 migration changed PRAGMA user_version")
    check(
        rollback.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (before_rollback["schema_version"],),
        "failed v13 migration changed schema_meta",
    )
    for kind, expected_names in (
        ("table", EXPECTED_V13_TABLES),
        ("index", EXPECTED_V13_INDEXES),
        ("trigger", EXPECTED_V13_TRIGGERS),
    ):
        check(
            not (expected_names & object_names(rollback, kind)),
            f"failed v13 migration left operation-fact {kind}s behind",
        )
    check(
        rollback.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
            (STATE_REVISION_OPERATION_FACT_MIGRATION_ID,),
        ).fetchone()
        == (0,),
        "failed v13 migration left an operation-fact migration receipt behind",
    )
    after_rollback = {
        "schema_version": rollback.execute(
            "SELECT schema_version FROM schema_meta WHERE singleton = 1"
        ).fetchone()[0],
        "revision_count": rollback.execute("SELECT COUNT(*) FROM state_revisions").fetchone()[0],
        "journal_count": rollback.execute("SELECT COUNT(*) FROM state_revision_journals").fetchone()[0],
        "event_count": rollback.execute("SELECT COUNT(*) FROM state_revision_events").fetchone()[0],
    }
    check(after_rollback == before_rollback, f"failed v13 migration changed v12 data: {after_rollback!r}")
    assert_health(rollback, "rolled-back v12->v13")
    return migrated_v12, rollback


def provider_lineage_migration_sql(
    lineage_tail: str,
    checksum: str,
    *,
    fail_after: bool = False,
) -> str:
    """Mirror the native v13 -> v14 additive lineage migration transaction."""
    body = [
        "BEGIN",
        lineage_tail,
        "UPDATE schema_meta SET schema_version = 14, min_app_version = '0.13.0', updated_at_ms = 5 WHERE singleton = 1",
        "INSERT INTO schema_migrations (migration_id, checksum_sha256, started_at_ms, completed_at_ms, duration_ms, app_version) "
        f"VALUES ('{PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID}', '{checksum}', 5, 5, 0, '{PROVIDER_ATTEMPT_LINEAGE_MIGRATION_APP_VERSION}')",
    ]
    if fail_after:
        body.append("INSERT INTO provider_attempt_lineage_fact_table_that_must_not_exist VALUES (1)")
    else:
        body.append("COMMIT")
    return ";\n".join(body) + ";\n"


def prepare_v13_fixture(
    schema_v10: str,
    state_revision_tail: str,
    journal_tail: str,
    operation_fact_tail: str,
) -> sqlite3.Connection:
    """Create a committed v13 fixture without running v14 assertions."""
    checksum = hashlib.sha256(operation_fact_tail.encode("utf-8")).hexdigest()
    connection = prepare_v12_fixture(schema_v10, state_revision_tail, journal_tail)
    fact_rows = infer_operation_fact_rows(connection)
    connection.executescript(operation_fact_migration_sql(operation_fact_tail, fact_rows, checksum))
    connection.execute("PRAGMA user_version = 13")
    connection.commit()
    assert_health(connection, "v13 fixture", include_operation_facts=True)
    check(
        connection.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (13,),
        "v13 fixture did not retain schema_meta.schema_version=13",
    )
    return connection


def seed_provider_lineage_fixture(connection: sqlite3.Connection) -> None:
    """Seed the minimum native scope needed to exercise v14 DDL.

    The fixture intentionally uses synthetic opaque identifiers and hashes.  It
    does not contain a provider secret, URL credential, prompt body, cookie, or
    file bytes; the lineage table must remain metadata-only by construction.
    """
    connection.execute(
        "INSERT INTO provider_profiles ("
        "id, profile_id, provider_type, display_name, normalized_base_url, "
        "credential_ref, auth_scheme, config_json, egress_policy_json, enabled, "
        "created_at_ms, updated_at_ms"
        ") VALUES ('provider_v14_a', 'profile_default', 'openai_compatible', "
        "'v14 provider A', 'https://provider-a.example/v1', NULL, 'bearer', '{}', '{}', 1, 10, 10)"
    )
    connection.execute(
        "INSERT INTO provider_profiles ("
        "id, profile_id, provider_type, display_name, normalized_base_url, "
        "credential_ref, auth_scheme, config_json, egress_policy_json, enabled, "
        "created_at_ms, updated_at_ms"
        ") VALUES ('provider_v14_b', 'profile_default', 'openai_compatible', "
        "'v14 provider B', 'https://provider-b.example/v1', NULL, 'bearer', '{}', '{}', 1, 10, 10)"
    )
    connection.execute(
        "INSERT INTO conversations (id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES ('conversation_v14_a', 'profile_default', 'v14 lineage', 10, 10, '{}')"
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, name, created_at_ms) "
        "VALUES ('branch_v14_a', 'conversation_v14_a', 'main', 10)"
    )
    connection.execute(
        "INSERT INTO generations ("
        "id, conversation_id, branch_id, provider_profile_id, model_id, state, "
        "request_parameters_json, created_at_ms"
        ") VALUES ('run_v14_a', 'conversation_v14_a', 'branch_v14_a', 'provider_v14_a', "
        "'model-v14-a', 'queued', '{}', 10)"
    )
    connection.execute(
        "INSERT INTO run_attempts ("
        "id, generation_id, ordinal, provider_profile_id, model_id, state, created_at_ms"
        ") VALUES ('attempt_v14_a', 'run_v14_a', 1, 'provider_v14_a', 'model-v14-a', 'created', 10)"
    )
    connection.execute(
        "INSERT INTO frozen_provider_inputs ("
        "id, schema_version, attempt_id, run_id, provider_profile_id, model_id, "
        "messages_json, parameters_json, content_sha256, created_at_ms"
        ") VALUES ('provider_input_v14_a', 1, 'attempt_v14_a', 'run_v14_a', 'provider_v14_a', "
        "'model-v14-a', '[{\"role\":\"user\",\"content\":\"fixture\"}]', '{}', ?1, 10)",
        ("a" * 64,),
    )
    connection.commit()


def lineage_fact_values(
    *,
    fact_id: str = "lineage_v14_a",
    frozen_input_id: str = "provider_input_v14_a",
    run_id: str = "run_v14_a",
    attempt_id: str = "attempt_v14_a",
    provider_profile_id: str = "provider_v14_a",
    model_id: str = "model-v14-a",
    input_content_sha256: str = "a" * 64,
    lineage_sha256: str = "b" * 64,
    created_at_ms: int = 10,
) -> tuple[object, ...]:
    """Return one safe, bounded v14 row in schema column order."""
    return (
        fact_id,
        1,
        frozen_input_id,
        run_id,
        attempt_id,
        provider_profile_id,
        model_id,
        1,
        "c" * 64,
        "d" * 64,
        "adapter-v14",
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        "e" * 64,
        "balanced",
        "balanced",
        None,
        None,
        None,
        None,
        input_content_sha256,
        lineage_sha256,
        created_at_ms,
    )


PROVIDER_LINEAGE_INSERT_COLUMNS = (
    "id, schema_version, frozen_provider_input_id, run_id, attempt_id, provider_profile_id, model_id, "
    "provider_definition_schema_version, provider_definition_sha256, endpoint_fingerprint_sha256, adapter_revision, "
    "catalog_snapshot_id, catalog_snapshot_sha256, model_descriptor_revision_id, model_descriptor_sha256, "
    "model_capability_snapshot_id, model_capability_snapshot_sha256, route_revision_id, routing_decision_receipt_id, "
    "retry_policy_revision_id, cache_policy_revision_id, cache_plan_id, price_snapshot_id, price_snapshot_sha256, "
    "parameter_profile_revision_id, resolved_parameters_sha256, requested_effort, effective_effort, context_manifest_id, "
    "context_manifest_sha256, authority_continuity_record_id, data_classification_revision_id, input_content_sha256, "
    "lineage_sha256, created_at_ms"
)


def insert_provider_lineage_fact(
    connection: sqlite3.Connection,
    values: tuple[object, ...],
) -> None:
    placeholders = ", ".join("?" for _ in values)
    connection.execute(
        f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({placeholders})",
        values,
    )


def verify_provider_lineage_migration(
    schema_v10: str,
    state_revision_tail: str,
    journal_tail: str,
    operation_fact_tail: str,
    lineage_tail: str,
    migrated_v13: sqlite3.Connection,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    """Verify v14 DDL, exact scope, paired unknowns, immutability and rollback."""
    checksum = hashlib.sha256(lineage_tail.encode("utf-8")).hexdigest()
    seed_provider_lineage_fixture(migrated_v13)
    before_objects = object_rows(migrated_v13)
    migrated_v13.executescript(provider_lineage_migration_sql(lineage_tail, checksum))
    migrated_v13.execute("PRAGMA user_version = 14")
    migrated_v13.commit()
    assert_health(
        migrated_v13,
        "migrated v13->v14",
        include_operation_facts=True,
        include_provider_lineage=True,
    )
    after_objects = object_rows(migrated_v13)
    check(
        before_objects <= after_objects,
        "v14 migration changed or removed pre-existing schema objects",
    )
    added_objects = {(kind, name) for kind, name, _ in after_objects - before_objects}
    expected_objects = (
        {("table", name) for name in EXPECTED_V14_TABLES}
        | {("index", name) for name in EXPECTED_V14_INDEXES}
        | {("trigger", name) for name in EXPECTED_V14_TRIGGERS}
    )
    check(
        added_objects == expected_objects,
        "v14 migration object inventory drifted: "
        f"missing={sorted(expected_objects - added_objects)!r}, "
        f"unexpected={sorted(added_objects - expected_objects)!r}",
    )
    check(
        migrated_v13.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (14,),
        "migrated v14 schema_meta.schema_version != 14",
    )
    check(
        migrated_v13.execute(
            "SELECT migration_id, checksum_sha256, app_version, completed_at_ms "
            "FROM schema_migrations WHERE migration_id = ?1",
            (PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,),
        ).fetchone()
        == (
            PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,
            checksum,
            PROVIDER_ATTEMPT_LINEAGE_MIGRATION_APP_VERSION,
            5,
        ),
        "v14 migration receipt mismatch",
    )

    insert_provider_lineage_fact(migrated_v13, lineage_fact_values())
    migrated_v13.commit()
    check(
        migrated_v13.execute("SELECT COUNT(*) FROM provider_attempt_lineage_facts").fetchone()
        == (1,),
        "v14 lineage fixture row was not persisted",
    )
    columns = [row[1] for row in migrated_v13.execute(
        "PRAGMA table_info(provider_attempt_lineage_facts)"
    ).fetchall()]
    check(
        tuple(columns) == EXPECTED_V14_COLUMNS,
        "v14 lineage table column order/inventory drifted",
    )
    check(
        "credential" not in {name.lower() for name in columns}
        and "prompt" not in {name.lower() for name in columns}
        and "raw_url" not in {name.lower() for name in columns}
        and "cookie" not in {name.lower() for name in columns}
        and "file_bytes" not in {name.lower() for name in columns},
        "v14 lineage table exposes a forbidden raw/secret column",
    )

    # Required fingerprints are strict lower-case SHA-256 values. Exercise
    # both representation and length guards explicitly so malformed
    # provenance cannot become trusted facts if the DDL is relaxed later.
    for column, value in (
        ("provider_definition_sha256", "A" * 64),
        ("endpoint_fingerprint_sha256", "z" * 64),
        ("resolved_parameters_sha256", "0" * 63),
        ("input_content_sha256", "A" * 64),
        ("lineage_sha256", "1" * 63),
    ):
        values = list(lineage_fact_values(fact_id=f"lineage_bad_hash_{column}"))
        values[columns.index(column)] = value
        expect_database_error(
            migrated_v13,
            f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({', '.join('?' for _ in values)})",
            values,
            label=f"v14 malformed {column}",
        )

    # Optional provenance is unknown only when both members of an ID/hash pair
    # are NULL.  Empty strings, one-sided pairs, and upper-case/non-SHA hashes
    # must not be accepted as a substitute for unavailable evidence.
    for column, value in (
        ("catalog_snapshot_id", ""),
        ("adapter_revision", ""),
        ("requested_effort", ""),
    ):
        values = list(lineage_fact_values(fact_id=f"lineage_bad_{column}"))
        index = columns.index(column)
        values[index] = value
        expect_database_error(
            migrated_v13,
            f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({', '.join('?' for _ in values)})",
            values,
            label=f"v14 invalid empty {column}",
        )
    for id_column, hash_column in (
        ("catalog_snapshot_id", "catalog_snapshot_sha256"),
        ("model_descriptor_revision_id", "model_descriptor_sha256"),
        ("model_capability_snapshot_id", "model_capability_snapshot_sha256"),
        ("price_snapshot_id", "price_snapshot_sha256"),
        ("context_manifest_id", "context_manifest_sha256"),
    ):
        values = list(lineage_fact_values(fact_id=f"lineage_bad_pair_{id_column}"))
        values[columns.index(id_column)] = "snapshot-v14"
        expect_database_error(
            migrated_v13,
            f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({', '.join('?' for _ in values)})",
            values,
            label=f"v14 unpaired {id_column}/{hash_column}",
        )

    # Scope and input-content guards reject cross-run, cross-attempt,
    # cross-profile/model, and stale frozen-input hash combinations.
    for label, kwargs in (
        ("cross run", {"run_id": "run_missing_v14"}),
        ("cross attempt", {"attempt_id": "attempt_missing_v14"}),
        ("cross provider profile", {"provider_profile_id": "provider_v14_b"}),
        ("cross model", {"model_id": "model-v14-b"}),
        ("input hash mismatch", {"input_content_sha256": "f" * 64}),
    ):
        values = list(lineage_fact_values(fact_id=f"lineage_bad_scope_{label.replace(' ', '_')}", **kwargs))
        expect_database_error(
            migrated_v13,
            f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({', '.join('?' for _ in values)})",
            values,
            label=f"v14 {label}",
        )

    # Duplicate frozen-input facts and every mutation path are hard failures.
    duplicate_values = lineage_fact_values(fact_id="lineage_v14_duplicate")
    expect_database_error(
        migrated_v13,
        f"INSERT INTO provider_attempt_lineage_facts ({PROVIDER_LINEAGE_INSERT_COLUMNS}) VALUES ({', '.join('?' for _ in duplicate_values)})",
        duplicate_values,
        label="v14 duplicate frozen-input fact",
    )
    expect_database_error(
        migrated_v13,
        "UPDATE provider_attempt_lineage_facts SET lineage_sha256 = ?1 WHERE id = 'lineage_v14_a'",
        ("f" * 64,),
        label="v14 lineage immutable update",
    )
    expect_database_error(
        migrated_v13,
        "DELETE FROM provider_attempt_lineage_facts WHERE id = 'lineage_v14_a'",
        label="v14 lineage immutable delete",
    )
    check(
        migrated_v13.execute(
            "SELECT input_content_sha256, lineage_sha256 FROM provider_attempt_lineage_facts WHERE id = 'lineage_v14_a'"
        ).fetchone()
        == ("a" * 64, "b" * 64),
        "v14 rejected/tamper attempts changed the original lineage fact",
    )

    # A semantic retry gets a new frozen input and fact; the first fact remains
    # byte-for-byte unchanged.  This fixture uses a second attempt in the same
    # generation so historical provider lineage cannot be overwritten.
    migrated_v13.execute(
        "INSERT INTO run_attempts (id, generation_id, ordinal, provider_profile_id, model_id, state, created_at_ms) "
        "VALUES ('attempt_v14_retry', 'run_v14_a', 2, 'provider_v14_a', 'model-v14-a', 'created', 11)"
    )
    migrated_v13.execute(
        "INSERT INTO frozen_provider_inputs ("
        "id, schema_version, attempt_id, run_id, provider_profile_id, model_id, messages_json, parameters_json, content_sha256, created_at_ms"
        ") VALUES ('provider_input_v14_retry', 1, 'attempt_v14_retry', 'run_v14_a', 'provider_v14_a', 'model-v14-a', "
        "'[{\"role\":\"user\",\"content\":\"retry\"}]', '{}', ?1, 11)",
        ("f" * 64,),
    )
    retry_values = lineage_fact_values(
        fact_id="lineage_v14_retry",
        frozen_input_id="provider_input_v14_retry",
        attempt_id="attempt_v14_retry",
        input_content_sha256="f" * 64,
        lineage_sha256="1" * 64,
        created_at_ms=11,
    )
    insert_provider_lineage_fact(migrated_v13, retry_values)
    migrated_v13.commit()
    check(
        migrated_v13.execute("SELECT COUNT(*) FROM provider_attempt_lineage_facts").fetchone()
        == (2,),
        "v14 retry did not append a successor lineage fact",
    )
    check(
        migrated_v13.execute(
            "SELECT lineage_sha256 FROM provider_attempt_lineage_facts WHERE id = 'lineage_v14_a'"
        ).fetchone()
        == ("b" * 64,),
        "v14 retry mutated the original lineage fact",
    )
    # Build a separate v13 fixture to verify atomic rollback of the DDL and
    # schema receipt.  The SQL check is independent of the Rust migrator.
    rollback = prepare_v13_fixture(schema_v10, state_revision_tail, journal_tail, operation_fact_tail)
    before = {
        "schema_version": rollback.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()[0],
        "provider_count": rollback.execute("SELECT COUNT(*) FROM provider_profiles").fetchone()[0],
    }
    try:
        rollback.executescript(provider_lineage_migration_sql(lineage_tail, checksum, fail_after=True))
    except sqlite3.DatabaseError:
        rollback.rollback()
    else:
        fail("intentional v14 migration failure unexpectedly committed")
    check(rollback.execute("PRAGMA user_version").fetchone() == (13,), "failed v14 migration changed PRAGMA user_version")
    check(
        rollback.execute("SELECT schema_version FROM schema_meta WHERE singleton = 1").fetchone()
        == (before["schema_version"],),
        "failed v14 migration changed schema_meta",
    )
    for kind, expected_names in (
        ("table", EXPECTED_V14_TABLES),
        ("index", EXPECTED_V14_INDEXES),
        ("trigger", EXPECTED_V14_TRIGGERS),
    ):
        check(
            not (expected_names & object_names(rollback, kind)),
            f"failed v14 migration left lineage {kind}s behind",
        )
    check(
        rollback.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
            (PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,),
        ).fetchone()
        == (0,),
        "failed v14 migration left a lineage migration receipt behind",
    )
    assert_health(rollback, "rolled-back v13->v14", include_operation_facts=True)
    check(
        rollback.execute("SELECT COUNT(*) FROM provider_profiles").fetchone()
        == (before["provider_count"],),
        "failed v14 migration changed pre-existing provider data",
    )
    return migrated_v13, rollback


def assert_health_without_v11(connection: sqlite3.Connection, label: str) -> None:
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    check(not foreign_key_violations, f"{label}: foreign_key_check returned {foreign_key_violations}")
    integrity = connection.execute("PRAGMA quick_check").fetchone()
    check(integrity == ("ok",), f"{label}: quick_check returned {integrity}")


def seed_scope_fixture(connection: sqlite3.Connection) -> None:
    now = 10
    connection.execute(
        "INSERT INTO app_profiles (id, display_name, created_at_ms, updated_at_ms, settings_json) "
        "VALUES ('profile_cas', 'CAS profile', ?1, ?1, '{}')",
        (now,),
    )
    connection.execute(
        "INSERT INTO conversations (id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES ('conversation_cas_1', 'profile_cas', 'CAS one', ?1, ?1, '{}')",
        (now,),
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, name, created_at_ms) "
        "VALUES ('branch_cas_1', 'conversation_cas_1', 'main', ?1)",
        (now,),
    )
    connection.execute(
        "INSERT INTO conversations (id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES ('conversation_cas_2', 'profile_cas', 'CAS two', ?1, ?1, '{}')",
        (now,),
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, name, created_at_ms) "
        "VALUES ('branch_cas_2', 'conversation_cas_2', 'main', ?1)",
        (now,),
    )
    connection.execute(
        "INSERT INTO state_revision_streams ("
        "id, profile_id, project_id, conversation_id, branch_id, created_at_ms"
        ") VALUES ('stream_cas_1', 'profile_cas', NULL, 'conversation_cas_1', 'branch_cas_1', ?1)",
        (now,),
    )
    connection.execute(
        "INSERT INTO state_revision_streams ("
        "id, profile_id, project_id, conversation_id, branch_id, created_at_ms"
        ") VALUES ('stream_cas_2', 'profile_cas', NULL, 'conversation_cas_2', 'branch_cas_2', ?1)",
        (now,),
    )
    connection.execute(
        "INSERT INTO state_revision_heads (stream_id, accepted_revision_id, branch_sequence, updated_at_ms) "
        "VALUES ('stream_cas_1', NULL, 0, ?1), ('stream_cas_2', NULL, 0, ?1)",
        (now,),
    )
    connection.commit()


def insert_revision(
    connection: sqlite3.Connection,
    revision_id: str,
    stream_id: str,
    *,
    kind: str = "root",
    status: str = "accepted",
    sequence: int = 0,
    observed: str | None = None,
    expected: str | None = None,
    state_digest: str = "a" * 64,
) -> None:
    connection.execute(
        "INSERT INTO state_revisions ("
        "id, stream_id, kind, status, branch_sequence, "
        "watermark_json, observed_head_id, expected_head_id, "
        "actor_json, causation_json, manifest_json, authority_json, "
        "routing_cache_json, state_digest, canonicalization_revision, created_at_ms"
        ") VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?7, '{}', '{}', '{}', '{}', '{}', ?8, 'cas-v1', ?5)",
        (revision_id, stream_id, kind, status, sequence, observed, expected, state_digest),
    )


def make_journal_event_payload(
    stream_id: str,
    revision_id: str,
    *,
    kind: str,
    status: str,
    branch_sequence: int,
    observed: str | None,
    expected: str | None,
    accepted: str | None,
    canonical_hash: str,
    idempotency_hash: str,
    operation_id: str | None = None,
) -> str:
    """Build the bounded, hash-only v12 event payload used by SQL fixtures."""
    payload = {
        "schemaVersion": 1,
        "streamId": stream_id,
        "stateRevisionId": revision_id,
        "kind": kind,
        "status": status,
        "branchSequence": branch_sequence,
        "observedHeadStateRevisionId": observed,
        "expectedHeadStateRevisionId": expected,
        "acceptedHeadStateRevisionId": accepted,
        "canonicalPayloadHash": canonical_hash,
        "idempotencyKeyHash": idempotency_hash,
        "operationId": operation_id,
        "watermarkHash": "c" * 64,
        "actorHash": "d" * 64,
        "causationHash": "e" * 64,
        "manifestHash": "f" * 64,
        "authorityHash": "0" * 64,
        "routingCacheHash": "1" * 64,
        "causalCursorHash": "2" * 64,
        "policyRevisionId": "policy-v1",
    }
    return json.dumps(payload, separators=(",", ":"))


def insert_journal_event(
    connection: sqlite3.Connection,
    *,
    event_id: str,
    stream_id: str,
    sequence: int,
    revision_id: str,
    payload_json: str,
    occurred_at_ms: int,
) -> None:
    connection.execute(
        "INSERT INTO state_revision_events ("
        "id, schema_version, stream_id, sequence_no, event_type, source, visibility, sensitivity, "
        "revision_id, payload_json, occurred_at_ms, committed_at_ms"
        ") VALUES (?1, 1, ?2, ?3, 'state.revision_appended', 'harness', 'inspector', 'normal', "
        "?4, ?5, ?6, ?6)",
        (event_id, stream_id, sequence, revision_id, payload_json, occurred_at_ms),
    )


def insert_complete_journal(connection: sqlite3.Connection, stream_id: str, epoch: str, created_at_ms: int = 10) -> None:
    connection.execute(
        "INSERT INTO state_revision_journals ("
        "stream_id, schema_version, journal_epoch, coverage, coverage_reason, created_at_ms"
        ") VALUES (?1, 1, ?2, 'complete', NULL, ?3)",
        (stream_id, epoch, created_at_ms),
    )


def expect_database_error(
    connection: sqlite3.Connection,
    statement: str,
    parameters: Iterable[object] = (),
    *,
    label: str,
) -> str:
    # Use a savepoint instead of connection.rollback().  The latter would also
    # erase all valid fixture rows created earlier in the surrounding test.
    savepoint = "verify_expected_error"
    connection.execute(f"SAVEPOINT {savepoint}")
    try:
        connection.execute(statement, tuple(parameters))
    except sqlite3.DatabaseError as error:
        connection.execute(f"ROLLBACK TO {savepoint}")
        connection.execute(f"RELEASE {savepoint}")
        return str(error)
    connection.execute(f"ROLLBACK TO {savepoint}")
    connection.execute(f"RELEASE {savepoint}")
    fail(f"{label}: statement unexpectedly succeeded")


def verify_v11_constraints(connection: sqlite3.Connection) -> None:
    seed_scope_fixture(connection)
    # A fresh v12 stream is complete from its first committed fact onward.
    # Keep the two streams in this fixture journaled so receipt checks below
    # cannot accidentally pass with the legacy-partial compatibility rule.
    insert_complete_journal(connection, "stream_cas_1", "journal_epoch_cas_1")
    insert_complete_journal(connection, "stream_cas_2", "journal_epoch_cas_2")

    # A root accepted revision can become an accepted head at sequence zero.
    insert_revision(connection, "rev_cas_0", "stream_cas_1")
    connection.execute(
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_0', branch_sequence = 0, updated_at_ms = 11 "
        "WHERE stream_id = 'stream_cas_1'"
    )
    insert_journal_event(
        connection,
        event_id="event_cas_0",
        stream_id="stream_cas_1",
        sequence=1,
        revision_id="rev_cas_0",
        payload_json=make_journal_event_payload(
            "stream_cas_1",
            "rev_cas_0",
            kind="root",
            status="accepted",
            branch_sequence=0,
            observed=None,
            expected=None,
            accepted="rev_cas_0",
            canonical_hash="a" * 64,
            idempotency_hash="0" * 64,
        ),
        occurred_at_ms=11,
    )

    # A child revision, parent lineage, edge and idempotency receipt all remain
    # append-only and scoped to the same stream.
    insert_revision(
        connection,
        "rev_cas_1",
        "stream_cas_1",
        kind="continuation",
        sequence=1,
        observed="rev_cas_0",
        expected="rev_cas_0",
        state_digest="b" * 64,
    )
    connection.execute(
        "INSERT INTO state_revision_parents (revision_id, parent_revision_id, ordinal) "
        "VALUES ('rev_cas_1', 'rev_cas_0', 0)"
    )
    # Edge orientation is canonicalized as `from = derived/new revision` and
    # `to = source/parent revision`.  In other words, a child revision that
    # `continues-from` rev_cas_0 points from rev_cas_1 to rev_cas_0.  Keeping
    # this explicit in the independent verifier prevents a parent->child
    # fixture from silently disagreeing with the native append path.
    connection.execute(
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, "
        "causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_cas_1', 'continues-from', 'rev_cas_1', 'rev_cas_0', 'op_cas_1', '{}', 'policy-v1', 12)"
    )
    connection.execute(
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_1', branch_sequence = 1, updated_at_ms = 12 "
        "WHERE stream_id = 'stream_cas_1'"
    )
    child_event_payload = make_journal_event_payload(
        "stream_cas_1",
        "rev_cas_1",
        kind="continuation",
        status="accepted",
        branch_sequence=1,
        observed="rev_cas_0",
        expected="rev_cas_0",
        accepted="rev_cas_1",
        canonical_hash="2" * 64,
        idempotency_hash="1" * 64,
        operation_id="op_cas_1",
    )
    insert_journal_event(
        connection,
        event_id="event_cas_1",
        stream_id="stream_cas_1",
        sequence=2,
        revision_id="rev_cas_1",
        payload_json=child_event_payload,
        occurred_at_ms=12,
    )
    connection.execute(
        "INSERT INTO state_revision_idempotency ("
        "stream_id, idempotency_key_hash, canonical_payload_hash, "
        "result_revision_id, receipt_json, created_at_ms"
        ") VALUES ('stream_cas_1', ?1, ?2, 'rev_cas_1', ?3, 12)",
        (
            "1" * 64,
            "2" * 64,
            json.dumps(
                {
                    "schemaVersion": 1,
                    "outcome": "applied",
                    "revisionId": "rev_cas_1",
                    "streamId": "stream_cas_1",
                    "acceptedHeadStateRevisionId": "rev_cas_1",
                    "expectedHeadStateRevisionId": "rev_cas_0",
                    "branchSequence": 1,
                    "canonicalPayloadHash": "2" * 64,
                    "journalEpoch": "journal_epoch_cas_1",
                    "journalSequence": 2,
                    "journalEventId": "event_cas_1",
                },
                separators=(",", ":"),
            ),
        ),
    )

    receipt_row = connection.execute(
        "SELECT stream_id, canonical_payload_hash, result_revision_id, receipt_json "
        "FROM state_revision_idempotency "
        "WHERE stream_id = 'stream_cas_1' AND idempotency_key_hash = ?1",
        ("1" * 64,),
    ).fetchone()
    check(receipt_row is not None, "state-revision idempotency receipt fixture is missing")
    receipt_stream_id, receipt_payload_hash, receipt_revision_id, receipt_json = receipt_row
    try:
        receipt = json.loads(receipt_json)
    except json.JSONDecodeError as error:
        fail(f"state-revision idempotency receipt fixture is not JSON: {error}")
    receipt_variant = verify_receipt_values(
        receipt,
        allow_legacy=False,
        expected_stream=receipt_stream_id,
        expected_revision=receipt_revision_id,
        expected_hash=receipt_payload_hash,
        expected_sequence=1,
    )
    check(receipt_variant == "complete", "fresh v12 receipt must include a complete journal cursor")
    check(
        receipt["acceptedHeadStateRevisionId"] == "rev_cas_1",
        "state-revision receipt accepted head must capture the original post-commit head",
    )
    check(
        receipt["expectedHeadStateRevisionId"] == "rev_cas_0",
        "state-revision receipt expected head must capture the original CAS base",
    )
    check(receipt["branchSequence"] == 1, "state-revision receipt branch sequence mismatch")
    check(
        (receipt["journalEpoch"], receipt["journalSequence"], receipt["journalEventId"])
        == ("journal_epoch_cas_1", 2, "event_cas_1"),
        "state-revision receipt journal cursor does not identify the original event",
    )
    event_row = connection.execute(
        "SELECT sequence_no, id, payload_json FROM state_revision_events "
        "WHERE stream_id = ?1 AND revision_id = ?2",
        (receipt_stream_id, receipt_revision_id),
    ).fetchone()
    check(event_row is not None, "state-revision complete receipt event is missing")
    event_sequence, event_id, event_json = event_row
    check((event_sequence, event_id) == (2, "event_cas_1"), "state-revision journal event cursor row drifted")
    event_payload = json.loads(event_json)
    check(
        set(event_payload) == EXPECTED_STATE_REVISION_EVENT_PAYLOAD_KEYS,
        "state-revision journal event payload keys drifted",
    )
    check(
        event_payload["streamId"] == receipt_stream_id
        and event_payload["stateRevisionId"] == receipt_revision_id
        and event_payload["branchSequence"] == receipt["branchSequence"]
        and event_payload["canonicalPayloadHash"] == receipt["canonicalPayloadHash"],
        "state-revision receipt/journal event identity drifted",
    )

    edge_direction = connection.execute(
        "SELECT from_revision_id, to_revision_id "
        "FROM state_revision_edges WHERE id = 'edge_cas_1'"
    ).fetchone()
    check(
        edge_direction == ("rev_cas_1", "rev_cas_0"),
        f"continues-from edge direction drifted: {edge_direction!r}",
    )

    # Candidate/rejected states are legal immutable facts but cannot be heads
    # because the head trigger requires an accepted revision at the same seq.
    insert_revision(
        connection,
        "rev_cas_candidate",
        "stream_cas_1",
        kind="retry-result",
        status="candidate",
        sequence=2,
        expected="rev_cas_1",
    )
    expect_database_error(
        connection,
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_candidate', branch_sequence = 2 "
        "WHERE stream_id = 'stream_cas_1'",
        label="candidate head rejection",
    )

    # Bounded CHECK/UNIQUE constraints.
    expect_database_error(
        connection,
        "INSERT INTO state_revisions ("
        "id, stream_id, kind, status, branch_sequence, watermark_json, "
        "actor_json, causation_json, manifest_json, authority_json, "
        "routing_cache_json, state_digest, canonicalization_revision, created_at_ms"
        ") VALUES ('rev_cas_negative', 'stream_cas_1', 'root', 'accepted', -1, '{}', '{}', '{}', '{}', '{}', '{}', ?1, 'cas-v1', 13)",
        ("c" * 64,),
        label="negative branch sequence",
    )
    expect_database_error(
        connection,
        "INSERT INTO state_revisions ("
        "id, stream_id, kind, status, branch_sequence, watermark_json, "
        "actor_json, causation_json, manifest_json, authority_json, "
        "routing_cache_json, state_digest, canonicalization_revision, created_at_ms"
        ") VALUES ('rev_cas_duplicate_seq', 'stream_cas_1', 'root', 'accepted', 1, '{}', '{}', '{}', '{}', '{}', '{}', ?1, 'cas-v1', 13)",
        ("d" * 64,),
        label="duplicate branch sequence",
    )
    expect_database_error(
        connection,
        "INSERT INTO state_revision_idempotency ("
        "stream_id, idempotency_key_hash, canonical_payload_hash, "
        "result_revision_id, receipt_json, created_at_ms"
        ") VALUES ('stream_cas_1', 'not-a-sha', ?1, 'rev_cas_1', '{}', 14)",
        ("2" * 64,),
        label="invalid idempotency hash",
    )

    # Scope guards prevent a stream, parent, edge, or head from crossing a
    # conversation/branch boundary.
    expect_database_error(
        connection,
        "INSERT INTO state_revision_streams ("
        "id, profile_id, project_id, conversation_id, branch_id, created_at_ms"
        ") VALUES ('stream_cas_bad', 'profile_cas', NULL, 'conversation_cas_2', 'branch_cas_1', 15)",
        label="cross-conversation stream",
    )
    insert_revision(connection, "rev_cas_2", "stream_cas_2", sequence=0)
    expect_database_error(
        connection,
        "INSERT INTO state_revision_parents (revision_id, parent_revision_id, ordinal) "
        "VALUES ('rev_cas_2', 'rev_cas_0', 0)",
        label="cross-stream parent",
    )
    expect_database_error(
        connection,
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, "
        "causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_cas_bad', 'inherits-from', 'rev_cas_0', 'rev_cas_2', NULL, '{}', 'policy-v1', 15)",
        label="cross-stream edge",
    )
    expect_database_error(
        connection,
        "UPDATE state_revision_heads SET accepted_revision_id = 'rev_cas_2', branch_sequence = 0 "
        "WHERE stream_id = 'stream_cas_1'",
        label="cross-stream head",
    )

    # Parent/edge relationship checks and immutable facts.
    expect_database_error(
        connection,
        "INSERT INTO state_revision_parents (revision_id, parent_revision_id, ordinal) "
        "VALUES ('rev_cas_1', 'rev_cas_0', 0)",
        label="duplicate parent",
    )
    expect_database_error(
        connection,
        "INSERT INTO state_revision_parents (revision_id, parent_revision_id, ordinal) "
        "VALUES ('rev_cas_1', 'rev_cas_1', 1)",
        label="self parent",
    )
    expect_database_error(
        connection,
        "INSERT INTO state_revision_edges ("
        "id, kind, from_revision_id, to_revision_id, operation_id, "
        "causal_cursor_json, policy_revision_id, created_at_ms"
        ") VALUES ('edge_cas_self', 'inherits-from', 'rev_cas_1', 'rev_cas_1', NULL, '{}', 'policy-v1', 16)",
        label="self edge",
    )
    immutable_statements = [
        ("UPDATE state_revision_streams SET created_at_ms = 99 WHERE id = 'stream_cas_1'", "immutable stream update"),
        ("DELETE FROM state_revision_streams WHERE id = 'stream_cas_1'", "immutable stream delete"),
        ("UPDATE state_revisions SET state_digest = 'e' || substr(state_digest, 2) WHERE id = 'rev_cas_0'", "immutable revision update"),
        ("DELETE FROM state_revisions WHERE id = 'rev_cas_0'", "immutable revision delete"),
        ("UPDATE state_revision_parents SET ordinal = 1 WHERE revision_id = 'rev_cas_1'", "immutable parent update"),
        ("DELETE FROM state_revision_parents WHERE revision_id = 'rev_cas_1'", "immutable parent delete"),
        ("UPDATE state_revision_edges SET policy_revision_id = 'policy-v2' WHERE id = 'edge_cas_1'", "immutable edge update"),
        ("DELETE FROM state_revision_edges WHERE id = 'edge_cas_1'", "immutable edge delete"),
        ("UPDATE state_revision_idempotency SET receipt_json = '{}' WHERE stream_id = 'stream_cas_1'", "immutable idempotency update"),
        ("DELETE FROM state_revision_idempotency WHERE stream_id = 'stream_cas_1'", "immutable idempotency delete"),
    ]
    for statement, label in immutable_statements:
        expect_database_error(connection, statement, label=label)

    connection.commit()
    assert_health(connection, "v11 constraint fixture")
    counts = {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in EXPECTED_V11_TABLES
    }
    check(counts["state_revisions"] == 4, f"unexpected revision count: {counts}")
    check(counts["state_revision_parents"] == 1, f"unexpected parent count: {counts}")
    check(counts["state_revision_edges"] == 1, f"unexpected edge count: {counts}")
    check(counts["state_revision_idempotency"] == 1, f"unexpected idempotency count: {counts}")


def verify_projection_safety(connection: sqlite3.Connection) -> None:
    """Ensure revision/lineage tables expose only bounded, non-secret facts."""
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type = 'table' AND (name LIKE 'state_revision_%' "
        "OR name = 'provider_attempt_lineage_facts')"
    ).fetchall()
    check(rows, "state-revision/provider-lineage tables are absent from projection safety check")
    # This external verifier only sees the SQL contract; it cannot exercise the
    # Rust redacted projection.  It still ensures the storage schema does not
    # create a raw file/blob table as part of v11 and records that JSON columns
    # are text manifests, not provider body blobs.
    columns = {
        table: [row[1] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()]
        for table in (
            EXPECTED_V11_TABLES
            | EXPECTED_V12_TABLES
            | EXPECTED_V13_TABLES
            | EXPECTED_V14_TABLES
        )
        if table in object_names(connection, "table")
    }
    forbidden = {"raw_body", "secret", "token", "password", "file_bytes", "blob_bytes"}
    for table, names in columns.items():
        check(
            not (forbidden & {name.lower() for name in names}),
            f"{table}: forbidden raw/secret column present: {sorted(forbidden & {name.lower() for name in names})}",
        )
    if "provider_attempt_lineage_facts" in columns:
        lineage_names = {name.lower() for name in columns["provider_attempt_lineage_facts"]}
        check(
            {"lineage_sha256", "input_content_sha256", "endpoint_fingerprint_sha256"} <= lineage_names,
            "provider-attempt lineage table is missing required opaque fingerprints",
        )


def run() -> dict[str, object]:
    verify_receipt_schema_document()
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    state_tail = state_revision_schema_tail(schema)
    journal_tail = state_revision_journal_schema_tail(schema)
    operation_fact_tail = state_revision_operation_fact_schema_tail(schema)
    lineage_tail = provider_attempt_lineage_schema_tail(schema)
    schema_v10 = schema.split(STATE_REVISION_MARKER, 1)[0]

    fresh = open_connection()
    fresh.executescript(schema)
    fresh.commit()
    assert_health(
        fresh,
        "fresh schema",
        include_operation_facts=True,
        include_provider_lineage=True,
    )
    verify_projection_safety(fresh)

    migrated_v11, rolled_back_v11 = verify_migration(schema_v10, state_tail)
    del migrated_v11, rolled_back_v11
    migrated_v12, rolled_back_v12 = verify_journal_migration(schema_v10, state_tail, journal_tail)
    del rolled_back_v12
    migrated_v13, rolled_back_v13 = verify_operation_fact_migration(
        schema_v10,
        state_tail,
        journal_tail,
        operation_fact_tail,
        migrated_v12,
    )
    del migrated_v12, rolled_back_v13
    migrated_v14, rolled_back_v14 = verify_provider_lineage_migration(
        schema_v10,
        state_tail,
        journal_tail,
        operation_fact_tail,
        lineage_tail,
        migrated_v13,
    )
    v14_valid_lineage_rows = migrated_v14.execute(
        "SELECT COUNT(*) FROM provider_attempt_lineage_facts"
    ).fetchone()[0]
    del migrated_v13, rolled_back_v14

    # Compare the v14 migration with a fresh database at that same version.
    # Later migrations may append tables, triggers or lineage columns; they
    # must not be installed by a v13->v14 upgrade or hidden by a looser inventory.
    # The full current schema above still receives its own fresh-profile smoke,
    # health, projection-safety and v11-constraint checks.
    fresh_v14 = open_connection()
    fresh_v14.executescript(schema.split(RUN_CONTROL_MARKER, 1)[0])
    fresh_v14.commit()
    fresh_objects = object_rows(fresh_v14)
    migrated_objects = object_rows(migrated_v14)
    check(
        fresh_objects == migrated_objects,
        "fresh/migrated sqlite_master structural mismatch: "
        f"missing={sorted(fresh_objects - migrated_objects)!r}, "
        f"extra={sorted(migrated_objects - fresh_objects)!r}",
    )
    check(
        migrated_v14.execute(
            "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = ?1", (STATE_REVISION_MIGRATION_ID,)
        ).fetchone()
        == (hashlib.sha256(state_tail.encode("utf-8")).hexdigest(),),
        "v11 migration checksum does not match the exact migration tail",
    )
    check(
        migrated_v14.execute(
            "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = ?1",
            (STATE_REVISION_JOURNAL_MIGRATION_ID,),
        ).fetchone()
        == (hashlib.sha256(journal_tail.encode("utf-8")).hexdigest(),),
        "v12 migration checksum does not match the exact migration tail",
    )
    check(
        migrated_v14.execute(
            "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = ?1",
            (STATE_REVISION_OPERATION_FACT_MIGRATION_ID,),
        ).fetchone()
        == (hashlib.sha256(operation_fact_tail.encode("utf-8")).hexdigest(),),
        "v13 migration checksum does not match the exact migration tail",
    )
    check(
        migrated_v14.execute(
            "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = ?1",
            (PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,),
        ).fetchone()
        == (hashlib.sha256(lineage_tail.encode("utf-8")).hexdigest(),),
        "v14 migration checksum does not match the exact migration tail",
    )

    verify_v11_constraints(fresh)
    return {
        "sqlite": sqlite3.sqlite_version,
        "freshObjects": len(fresh_objects),
        "freshObjectsSchemaVersion": 14,
        "currentFreshObjects": len(object_rows(fresh)),
        "currentFreshSchemaSmokeVerified": True,
        "v14ValidLineageRows": v14_valid_lineage_rows,
        "v14ProjectionSafetyVerified": True,
        "v14ScopeGuardsVerified": True,
        "v14ImmutableGuardsVerified": True,
        "currentSchemaVersion": 14,
        "currentMigrationReceipt": PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,
        "v11Tables": sorted(EXPECTED_V11_TABLES),
        "v11Indexes": sorted(EXPECTED_V11_INDEXES),
        "v11Triggers": len(EXPECTED_V11_TRIGGERS),
        "v11MigrationReceipt": STATE_REVISION_MIGRATION_ID,
        "v12Tables": sorted(EXPECTED_V12_TABLES),
        "v12Indexes": sorted(EXPECTED_V12_INDEXES),
        "v12Triggers": len(EXPECTED_V12_TRIGGERS),
        "v12MigrationReceipt": STATE_REVISION_JOURNAL_MIGRATION_ID,
        "v13Tables": sorted(EXPECTED_V13_TABLES),
        "v13Indexes": sorted(EXPECTED_V13_INDEXES),
        "v13Triggers": len(EXPECTED_V13_TRIGGERS),
        "v13MigrationReceipt": STATE_REVISION_OPERATION_FACT_MIGRATION_ID,
        "v14Tables": sorted(EXPECTED_V14_TABLES),
        "v14Indexes": sorted(EXPECTED_V14_INDEXES),
        "v14Triggers": len(EXPECTED_V14_TRIGGERS),
        "v14MigrationReceipt": PROVIDER_ATTEMPT_LINEAGE_MIGRATION_ID,
        "v11RollbackVerified": True,
        "v12RollbackVerified": True,
        "v13RollbackVerified": True,
        "v14RollbackVerified": True,
        "rollbackVerified": True,
        "constraintMatrixVerified": True,
    }


def main() -> int:
    try:
        result = run()
    except (OSError, sqlite3.DatabaseError, VerificationError) as error:
        print(f"STATE_REVISION_SCHEMA_VERIFY: FAIL: {error}", file=sys.stderr)
        print(f"PROVIDER_ATTEMPT_LINEAGE_VERIFY: FAIL: {error}", file=sys.stderr)
        return 1
    print("STATE_REVISION_SCHEMA_VERIFY: PASS")
    # Keep the historical prefix for existing CI consumers while exposing the
    # v14-specific acceptance label required by the provider-lineage test plan.
    print("PROVIDER_ATTEMPT_LINEAGE_VERIFY: PASS")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
