from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import import_history

try:
    import compression.zstd as compression_zstd
except ImportError:  # pragma: no cover - Python versions before 3.14
    compression_zstd = None


def _empty_import_setup(root: Path) -> tuple[Path, list[str]]:
    codex = root / "codex"
    gemini = root / "gemini"
    out = root / "out"
    codex.mkdir()
    gemini.mkdir()
    (codex / "session_index.jsonl").write_text("", encoding="utf-8")
    (codex / "history.jsonl").write_text("", encoding="utf-8")
    return out, [
        "--home", str(root),
        "--codex-root", str(codex),
        "--gemini-root", str(gemini),
        "--out-dir", str(out),
    ]

def _encode_varint(value: int) -> bytes:
    payload = bytearray()
    while value >= 0x80:
        payload.append((value & 0x7F) | 0x80)
        value >>= 7
    payload.append(value)
    return bytes(payload)

def _encode_bytes_field(field_number: int, value: bytes) -> bytes:
    tag = (field_number << 3) | 2
    return _encode_varint(tag) + _encode_varint(len(value)) + value

def _agy_step(step_type: int, text: str) -> tuple[int, bytes]:
    nested_field = 2 if step_type == 14 else 3
    outer_field = 19 if step_type == 14 else 20
    nested = _encode_bytes_field(nested_field, text.encode("utf-8"))
    return step_type, _encode_bytes_field(outer_field, nested)

def _write_agy_summary_db(path: Path, rows: list[tuple[str, str, int]]) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            """
            CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                title TEXT,
                preview TEXT,
                step_count INTEGER,
                last_modified_time TEXT,
                workspace_uris TEXT,
                status TEXT,
                source TEXT,
                project_id TEXT,
                agent_name TEXT,
                parent_conversation_id TEXT
            )
            """
        )
        connection.executemany(
            """
            INSERT INTO conversation_summaries(
                conversation_id, title, preview, step_count,
                last_modified_time, workspace_uris, status, source,
                project_id, agent_name, parent_conversation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    conversation_id,
                    title,
                    f"preview:{title}",
                    step_count,
                    "2026-11-14T00:00:00Z",
                    "[]",
                    "active",
                    "test",
                    "project",
                    "agent",
                    None,
                )
                for conversation_id, title, step_count in rows
            ],
        )
        connection.commit()
    finally:
        connection.close()

def _write_agy_trajectory_db(path: Path, steps: list[tuple[int, bytes]]) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)"
        )
        connection.executemany(
            "INSERT INTO steps(idx, step_type, step_payload) VALUES (?, ?, ?)",
            [
                (index, step_type, payload)
                for index, (step_type, payload) in enumerate(steps)
            ],
        )
        connection.commit()
    finally:
        connection.close()


def _rollout_event(
    ordinal: int,
    thread_id: str,
    turn_id: str,
    item_id: str,
    item_type: str,
    text: str,
) -> dict[str, object]:
    block_type = "text" if item_type == "UserMessage" else "Text"
    return {
        "ordinal": ordinal,
        "timestamp": f"2026-11-14T00:00:{ordinal:02d}Z",
        "type": "event_msg",
        "payload": {
            "type": "item_completed",
            "thread_id": thread_id,
            "turn_id": turn_id,
            "item": {
                "type": item_type,
                "id": item_id,
                "content": [{"type": block_type, "text": text}],
            },
            "started_at_ms": ordinal,
            "completed_at_ms": ordinal + 1,
        },
    }


def _write_rollout(
    path: Path,
    session_id: str,
    events: list[dict[str, object]],
) -> None:
    rows = [
        {
            "ordinal": 0,
            "timestamp": "2026-11-14T00:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "session_id": session_id,
                "originator": "codex",
                "timestamp": "2026-11-14T00:00:00Z",
            },
        },
        *events,
    ]
    encoded = (
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".zst":
        if compression_zstd is None:
            raise unittest.SkipTest("standard-library zstd unavailable")
        with compression_zstd.ZstdFile(path, "wb") as handle:
            handle.write(encoded)
    else:
        path.write_bytes(encoded)


class ImportHistoryTests(unittest.TestCase):
    def test_rollout_parser_extracts_plain_messages_and_retains_unsupported_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            (codex / "sessions" / "2026" / "11").mkdir(parents=True)
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            session_id = "01234567-89ab-cdef-0123-456789abcdef"
            turn_id = "11234567-89ab-cdef-0123-456789abcdef"
            rollout = (
                codex
                / "sessions"
                / "2026"
                / "11"
                / f"rollout-2026-11-14T00-00-00-{session_id}.jsonl"
            )
            _write_rollout(
                rollout,
                session_id,
                [
                    _rollout_event(1, session_id, turn_id, "user-1", "UserMessage", "hello"),
                    _rollout_event(2, session_id, turn_id, "assistant-1", "AgentMessage", "world"),
                    _rollout_event(3, session_id, turn_id, "reasoning-1", "Reasoning", "ignored"),
                ],
            )
            writer = import_history.BodyWriter(root / "body.jsonl", root)
            records, sources, artifact = import_history.discover(
                root, codex, gemini, writer
            )
            rollout_source = next(
                item for item in sources if item.get("source") == "codex.rollout"
            )
            record = next(item for item in records if item["source"] == "codex.rollout")
            self.assertEqual(rollout_source["files"], 1)
            self.assertEqual(rollout_source["decoded_lines"], 4)
            self.assertEqual(rollout_source["state"], "partial")
            self.assertEqual(record["details"]["body_message_count"], 2)
            self.assertEqual(record["details"]["unsupported_count"], 1)
            self.assertEqual(record["details"]["session_meta_state"], "verified")
            self.assertEqual(record["details"]["source_hash_state"], "verified")
            self.assertEqual(artifact["messages"], 2)
            writer.close()
            self.assertEqual(len(root.joinpath("body.jsonl").read_text(encoding="utf-8").splitlines()), 2)

    def test_rollout_parser_extracts_zstd_messages_and_hashes_compressed_source(self) -> None:
        if compression_zstd is None:
            self.skipTest("standard-library zstd unavailable")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            (codex / "sessions" / "2026" / "11").mkdir(parents=True)
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            session_id = "02234567-89ab-cdef-0123-456789abcdef"
            turn_id = "12234567-89ab-cdef-0123-456789abcdef"
            rollout = (
                codex
                / "sessions"
                / "2026"
                / "11"
                / f"rollout-2026-11-14T00-00-00-{session_id}.jsonl.zst"
            )
            _write_rollout(
                rollout,
                session_id,
                [_rollout_event(1, session_id, turn_id, "user-1", "UserMessage", "compressed")],
            )
            expected_hash = hashlib.sha256(rollout.read_bytes()).hexdigest()
            writer = import_history.BodyWriter(root / "body.jsonl", root)
            records, sources, _ = import_history.discover(
                root, codex, gemini, writer
            )
            record = next(item for item in records if item["source"] == "codex.rollout")
            self.assertEqual(record["source_sha256"], expected_hash)
            self.assertEqual(record["details"]["rollout_format"], "zstd_jsonl")
            self.assertEqual(record["details"]["body_message_count"], 1)
            writer.close()
            body_index = writer.write_index()
            index_payload = json.loads(
                Path(body_index["path"]).read_text(encoding="utf-8")
            )
            span = index_payload["records"][record["record_id"]][0]
            self.assertEqual(
                span["provenance"][0]["snapshot_sha256"],
                expected_hash,
            )

    def test_rollout_parser_records_invalid_zstd_as_partial_evidence(self) -> None:
        if compression_zstd is None:
            self.skipTest("standard-library zstd unavailable")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            sessions = codex / "sessions" / "2026" / "11"
            sessions.mkdir(parents=True)
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            session_id = "06234567-89ab-cdef-0123-456789abcdef"
            path = sessions / f"rollout-{session_id}.jsonl.zst"
            path.write_bytes(b"not-a-zstandard-stream")
            writer = import_history.BodyWriter(root / "body.jsonl", root)
            records, sources, _ = import_history.discover(
                root, codex, gemini, writer
            )
            source = next(item for item in sources if item.get("source") == "codex.rollout")
            record = next(item for item in records if item["source"] == "codex.rollout")
            self.assertEqual(source["files"], 1)
            self.assertEqual(source["decode_errors"], 1)
            self.assertEqual(source["state"], "partial")
            self.assertTrue(record["details"]["decode_error"])
            self.assertEqual(record["details"]["body_message_count"], 0)

    def test_rollout_records_merge_with_codex_thread_observation(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            (codex / "sessions" / "2026" / "11").mkdir(parents=True)
            gemini.mkdir()
            session_id = "03234567-89ab-cdef-0123-456789abcdef"
            turn_id = "13234567-89ab-cdef-0123-456789abcdef"
            (codex / "session_index.jsonl").write_text(
                json.dumps({"id": session_id, "title": "metadata"}) + "\n",
                encoding="utf-8",
            )
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            path = codex / "sessions" / "2026" / "11" / f"rollout-{session_id}.jsonl"
            _write_rollout(
                path,
                session_id,
                [_rollout_event(1, session_id, turn_id, "user-1", "UserMessage", "merge")],
            )
            writer = import_history.BodyWriter(root / "body.jsonl", root)
            records, _, _ = import_history.discover(root, codex, gemini, writer)
            writer.close()
            matching = [
                item
                for item in records
                if item["record_id"] == import_history.record_id("codex.thread", session_id)
            ]
            self.assertEqual(len(matching), 1)
            evidence = matching[0]["details"]["source_evidence"]
            self.assertEqual(
                {item["source"] for item in evidence},
                {"codex.session_index", "codex.rollout"},
            )

    def test_rollout_parser_records_malformed_and_limit_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            sessions = codex / "sessions" / "2026" / "11"
            sessions.mkdir(parents=True)
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            session_id = "04234567-89ab-cdef-0123-456789abcdef"
            path = sessions / f"rollout-{session_id}.jsonl"
            path.write_bytes(
                (
                    b"{malformed}\n"
                    + json.dumps(
                        {
                            "ordinal": 1,
                            "type": "event_msg",
                            "payload": {
                                "type": "item_completed",
                                "item": {
                                    "type": "UserMessage",
                                    "id": "bad",
                                    "content": "not-a-list",
                                },
                            },
                        }
                    ).encode("utf-8")
                    + b"\n"
                )
            )
            old_limit = import_history.MAX_ROLLOUT_LINES
            import_history.MAX_ROLLOUT_LINES = 1
            try:
                writer = import_history.BodyWriter(root / "body.jsonl", root)
                records, sources, _ = import_history.discover(
                    root, codex, gemini, writer
                )
                writer.close()
            finally:
                import_history.MAX_ROLLOUT_LINES = old_limit
            source = next(item for item in sources if item.get("source") == "codex.rollout")
            record = next(item for item in records if item["source"] == "codex.rollout")
            self.assertEqual(source["malformed_lines"], 1)
            self.assertTrue(record["details"]["line_limit_reached"])
            self.assertGreaterEqual(record["details"]["malformed_count"], 1)
            self.assertEqual(record["details"]["body_message_count"], 0)

    def test_rollout_duplicate_with_sqlite_observation_keeps_one_body_span(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            sessions = codex / "sessions" / "2026" / "11"
            sessions.mkdir(parents=True)
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            session_id = "05234567-89ab-cdef-0123-456789abcdef"
            turn_id = "15234567-89ab-cdef-0123-456789abcdef"
            item_id = "shared-message"
            sqlite_path = codex / "thread_history_1.sqlite"
            connection = sqlite3.connect(sqlite_path)
            try:
                connection.execute(
                    "CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, "
                    "rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT)"
                )
                connection.execute(
                    "INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        session_id,
                        turn_id,
                        item_id,
                        1,
                        1,
                        json.dumps(
                            {
                                "content": [
                                    {"type": "text", "text": "same-body"}
                                ]
                            }
                        ),
                        "userMessage",
                    ),
                )
                connection.commit()
            finally:
                connection.close()
            path = sessions / f"rollout-{session_id}.jsonl"
            _write_rollout(
                path,
                session_id,
                [_rollout_event(1, session_id, turn_id, item_id, "UserMessage", "same-body")],
            )
            writer = import_history.BodyWriter(root / "body.jsonl", root)
            records, _, _ = import_history.discover(root, codex, gemini, writer)
            artifact = writer.close()
            record = next(item for item in records if item["record_id"] == import_history.record_id("codex.thread", session_id))
            self.assertEqual(artifact["messages"], 1)
            self.assertEqual(artifact["duplicates"], 1)
            self.assertEqual(record["details"]["body_message_count"], 1)
    def test_redact_text_removes_credentials_email_and_home(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            value = f"{home}\\notes token=sk-abcdefghijklmnopqrstuvwxyz user@example.com"
            sanitized = import_history.redact_text(value, home)
            self.assertNotIn(str(home), sanitized)
            self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz", sanitized)
            self.assertNotIn("user@example.com", sanitized)
            self.assertIn("[REDACTED", sanitized)

    def test_build_manifest_marks_metadata_only_sources_partial(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text(
                json.dumps(
                    {
                        "id": "thread-1",
                        "title": "hello",
                        "first_message": "password=secret",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            manifest = import_history.build_manifest(root, codex, gemini)
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")
            self.assertGreaterEqual(manifest["counts"]["records"], 1)
            self.assertGreaterEqual(manifest["counts"]["partial"], 1)
            self.assertEqual(manifest["records"][0]["redaction_state"], "applied")
            self.assertNotIn("secret", json.dumps(manifest))

    def test_write_is_atomic_and_json(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "nested" / "manifest.json"
            import_history.write_atomic(path, {"ok": True})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"ok": True})

    def test_jsonl_session_id_is_used_as_stable_identity(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            path = root / "history.jsonl"
            path.write_text(
                json.dumps({"session_id": "session-42", "title": "session title"}) + "\n",
                encoding="utf-8",
            )
            records, _ = import_history.parse_jsonl(path, "codex.history", root)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["source_id"], "session-42")
            self.assertNotIn("line-1", records[0]["record_id"])

    def test_sqlite_table_counts_do_not_claim_transcript_retrieval(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            path = root / "thread_history_1.sqlite"
            import sqlite3

            connection = sqlite3.connect(path)
            try:
                connection.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)")
                connection.execute("INSERT INTO messages(body) VALUES ('private body')")
                connection.commit()
            finally:
                connection.close()

            records, info = import_history.sqlite_summary(
                path, "codex.thread_history", root
            )
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["retrieval_state"], "partial")
            self.assertFalse(records[0]["transcript_available"])
            self.assertEqual(info["transcript_rows_observed"], 1)
            self.assertFalse(info["transcript_available"])


    def test_dry_run_does_not_create_body_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text(
                json.dumps({"id": "thread-1", "title": "dry-run"}) + "\n",
                encoding="utf-8",
            )
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            self.assertEqual(
                import_history.main(
                    [
                        "--home", str(root),
                        "--codex-root", str(codex),
                        "--gemini-root", str(gemini),
                        "--out-dir", str(out),
                        "--dry-run",
                    ]
                ),
                0,
            )
            self.assertFalse((out / "history-bodies.jsonl").exists())
            self.assertFalse((out / "history-manifest.json").exists())

    def test_dry_run_ignores_body_artifact_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            forced = root / "forced-body.jsonl"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text(
                json.dumps({"id": "thread-2", "title": "dry-run-env"}) + "\n",
                encoding="utf-8",
            )
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            previous = os.environ.get("OMNIA_HISTORY_BODY_ARTIFACT")
            os.environ["OMNIA_HISTORY_BODY_ARTIFACT"] = str(forced)
            try:
                self.assertEqual(
                    import_history.main(
                        [
                            "--home", str(root),
                            "--codex-root", str(codex),
                            "--gemini-root", str(gemini),
                            "--out-dir", str(out),
                            "--dry-run",
                        ]
                    ),
                    0,
                )
            finally:
                if previous is None:
                    os.environ.pop("OMNIA_HISTORY_BODY_ARTIFACT", None)
                else:
                    os.environ["OMNIA_HISTORY_BODY_ARTIFACT"] = previous
            self.assertFalse(forced.exists())
            self.assertFalse((out / "history-bodies.jsonl").exists())
            self.assertFalse((out / "history-manifest.json").exists())

    def test_codex_parser_distinguishes_message_states(self) -> None:
        self.assertEqual(
            import_history._parse_codex_message("userMessage", {"content": [{"type": "text", "text": "ok"}]}),
            ("user", "ok", "ok"),
        )
        self.assertEqual(
            import_history._parse_codex_message("userMessage", {"content": []}),
            ("", "", "empty"),
        )
        self.assertEqual(
            import_history._parse_codex_message("userMessage", {"content": "bad"}),
            ("", "", "malformed"),
        )
        self.assertEqual(
            import_history._parse_codex_message("tool", {}),
            ("", "", "unsupported"),
        )

    def test_sqlite_snapshot_is_consistent_and_hashed_once(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            path = root / "sample.sqlite"
            connection = sqlite3.connect(path)
            try:
                connection.execute("CREATE TABLE values_table(value TEXT)")
                connection.execute("INSERT INTO values_table(value) VALUES ('one')")
                connection.commit()
            finally:
                connection.close()
            with import_history._sqlite_snapshot(path, snapshot_root=root) as (snapshot, digest):
                self.assertEqual(snapshot.execute("SELECT value FROM values_table").fetchone()[0], "one")
                self.assertEqual(len(digest), 64)
                self.assertTrue(snapshot.in_transaction)

    def test_discover_extracts_antigravity_dev_summary_rows(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            surface = gemini / "antigravity-dev"
            surface.mkdir(parents=True)
            _write_agy_summary_db(
                surface / "conversation_summaries.db",
                [
                    ("dev-1", "development one", 0),
                    ("dev-2", "development two", 0),
                ],
            )
            writer = import_history.BodyWriter(root / "bodies.jsonl", root)
            records, sources, artifact = import_history.discover(
                root, codex, gemini, writer
            )
            source = next(
                item for item in sources if item.get("source") == "agy.antigravity-dev"
            )
            dev_records = [
                item for item in records if item["source"] == "agy.antigravity-dev"
            ]
            self.assertEqual(source["summary_records"], 2)
            self.assertEqual(source["state"], "partial")
            self.assertEqual(len(dev_records), 2)
            self.assertTrue(
                all(
                    item["details"]["metadata_kind"] == "agy_summary_only"
                    for item in dev_records
                )
            )
            self.assertTrue(
                all(item["details"]["missing_trajectory"] for item in dev_records)
            )
            self.assertFalse(artifact["messages"])

    def test_discover_extracts_summary_only_ide_root_without_conversations(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            surface = gemini / "antigravity-ide"
            surface.mkdir(parents=True)
            _write_agy_summary_db(
                surface / "conversation_summaries.db",
                [("ide-1", "summary only", 3)],
            )
            writer = import_history.BodyWriter(root / "bodies.jsonl", root)
            records, sources, _ = import_history.discover(root, codex, gemini, writer)
            source = next(
                item for item in sources if item.get("source") == "agy.antigravity-ide"
            )
            ide_records = [
                item for item in records if item["source"] == "agy.antigravity-ide"
            ]
            self.assertEqual(source["summary_records"], 1)
            self.assertEqual(source["trajectory_databases"], 0)
            self.assertEqual(len(ide_records), 1)
            self.assertEqual(
                ide_records[0]["details"]["metadata_kind"], "agy_summary_only"
            )
            self.assertTrue(ide_records[0]["details"]["missing_trajectory"])
            self.assertFalse(ide_records[0]["transcript_available"])
            self.assertEqual(ide_records[0]["retrieval_state"], "partial")

    def test_discover_parses_trajectory_for_compatible_ide_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            surface = gemini / "antigravity-ide"
            conversations = surface / "conversations"
            conversations.mkdir(parents=True)
            _write_agy_summary_db(
                surface / "conversation_summaries.db",
                [("ide-2", "trajectory", 2)],
            )
            _write_agy_trajectory_db(
                conversations / "ide-2.db",
                [_agy_step(14, "hello"), _agy_step(15, "world")],
            )
            writer = import_history.BodyWriter(root / "bodies.jsonl", root)
            records, sources, artifact = import_history.discover(
                root, codex, gemini, writer
            )
            source = next(
                item for item in sources if item.get("source") == "agy.antigravity-ide"
            )
            record = next(
                item
                for item in records
                if item["source"] == "agy.antigravity-ide"
            )
            self.assertEqual(source["trajectory_databases"], 1)
            self.assertEqual(source["steps"], 2)
            self.assertEqual(record["details"]["user_count"], 1)
            self.assertEqual(record["details"]["assistant_count"], 1)
            self.assertEqual(record["details"]["body_message_count"], 2)
            self.assertTrue(record["transcript_available"])
            self.assertEqual(record["retrieval_state"], "verified")
            self.assertEqual(artifact["messages"], 2)

    def test_discover_keeps_migration_marker_only_root_as_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            surface = gemini / "antigravity-ide"
            surface.mkdir(parents=True)
            (surface / ".ide_migration").write_text("migrated", encoding="utf-8")
            writer = import_history.BodyWriter(root / "bodies.jsonl", root)
            records, sources, _ = import_history.discover(root, codex, gemini, writer)
            source = next(
                item for item in sources if item.get("source") == "agy.antigravity-ide"
            )
            ide_records = [
                item for item in records if item["source"] == "agy.antigravity-ide"
            ]
            self.assertEqual(source["state"], "partial")
            self.assertEqual(len(ide_records), 1)
            self.assertEqual(
                ide_records[0]["details"]["metadata_kind"], "filesystem_inventory"
            )

    def test_body_writer_abort_preserves_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            destination = root / "history-bodies.jsonl"
            destination.write_text("old\\n", encoding="utf-8")
            writer = import_history.BodyWriter(destination, root)
            writer.add("record", {"role": "user", "text": "new"})
            writer.abort()
            self.assertEqual(destination.read_text(encoding="utf-8"), "old\\n")

    def test_body_index_is_written_and_references_ordered_span(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            destination = root / "history-bodies.jsonl"
            writer = import_history.BodyWriter(destination, root)
            self.assertTrue(
                writer.add(
                    "codex.thread:test",
                    {
                        "role": "user",
                        "text": "ordered message",
                        "item_id": "item-1",
                        "ordinal": 1,
                        "source": "codex",
                        "snapshot_sha256": "a" * 64,
                    },
                )
            )
            stats = writer.close()
            index = writer.write_index()
            self.assertIsNotNone(index)
            assert index is not None
            payload = json.loads(Path(index["path"]).read_text(encoding="utf-8"))
            self.assertEqual(payload["body_sha256"], stats["sha256"])
            self.assertEqual(payload["messages"], 1)
            self.assertEqual(payload["records"]["codex.thread:test"][0]["offset"], 0)

    def test_body_writer_orders_messages_and_records_ordinal_conflicts(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            destination = root / "history-bodies.jsonl"
            writer = import_history.BodyWriter(destination, root)
            self.assertTrue(
                writer.add(
                    "record",
                    {"role": "assistant", "text": "one", "item_id": "a", "ordinal": 1},
                )
            )
            self.assertTrue(
                writer.add(
                    "record",
                    {"role": "user", "text": "zero", "item_id": "b", "ordinal": 0},
                )
            )
            self.assertTrue(
                writer.add(
                    "record",
                    {"role": "user", "text": "other", "item_id": "c", "ordinal": 0},
                )
            )
            stats = writer.close()
            ordinals = [
                json.loads(line)["ordinal"]
                for line in destination.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(ordinals, [0, 0, 1])
            self.assertEqual(stats["ordinal_conflicts"], 1)

    def test_body_writer_merges_exact_duplicate_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            destination = root / "history-bodies.jsonl"
            writer = import_history.BodyWriter(destination, root)
            message = {
                "role": "user",
                "text": "same",
                "item_id": "same-item",
                "ordinal": 0,
                "timestamp": 1,
            }
            self.assertTrue(writer.add("record", {**message, "source": "codex"}))
            self.assertFalse(writer.add("record", {**message, "source": "agy"}))
            stats = writer.close()
            index = writer.write_index()
            assert index is not None
            payload = json.loads(Path(index["path"]).read_text(encoding="utf-8"))
            self.assertEqual(stats["duplicates"], 1)
            self.assertEqual(len(payload["records"]["record"][0]["provenance"]), 2)

    def test_upsert_does_not_promote_partial_plus_verified(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            records: dict[str, dict[str, object]] = {}
            partial = import_history.make_record(
                "codex.history",
                "same",
                root / "history.jsonl",
                root,
                "a" * 64,
                retrieval_state="partial",
                details={"metadata_state": "verified"},
            )
            verified = import_history.make_record(
                "codex.thread",
                "same",
                root / "thread_history_1.sqlite",
                root,
                "b" * 64,
                retrieval_state="verified",
                transcript_available=True,
                details={"metadata_state": "verified", "body_message_count": 1},
            )
            import_history._upsert_record(records, partial)
            import_history._upsert_record(records, verified)
            merged = records[partial["record_id"]]
            self.assertEqual(merged["retrieval_state"], "partial")
            self.assertIn("partial", merged["details"]["evidence_source_states"])

    def test_upsert_preserves_deterministic_source_evidence_across_agy_surfaces(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            cli = import_history.make_record(
                "agy.antigravity-cli",
                "same-conversation",
                root / "cli" / "conversations.db",
                root,
                "a" * 64,
                details={
                    "metadata_kind": "agy_trajectory",
                    "summary_sha256": "c" * 64,
                },
            )
            dev = import_history.make_record(
                "agy.antigravity-dev",
                "same-conversation",
                root / "dev" / "conversations.db",
                root,
                "b" * 64,
                details={
                    "metadata_kind": "agy_summary_only",
                    "summary_sha256": "d" * 64,
                },
            )
            for cli_hash in ("a" * 64, None):
                cli["source_sha256"] = cli_hash
                expected = sorted(
                    [
                        {
                            "source": "agy.antigravity-cli",
                            "source_path": "~/cli/conversations.db",
                            "source_sha256": cli_hash,
                            "metadata_kind": "agy_trajectory",
                            "summary_sha256": "c" * 64,
                        },
                        {
                            "source": "agy.antigravity-dev",
                            "source_path": "~/dev/conversations.db",
                            "source_sha256": "b" * 64,
                            "metadata_kind": "agy_summary_only",
                            "summary_sha256": "d" * 64,
                        },
                    ],
                    key=lambda item: json.dumps(
                        item, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":"),
                    ),
                )
                self.assertEqual(
                    import_history._merge_source_evidence(
                        expected[0], [expected[1], expected[0]]
                    ),
                    expected,
                )
                for order in (
                    (cli, dev),
                    (dev, cli),
                    (cli, dev, cli, dev),
                    (dev, cli, dev, cli),
                ):
                    with self.subTest(
                        cli_hash=cli_hash,
                        order=tuple(item["source"] for item in order),
                    ):
                        records: dict[str, dict[str, object]] = {}
                        for observation in order:
                            import_history._upsert_record(
                                records, json.loads(json.dumps(observation))
                            )
                        self.assertEqual(len(records), 1)
                        merged = records[cli["record_id"]]
                        self.assertEqual(
                            merged["details"]["source_evidence"], expected
                        )
                        # Re-inserting the aggregate cannot project its mixed
                        # display fields into a new source observation.
                        import_history._upsert_record(
                            records, json.loads(json.dumps(merged))
                        )
                        self.assertEqual(
                            merged["details"]["source_evidence"], expected
                        )

    def test_main_publishes_hash_named_generation_and_keeps_it_on_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]
            self.assertEqual(import_history.main(args), 0)
            first = json.loads((out / "history-manifest.json").read_text(encoding="utf-8"))
            body_path = Path(first["body_artifact"]["path"])
            index_path = Path(first["body_artifact"]["index"]["path"])
            self.assertTrue(body_path.name.startswith("history-bodies."))
            self.assertTrue(body_path.exists())
            self.assertTrue(index_path.exists())
            self.assertEqual(import_history.main(args), 0)
            self.assertTrue(body_path.exists())
            generations = list(out.glob("history-bodies.*.jsonl"))
            self.assertEqual(generations, [body_path])

    def test_publish_failure_does_not_replace_existing_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out = root / "out"
            out.mkdir()
            manifest_path = out / "history-manifest.json"
            old = {"schema": "omnia.history-manifest.v2", "marker": "old"}
            import_history.write_atomic(manifest_path, old)
            staging = out / ".history-bodies.failure.jsonl"
            staging.write_text("not-json\n", encoding="utf-8")
            manifest = {
                "body_artifact": {
                    "path": str(staging),
                    "sha256": "0" * 64,
                    "index": {"path": str(staging.with_suffix(".index.json")), "sha256": "1" * 64},
                }
            }
            with self.assertRaises(ValueError):
                import_history._publish_generation(
                    out,
                    manifest,
                    {},
                    home=root,
                )
            self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), old)

    def test_manifest_and_receipt_roll_back_together_on_second_rename_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            manifest_path = root / "history-manifest.json"
            receipt_path = root / "history-receipt.json"
            old_manifest = {"schema": "omnia.history-manifest.v2", "generation": "old"}
            old_receipt = {"schema": "omnia.history-import-receipt.v1", "generation": "old"}
            import_history.write_atomic(manifest_path, old_manifest)
            import_history.write_atomic(receipt_path, old_receipt)
            previous_manifest = manifest_path.read_bytes()
            previous_receipt = receipt_path.read_bytes()

            original_replace = import_history.os.replace
            failed = {"value": False}

            def fail_receipt_replace(source: object, destination: object) -> None:
                if Path(destination) == receipt_path and not failed["value"]:
                    failed["value"] = True
                    raise OSError("injected_receipt_rename_failure")
                original_replace(source, destination)

            import_history.os.replace = fail_receipt_replace
            try:
                with self.assertRaises(OSError):
                    import_history._publish_manifest_receipt_pair(
                        manifest_path,
                        {"schema": "omnia.history-manifest.v2", "generation": "new"},
                        receipt_path,
                        {"schema": "omnia.history-import-receipt.v1", "generation": "new"},
                        previous_manifest,
                        previous_receipt,
                    )
            finally:
                import_history.os.replace = original_replace

            self.assertTrue(failed["value"])
            self.assertEqual(manifest_path.read_bytes(), previous_manifest)
            self.assertEqual(receipt_path.read_bytes(), previous_receipt)

    def test_active_pointer_publishes_and_verifies_immutable_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]

            self.assertEqual(import_history.main(args), 0)
            pointer_path = out / "history-active.json"
            self.assertTrue(pointer_path.is_file())
            pointer, manifest, receipt = import_history._read_active_generation(out)

            manifest_target = out / pointer["manifest"]["path"]
            receipt_target = out / pointer["receipt"]["path"]
            self.assertEqual(
                pointer["manifest"]["sha256"],
                hashlib.sha256(manifest_target.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                pointer["receipt"]["sha256"],
                hashlib.sha256(receipt_target.read_bytes()).hexdigest(),
            )
            self.assertEqual(receipt["manifest_sha256"], pointer["manifest"]["sha256"])
            self.assertEqual(receipt["generation"], pointer["generation"])
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")

            manifest_target.write_bytes(manifest_target.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "active_manifest_hash_mismatch"):
                import_history._read_active_generation(out)

    def test_receipt_path_basename_accepts_both_separators_and_alias(self) -> None:
        expected = "history-manifest." + ("a" * 64) + ".json"
        cases = (
            ("missing", {}, True),
            ("null", {"manifest_path": None}, True),
            ("absolute", {"manifest_path": "C:/history/" + expected}, True),
            ("slash", {"manifest_path": "history/archive/" + expected}, True),
            ("backslash", {"manifest_path": "history\\archive\\" + expected}, True),
            ("alias", {"manifest_path": "C:\\history\\history-manifest.json"}, True),
            ("wrong basename", {"manifest_path": "history-manifest.other.json"}, False),
            ("empty", {"manifest_path": ""}, False),
            ("wrong type", {"manifest_path": 7}, False),
        )
        for label, receipt, accepted in cases:
            with self.subTest(label=label):
                self.assertEqual(
                    import_history._receipt_path_matches(
                        receipt,
                        "manifest_path",
                        expected,
                        "history-manifest.json",
                    ),
                    accepted,
                )

    def test_active_pointer_rejects_manifest_receipt_path_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            pointer, manifest, receipt = import_history._read_active_generation(out)

            receipt["manifest_path"] = "C:\\history\\wrong-manifest.json"
            receipt_bytes = import_history.canonical_json_bytes(receipt)
            receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
            receipt_name = f"history-receipt.{receipt_hash}.json"
            (out / receipt_name).write_bytes(receipt_bytes)
            forged_pointer = import_history._active_pointer_payload(
                pointer["manifest"]["path"],
                pointer["manifest"]["sha256"],
                receipt_name,
                receipt_hash,
                receipt,
            )
            import_history.write_atomic(out / "history-active.json", forged_pointer)

            with self.assertRaisesRegex(
                ValueError, "active_receipt_manifest_path_mismatch"
            ):
                import_history._read_active_generation(out)

    def test_active_pointer_accepts_manifest_receipt_alias_and_windows_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            pointer, manifest, receipt = import_history._read_active_generation(out)

            receipt["manifest_path"] = "C:\\history\\history-manifest.json"
            receipt["body_path"] = (
                "C:\\history\\" + Path(manifest["body_artifact"]["path"]).name
            )
            receipt["index_path"] = (
                "C:\\history\\"
                + Path(manifest["body_artifact"]["index"]["path"]).name
            )
            receipt_bytes = import_history.canonical_json_bytes(receipt)
            receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
            receipt_name = f"history-receipt.{receipt_hash}.json"
            (out / receipt_name).write_bytes(receipt_bytes)
            forged_pointer = import_history._active_pointer_payload(
                pointer["manifest"]["path"],
                pointer["manifest"]["sha256"],
                receipt_name,
                receipt_hash,
                receipt,
            )
            import_history.write_atomic(out / "history-active.json", forged_pointer)

            selected_pointer, selected_manifest, selected_receipt = (
                import_history._read_active_generation(out)
            )
            self.assertEqual(selected_pointer["generation"], pointer["generation"])
            self.assertEqual(selected_manifest["schema"], "omnia.history-manifest.v2")
            self.assertEqual(
                selected_receipt["manifest_path"],
                "C:\\history\\history-manifest.json",
            )

    def test_active_pointer_rejects_counts_that_do_not_match_manifest_records(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            pointer, manifest, receipt = import_history._read_active_generation(out)

            manifest["counts"] = {
                "records": 1,
                "verified": 1,
                "partial": 0,
                "blocked": 0,
                "transcript_available": 0,
            }
            manifest_bytes = import_history.canonical_json_bytes(manifest)
            manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
            manifest_name = f"history-manifest.{manifest_hash}.json"
            (out / manifest_name).write_bytes(manifest_bytes)

            receipt["manifest_sha256"] = manifest_hash
            receipt["counts"] = manifest["counts"]
            receipt_bytes = import_history.canonical_json_bytes(receipt)
            receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
            receipt_name = f"history-receipt.{receipt_hash}.json"
            (out / receipt_name).write_bytes(receipt_bytes)

            forged_pointer = import_history._active_pointer_payload(
                manifest_name,
                manifest_hash,
                receipt_name,
                receipt_hash,
                receipt,
            )
            import_history.write_atomic(out / "history-active.json", forged_pointer)

            with self.assertRaisesRegex(
                ValueError, "active_generation_counts_mismatch"
            ):
                import_history._read_active_generation(out)

    def test_active_pointer_rejects_unhashable_record_retrieval_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            _, manifest, receipt = import_history._read_active_generation(out)

            manifest["records"] = [
                {"retrieval_state": [], "transcript_available": False}
            ]
            manifest["counts"] = {
                "records": 1,
                "verified": 0,
                "partial": 1,
                "blocked": 0,
                "transcript_available": 0,
            }
            manifest_bytes = import_history.canonical_json_bytes(manifest)
            manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
            manifest_name = f"history-manifest.{manifest_hash}.json"
            (out / manifest_name).write_bytes(manifest_bytes)

            receipt["manifest_sha256"] = manifest_hash
            receipt["counts"] = manifest["counts"]
            receipt_bytes = import_history.canonical_json_bytes(receipt)
            receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
            receipt_name = f"history-receipt.{receipt_hash}.json"
            (out / receipt_name).write_bytes(receipt_bytes)

            forged_pointer = import_history._active_pointer_payload(
                manifest_name,
                manifest_hash,
                receipt_name,
                receipt_hash,
                receipt,
            )
            import_history.write_atomic(out / "history-active.json", forged_pointer)

            with self.assertRaisesRegex(
                ValueError, "active_generation_record_invalid_state"
            ):
                import_history._read_active_generation(out)

    def test_active_pointer_survives_process_exit_before_pointer_replace(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]
            self.assertEqual(import_history.main(args), 0)
            previous_pointer = (out / "history-active.json").read_bytes()
            child = r"""
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import import_history

original_write_atomic = import_history.write_atomic

def stop_before_pointer(path, payload):
    if Path(path).name == "history-active.json":
        os._exit(73)
    return original_write_atomic(path, payload)

import_history.write_atomic = stop_before_pointer
raise SystemExit(import_history.main(sys.argv[2:]))
"""
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    child,
                    str(Path(__file__).resolve().parent),
                    *args,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 73)
            self.assertEqual((out / "history-active.json").read_bytes(), previous_pointer)
            pointer, manifest, receipt = import_history._read_active_generation(out)
            self.assertEqual(pointer["generation"], receipt["generation"])
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")

    def test_active_pointer_survives_process_exit_after_pointer_replace(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]
            self.assertEqual(import_history.main(args), 0)
            previous_pointer = (out / "history-active.json").read_bytes()
            child = r"""
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import import_history

original_write_atomic = import_history.write_atomic

def stop_after_pointer(path, payload):
    result = original_write_atomic(path, payload)
    if Path(path).name == "history-active.json":
        os._exit(74)
    return result

import_history.write_atomic = stop_after_pointer
raise SystemExit(import_history.main(sys.argv[2:]))
"""
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    child,
                    str(Path(__file__).resolve().parent),
                    *args,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 74)
            current_pointer = (out / "history-active.json").read_bytes()
            self.assertNotEqual(current_pointer, previous_pointer)
            pointer, manifest, receipt = import_history._read_active_generation(out)
            self.assertEqual(pointer["generation"], receipt["generation"])
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")
            self.assertEqual(
                (out / "history-manifest.json").read_bytes(),
                import_history.canonical_json_bytes(manifest),
            )
            self.assertEqual(
                (out / "history-receipt.json").read_bytes(),
                import_history.canonical_json_bytes(receipt),
            )

    def test_pointer_write_failure_restores_previous_aliases_and_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]
            self.assertEqual(import_history.main(args), 0)
            previous_pointer = (out / "history-active.json").read_bytes()
            previous_manifest = (out / "history-manifest.json").read_bytes()
            previous_receipt = (out / "history-receipt.json").read_bytes()
            original_write_atomic = import_history.write_atomic

            def fail_pointer(path: Path, payload: dict[str, object]) -> None:
                if Path(path).name == "history-active.json":
                    raise OSError("injected_pointer_write_failure")
                original_write_atomic(path, payload)

            import_history.write_atomic = fail_pointer
            try:
                with self.assertRaisesRegex(OSError, "injected_pointer_write_failure"):
                    import_history.main(args)
            finally:
                import_history.write_atomic = original_write_atomic

            self.assertEqual((out / "history-active.json").read_bytes(), previous_pointer)
            self.assertEqual((out / "history-manifest.json").read_bytes(), previous_manifest)
            self.assertEqual((out / "history-receipt.json").read_bytes(), previous_receipt)
            import_history._read_active_generation(out)

    def test_alias_recovery_requires_a_verified_pointer_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            args = [
                "--home", str(root),
                "--codex-root", str(codex),
                "--gemini-root", str(gemini),
                "--out-dir", str(out),
            ]
            self.assertEqual(import_history.main(args), 0)
            _, manifest, receipt = import_history._read_active_generation(out)
            (out / "history-manifest.json").write_bytes(b"stale alias\n")
            import_history._recover_compatibility_aliases(out)
            self.assertEqual(
                (out / "history-manifest.json").read_bytes(),
                import_history.canonical_json_bytes(manifest),
            )
            self.assertEqual(
                (out / "history-receipt.json").read_bytes(),
                import_history.canonical_json_bytes(receipt),
            )

            pointer_path = out / "history-active.json"
            pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
            pointer["manifest"]["sha256"] = "f" * 64
            pointer_path.write_text(
                json.dumps(pointer, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError,
                "active_pointer_invalid_targets|active_manifest_hash_mismatch|active_manifest_invalid",
            ):
                import_history._recover_compatibility_aliases(out)

    def test_alias_recovery_rejects_existing_pointer_with_missing_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            pointer = json.loads((out / "history-active.json").read_text(encoding="utf-8"))
            manifest_target = out / pointer["manifest"]["path"]
            manifest_target.unlink()
            with self.assertRaises(FileNotFoundError):
                import_history._recover_compatibility_aliases(out)

    def test_missing_active_pointer_recovers_from_valid_previous_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            self.assertEqual(import_history.main(args), 0)
            previous_path = out / "history-active.previous.json"
            previous_pointer = json.loads(previous_path.read_text(encoding="utf-8"))
            (out / "history-active.json").unlink()

            pointer, manifest, receipt = import_history._read_active_generation(out)

            self.assertEqual(pointer["recovered_from"], "history-active.previous.json")
            self.assertEqual(pointer["generation"], previous_pointer["generation"])
            self.assertEqual(pointer["generation"], receipt["generation"])
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")

    def test_malformed_active_pointer_recovers_from_valid_previous_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            self.assertEqual(import_history.main(args), 0)
            previous_path = out / "history-active.previous.json"
            previous_pointer = json.loads(previous_path.read_text(encoding="utf-8"))
            (out / "history-active.json").write_bytes(b"{ malformed pointer\n")

            pointer, manifest, receipt = import_history._read_active_generation(out)

            self.assertEqual(pointer["recovered_from"], "history-active.previous.json")
            self.assertEqual(pointer["generation"], previous_pointer["generation"])
            self.assertEqual(pointer["generation"], receipt["generation"])
            self.assertEqual(manifest["schema"], "omnia.history-manifest.v2")

    def test_tampered_active_artifact_recovers_from_valid_previous_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            self.assertEqual(import_history.main(args), 0)
            previous_path = out / "history-active.previous.json"
            previous_pointer, expected_manifest, expected_receipt = (
                import_history._read_generation_from_pointer(out, previous_path)
            )
            active_pointer = json.loads(
                (out / "history-active.json").read_text(encoding="utf-8")
            )
            active_manifest = out / active_pointer["manifest"]["path"]
            active_manifest.write_bytes(active_manifest.read_bytes() + b"tampered")

            pointer, manifest, receipt = import_history._read_active_generation(out)

            self.assertEqual(pointer["recovered_from"], "history-active.previous.json")
            self.assertEqual(pointer["generation"], previous_pointer["generation"])
            self.assertEqual(manifest, expected_manifest)
            self.assertEqual(receipt, expected_receipt)

    def test_invalid_previous_generation_is_unrecoverable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            self.assertEqual(import_history.main(args), 0)
            previous_path = out / "history-active.previous.json"
            previous_pointer = json.loads(previous_path.read_text(encoding="utf-8"))
            (out / previous_pointer["manifest"]["path"]).unlink()
            (out / "history-active.json").unlink()

            with self.assertRaisesRegex(
                ValueError, "active_generation_unrecoverable"
            ):
                import_history._read_active_generation(out)

    def test_no_pointers_is_clean_first_publication_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw) / "out"
            out.mkdir()

            import_history._recover_compatibility_aliases(out)

            self.assertIsNone(import_history._last_known_good_pointer_bytes(out))
            self.assertFalse((out / "history-manifest.json").exists())
            self.assertFalse((out / "history-receipt.json").exists())

    def test_alias_recovery_rejects_pointer_directories(self) -> None:
        for name in ("history-active.json", "history-active.previous.json"):
            with self.subTest(pointer=name), tempfile.TemporaryDirectory() as raw:
                out = Path(raw) / "out"
                out.mkdir()
                (out / name).mkdir()
                manifest_alias = out / "history-manifest.json"
                receipt_alias = out / "history-receipt.json"
                manifest_alias.write_bytes(b"stale manifest alias\n")
                receipt_alias.write_bytes(b"stale receipt alias\n")

                with self.assertRaises((FileNotFoundError, ValueError)):
                    import_history._recover_compatibility_aliases(out)

                self.assertEqual(
                    manifest_alias.read_bytes(), b"stale manifest alias\n"
                )
                self.assertEqual(
                    receipt_alias.read_bytes(), b"stale receipt alias\n"
                )

    def test_alias_recovery_falls_back_to_valid_previous_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out, args = _empty_import_setup(root)
            self.assertEqual(import_history.main(args), 0)
            self.assertEqual(import_history.main(args), 0)
            previous_path = out / "history-active.previous.json"
            _, expected_manifest, expected_receipt = (
                import_history._read_generation_from_pointer(out, previous_path)
            )
            (out / "history-active.json").unlink()
            (out / "history-manifest.json").write_bytes(b"stale manifest alias\n")
            (out / "history-receipt.json").write_bytes(b"stale receipt alias\n")

            import_history._recover_compatibility_aliases(out)

            self.assertEqual(
                (out / "history-manifest.json").read_bytes(),
                import_history.canonical_json_bytes(expected_manifest),
            )
            self.assertEqual(
                (out / "history-receipt.json").read_bytes(),
                import_history.canonical_json_bytes(expected_receipt),
            )

    def test_output_lock_rejects_competing_process(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out = root / "out"
            ready = root / "ready"
            child = r"""
import sys
import time
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import import_history

out = Path(sys.argv[2])
ready = Path(sys.argv[3])
with import_history._history_output_lock(out):
    ready.write_text("ready", encoding="utf-8")
    time.sleep(1.5)
"""
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    child,
                    str(Path(__file__).resolve().parent),
                    str(out),
                    str(ready),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    if process.poll() is not None:
                        self.fail(process.stderr.read() if process.stderr else "lock child exited")
                    import_history.time.sleep(0.02)
                self.assertTrue(ready.exists())
                with self.assertRaisesRegex(RuntimeError, "history_import_in_progress"):
                    with import_history._history_output_lock(out):
                        pass
            finally:
                process.communicate(timeout=10)

    def test_main_rejects_output_inside_source_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")
            with self.assertRaises(ValueError):
                import_history.main(
                    [
                        "--home", str(root),
                        "--codex-root", str(codex),
                        "--gemini-root", str(gemini),
                        "--out-dir", str(codex / "out"),
                    ]
                )
    def test_receipt_persisted_with_manifest_and_receipt_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            codex = root / "codex"
            gemini = root / "gemini"
            out = root / "out"
            codex.mkdir()
            gemini.mkdir()
            (codex / "session_index.jsonl").write_text("", encoding="utf-8")
            (codex / "history.jsonl").write_text("", encoding="utf-8")

            self.assertEqual(
                import_history.main(
                    [
                        "--home",
                        str(root),
                        "--codex-root",
                        str(codex),
                        "--gemini-root",
                        str(gemini),
                        "--out-dir",
                        str(out),
                    ]
                ),
                0,
            )
            receipt = json.loads((out / "history-receipt.json").read_text(encoding="utf-8"))
            manifest_bytes = (out / "history-manifest.json").read_bytes()
            self.assertEqual(
                receipt["manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest()
            )
            self.assertIn("manifest_path", receipt)
            self.assertIn("receipt_path", receipt)
            self.assertEqual(receipt["status"], "partial")


if __name__ == "__main__":
    unittest.main()
