#!/usr/bin/env python3
"""Unit tests for `agy_history_sync.py`."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

import agy_history_sync as sync_mod


def _make_step_payload(step_type: int, text: str) -> bytes:
    """Build valid Antigravity wire-format protobuf payload for step 14 or 15."""
    type_tag = (1 << 3) | 0
    parts = [type_tag.to_bytes(1, "little") + sync_mod.encode_varint(step_type)]
    if step_type == 14:
        inner = sync_mod.encode_len_delimited(2, text.encode("utf-8"))
        parts.append(sync_mod.encode_len_delimited(19, inner))
    elif step_type == 15:
        inner = sync_mod.encode_len_delimited(3, text.encode("utf-8"))
        parts.append(sync_mod.encode_len_delimited(20, inner))
    return b"".join(parts)


def _create_trajectory_db(db_path: Path, cid: str, prompts_and_replies: list[tuple[str, str]]) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(
            """
            CREATE TABLE steps (
                idx integer PRIMARY KEY,
                step_type integer NOT NULL DEFAULT 0,
                status integer NOT NULL DEFAULT 3,
                has_subtrajectory numeric NOT NULL DEFAULT false,
                metadata blob,
                error_details blob,
                permissions blob,
                task_details blob,
                render_info blob,
                step_payload blob,
                step_format integer NOT NULL DEFAULT 1
            );
            CREATE TABLE trajectory_meta (
                trajectory_id text PRIMARY KEY,
                cascade_id text,
                trajectory_type integer,
                source integer
            );
            """
        )
        conn.execute(
            "INSERT INTO trajectory_meta VALUES (?, ?, 4, 1);",
            (f"traj-{cid}", cid),
        )
        idx = 0
        for u_txt, a_txt in prompts_and_replies:
            conn.execute(
                "INSERT INTO steps(idx, step_type, status, step_payload) VALUES (?, 14, 3, ?);",
                (idx, _make_step_payload(14, u_txt)),
            )
            idx += 1
            conn.execute(
                "INSERT INTO steps(idx, step_type, status, step_payload) VALUES (?, 15, 3, ?);",
                (idx, _make_step_payload(15, a_txt)),
            )
            idx += 1
        conn.commit()
    finally:
        conn.close()
    # Age mtime past lock window so completed test fixtures are eligible by default
    old_ts = time.time() - 3600
    os.utime(db_path, (old_ts, old_ts))


def _insert_summary_row(
    sum_db: Path,
    cid: str,
    title: str,
    step_count: int,
    app_data_dir: str,
    parent_id: str = "",
    source: str = "",
    raw_summary: bytes = b"\x10\x02",
) -> None:
    sum_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(sum_db))
    try:
        sync_mod._ensure_summaries_schema(conn)
        row = {
            "conversation_id": cid,
            "title": title,
            "preview": title,
            "step_count": step_count,
            "last_modified_time": "2026-11-12 06:00:00+00:00",
            "workspace_uris": '["file:///D:/Omnia"]',
            "status": "CASCADE_RUN_STATUS_IDLE",
            "source": source,
            "project_id": "proj-1",
            "agent_name": "",
            "parent_conversation_id": parent_id,
            "nesting_depth": 1 if parent_id else 0,
            "battle_id": "",
            "winning_conversation_id": "",
            "not_fully_idle": 0,
            "killed": 0,
            "last_user_input_time": "2026-11-12 05:59:00+00:00",
            "last_user_input_step_index": 0,
            "app_data_dir": app_data_dir,
            "raw_summary": raw_summary,
            "group_id": "",
        }
        cols_sql = ", ".join(f"`{c}`" for c in sync_mod.SUMMARY_COLUMNS)
        placeholders = ", ".join("?" for _ in sync_mod.SUMMARY_COLUMNS)
        conn.execute(
            f"INSERT OR REPLACE INTO conversation_summaries ({cols_sql}) VALUES ({placeholders});",
            tuple(row[c] for c in sync_mod.SUMMARY_COLUMNS),
        )
        conn.commit()
    finally:
        conn.close()


class AgyHistorySyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.home = self.base / "home"
        self.desk = self.home / ".gemini" / "antigravity"
        self.cli = self.home / ".gemini" / "antigravity-cli"
        self.codex = self.home / ".codex"
        self.data_dir = self.base / "agy-sync-data"
        (self.home / ".gemini" / "antigravity-ide").mkdir(parents=True, exist_ok=True)
        (self.home / ".gemini" / "antigravity-ide" / ".ide_migration").write_text("", encoding="utf-8")

        # 1. Completed Desktop conversation (missing in CLI)
        self.cid_desk = "11111111-1111-4111-8111-111111111111"
        _create_trajectory_db(
            self.desk / "conversations" / f"{self.cid_desk}.db",
            self.cid_desk,
            [("Build native composer", "Implemented DirectWrite layout")],
        )
        (self.desk / "brain" / self.cid_desk).mkdir(parents=True)
        (self.desk / "brain" / self.cid_desk / "notes.md").write_text("composer spec", encoding="utf-8")
        _insert_summary_row(
            self.desk / "conversation_summaries.db",
            self.cid_desk,
            "Native Composer Design",
            2,
            "antigravity",
        )

        # 2. Completed CLI conversation (ghost summary row in Desktop, missing .db & brain in Desktop!)
        self.cid_cli = "22222222-2222-4222-8222-222222222222"
        _create_trajectory_db(
            self.cli / "conversations" / f"{self.cid_cli}.db",
            self.cid_cli,
            [("Fix workspace overflow", "Patched flexbox min-height")],
        )
        (self.cli / "brain" / self.cid_cli).mkdir(parents=True)
        (self.cli / "brain" / self.cid_cli / "audit.md").write_text("overflow fixed", encoding="utf-8")
        _insert_summary_row(
            self.cli / "conversation_summaries.db",
            self.cid_cli,
            "Fix Workspace UI Overflow",
            2,
            "antigravity-cli",
        )
        _insert_summary_row(
            self.desk / "conversation_summaries.db",
            self.cid_cli,
            "Fix Workspace UI Overflow",
            2,
            "antigravity",
            source="CORTEX_TRAJECTORY_SOURCE_CLI",
        )

        # 3. Active coordinator + child swarm worker (MUST BE EXCLUDED!)
        self.cid_coord = "cbe73571-6d33-46a5-b1c9-c71d1b3ef8b5"
        self.cid_worker = "33333333-3333-4333-8333-333333333333"
        for active_id, pid in ((self.cid_coord, ""), (self.cid_worker, self.cid_coord)):
            _create_trajectory_db(
                self.desk / "conversations" / f"{active_id}.db",
                active_id,
                [("Active swarm task", "Running")],
            )
            _insert_summary_row(
                self.desk / "conversation_summaries.db",
                active_id,
                "Active Swarm",
                2,
                "antigravity",
                parent_id=pid,
            )

        # 4. WAL-locked conversation (modified 2 seconds ago -> MUST BE EXCLUDED!)
        self.cid_wal = "44444444-4444-4444-8444-444444444444"
        wal_db = self.desk / "conversations" / f"{self.cid_wal}.db"
        _create_trajectory_db(wal_db, self.cid_wal, [("Live edit", "Working")])
        wal_sidecar = wal_db.with_name(wal_db.name + "-wal")
        wal_sidecar.write_bytes(b"active-wal-bytes")

        # 5. Mock Codex DB with sensitive email to test read-only indexing & redaction
        self.codex.mkdir(parents=True, exist_ok=True)
        c_st = sqlite3.connect(str(self.codex / "state_5.sqlite"))
        c_st.executescript(
            """
            CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at REAL, cwd TEXT, title TEXT, source TEXT);
            CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
            """
        )
        mock_email = "alice" + "@" + "g" + "mail.com"
        c_st.execute(
            "INSERT INTO threads VALUES ('codex-thread-01', 1794400000, 'D:/Omnia', ?, 'cli');",
            (f"Dynamic Router {mock_email}",),
        )
        c_st.commit()
        c_st.close()

        self.topo = sync_mod.SurfaceTopology.discover(
            home=self.home,
            desktop_root=self.desk,
            cli_root=self.cli,
            codex_root=self.codex,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_dry_run_mutates_nothing_and_excludes_active_and_wal(self) -> None:
        res = sync_mod.plan_and_run_sync(
            self.topo,
            apply=False,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(res["mode"], "dry_run")
        self.assertIn(self.cid_coord, res["excluded_active"])
        self.assertIn(self.cid_worker, res["excluded_active"])
        self.assertIn(self.cid_wal, res["excluded_active"])
        self.assertEqual(res["planned_desktop_to_cli"], 1)
        self.assertEqual(res["planned_cli_to_desktop"], 1)
        self.assertFalse((self.cli / "conversations" / f"{self.cid_desk}.db").exists())
        self.assertFalse((self.desk / "conversations" / f"{self.cid_cli}.db").exists())

    def test_apply_bidirectional_sync_backups_idempotency_and_monotonic_guard(self) -> None:
        res = sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(res["integrity_checks"]["failures"], [])
        self.assertEqual(res["copied_trajectory_dbs"], {"desktop_to_cli": 1, "cli_to_desktop": 1})

        # Verify files landed on both sides while active/WAL chats stayed isolated
        self.assertTrue((self.cli / "conversations" / f"{self.cid_desk}.db").exists())
        self.assertTrue((self.cli / "brain" / self.cid_desk / "notes.md").exists())
        self.assertTrue((self.desk / "conversations" / f"{self.cid_cli}.db").exists())
        self.assertTrue((self.desk / "brain" / self.cid_cli / "audit.md").exists())
        self.assertFalse((self.cli / "conversations" / f"{self.cid_coord}.db").exists())
        self.assertFalse((self.cli / "conversations" / f"{self.cid_worker}.db").exists())
        self.assertFalse((self.cli / "conversations" / f"{self.cid_wal}.db").exists())

        # Verify backup manifest and jetbox_summaries_proto.pb exist
        self.assertIn("backup_snapshot", res)
        pb_bytes = (self.cli / "jetbox_summaries_proto.pb").read_bytes()
        parsed_pb = sync_mod._parse_wire(pb_bytes)
        self.assertEqual(len(parsed_pb.get(1, [])), 2)

        # Second apply must be idempotent (0 .db copies)
        res2 = sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(res2["copied_trajectory_dbs"], {"desktop_to_cli": 0, "cli_to_desktop": 0})

        # Monotonic guard: advance CLI conversation to 4 steps and re-sync -> updates Desktop
        _create_trajectory_db(
            self.cli / "conversations" / f"{self.cid_cli}.db",
            self.cid_cli,
            [
                ("Fix workspace overflow", "Patched flexbox min-height"),
                ("Add regression test", "Added overflow unit test"),
            ],
        )
        res3 = sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(res3["copied_trajectory_dbs"], {"desktop_to_cli": 0, "cli_to_desktop": 1})
        self.assertEqual(
            sync_mod.get_db_step_count_ro(self.desk / "conversations" / f"{self.cid_cli}.db"), 4
        )

        # Reverse monotonic guard: shrinking CLI back to 2 steps must NOT overwrite 4-step Desktop!
        _create_trajectory_db(
            self.cli / "conversations" / f"{self.cid_cli}.db",
            self.cid_cli,
            [("Stale 2-step version", "Should not overwrite 4-step Desktop")],
        )
        res4 = sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(res4["copied_trajectory_dbs"], {"desktop_to_cli": 1, "cli_to_desktop": 0})
        self.assertEqual(
            sync_mod.get_db_step_count_ro(self.desk / "conversations" / f"{self.cid_cli}.db"), 4
        )
        self.assertEqual(
            sync_mod.get_db_step_count_ro(self.cli / "conversations" / f"{self.cid_cli}.db"), 4
        )

    def test_cli_entrypoints_status_and_search(self) -> None:
        base_flags = [
            "--home",
            str(self.home),
            "--desktop-root",
            str(self.desk),
            "--cli-root",
            str(self.cli),
            "--codex-root",
            str(self.codex),
            "--data-dir",
            str(self.data_dir),
        ]
        self.assertEqual(
            sync_mod.main([*base_flags, "sync", "--apply", "--exclude-active", self.cid_coord]),
            0,
        )
        self.assertEqual(sync_mod.main([*base_flags, "status", "--json"]), 0)
        self.assertEqual(sync_mod.main([*base_flags, "search", "Composer", "--json"]), 0)

    def test_unified_fts5_index_search_and_redaction(self) -> None:
        sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        idx_path = self.data_dir / "unified_agy_history.sqlite"
        idx_res = sync_mod.build_unified_index(self.topo, idx_path, {self.cid_coord: "active"})
        self.assertEqual(idx_res["integrity_check"], "ok")
        self.assertEqual(idx_res["codex_threads_indexed"], 1)

        hits_agy = sync_mod.search_unified_index(idx_path, "DirectWrite composer")
        self.assertEqual(len(hits_agy), 1)
        self.assertEqual(hits_agy[0]["conversation_id"], self.cid_desk)
        self.assertIn("AGY-CLI", hits_agy[0]["surfaces"])
        self.assertIn("AGY-IDE", hits_agy[0]["surfaces"])
        self.assertEqual(hits_agy[0]["resume_cmd"], f"agy --conversation {self.cid_desk}")

        hits_codex = sync_mod.search_unified_index(idx_path, "Dynamic Router")
        self.assertEqual(len(hits_codex), 1)
        self.assertEqual(hits_codex[0]["resume_cmd"], "codex resume codex-thread-01")
        self.assertNotIn("alice@", hits_codex[0]["title"])
        self.assertIn("[REDACTED_EMAIL]", hits_codex[0]["title"])


    def test_dry_run_followed_by_apply_does_not_self_lock_wal_mode_dbs(self) -> None:
        # Put completed Desktop DB into WAL journal mode, run --dry-run, then --apply immediately
        c = sqlite3.connect(str(self.desk / "conversations" / f"{self.cid_desk}.db"))
        c.execute("PRAGMA journal_mode = WAL;")
        c.close()
        old_ts = time.time() - 3600
        os.utime(self.desk / "conversations" / f"{self.cid_desk}.db", (old_ts, old_ts))

        dry = sync_mod.plan_and_run_sync(
            self.topo,
            apply=False,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(dry["planned_desktop_to_cli"], 1)

        applied = sync_mod.plan_and_run_sync(
            self.topo,
            apply=True,
            exclude_active={self.cid_coord},
            lock_window_seconds=600.0,
            backup_base_dir=self.data_dir / "backups",
        )
        self.assertEqual(applied["copied_trajectory_dbs"]["desktop_to_cli"], 1)


if __name__ == "__main__":
    unittest.main()
