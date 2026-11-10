"""Independent contract verifier for the provider-attempt lineage schema.

This checker intentionally validates only the checked-in JSON contract.  It does
not claim that native storage persists the record or that the renderer exposes a
safe projection.  Those claims require the v14 Rust migration/runtime tests.

Run from the repository root with::

    python scripts/verify-provider-attempt-lineage-schema.py

The verifier is dependency-free and exits non-zero when the contract weakens in
a way that could expose mutable, unbounded, or secret-bearing provenance.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import NoReturn


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "docs" / "omnia-ultra" / "schemas" / "provider-attempt-lineage.schema.json"
SQL_PATH = ROOT / "docs" / "storage-schema.sql"

REQUIRED_FIELDS = {
    "schemaVersion",
    "lineageFactId",
    "runId",
    "attemptId",
    "frozenProviderInputId",
    "providerProfileId",
    "modelId",
    "providerDefinitionSha256",
    "providerDefinitionSchemaVersion",
    "endpointFingerprintSha256",
    "adapterRevision",
    "catalogSnapshotId",
    "catalogSnapshotSha256",
    "modelDescriptorRevisionId",
    "modelDescriptorSha256",
    "modelCapabilitySnapshotId",
    "modelCapabilitySnapshotSha256",
    "routeRevisionId",
    "retryPolicyRevisionId",
    "cachePolicyRevisionId",
    "priceSnapshotId",
    "priceSnapshotSha256",
    "parameterProfileRevisionId",
    "resolvedParametersSha256",
    "requestedEffort",
    "effectiveEffort",
    "contextManifestId",
    "contextManifestSha256",
    "authorityContinuityRecordId",
    "dataClassificationRevisionId",
    "inputContentSha256",
    "lineageSha256",
    "createdAtMs",
    "routingDecisionReceiptId",
    "cachePlanId",
}

# Every field on the native fact is required in the interchange contract.  A
# field whose evidence is unavailable is represented by JSON null; omission is
# not a second spelling for unknown.  Keep this set explicit so adding a
# native column without updating the contract fails closed.
OPTIONAL_FIELDS: set[str] = set()

SECRET_OR_RAW_FIELDS = {
    "credential",
    "credentialRef",
    "apiKey",
    "accessToken",
    "refreshToken",
    "cookie",
    "cookies",
    "rawBody",
    "providerBody",
    "prompt",
    "messages",
    "attachments",
    "fileBytes",
    "absolutePath",
    "rawUrl",
}


def fail(message: str) -> NoReturn:
    raise AssertionError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def schema() -> dict:
    try:
        payload = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing schema: {SCHEMA_PATH}")
    except json.JSONDecodeError as error:
        fail(f"schema is not valid JSON: {error}")
    require(isinstance(payload, dict), "schema root must be an object")
    return payload


def storage_sql() -> str:
    try:
        return SQL_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        fail(f"missing storage schema: {SQL_PATH}")


def _seed_sql_fixture(connection: sqlite3.Connection) -> None:
    """Create the smallest valid parent graph for one lineage row.

    ``fixture_id`` is deliberately an integer rather than arbitrary SQL text;
    every negative probe gets a fresh graph.  This prevents a rejection from
    being attributed to the intended CHECK/trigger when it actually came from
    ``UNIQUE(frozen_provider_input_id)`` left by a previous probe.
    """


def _fixture_ids(fixture_id: int = 0) -> dict[str, str]:
    require(isinstance(fixture_id, int) and fixture_id >= 0, "fixture id must be a non-negative integer")
    suffix = "" if fixture_id == 0 else f"_{fixture_id}"
    return {
        "profile": f"profile_default{suffix}",
        "provider": f"provider_test{suffix}",
        "conversation": f"conversation_test{suffix}",
        "branch": f"branch_test{suffix}",
        "run": f"run_test{suffix}",
        "attempt": f"attempt_test{suffix}",
        "input": f"provider_input_test{suffix}",
    }


def _seed_sql_fixture(connection: sqlite3.Connection, fixture_id: int = 0) -> None:
    """Create the smallest valid parent graph for one lineage row."""

    ids = _fixture_ids(fixture_id)
    connection.execute(
        "INSERT INTO app_profiles "
        "(id, display_name, created_at_ms, updated_at_ms, settings_json) "
        "VALUES (?, ?, 1, 1, ?)",
        (ids["profile"], "Verifier profile", "{}"),
    )
    connection.execute(
        "INSERT INTO provider_profiles "
        "(id, profile_id, provider_type, display_name, normalized_base_url, "
        "credential_ref, auth_scheme, config_json, egress_policy_json, "
        "enabled, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, 'openai-compatible', ?, 'https://provider.invalid/v1', "
        "'opaque:test', 'bearer', '{}', '{}', 1, 1, 1)",
        (ids["provider"], ids["profile"], "Verifier provider"),
    )
    connection.execute(
        "INSERT INTO conversations "
        "(id, profile_id, title, created_at_ms, updated_at_ms, metadata_json) "
        "VALUES (?, ?, 'Verifier', 1, 1, '{}')",
        (ids["conversation"], ids["profile"]),
    )
    connection.execute(
        "INSERT INTO conversation_branches (id, conversation_id, created_at_ms) "
        "VALUES (?, ?, 1)",
        (ids["branch"], ids["conversation"]),
    )
    connection.execute(
        "INSERT INTO generations "
        "(id, conversation_id, branch_id, provider_profile_id, model_id, "
        "state, request_parameters_json, created_at_ms) "
        "VALUES (?, ?, ?, ?, 'model-test', 'queued', '{}', 1)",
        (ids["run"], ids["conversation"], ids["branch"], ids["provider"]),
    )
    connection.execute(
        "INSERT INTO run_attempts "
        "(id, generation_id, ordinal, provider_profile_id, model_id, state, "
        "accepted_by_provider, idempotency_supported, created_at_ms) "
        "VALUES (?, ?, 1, ?, 'model-test', 'created', 'false', 0, 1)",
        (ids["attempt"], ids["run"], ids["provider"]),
    )
    connection.execute(
        "INSERT INTO frozen_provider_inputs "
        "(id, schema_version, attempt_id, run_id, provider_profile_id, "
        "model_id, messages_json, parameters_json, content_sha256, created_at_ms) "
        "VALUES (?, 1, ?, ?, ?, 'model-test', '[]', '{}', ?, 1)",
        (
            ids["input"],
            ids["attempt"],
            ids["run"],
            ids["provider"],
            "0" * 64,
        ),
    )


def _fresh_sql_connection(fixture_id: int) -> sqlite3.Connection:
    """Open a fully isolated database and seed one parent graph."""

    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA trusted_schema = OFF")
    try:
        connection.executescript(storage_sql())
        _seed_sql_fixture(connection, fixture_id)
    except sqlite3.DatabaseError as error:
        connection.close()
        fail(f"fresh SQL fixture {fixture_id} could not be created: {error}")
    return connection


def _valid_lineage_params(fixture_id: int = 0) -> tuple[object, ...]:
    ids = _fixture_ids(fixture_id)
    zero = "0" * 64
    return (
        f"provider_lineage_test{'' if fixture_id == 0 else f'_{fixture_id}'}",  # id
        1,  # schema_version
        ids["input"],  # frozen_provider_input_id
        ids["run"],  # run_id
        ids["attempt"],  # attempt_id
        ids["provider"],  # provider_profile_id
        "model-test",  # model_id
        1,  # provider_definition_schema_version
        zero,  # provider_definition_sha256
        zero,  # endpoint_fingerprint_sha256
        "native-test",  # adapter_revision
        None,  # catalog_snapshot_id
        None,  # catalog_snapshot_sha256
        None,  # model_descriptor_revision_id
        None,  # model_descriptor_sha256
        None,  # model_capability_snapshot_id
        None,  # model_capability_snapshot_sha256
        None,  # route_revision_id
        None,  # routing_decision_receipt_id
        None,  # retry_policy_revision_id
        None,  # cache_policy_revision_id
        None,  # cache_plan_id
        None,  # price_snapshot_id
        None,  # price_snapshot_sha256
        None,  # parameter_profile_revision_id
        zero,  # resolved_parameters_sha256
        None,  # requested_effort
        None,  # effective_effort
        None,  # context_manifest_id
        None,  # context_manifest_sha256
        None,  # authority_continuity_record_id
        None,  # data_classification_revision_id
        zero,  # input_content_sha256
        zero,  # lineage_sha256
        1,  # created_at_ms
    )


LINEAGE_INSERT = """
    INSERT INTO provider_attempt_lineage_facts (
        id, schema_version, frozen_provider_input_id, run_id, attempt_id,
        provider_profile_id, model_id, provider_definition_schema_version,
        provider_definition_sha256, endpoint_fingerprint_sha256, adapter_revision,
        catalog_snapshot_id, catalog_snapshot_sha256,
        model_descriptor_revision_id, model_descriptor_sha256,
        model_capability_snapshot_id, model_capability_snapshot_sha256,
        route_revision_id, routing_decision_receipt_id, retry_policy_revision_id,
        cache_policy_revision_id, cache_plan_id, price_snapshot_id,
        price_snapshot_sha256, parameter_profile_revision_id,
        resolved_parameters_sha256, requested_effort, effective_effort,
        context_manifest_id, context_manifest_sha256, authority_continuity_record_id,
        data_classification_revision_id, input_content_sha256, lineage_sha256,
        created_at_ms
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
"""


def verify_sql_contract() -> dict[str, object]:
    """Verify the checked-in v14 DDL independently of Rust runtime code."""

    sql = storage_sql()
    require(
        "-- Omnia schema v14: immutable provider-attempt lineage facts." in sql,
        "v14 storage-schema marker missing",
    )
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA trusted_schema = OFF")
    try:
        connection.executescript(sql)
    except sqlite3.DatabaseError as error:
        fail(f"checked-in storage schema does not execute: {error}")

    table = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        ("provider_attempt_lineage_facts",),
    ).fetchone()
    require(table is not None, "provider-attempt lineage table missing from storage schema")
    table_sql = table[0] or ""
    require("STRICT" in table_sql, "provider-attempt lineage table must be STRICT")
    require(
        "frozen_provider_input_id TEXT NOT NULL UNIQUE" in table_sql,
        "one-to-one frozen-input uniqueness missing",
    )
    require("REFERENCES frozen_provider_inputs" in table_sql, "frozen-input foreign key missing")
    require("ON DELETE RESTRICT" in table_sql, "lineage retention guard missing")

    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(provider_attempt_lineage_facts)")
    }
    required_columns = {
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
        "resolved_parameters_sha256",
        "requested_effort",
        "effective_effort",
        "input_content_sha256",
        "lineage_sha256",
        "created_at_ms",
    }
    require(required_columns <= columns, "lineage table column inventory is incomplete")

    indexes = {
        row[1] for row in connection.execute("PRAGMA index_list(provider_attempt_lineage_facts)")
    }
    expected_indexes = {
        "provider_attempt_lineage_facts_attempt_idx",
        "provider_attempt_lineage_facts_run_idx",
        "provider_attempt_lineage_facts_provider_idx",
    }
    require(expected_indexes <= indexes, "lineage lookup index inventory is incomplete")

    triggers = {
        row[1]
        for row in connection.execute(
            "SELECT type, name FROM sqlite_master "
            "WHERE type = 'trigger' AND name LIKE 'provider_attempt_lineage_facts_%'"
        )
    }
    expected_triggers = {
        "provider_attempt_lineage_facts_scope_guard_insert",
        "provider_attempt_lineage_facts_immutable_update",
        "provider_attempt_lineage_facts_immutable_delete",
    }
    require(expected_triggers <= triggers, "lineage trigger inventory is incomplete")
    require(
        "length(lineage_sha256) = 64" in table_sql
        and "lineage_sha256 = lower(lineage_sha256)" in table_sql,
        "lineage hash integrity checks missing",
    )
    require(
        re.search(r"catalog_snapshot_id TEXT\s*\n\s*CHECK \(catalog_snapshot_id IS NULL", table_sql),
        "catalog unknown/null semantics missing",
    )

    _seed_sql_fixture(connection)
    connection.execute(LINEAGE_INSERT, _valid_lineage_params())
    row_count = connection.execute(
        "SELECT COUNT(*) FROM provider_attempt_lineage_facts"
    ).fetchone()[0]
    require(row_count == 1, "valid lineage fixture did not persist exactly one row")

    duplicate_rejected = False
    try:
        connection.execute(LINEAGE_INSERT, _valid_lineage_params())
    except sqlite3.IntegrityError:
        duplicate_rejected = True
    require(duplicate_rejected, "duplicate lineage insert was accepted")

    cross_scope = list(_valid_lineage_params())
    cross_scope[6] = "different-model"
    cross_scope_rejected = False
    try:
        connection.execute(LINEAGE_INSERT, tuple(cross_scope))
    except sqlite3.IntegrityError:
        cross_scope_rejected = True
    require(cross_scope_rejected, "cross-scope lineage insert was accepted")

    tamper_rejected = False
    try:
        connection.execute(
            "UPDATE provider_attempt_lineage_facts SET adapter_revision = 'tampered'"
        )
    except sqlite3.IntegrityError:
        tamper_rejected = True
    require(tamper_rejected, "lineage update tampering was accepted")

    delete_rejected = False
    try:
        connection.execute("DELETE FROM provider_attempt_lineage_facts")
    except sqlite3.IntegrityError:
        delete_rejected = True
    require(delete_rejected, "lineage deletion was accepted")

    # The sqlite3 module opens an implicit transaction for the fixture insert
    # (and keeps it open after trigger-rejected statements).  End that
    # transaction before starting the explicit rollback probe; otherwise
    # SQLite raises ``cannot start a transaction within a transaction`` and
    # the verifier crashes before it can exercise rollback semantics.
    connection.commit()
    rollback_count = None
    connection.execute("BEGIN")
    try:
        invalid = list(_valid_lineage_params())
        invalid[33] = "F" * 64
        connection.execute(LINEAGE_INSERT, tuple(invalid))
    except sqlite3.DatabaseError:
        connection.rollback()
    else:
        connection.rollback()
        fail("invalid uppercase lineage hash was accepted")
    rollback_count = connection.execute(
        "SELECT COUNT(*) FROM provider_attempt_lineage_facts"
    ).fetchone()[0]
    require(rollback_count == 1, "failed lineage transaction did not roll back")

    forbidden = {
        "credential",
        "cookie",
        "prompt",
        "messages",
        "attachment",
        "file_bytes",
        "absolute_path",
        "raw_url",
        "request_body",
    }
    lowered_table_sql = table_sql.lower()
    leaked_columns = sorted(name for name in forbidden if name in lowered_table_sql)
    require(not leaked_columns, f"lineage table exposes raw/secret column names: {leaked_columns}")

    return {
        "storageSchema": str(SQL_PATH.relative_to(ROOT)),
        "table": "provider_attempt_lineage_facts",
        "requiredColumns": len(required_columns),
        "indexes": sorted(expected_indexes),
        "triggers": sorted(expected_triggers),
        "validRows": row_count,
        "duplicateRejected": duplicate_rejected,
        "crossScopeRejected": cross_scope_rejected,
        "tamperRejected": tamper_rejected,
        "deleteRejected": delete_rejected,
        "rollbackVerified": rollback_count == 1,
        "redactionColumnScan": True,
    }


def verify() -> dict[str, object]:
    document = schema()
    require(document.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema draft drift")
    require(document.get("$id") == "https://omnia.local/schemas/provider-attempt-lineage.schema.json", "schema id drift")
    require(document.get("type") == "object", "schema root type must be object")
    require(document.get("additionalProperties") is False, "lineage schema must reject unknown properties")

    required = set(document.get("required", []))
    require(required == REQUIRED_FIELDS, f"required fields drift: {sorted(required ^ REQUIRED_FIELDS)}")
    properties = document.get("properties", {})
    require(isinstance(properties, dict), "properties must be an object")
    property_names = set(properties)
    require(property_names == REQUIRED_FIELDS | OPTIONAL_FIELDS, "property inventory drift")
    forbidden = sorted(property_names & SECRET_OR_RAW_FIELDS)
    require(not forbidden, f"schema includes secret/raw field(s): {forbidden}")

    require(properties["schemaVersion"].get("const") == 1, "schemaVersion must remain 1")
    require(properties["requestedEffort"].get("$ref") == "#/$defs/nullableEffort", "requested effort must preserve unknown")
    require(properties["effectiveEffort"].get("$ref") == "#/$defs/nullableText", "effective effort must preserve unknown")
    require(properties["priceSnapshotId"].get("$ref") == "#/$defs/nullableId", "price snapshot must be nullable")
    require(properties["priceSnapshotSha256"].get("$ref") == "#/$defs/nullableHash", "price hash must be nullable")
    require(properties["contextManifestId"].get("$ref") == "#/$defs/nullableId", "context manifest must be nullable")
    require(properties["contextManifestSha256"].get("$ref") == "#/$defs/nullableHash", "context hash must be nullable")
    for field in (
        "catalogSnapshotId",
        "catalogSnapshotSha256",
        "modelDescriptorRevisionId",
        "modelDescriptorSha256",
        "modelCapabilitySnapshotId",
        "modelCapabilitySnapshotSha256",
        "routeRevisionId",
        "retryPolicyRevisionId",
        "cachePolicyRevisionId",
        "parameterProfileRevisionId",
        "authorityContinuityRecordId",
        "dataClassificationRevisionId",
    ):
        reference = properties[field].get("$ref", "")
        require(
            reference in ("#/$defs/nullableId", "#/$defs/nullableHash"),
            f"{field} must preserve explicit unknown/null semantics",
        )

    definitions = document.get("$defs", {})
    require(isinstance(definitions, dict), "$defs must be an object")
    require(
        set(definitions)
        >= {"id", "nullableId", "hash", "nullableHash", "revision", "nullableText", "effort", "nullableEffort"},
        "missing reusable contract definitions",
    )
    require(definitions["id"].get("maxLength") == 512, "id bound weakened")
    require(definitions["revision"].get("maxLength") == 160, "revision bound weakened")
    require(definitions["nullableText"].get("maxLength") == 80, "nullable text bound weakened")
    require(definitions["effort"].get("enum") == ["fast", "balanced", "deep", "ultra", "custom"], "effort enum drift")
    require(
        definitions.get("nullableEffort", {}).get("enum")
        == ["fast", "balanced", "deep", "ultra", "custom", None],
        "nullable effort enum drift",
    )

    all_of = document.get("allOf", [])
    require(isinstance(all_of, list) and len(all_of) >= 2, "conditional provenance rules are required")
    serialized = json.dumps(document, sort_keys=True)
    for left, right in (
        ("catalogSnapshotId", "catalogSnapshotSha256"),
        ("modelDescriptorRevisionId", "modelDescriptorSha256"),
        ("modelCapabilitySnapshotId", "modelCapabilitySnapshotSha256"),
        ("priceSnapshotId", "priceSnapshotSha256"),
        ("contextManifestId", "contextManifestSha256"),
    ):
        require(left in serialized and right in serialized, f"{left}/{right} pair rule missing")

    sql_result = verify_sql_contract()
    return {
        "schema": str(SCHEMA_PATH.relative_to(ROOT)),
        "requiredFields": len(required),
        "optionalFields": len(OPTIONAL_FIELDS),
        "secretFieldNames": 0,
        "additionalPropertiesRejected": True,
        "conditionalPairRules": len(all_of),
        "sqlContract": sql_result,
    }


def main() -> int:
    try:
        result = verify()
    except AssertionError as error:
        print(f"PROVIDER_ATTEMPT_LINEAGE_SCHEMA_VERIFY: FAIL: {error}", file=sys.stderr)
        return 1
    print("PROVIDER_ATTEMPT_LINEAGE_SCHEMA_VERIFY: PASS")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
