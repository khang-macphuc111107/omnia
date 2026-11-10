"""Regression coverage for the independent v11-v14 SQLite migration verifier.

The checked-in schema also contains later migrations. Historical migration
checks must retain their exact inventory while the complete current SQL still
receives fresh-profile smoke and projection-safety checks. These tests execute
real SQLite databases and mutated SQL copies; they do not prove Rust migrations
or packaged Tauri behavior.
"""

from __future__ import annotations

from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-state-revision-schema.py"
SPEC = importlib.util.spec_from_file_location("state_revision_schema_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import bootstrap
    raise RuntimeError(f"unable to load verifier at {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)

V14_MARKER = "-- Omnia schema v14: immutable provider-attempt lineage facts."
V15_MARKER = "-- Omnia schema v15: durable run-control resolutions, checkpoints,"


def run_with_schema(schema: str) -> dict[str, object]:
    """Use real verifier behavior with an isolated copy of its SQL input."""
    connections: list[sqlite3.Connection] = []
    real_open_connection = VERIFIER.open_connection

    def tracked_connection() -> sqlite3.Connection:
        connection = real_open_connection()
        connections.append(connection)
        return connection

    with tempfile.TemporaryDirectory(prefix="omnia-state-revision-contract-") as directory:
        schema_path = Path(directory) / "storage-schema.sql"
        schema_path.write_text(schema, encoding="utf-8")
        with (
            patch.object(VERIFIER, "SCHEMA_PATH", schema_path),
            patch.object(VERIFIER, "open_connection", side_effect=tracked_connection),
        ):
            try:
                return VERIFIER.run()
            finally:
                for connection in connections:
                    connection.close()


class StateRevisionSchemaVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = (ROOT / "docs" / "storage-schema.sql").read_text(encoding="utf-8")

    def test_v14_sql_stops_before_later_migrations(self) -> None:
        schema = (
            "-- earlier schema\n"
            f"{V14_MARKER}\nCREATE TABLE lineage (id TEXT);\n"
            f"{V15_MARKER}\nCREATE TABLE later (id TEXT);\n"
        )
        self.assertEqual(
            VERIFIER.provider_attempt_lineage_schema_tail(schema),
            "\nCREATE TABLE lineage (id TEXT);\n",
        )

    def test_missing_v14_marker_fails_closed(self) -> None:
        with self.assertRaisesRegex(VERIFIER.VerificationError, "missing the v14 marker"):
            VERIFIER.provider_attempt_lineage_schema_tail("CREATE TABLE unrelated (id TEXT);")

    def test_missing_v15_boundary_fails_closed(self) -> None:
        with self.assertRaisesRegex(VERIFIER.VerificationError, "missing the v15 marker"):
            VERIFIER.provider_attempt_lineage_schema_tail(
                f"{V14_MARKER}\nCREATE TABLE lineage (id TEXT);\n"
            )

    def test_displaced_v15_marker_cannot_install_later_objects_as_v14(self) -> None:
        mutated = self.schema.replace(V15_MARKER, "-- displaced v15 marker", 1).replace(
            "-- Omnia schema v16: authoritative goals, tasks, and starter workflows.",
            f"{V15_MARKER}\n-- Omnia schema v16: authoritative goals, tasks, and starter workflows.",
            1,
        )
        self.assertNotEqual(mutated, self.schema)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "v14 migration object inventory drifted"):
            run_with_schema(mutated)

    def test_real_v14_fixture_keeps_exact_columns_and_excludes_run_control(self) -> None:
        prefix = self.schema.split(V14_MARKER, 1)[0]
        lineage_sql = VERIFIER.provider_attempt_lineage_schema_tail(self.schema)
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.executescript(prefix + lineage_sql)
            columns = [
                row[1]
                for row in connection.execute("PRAGMA table_info(provider_attempt_lineage_facts)")
            ]
            self.assertEqual(len(columns), 35)
            self.assertNotIn("provider_definition_revision_id", columns)
            self.assertIsNone(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_control_operations'"
                ).fetchone()
            )

    def test_current_schema_verifies_v14_parity_and_complete_fresh_sql(self) -> None:
        result = run_with_schema(self.schema)
        self.assertEqual(result["currentSchemaVersion"], 14)
        self.assertEqual(result["freshObjectsSchemaVersion"], 14)
        self.assertGreater(result["currentFreshObjects"], result["freshObjects"])
        self.assertTrue(result["currentFreshSchemaSmokeVerified"])
        for version in range(11, 15):
            with self.subTest(version=version):
                self.assertTrue(result[f"v{version}RollbackVerified"])
        self.assertTrue(result["constraintMatrixVerified"])
        self.assertTrue(result["v14ScopeGuardsVerified"])
        self.assertTrue(result["v14ImmutableGuardsVerified"])

    def test_later_additive_table_does_not_change_v14_parity(self) -> None:
        baseline = run_with_schema(self.schema)
        extended = run_with_schema(self.schema + "\nCREATE TABLE future_probe (id TEXT PRIMARY KEY);\n")
        self.assertEqual(extended["freshObjects"], baseline["freshObjects"])
        self.assertEqual(extended["currentFreshObjects"], baseline["currentFreshObjects"] + 1)

    def test_extra_v14_column_still_fails_exact_inventory(self) -> None:
        mutated = self.schema.replace(
            "CREATE TABLE provider_attempt_lineage_facts (\n",
            "CREATE TABLE provider_attempt_lineage_facts (\n    unexpected_column TEXT,\n",
            1,
        )
        self.assertNotEqual(mutated, self.schema)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "column order/inventory drifted"):
            run_with_schema(mutated)

    def test_missing_v14_immutability_trigger_still_fails_closed(self) -> None:
        mutated = self.schema.replace(
            "CREATE TRIGGER provider_attempt_lineage_facts_immutable_delete\n",
            "CREATE TRIGGER unrelated_immutable_delete\n",
            1,
        )
        self.assertNotEqual(mutated, self.schema)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "missing state-revision trigger"):
            run_with_schema(mutated)

    def test_invalid_later_sql_is_still_executed_and_rejected(self) -> None:
        with self.assertRaises(sqlite3.DatabaseError):
            run_with_schema(self.schema + "\nCREATE TABLE invalid_later (;\n")

    def test_unsafe_later_lineage_column_still_fails_projection_safety(self) -> None:
        mutated = self.schema + "\nALTER TABLE provider_attempt_lineage_facts ADD COLUMN raw_body TEXT;\n"
        with self.assertRaisesRegex(VERIFIER.VerificationError, "forbidden raw/secret column present"):
            run_with_schema(mutated)


if __name__ == "__main__":
    unittest.main()
