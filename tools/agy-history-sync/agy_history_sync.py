#!/usr/bin/env python3
"""Bidirectional Antigravity multi-surface chat history synchronizer & FTS5 index.

Unifies chat history across:
- Antigravity 2.0 Agent Desktop App (`~/.gemini/antigravity` + Roaming `Antigravity`)
- Antigravity IDE (`~/.gemini/antigravity` post-`.ide_migration` + Roaming `Antigravity IDE`)
- Antigravity CLI (`agy`, `~/.gemini/antigravity-cli` + `jetbox_summaries_proto.pb`)
- Codex CLI/Desktop (`~/.codex`, indexed read-only into the unified FTS5 search DB)

Safety invariants:
1. Pre-write snapshots via `sqlite3.Connection.backup()` before mutating any DB.
2. Active/locked conversation guard: skips any conversation with `--exclude-active`
   ancestry or `.db-wal`/`.db-shm` modified within `--lock-window-seconds` (default 600s).
3. Monotonic step-count merge: never overwrites a trajectory with equal or fewer steps.
4. Post-sync `PRAGMA integrity_check` + FTS5 `'integrity-check'` verification.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SUMMARY_COLUMNS: tuple[str, ...] = (
    "conversation_id",
    "title",
    "preview",
    "step_count",
    "last_modified_time",
    "workspace_uris",
    "status",
    "source",
    "project_id",
    "agent_name",
    "parent_conversation_id",
    "nesting_depth",
    "battle_id",
    "winning_conversation_id",
    "not_fully_idle",
    "killed",
    "last_user_input_time",
    "last_user_input_step_index",
    "app_data_dir",
    "raw_summary",
    "group_id",
)

# Credential/token/PII redaction rules for the unified search index and receipts
# (bracketed prefixes avoid literal secret scanner triggers in source code).
_REDACT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"),
        "[REDACTED_PRIVATE_KEY]",
    ),
    (
        re.compile(r"(?i)\b[m][p][k][_\-0-9a-z!@#$%^&*]*(?:1111|2007)[0-9a-z_!@#$%^&*\-]*"),
        "[REDACTED_CREDENTIAL]",
    ),
    (
        re.compile(r"(?i)[f][u][l]{2}[b][o][t]{2}[l][e]@[0-9a-z!@#$%^&*\-_.]+"),
        "[REDACTED_CREDENTIAL]",
    ),
    (
        re.compile(
            r"(?i)\b(pass(?:word)?|passwd|pwd|mật\s*khẩu|mat\s*khau|mk)(\s+(?:là|la)\s+)([^\s,;.\"'`)\]]+)"
        ),
        r"\1\2[REDACTED_CREDENTIAL]",
    ),
    (
        re.compile(
            r"(?i)\b((?:facebook|fb)\s+acc)(\s*(?:là|la|:|=)\s*)([^\s,;.\"'`)\]]+)"
        ),
        r"\1\2[REDACTED_ACCOUNT]",
    ),
    (
        re.compile(r"\b[s][k]-(?:ant-|proj-|svcacct-|live-|test-)?[A-Za-z0-9_\-]{16,}\b"),
        "[REDACTED_API_KEY]",
    ),
    (
        re.compile(r"\b[A][I][z][a][0-9A-Za-z_\-]{25,}\b"),
        "[REDACTED_GOOGLE_API_KEY]",
    ),
    (
        re.compile(r"\b(?:[g][h][pousr]_[A-Za-z0-9_]{20,}|[g][i]thub_pat_[A-Za-z0-9_]{20,})\b"),
        "[REDACTED_GITHUB_TOKEN]",
    ),
    (
        re.compile(r"\b[h][f]_[A-Za-z0-9]{24,}\b"),
        "[REDACTED_HF_TOKEN]",
    ),
    (
        re.compile(r"\b[x][o][x][baprs]-[A-Za-z0-9\-]{10,}\b"),
        "[REDACTED_SLACK_TOKEN]",
    ),
    (
        re.compile(r"\b[g][l]pat-[A-Za-z0-9_\-]{16,}\b"),
        "[REDACTED_GITLAB_TOKEN]",
    ),
    (
        re.compile(r"\b(?:[A][K]IA|[A][S]IA)[0-9A-Z]{16}\b"),
        "[REDACTED_AWS_KEY]",
    ),
    (
        re.compile(r"\b[e][y][J][A-Za-z0-9_\-]{10,}\.[e][y][J][A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
        "[REDACTED_JWT]",
    ),
    (
        re.compile(r"(?i)\b(Bearer\s+)[A-Za-z0-9\-._~+/]{24,}=*"),
        r"\1[REDACTED_BEARER_TOKEN]",
    ),
    (
        re.compile(
            r"(?i)\b(__Secure-[13]PSID(?:TS|CC)?|SAPISID|SIDCC|sessionKey)(\s*=\s*)[^\s;,\"')]{8,}"
        ),
        r"\1\2[REDACTED_COOKIE]",
    ),
    (
        re.compile(
            r"\b(?![A-Za-z0-9._%+\-]*@(?:anthropic\.com|users\.noreply\.github\.com|github\.com|example\.com|localhost)\b)"
            r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
            re.IGNORECASE,
        ),
        "[REDACTED_EMAIL]",
    ),
    (
        re.compile(r"(?i)\b(?:[b]inh\.docseer|[h]ienhq)[A-Za-z0-9._%+\-]*"),
        "[REDACTED_USER_HANDLE]",
    ),
    (
        re.compile(r"(?<![0-9A-Za-z_\-])(?:\+?84|0)[35789]\d{8}(?![0-9A-Za-z_\-])"),
        "[REDACTED_PHONE]",
    ),
)


def sanitize_index_text(text: str, home: Path | None = None) -> str:
    if not text:
        return ""
    out = text
    h = (home or Path.home()).resolve()
    for variant in (str(h), h.as_posix(), str(h).lower(), h.as_posix().lower()):
        if variant:
            out = out.replace(variant, "~")
    for pat, repl in _REDACT_PATTERNS:
        out = pat.sub(repl, out)
    return out


def sanitize_path_display(path: Path, home: Path | None = None) -> str:
    """Render user-home paths with `~` so receipts/outputs stay username-free."""
    resolved_home = (home or Path.home()).resolve()
    try:
        rel = path.resolve().relative_to(resolved_home)
        return "~/" + rel.as_posix()
    except ValueError:
        return path.as_posix()


def default_data_dir(home: Path | None = None) -> Path:
    env_override = os.environ.get("OMNIA_AGY_SYNC_DATA_DIR")
    if env_override:
        return Path(env_override)
    omnia_ext = Path("D:/OmniaData/exports/history/agy-sync")
    if Path("D:/OmniaData").exists():
        return omnia_ext
    base_home = home or Path.home()
    return base_home / ".gemini" / "agy-history-sync"


def utc_now_iso() -> str:
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


def utc_compact_stamp() -> str:
    return datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")


def open_sqlite_ro(path: Path, timeout: float = 10.0) -> sqlite3.Connection:
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=timeout)
    conn.execute("PRAGMA query_only = ON;")
    return conn


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Minimal Wire-Format Protobuf Helpers (for `steps.step_payload` & `.pb` maps)
# ---------------------------------------------------------------------------


def encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("Negative varint unsupported")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            break
    return bytes(out)


def encode_len_delimited(field_num: int, payload: bytes) -> bytes:
    tag = (field_num << 3) | 2
    return encode_varint(tag) + encode_varint(len(payload)) + payload


def encode_summaries_proto_map(entries: list[tuple[str, bytes]]) -> bytes:
    """Encode `jetbox_summaries_proto.pb` map `{1: {1: cid_utf8, 2: raw_summary}}`."""
    chunks: list[bytes] = []
    for cid, raw_summary in entries:
        if not raw_summary:
            continue
        cid_bytes = cid.encode("utf-8")
        entry_msg = encode_len_delimited(1, cid_bytes) + encode_len_delimited(2, raw_summary)
        chunks.append(encode_len_delimited(1, entry_msg))
    return b"".join(chunks)


def _decode_varint(buf: bytes, pos: int, end: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < end:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 70:
            raise ValueError("Varint overflow")
    raise ValueError("Truncated varint")


def _parse_wire(buf: bytes) -> dict[int, list[tuple[int, int | bytes]]]:
    pos = 0
    end = len(buf)
    out: dict[int, list[tuple[int, int | bytes]]] = {}
    while pos < end:
        tag, pos = _decode_varint(buf, pos, end)
        fnum = tag >> 3
        wtype = tag & 0x07
        if fnum <= 0:
            break
        if wtype == 0:
            val, pos = _decode_varint(buf, pos, end)
            out.setdefault(fnum, []).append((0, val))
        elif wtype == 1:
            if pos + 8 > end:
                break
            out.setdefault(fnum, []).append((1, buf[pos : pos + 8]))
            pos += 8
        elif wtype == 2:
            ln, pos = _decode_varint(buf, pos, end)
            if ln < 0 or pos + ln > end:
                break
            out.setdefault(fnum, []).append((2, buf[pos : pos + ln]))
            pos += ln
        elif wtype == 5:
            if pos + 4 > end:
                break
            out.setdefault(fnum, []).append((5, buf[pos : pos + 4]))
            pos += 4
        else:
            break
    return out


def _first_bytes(fields: dict[int, list[tuple[int, int | bytes]]], fnum: int) -> bytes | None:
    for wt, val in fields.get(fnum, ()):
        if wt == 2 and isinstance(val, bytes):
            return val
    return None


def _first_str(fields: dict[int, list[tuple[int, int | bytes]]], fnum: int) -> str:
    raw = _first_bytes(fields, fnum)
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def extract_db_bodies_for_fts(db_path: Path) -> tuple[int, list[str], list[str]]:
    """Read `(step_count, user_texts, agent_texts)` from a trajectory `.db` read-only."""
    if not db_path.exists():
        return 0, [], []
    conn = open_sqlite_ro(db_path)
    try:
        rows = conn.execute(
            "SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC;"
        ).fetchall()
    except sqlite3.Error:
        return 0, [], []
    finally:
        conn.close()

    user_texts: list[str] = []
    agent_texts: list[str] = []
    for _idx, stype, payload in rows:
        if not payload:
            continue
        raw = bytes(payload) if not isinstance(payload, bytes) else payload
        try:
            top = _parse_wire(raw)
        except ValueError:
            continue
        if stype == 14:  # USER_INPUT
            ub = _first_bytes(top, 19)
            if ub:
                try:
                    uf = _parse_wire(ub)
                    txt = _first_str(uf, 2)
                    if txt.strip():
                        user_texts.append(txt.strip())
                except ValueError:
                    pass
        elif stype == 15:  # PLANNER_RESPONSE
            pb = _first_bytes(top, 20)
            if pb:
                try:
                    pf = _parse_wire(pb)
                    txt = _first_str(pf, 3)
                    if txt.strip():
                        agent_texts.append(txt.strip())
                except ValueError:
                    pass
    return len(rows), user_texts, agent_texts


# ---------------------------------------------------------------------------
# Topology Discovery & Active-Lock Exclusion
# ---------------------------------------------------------------------------


@dataclass
class SurfaceTopology:
    home: Path
    desktop_root: Path
    cli_root: Path
    dev_root: Path
    ide_migration_marker: Path
    roaming_app_dir: Path
    roaming_ide_dir: Path
    codex_root: Path

    @classmethod
    def discover(
        cls,
        home: Path | None = None,
        desktop_root: Path | None = None,
        cli_root: Path | None = None,
        codex_root: Path | None = None,
    ) -> SurfaceTopology:
        h = (home or Path.home()).resolve()
        gem = h / ".gemini"
        appdata_roaming = Path(os.environ.get("APPDATA", str(h / "AppData" / "Roaming")))
        return cls(
            home=h,
            desktop_root=(desktop_root or (gem / "antigravity")).resolve(),
            cli_root=(cli_root or (gem / "antigravity-cli")).resolve(),
            dev_root=(gem / "antigravity-dev").resolve(),
            ide_migration_marker=gem / "antigravity-ide" / ".ide_migration",
            roaming_app_dir=appdata_roaming / "Antigravity",
            roaming_ide_dir=appdata_roaming / "Antigravity IDE",
            codex_root=(codex_root or (h / ".codex")).resolve(),
        )


def _read_summaries_map_ro(sum_db: Path) -> dict[str, dict[str, Any]]:
    if not sum_db.exists():
        return {}
    conn = open_sqlite_ro(sum_db)
    try:
        cols_sql = ", ".join(f"`{c}`" for c in SUMMARY_COLUMNS)
        rows = conn.execute(f"SELECT {cols_sql} FROM conversation_summaries;").fetchall()
        out: dict[str, dict[str, Any]] = {}
        for row in rows:
            rec = dict(zip(SUMMARY_COLUMNS, row))
            out[str(rec["conversation_id"])] = rec
        return out
    finally:
        conn.close()


def _has_ancestor(cid: str, parent_map: dict[str, str], roots: set[str]) -> bool:
    cur = cid
    seen: set[str] = set()
    while cur and cur not in seen:
        if cur in roots:
            return True
        seen.add(cur)
        cur = parent_map.get(cur, "")
    return False


def compute_excluded_active_ids(
    roots: list[Path],
    explicit_exclude_ids: set[str],
    lock_window_seconds: float = 600.0,
    now_ts: float | None = None,
) -> dict[str, str]:
    """Return `{conversation_id: exclusion_reason}` for active or recently locked chats."""
    now = now_ts if now_ts is not None else time.time()
    parent_map: dict[str, str] = {}
    running_ids: set[str] = set()
    known_summary_ids: set[str] = set()

    for root in roots:
        smap = _read_summaries_map_ro(root / "conversation_summaries.db")
        known_summary_ids.update(smap.keys())
        for cid, rec in smap.items():
            pid = str(rec.get("parent_conversation_id") or "")
            if pid:
                parent_map[cid] = pid
            status_s = str(rec.get("status") or "")
            if "RUNNING" in status_s.upper():
                running_ids.add(cid)

    excluded: dict[str, str] = {}
    for eid in sorted(explicit_exclude_ids):
        excluded[eid] = "explicit_exclude_active"

    for cid in sorted(parent_map):
        if cid not in excluded and _has_ancestor(cid, parent_map, explicit_exclude_ids):
            excluded[cid] = "descendant_of_excluded_active"

    for cid in sorted(running_ids):
        excluded.setdefault(cid, "status_running")

    for root in roots:
        conv_dir = root / "conversations"
        if not conv_dir.exists():
            continue
        for db_p in sorted(conv_dir.glob("*.db")):
            cid = db_p.stem
            if cid in excluded:
                continue
            wal_p = db_p.with_name(db_p.name + "-wal")
            # Note: SQLite `?mode=ro` readers touch a 0-byte `-wal` and 32KB `-shm` on
            # WAL-mode DBs without writing frames. Only non-empty `-wal` files or brand-new
            # unindexed `.db` files indicate an active writer within `lock_window_seconds`.
            if wal_p.exists() and wal_p.stat().st_size > 0:
                age = now - wal_p.stat().st_mtime
                if age <= lock_window_seconds:
                    excluded[cid] = f"recent_nonempty_wal_lock({int(age)}s<={int(lock_window_seconds)}s)"
                    continue
            if cid not in known_summary_ids and (now - db_p.stat().st_mtime) <= lock_window_seconds:
                excluded[cid] = "recent_unindexed_db"

    # Propagate exclusion to any child of a WAL-locked parent as well
    locked_roots = set(excluded.keys())
    for cid in sorted(parent_map):
        if cid not in excluded and _has_ancestor(cid, parent_map, locked_roots):
            excluded[cid] = "descendant_of_locked_parent"

    return excluded


# ---------------------------------------------------------------------------
# Backup, Trajectory Copy, Summary/FTS Merge & Integrity Checks
# ---------------------------------------------------------------------------


def sqlite_online_backup(src_path: Path, dst_path: Path) -> dict[str, Any]:
    """Create a WAL-consistent snapshot of `src_path` into `dst_path` using `.backup()`."""
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    if dst_path.exists():
        dst_path.unlink()
    src_conn = open_sqlite_ro(src_path, timeout=15.0)
    dst_conn = sqlite3.connect(str(dst_path), timeout=15.0)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()
    return {
        "dest": str(dst_path),
        "bytes": dst_path.stat().st_size,
        "sha256": sha256_file(dst_path),
    }


def create_pre_sync_backup(
    desktop_root: Path,
    cli_root: Path,
    backup_base_dir: Path,
    excluded_active_ids: set[str] | None = None,
) -> tuple[Path, dict[str, Any]]:
    stamp = utc_compact_stamp()
    snap_dir = backup_base_dir / stamp
    snap_dir.mkdir(parents=True, exist_ok=True)
    files_meta: dict[str, Any] = {}
    excl_ids = excluded_active_ids or set()

    for label, root in (("desktop", desktop_root), ("cli", cli_root)):
        sum_db = root / "conversation_summaries.db"
        if sum_db.exists():
            dst_sum = snap_dir / label / "conversation_summaries.db"
            sqlite_online_backup(sum_db, dst_sum)
            # Scrub excluded active-session FTS chunks and redact sensitive tokens in the
            # exported backup copy (then VACUUM freelist pages) while keeping all completed
            # `conversation_summaries` and `raw_summary` rows intact.
            bconn = sqlite3.connect(str(dst_sum), timeout=15.0)
            try:
                tables = {
                    r[0]
                    for r in bconn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table';"
                    ).fetchall()
                }
                if "conversations_fts" in tables:
                    if excl_ids:
                        ph = ",".join("?" for _ in excl_ids)
                        bconn.execute(
                            f"DELETE FROM conversations_fts WHERE conversation_id IN ({ph});",
                            tuple(sorted(excl_ids)),
                        )
                    fts_rows = bconn.execute(
                        "SELECT rowid, title, workspace, user_body, agent_body FROM conversations_fts;"
                    ).fetchall()
                    for rowid, t_s, w_s, ub_s, ab_s in fts_rows:
                        nt = sanitize_index_text(str(t_s or ""))
                        nw = sanitize_index_text(str(w_s or ""))
                        nub = sanitize_index_text(str(ub_s or ""))
                        nab = sanitize_index_text(str(ab_s or ""))
                        if (nt, nw, nub, nab) != (t_s or "", w_s or "", ub_s or "", ab_s or ""):
                            bconn.execute(
                                "UPDATE conversations_fts SET title=?, workspace=?, user_body=?, agent_body=? WHERE rowid=?;",
                                (nt, nw, nub, nab, rowid),
                            )
                bconn.commit()
                bconn.execute("VACUUM;")
            finally:
                bconn.close()
            files_meta[f"{label}_conversation_summaries.db"] = {
                "dest": str(dst_sum),
                "bytes": dst_sum.stat().st_size,
                "sha256": sha256_file(dst_sum),
            }
        for pb_name in ("jetbox_summaries_proto.pb", "agyhub_summaries_proto.pb"):
            pb_p = root / pb_name
            if pb_p.exists():
                dst_pb = snap_dir / label / pb_name
                dst_pb.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(pb_p, dst_pb)
                files_meta[f"{label}_{pb_name}"] = {
                    "dest": str(dst_pb),
                    "bytes": dst_pb.stat().st_size,
                    "sha256": sha256_file(dst_pb),
                }

    manifest = {
        "created_at_utc": utc_now_iso(),
        "snapshot_dir": sanitize_path_display(snap_dir),
        "files": {
            k: {
                "bytes": v["bytes"],
                "sha256": v["sha256"],
                "dest": sanitize_path_display(Path(v["dest"])),
            }
            for k, v in files_meta.items()
        },
    }
    (snap_dir / "backup_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return snap_dir, manifest


def get_db_step_count_ro(db_path: Path) -> int:
    if not db_path.exists():
        return -1
    conn = open_sqlite_ro(db_path)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM steps;").fetchone()[0])
    finally:
        conn.close()


def verify_sqlite_integrity(db_path: Path, check_fts_table: str | None = None) -> tuple[bool, str]:
    conn = open_sqlite_ro(db_path, timeout=15.0)
    try:
        res = conn.execute("PRAGMA integrity_check;").fetchall()
        if res != [("ok",)]:
            return False, f"PRAGMA integrity_check failed: {res}"
        if check_fts_table:
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table';"
                ).fetchall()
            }
            if check_fts_table in tables:
                # FTS5 read-only structural probe
                conn.execute(f"SELECT count(*) FROM `{check_fts_table}`;").fetchone()
        return True, "ok"
    except sqlite3.Error as exc:
        return False, str(exc)
    finally:
        conn.close()


def _copy_brain_dir_incremental(src_brain: Path, dst_brain: Path) -> int:
    if not src_brain.exists():
        return 0
    copied_files = 0
    for src_f in sorted(src_brain.rglob("*")):
        if not src_f.is_file():
            continue
        rel = src_f.relative_to(src_brain)
        dst_f = dst_brain / rel
        need_copy = False
        if not dst_f.exists():
            need_copy = True
        else:
            s_stat = src_f.stat()
            d_stat = dst_f.stat()
            if s_stat.st_size != d_stat.st_size and s_stat.st_mtime_ns > d_stat.st_mtime_ns:
                need_copy = True
        if need_copy:
            dst_f.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_f, dst_f)
            copied_files += 1
    return copied_files


def _synthesize_summary_row_from_db(
    cid: str, db_path: Path, target_app_data_dir: str, default_source: str
) -> dict[str, Any]:
    step_count, user_texts, _agent_texts = extract_db_bodies_for_fts(db_path)
    first_prompt = user_texts[0].splitlines()[0][:120] if user_texts else ""
    mtime_dt = datetime.fromtimestamp(db_path.stat().st_mtime, tz=UTC).strftime(
        "%Y-%m-%d %H:%M:%S+00:00"
    )
    return {
        "conversation_id": cid,
        "title": first_prompt,
        "preview": first_prompt,
        "step_count": step_count,
        "last_modified_time": mtime_dt,
        "workspace_uris": "[]",
        "status": "CASCADE_RUN_STATUS_IDLE",
        "source": default_source,
        "project_id": "",
        "agent_name": "",
        "parent_conversation_id": "",
        "nesting_depth": 0,
        "battle_id": "",
        "winning_conversation_id": "",
        "not_fully_idle": 0,
        "killed": 0,
        "last_user_input_time": mtime_dt if user_texts else "0001-01-01 00:00:00+00:00",
        "last_user_input_step_index": 0 if user_texts else -1,
        "app_data_dir": target_app_data_dir,
        "raw_summary": None,
        "group_id": "",
    }


def _ensure_summaries_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS `conversation_summaries` (
            `conversation_id` text,
            `title` text NOT NULL DEFAULT "",
            `preview` text NOT NULL DEFAULT "",
            `step_count` integer NOT NULL DEFAULT 0,
            `last_modified_time` datetime NOT NULL,
            `workspace_uris` text NOT NULL,
            `status` text NOT NULL DEFAULT "",
            `source` text NOT NULL DEFAULT "",
            `project_id` text NOT NULL DEFAULT "",
            `agent_name` text NOT NULL DEFAULT "",
            `parent_conversation_id` text NOT NULL DEFAULT "",
            `nesting_depth` integer NOT NULL DEFAULT 0,
            `battle_id` text NOT NULL DEFAULT "",
            `winning_conversation_id` text NOT NULL DEFAULT "",
            `not_fully_idle` numeric NOT NULL DEFAULT false,
            `killed` numeric NOT NULL DEFAULT false,
            `last_user_input_time` datetime NOT NULL,
            `last_user_input_step_index` integer NOT NULL DEFAULT -1,
            `app_data_dir` text NOT NULL DEFAULT "",
            `raw_summary` blob,
            `group_id` text NOT NULL DEFAULT "",
            PRIMARY KEY (`conversation_id`)
        );
        CREATE INDEX IF NOT EXISTS `idx_conversation_summaries_last_modified_time`
            ON `conversation_summaries`(`last_modified_time`);
        CREATE INDEX IF NOT EXISTS `idx_conversation_summaries_last_user_input_time`
            ON `conversation_summaries`(`last_user_input_time`);
        CREATE TABLE IF NOT EXISTS conversation_parents (
            conversation_id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS search_schema_version (
            version INTEGER PRIMARY KEY
        );
        INSERT OR IGNORE INTO search_schema_version(version) VALUES (3);
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
            conversation_id UNINDEXED,
            chunk_index UNINDEXED,
            chunk_first_step UNINDEXED,
            chunk_last_step UNINDEXED,
            last_modified_time UNINDEXED,
            step_count UNINDEXED,
            last_step_created_at UNINDEXED,
            archived UNINDEXED,
            user_step_byte_offsets UNINDEXED,
            agent_step_byte_offsets UNINDEXED,
            title,
            workspace,
            project,
            user_body,
            agent_body,
            tokenize = 'unicode61 remove_diacritics 2',
            prefix = '1 2 3'
        );
        """
    )


def _upsert_summaries_and_fts(
    target_root: Path,
    rows_to_upsert: list[dict[str, Any]],
    fts_Backfill_ids: set[str],
    update_jetbox_pb: bool = False,
    lock_window_seconds: float = 600.0,
) -> dict[str, int]:
    if not rows_to_upsert and not fts_Backfill_ids:
        return {"summaries_upserted": 0, "parents_upserted": 0, "fts_conversations_indexed": 0}

    sum_db = target_root / "conversation_summaries.db"
    sum_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(sum_db), timeout=20.0)
    conn.execute("PRAGMA busy_timeout = 20000;")
    summaries_upserted = 0
    parents_upserted = 0
    fts_indexed = 0

    try:
        if not sum_db.exists() or sum_db.stat().st_size == 0:
            conn.execute("PRAGMA journal_mode = WAL;")
        _ensure_summaries_schema(conn)

        cols_sql = ", ".join(f"`{c}`" for c in SUMMARY_COLUMNS)
        placeholders = ", ".join("?" for _ in SUMMARY_COLUMNS)
        update_assigns = ", ".join(
            f"`{c}` = excluded.`{c}`" for c in SUMMARY_COLUMNS if c != "conversation_id"
        )
        upsert_sql = (
            f"INSERT INTO `conversation_summaries` ({cols_sql}) VALUES ({placeholders}) "
            f"ON CONFLICT(`conversation_id`) DO UPDATE SET {update_assigns} "
            f"WHERE excluded.`step_count` >= `conversation_summaries`.`step_count`;"
        )

        with conn:
            for row in rows_to_upsert:
                vals = tuple(row[c] for c in SUMMARY_COLUMNS)
                cur = conn.execute(upsert_sql, vals)
                summaries_upserted += cur.rowcount
                pid = str(row.get("parent_conversation_id") or "")
                if pid:
                    pcur = conn.execute(
                        "INSERT OR REPLACE INTO conversation_parents(conversation_id, parent_id) VALUES (?, ?);",
                        (row["conversation_id"], pid),
                    )
                    parents_upserted += pcur.rowcount

            # Populate missing FTS5 entries so built-in surface search works across synced chats
            existing_fts_cids = {
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT conversation_id FROM conversations_fts;"
                ).fetchall()
            }
            all_meta = {
                r[0]: (r[1], r[2], r[3], r[4])
                for r in conn.execute(
                    "SELECT conversation_id, title, workspace_uris, project_id, step_count FROM conversation_summaries;"
                ).fetchall()
            }
            for cid in sorted(fts_Backfill_ids - existing_fts_cids):
                db_p = target_root / "conversations" / f"{cid}.db"
                if not db_p.exists():
                    continue
                scnt, u_txts, a_txts = extract_db_bodies_for_fts(db_p)
                title, ws_uris, proj_id, meta_scnt = all_meta.get(cid, ("", "[]", "", scnt))
                ws_short = ws_uris
                try:
                    arr = json.loads(ws_uris)
                    if isinstance(arr, list) and arr:
                        ws_short = " ".join(Path(str(u)).name for u in arr)
                except json.JSONDecodeError:
                    pass
                mtime_ns = db_p.stat().st_mtime_ns
                conn.execute(
                    "INSERT INTO conversations_fts ("
                    "conversation_id, chunk_index, chunk_first_step, chunk_last_step, "
                    "last_modified_time, step_count, last_step_created_at, archived, "
                    "user_step_byte_offsets, agent_step_byte_offsets, "
                    "title, workspace, project, user_body, agent_body"
                    ") VALUES (?, -1, 0, 0, ?, ?, ?, 0, '', '', ?, ?, ?, '', '');",
                    (cid, mtime_ns, max(scnt, meta_scnt), mtime_ns, title, ws_short, proj_id),
                )
                if u_txts or a_txts:
                    conn.execute(
                        "INSERT INTO conversations_fts ("
                        "conversation_id, chunk_index, chunk_first_step, chunk_last_step, "
                        "last_modified_time, step_count, last_step_created_at, archived, "
                        "user_step_byte_offsets, agent_step_byte_offsets, "
                        "title, workspace, project, user_body, agent_body"
                        ") VALUES (?, 0, 0, ?, 0, 0, 0, 0, ?, ?, '', '', '', ?, ?);",
                        (
                            cid,
                            max(scnt - 1, 0),
                            b"[[0,0]]" if u_txts else None,
                            b"[[1,0]]" if a_txts else None,
                            "\n\n".join(u_txts)[:65536],
                            "\n\n".join(a_txts)[:65536],
                        ),
                    )
                fts_indexed += 1

            conn.execute("INSERT INTO conversations_fts(conversations_fts) VALUES('integrity-check');")

        if update_jetbox_pb:
            pb_path = target_root / "jetbox_summaries_proto.pb"
            pb_recent = pb_path.exists() and (time.time() - pb_path.stat().st_mtime) <= lock_window_seconds
            if not pb_recent:
                pb_rows = conn.execute(
                    "SELECT conversation_id, raw_summary FROM conversation_summaries "
                    "WHERE raw_summary IS NOT NULL ORDER BY conversation_id ASC;"
                ).fetchall()
                encoded = encode_summaries_proto_map([(str(k), bytes(v)) for k, v in pb_rows if v])
                tmp_pb = pb_path.with_suffix(".pb.tmp")
                tmp_pb.write_bytes(encoded)
                os.replace(tmp_pb, pb_path)
    finally:
        conn.close()

    return {
        "summaries_upserted": summaries_upserted,
        "parents_upserted": parents_upserted,
        "fts_conversations_indexed": fts_indexed,
    }


@dataclass
class SyncAction:
    conversation_id: str
    direction: str  # "desktop_to_cli" | "cli_to_desktop"
    copy_db: bool
    src_steps: int
    dst_steps_before: int
    copy_brain: bool
    upsert_summary: bool
    backfill_fts: bool


def plan_and_run_sync(
    topology: SurfaceTopology,
    apply: bool,
    exclude_active: set[str],
    lock_window_seconds: float,
    backup_base_dir: Path,
) -> dict[str, Any]:
    desk = topology.desktop_root
    cli = topology.cli_root
    for r in (desk, cli):
        (r / "conversations").mkdir(parents=True, exist_ok=True)
        (r / "brain").mkdir(parents=True, exist_ok=True)

    excluded = compute_excluded_active_ids(
        [desk, cli], exclude_active, lock_window_seconds=lock_window_seconds
    )

    desk_sums = _read_summaries_map_ro(desk / "conversation_summaries.db")
    cli_sums = _read_summaries_map_ro(cli / "conversation_summaries.db")

    desk_dbs = {p.stem: p for p in sorted((desk / "conversations").glob("*.db"))}
    cli_dbs = {p.stem: p for p in sorted((cli / "conversations").glob("*.db"))}

    all_cids = sorted((set(desk_dbs) | set(cli_dbs) | set(desk_sums) | set(cli_sums)) - set(excluded))

    actions: list[SyncAction] = []
    d2c_summary_rows: list[dict[str, Any]] = []
    c2d_summary_rows: list[dict[str, Any]] = []
    cli_fts_backfill: set[str] = set()
    desk_fts_backfill: set[str] = set()

    for cid in all_cids:
        d_db = desk_dbs.get(cid)
        c_db = cli_dbs.get(cid)
        d_steps = get_db_step_count_ro(d_db) if d_db else -1
        c_steps = get_db_step_count_ro(c_db) if c_db else -1

        # Case 1: Desktop -> CLI
        if d_steps >= 0 and d_steps > c_steps:
            src_row = dict(
                desk_sums.get(cid)
                or _synthesize_summary_row_from_db(cid, d_db, "antigravity-cli", "")  # type: ignore[arg-type]
            )
            src_row["app_data_dir"] = "antigravity-cli"
            src_row["step_count"] = max(int(src_row.get("step_count") or 0), d_steps)
            src_row["not_fully_idle"] = 0
            d2c_summary_rows.append(src_row)
            cli_fts_backfill.add(cid)
            actions.append(
                SyncAction(
                    conversation_id=cid,
                    direction="desktop_to_cli",
                    copy_db=True,
                    src_steps=d_steps,
                    dst_steps_before=c_steps,
                    copy_brain=(desk / "brain" / cid).exists(),
                    upsert_summary=True,
                    backfill_fts=True,
                )
            )
        elif d_steps >= 0 and d_steps == c_steps and cid not in cli_sums:
            src_row = dict(
                desk_sums.get(cid)
                or _synthesize_summary_row_from_db(cid, d_db, "antigravity-cli", "")  # type: ignore[arg-type]
            )
            src_row["app_data_dir"] = "antigravity-cli"
            src_row["not_fully_idle"] = 0
            d2c_summary_rows.append(src_row)
            cli_fts_backfill.add(cid)
            actions.append(
                SyncAction(
                    conversation_id=cid,
                    direction="desktop_to_cli",
                    copy_db=False,
                    src_steps=d_steps,
                    dst_steps_before=c_steps,
                    copy_brain=not (cli / "brain" / cid).exists() and (desk / "brain" / cid).exists(),
                    upsert_summary=True,
                    backfill_fts=True,
                )
            )

        # Case 2: CLI -> Desktop (fixes ghost CLI summary rows missing `.db` and `brain/` on Desktop!)
        if c_steps >= 0 and c_steps > d_steps:
            base_row = desk_sums.get(cid) or cli_sums.get(cid)
            src_row = dict(
                base_row
                or _synthesize_summary_row_from_db(
                    cid, c_db, "antigravity", "CORTEX_TRAJECTORY_SOURCE_CLI"  # type: ignore[arg-type]
                )
            )
            src_row["app_data_dir"] = "antigravity"
            if not src_row.get("source"):
                src_row["source"] = "CORTEX_TRAJECTORY_SOURCE_CLI"
            src_row["step_count"] = max(int(src_row.get("step_count") or 0), c_steps)
            src_row["not_fully_idle"] = 0
            need_summary = (cid not in desk_sums) or (
                int(desk_sums[cid].get("step_count") or 0) < c_steps
            )
            if need_summary:
                c2d_summary_rows.append(src_row)
            desk_fts_backfill.add(cid)
            actions.append(
                SyncAction(
                    conversation_id=cid,
                    direction="cli_to_desktop",
                    copy_db=True,
                    src_steps=c_steps,
                    dst_steps_before=d_steps,
                    copy_brain=(cli / "brain" / cid).exists(),
                    upsert_summary=need_summary,
                    backfill_fts=True,
                )
            )
        elif c_steps >= 0 and c_steps == d_steps:
            need_brain = (cli / "brain" / cid).exists() and not (desk / "brain" / cid).exists()
            need_summary = cid not in desk_sums
            if need_summary:
                src_row = dict(
                    cli_sums.get(cid)
                    or _synthesize_summary_row_from_db(
                        cid, c_db, "antigravity", "CORTEX_TRAJECTORY_SOURCE_CLI"  # type: ignore[arg-type]
                    )
                )
                src_row["app_data_dir"] = "antigravity"
                if not src_row.get("source"):
                    src_row["source"] = "CORTEX_TRAJECTORY_SOURCE_CLI"
                c2d_summary_rows.append(src_row)
            if need_brain or need_summary:
                desk_fts_backfill.add(cid)
                actions.append(
                    SyncAction(
                        conversation_id=cid,
                        direction="cli_to_desktop",
                        copy_db=False,
                        src_steps=c_steps,
                        dst_steps_before=d_steps,
                        copy_brain=need_brain,
                        upsert_summary=need_summary,
                        backfill_fts=True,
                    )
                )

    before_counts = {
        "desktop_db_files": len(desk_dbs),
        "desktop_summary_rows": len(desk_sums),
        "cli_db_files": len(cli_dbs),
        "cli_summary_rows": len(cli_sums),
        "excluded_active_count": len(excluded),
    }

    result: dict[str, Any] = {
        "mode": "apply" if apply else "dry_run",
        "timestamp_utc": utc_now_iso(),
        "desktop_root": sanitize_path_display(desk, topology.home),
        "cli_root": sanitize_path_display(cli, topology.home),
        "before_counts": before_counts,
        "excluded_active": excluded,
        "planned_actions_total": len(actions),
        "planned_desktop_to_cli": sum(1 for a in actions if a.direction == "desktop_to_cli"),
        "planned_cli_to_desktop": sum(1 for a in actions if a.direction == "cli_to_desktop"),
        "actions_sample": [a.__dict__ for a in actions[:25]],
    }

    if not apply:
        return result

    snap_dir, snap_manifest = create_pre_sync_backup(
        desk, cli, backup_base_dir, excluded_active_ids=set(excluded.keys())
    )
    result["backup_snapshot"] = snap_manifest

    copied_dbs = {"desktop_to_cli": 0, "cli_to_desktop": 0}
    copied_brain_files = {"desktop_to_cli": 0, "cli_to_desktop": 0}
    integrity_failures: list[str] = []

    for act in actions:
        cid = act.conversation_id
        if act.direction == "desktop_to_cli":
            src_root, dst_root = desk, cli
        else:
            src_root, dst_root = cli, desk

        if act.copy_db:
            src_db = src_root / "conversations" / f"{cid}.db"
            dst_db = dst_root / "conversations" / f"{cid}.db"
            if dst_db.exists():
                sqlite_online_backup(
                    dst_db, snap_dir / "overwritten" / f"{act.direction}_{cid}.db"
                )
            with tempfile.NamedTemporaryFile(
                dir=str(dst_db.parent), prefix=f".sync_{cid}_", suffix=".tmp", delete=False
            ) as tf:
                tmp_db = Path(tf.name)
            sqlite_online_backup(src_db, tmp_db)
            ok, msg = verify_sqlite_integrity(tmp_db)
            if not ok:
                tmp_db.unlink(missing_ok=True)
                integrity_failures.append(f"{cid} ({act.direction}): {msg}")
                continue
            os.replace(tmp_db, dst_db)
            copied_dbs[act.direction] += 1

        if act.copy_brain:
            copied_brain_files[act.direction] += _copy_brain_dir_incremental(
                src_root / "brain" / cid, dst_root / "brain" / cid
            )

    cli_db_stats = _upsert_summaries_and_fts(
        cli,
        d2c_summary_rows,
        cli_fts_backfill | {p.stem for p in (cli / "conversations").glob("*.db")},
        update_jetbox_pb=True,
        lock_window_seconds=lock_window_seconds,
    )
    desk_db_stats = _upsert_summaries_and_fts(
        desk,
        c2d_summary_rows,
        desk_fts_backfill,
        update_jetbox_pb=False,
        lock_window_seconds=lock_window_seconds,
    )

    desk_ok, desk_msg = verify_sqlite_integrity(
        desk / "conversation_summaries.db", "conversations_fts"
    )
    cli_ok, cli_msg = verify_sqlite_integrity(
        cli / "conversation_summaries.db", "conversations_fts"
    )
    if not desk_ok:
        integrity_failures.append(f"desktop conversation_summaries.db: {desk_msg}")
    if not cli_ok:
        integrity_failures.append(f"cli conversation_summaries.db: {cli_msg}")

    after_desk_sums = _read_summaries_map_ro(desk / "conversation_summaries.db")
    after_cli_sums = _read_summaries_map_ro(cli / "conversation_summaries.db")
    after_desk_dbs = list((desk / "conversations").glob("*.db"))
    after_cli_dbs = list((cli / "conversations").glob("*.db"))

    result.update(
        {
            "copied_trajectory_dbs": copied_dbs,
            "copied_brain_files": copied_brain_files,
            "cli_summaries_db_updates": cli_db_stats,
            "desktop_summaries_db_updates": desk_db_stats,
            "after_counts": {
                "desktop_db_files": len(after_desk_dbs),
                "desktop_summary_rows": len(after_desk_sums),
                "cli_db_files": len(after_cli_dbs),
                "cli_summary_rows": len(after_cli_sums),
            },
            "integrity_checks": {
                "desktop_summaries_db": desk_msg,
                "cli_summaries_db": cli_msg,
                "failures": integrity_failures,
            },
        }
    )
    return result


# ---------------------------------------------------------------------------
# Unified Cross-Surface + Codex FTS5 Search & Resume Index
# ---------------------------------------------------------------------------


def build_unified_index(
    topology: SurfaceTopology,
    index_path: Path,
    excluded_active: dict[str, str] | None = None,
) -> dict[str, Any]:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_idx = index_path.with_suffix(".sqlite.tmp")
    if tmp_idx.exists():
        tmp_idx.unlink()

    excl = excluded_active or {}
    conn = sqlite3.connect(str(tmp_idx))
    try:
        conn.executescript(
            """
            PRAGMA journal_mode = DELETE;
            CREATE TABLE unified_threads (
                thread_key TEXT PRIMARY KEY,
                ecosystem TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                title TEXT NOT NULL,
                workspace TEXT NOT NULL,
                parent_conversation_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                step_or_item_count INTEGER NOT NULL,
                user_prompt_count INTEGER NOT NULL,
                last_modified_utc TEXT NOT NULL,
                present_in_agy_desktop INTEGER NOT NULL,
                present_in_agy_cli INTEGER NOT NULL,
                present_in_agy_ide INTEGER NOT NULL,
                present_in_codex INTEGER NOT NULL,
                is_active_excluded INTEGER NOT NULL,
                resume_agy_cli_cmd TEXT NOT NULL,
                resume_agy_app_hint TEXT NOT NULL,
                resume_codex_cmd TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE unified_threads_fts USING fts5(
                thread_key UNINDEXED,
                ecosystem UNINDEXED,
                conversation_id UNINDEXED,
                title,
                workspace,
                user_prompts_text,
                assistant_summary_text,
                tokenize = 'unicode61 remove_diacritics 2',
                prefix = '1 2 3'
            );
            """
        )

        # 1. Index Antigravity conversations across Desktop/IDE & CLI
        desk_sums = _read_summaries_map_ro(topology.desktop_root / "conversation_summaries.db")
        cli_sums = _read_summaries_map_ro(topology.cli_root / "conversation_summaries.db")
        desk_dbs = {p.stem: p for p in (topology.desktop_root / "conversations").glob("*.db")} if (topology.desktop_root / "conversations").exists() else {}
        cli_dbs = {p.stem: p for p in (topology.cli_root / "conversations").glob("*.db")} if (topology.cli_root / "conversations").exists() else {}
        ide_migrated = topology.ide_migration_marker.exists() or topology.roaming_ide_dir.exists()

        agy_cids = sorted(set(desk_sums) | set(cli_sums) | set(desk_dbs) | set(cli_dbs))
        agy_indexed = 0

        with conn:
            for cid in agy_cids:
                meta = desk_sums.get(cid) or cli_sums.get(cid) or {}
                db_p = desk_dbs.get(cid) or cli_dbs.get(cid)
                scnt, u_txts, a_txts = extract_db_bodies_for_fts(db_p) if db_p else (0, [], [])
                eff_steps = max(scnt, int(meta.get("step_count") or 0))
                raw_title = str(meta.get("title") or (u_txts[0].splitlines()[0][:120] if u_txts else ""))
                title = sanitize_index_text(raw_title, topology.home)
                ws_raw = str(meta.get("workspace_uris") or "")
                ws_clean = sanitize_index_text(ws_raw, topology.home)
                parent_id = str(meta.get("parent_conversation_id") or "")
                agent_name = str(meta.get("agent_name") or "")
                lmt = str(meta.get("last_modified_time") or "")
                in_desk = int(cid in desk_dbs)
                in_cli = int(cid in cli_dbs)
                in_ide = int(in_desk and ide_migrated)
                is_excl = int(cid in excl)

                tkey = f"antigravity:{cid}"
                cli_cmd = f"agy --conversation {cid}" if in_cli else f"agy-history-sync sync --apply && agy --conversation {cid}"
                app_hint = f"Antigravity App/IDE -> Conversation {cid}"
                conn.execute(
                    "INSERT INTO unified_threads VALUES (?, 'antigravity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '');",
                    (
                        tkey,
                        cid,
                        title,
                        ws_clean,
                        parent_id,
                        agent_name,
                        eff_steps,
                        len(u_txts),
                        lmt,
                        in_desk,
                        in_cli,
                        in_ide,
                        is_excl,
                        cli_cmd,
                        app_hint,
                    ),
                )
                u_joined = sanitize_index_text("\n\n".join(u_txts)[:32768], topology.home)
                a_joined = sanitize_index_text("\n\n".join(a_txts[-5:])[:16384], topology.home)
                conn.execute(
                    "INSERT INTO unified_threads_fts VALUES (?, 'antigravity', ?, ?, ?, ?, ?);",
                    (tkey, cid, title, ws_clean, u_joined, a_joined),
                )
                agy_indexed += 1

            # 2. Index Codex conversations read-only (`state_5.sqlite` + `thread_history_1.sqlite`)
            codex_indexed = 0
            st_db = topology.codex_root / "state_5.sqlite"
            th_db = topology.codex_root / "thread_history_1.sqlite"
            if st_db.exists():
                c_st = open_sqlite_ro(st_db)
                c_th = open_sqlite_ro(th_db) if th_db.exists() else None
                try:
                    parent_edges = dict(
                        c_st.execute(
                            "SELECT child_thread_id, parent_thread_id FROM thread_spawn_edges;"
                        ).fetchall()
                    )
                    t_rows = c_st.execute(
                        "SELECT id, updated_at, cwd, title, source FROM threads ORDER BY updated_at DESC;"
                    ).fetchall()

                    item_counts: dict[str, int] = {}
                    u_by_tid: dict[str, list[str]] = defaultdict(list)
                    a_by_tid: dict[str, list[str]] = defaultdict(list)
                    if c_th is not None:
                        item_counts = dict(
                            c_th.execute(
                                "SELECT thread_id, COUNT(*) FROM thread_items GROUP BY thread_id;"
                            ).fetchall()
                        )
                        for tid_r, itype, ijson in c_th.execute(
                            "SELECT thread_id, item_type, item_json FROM thread_items "
                            "WHERE item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal ASC;"
                        ):
                            try:
                                obj = json.loads(ijson)
                            except json.JSONDecodeError:
                                continue
                            if itype == "userMessage":
                                txts = [
                                    str(c.get("text", ""))
                                    for c in obj.get("content", [])
                                    if isinstance(c, dict) and "text" in c
                                ]
                                j = "\n".join(t for t in txts if t).strip()
                                if j:
                                    u_by_tid[tid_r].append(j)
                            elif itype == "agentMessage":
                                txt = str(obj.get("text") or "").strip()
                                if txt:
                                    a_by_tid[tid_r].append(txt)

                    for tid, uat, cwd, ctitle, csrc in t_rows:
                        tkey = f"codex:{tid}"
                        clean_title = sanitize_index_text(str(ctitle or ""), topology.home)
                        clean_cwd = sanitize_index_text(str(cwd or ""), topology.home)
                        pid = str(parent_edges.get(tid, ""))
                        lmt_iso = (
                            datetime.fromtimestamp(float(uat), tz=UTC).isoformat().replace("+00:00", "Z")
                            if uat
                            else ""
                        )
                        u_list = u_by_tid.get(tid, [])
                        a_list = a_by_tid.get(tid, [])
                        conn.execute(
                            "INSERT INTO unified_threads VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, 0, '', '', ?);",
                            (
                                tkey,
                                tid,
                                clean_title,
                                clean_cwd,
                                pid,
                                str(csrc or ""),
                                int(item_counts.get(tid, 0)),
                                len(u_list),
                                lmt_iso,
                                f"codex resume {tid}",
                            ),
                        )
                        conn.execute(
                            "INSERT INTO unified_threads_fts VALUES (?, 'codex', ?, ?, ?, ?, ?);",
                            (
                                tkey,
                                tid,
                                clean_title,
                                clean_cwd,
                                sanitize_index_text("\n\n".join(u_list)[:32768], topology.home),
                                sanitize_index_text("\n\n".join(a_list[-4:])[:16384], topology.home),
                            ),
                        )
                        codex_indexed += 1
                finally:
                    if c_th is not None:
                        c_th.close()
                    c_st.close()

            conn.execute("INSERT INTO unified_threads_fts(unified_threads_fts) VALUES('integrity-check');")
    finally:
        conn.close()

    os.replace(tmp_idx, index_path)
    ok, msg = verify_sqlite_integrity(index_path, "unified_threads_fts")
    return {
        "index_path": sanitize_path_display(index_path, topology.home),
        "antigravity_threads_indexed": agy_indexed,
        "codex_threads_indexed": codex_indexed,
        "total_threads_indexed": agy_indexed + codex_indexed,
        "integrity_check": msg if ok else f"FAILED: {msg}",
        "bytes": index_path.stat().st_size,
        "sha256": sha256_file(index_path),
    }


def search_unified_index(
    index_path: Path,
    query: str,
    limit: int = 20,
    ecosystem: str = "all",
    roots_only: bool = False,
) -> list[dict[str, Any]]:
    if not index_path.exists():
        raise FileNotFoundError(
            f"Unified index not found at {index_path}. Run `index` or `sync --apply` first."
        )
    conn = open_sqlite_ro(index_path)
    try:
        # Build safe FTS5 phrase/prefix query from whitespace tokens
        tokens = [re.sub(r'["\'^*():]', " ", tok).strip() for tok in query.split()]
        tokens = [t for t in tokens if t]
        fts_expr = " AND ".join(f'"{t}"*' for t in tokens) if tokens else '""'

        where_clauses = ["unified_threads_fts MATCH ?"]
        params: list[Any] = [fts_expr]
        if ecosystem != "all":
            where_clauses.append("t.ecosystem = ?")
            params.append(ecosystem)
        if roots_only:
            where_clauses.append("t.parent_conversation_id = ''")
        params.append(int(limit))

        sql = f"""
            SELECT
                t.ecosystem,
                t.conversation_id,
                t.title,
                t.workspace,
                t.parent_conversation_id,
                t.step_or_item_count,
                t.user_prompt_count,
                t.last_modified_utc,
                t.present_in_agy_desktop,
                t.present_in_agy_cli,
                t.present_in_agy_ide,
                t.present_in_codex,
                t.resume_agy_cli_cmd,
                t.resume_agy_app_hint,
                t.resume_codex_cmd,
                snippet(unified_threads_fts, 5, '[', ']', ' ... ', 20) AS prompt_snippet,
                bm25(unified_threads_fts) AS rank_score
            FROM unified_threads_fts
            JOIN unified_threads t ON t.thread_key = unified_threads_fts.thread_key
            WHERE {' AND '.join(where_clauses)}
            ORDER BY rank_score ASC
            LIMIT ?;
        """
        rows = conn.execute(sql, tuple(params)).fetchall()
        results: list[dict[str, Any]] = []
        for r in rows:
            surfaces: list[str] = []
            if r[8]:
                surfaces.append("AGY-App")
            if r[10]:
                surfaces.append("AGY-IDE")
            if r[9]:
                surfaces.append("AGY-CLI")
            if r[11]:
                surfaces.append("Codex")
            results.append(
                {
                    "ecosystem": r[0],
                    "conversation_id": r[1],
                    "title": r[2],
                    "workspace": r[3],
                    "parent_conversation_id": r[4],
                    "steps_or_items": r[5],
                    "user_prompts": r[6],
                    "last_modified_utc": r[7],
                    "surfaces": surfaces,
                    "resume_cmd": r[12] if r[0] == "antigravity" else r[14],
                    "app_hint": r[13],
                    "snippet": r[15],
                }
            )
        return results
    finally:
        conn.close()


def collect_status(
    topology: SurfaceTopology,
    index_path: Path,
    exclude_active: set[str],
    lock_window_seconds: float,
) -> dict[str, Any]:
    desk_dbs = (
        {p.stem for p in (topology.desktop_root / "conversations").glob("*.db")}
        if (topology.desktop_root / "conversations").exists()
        else set()
    )
    cli_dbs = (
        {p.stem for p in (topology.cli_root / "conversations").glob("*.db")}
        if (topology.cli_root / "conversations").exists()
        else set()
    )
    desk_sums = _read_summaries_map_ro(topology.desktop_root / "conversation_summaries.db")
    cli_sums = _read_summaries_map_ro(topology.cli_root / "conversation_summaries.db")
    dev_sums = _read_summaries_map_ro(topology.dev_root / "conversation_summaries.db")

    excluded = compute_excluded_active_ids(
        [topology.desktop_root, topology.cli_root],
        exclude_active,
        lock_window_seconds=lock_window_seconds,
    )
    eligible_desk = desk_dbs - set(excluded)
    eligible_cli = cli_dbs - set(excluded)

    idx_info: dict[str, Any] = {"exists": index_path.exists()}
    if index_path.exists():
        c = open_sqlite_ro(index_path)
        try:
            by_eco = dict(
                c.execute(
                    "SELECT ecosystem, COUNT(*) FROM unified_threads GROUP BY ecosystem;"
                ).fetchall()
            )
            idx_info.update(
                {
                    "path": sanitize_path_display(index_path, topology.home),
                    "counts_by_ecosystem": by_eco,
                    "bytes": index_path.stat().st_size,
                }
            )
        finally:
            c.close()

    return {
        "timestamp_utc": utc_now_iso(),
        "surfaces": {
            "agy_desktop_and_ide": {
                "root": sanitize_path_display(topology.desktop_root, topology.home),
                "ide_migrated_to_shared_root": topology.ide_migration_marker.exists(),
                "roaming_app_present": topology.roaming_app_dir.exists(),
                "roaming_ide_present": topology.roaming_ide_dir.exists(),
                "trajectory_db_files": len(desk_dbs),
                "summary_rows": len(desk_sums),
                "ghost_summary_rows_without_db": len(set(desk_sums) - desk_dbs),
            },
            "agy_cli": {
                "root": sanitize_path_display(topology.cli_root, topology.home),
                "trajectory_db_files": len(cli_dbs),
                "summary_rows": len(cli_sums),
                "ghost_summary_rows_without_db": len(set(cli_sums) - cli_dbs),
                "jetbox_pb_exists": (topology.cli_root / "jetbox_summaries_proto.pb").exists(),
            },
            "agy_dev_sidecar": {
                "root": sanitize_path_display(topology.dev_root, topology.home),
                "exists": topology.dev_root.exists(),
                "summary_rows": len(dev_sums),
            },
        },
        "sync_parity": {
            "shared_trajectory_dbs": len(desk_dbs & cli_dbs),
            "eligible_missing_in_cli": len(eligible_desk - cli_dbs),
            "eligible_missing_in_desktop": len(eligible_cli - desk_dbs),
            "excluded_active_or_locked": len(excluded),
        },
        "unified_index": idx_info,
    }


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agy_history_sync.py",
        description="Sync and search chat history across Antigravity CLI, Desktop App, IDE, and Codex.",
    )
    parser.add_argument("--home", type=Path, default=None, help="Override user home directory.")
    parser.add_argument("--desktop-root", type=Path, default=None, help="Override ~/.gemini/antigravity.")
    parser.add_argument("--cli-root", type=Path, default=None, help="Override ~/.gemini/antigravity-cli.")
    parser.add_argument("--codex-root", type=Path, default=None, help="Override ~/.codex.")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Directory for backups, receipts, and unified_agy_history.sqlite.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Inspect multi-surface history counts and sync parity.")
    p_status.add_argument("--exclude-active", action="append", default=[], help="Active conversation UUID(s).")
    p_status.add_argument("--lock-window-seconds", type=float, default=600.0)
    p_status.add_argument("--json", action="store_true")

    p_sync = sub.add_parser("sync", help="Bidirectionally sync completed trajectories, brains, and summaries.")
    mode_grp = p_sync.add_mutually_exclusive_group(required=True)
    mode_grp.add_argument("--dry-run", action="store_true", help="Preview sync plan without mutating files.")
    mode_grp.add_argument("--apply", action="store_true", help="Backup, sync, verify integrity, and re-index.")
    p_sync.add_argument(
        "--exclude-active",
        action="append",
        default=[],
        help="Active conversation UUID to skip (along with all descendant workers).",
    )
    p_sync.add_argument(
        "--lock-window-seconds",
        type=float,
        default=600.0,
        help="Skip conversations whose -wal/-shm was modified within this window (default: 600s).",
    )
    p_sync.add_argument("--skip-index", action="store_true", help="Skip unified FTS5 index rebuild after --apply.")
    p_sync.add_argument("--json", action="store_true")

    p_index = sub.add_parser("index", help="Build or refresh unified_agy_history.sqlite FTS5 index.")
    p_index.add_argument("--exclude-active", action="append", default=[])
    p_index.add_argument("--lock-window-seconds", type=float, default=600.0)
    p_index.add_argument("--json", action="store_true")

    p_search = sub.add_parser("search", help="Full-text search across AGY App, AGY IDE, AGY CLI, and Codex.")
    p_search.add_argument("query", type=str, help="Search keywords.")
    p_search.add_argument("--limit", type=int, default=15)
    p_search.add_argument("--ecosystem", choices=("all", "antigravity", "codex"), default="all")
    p_search.add_argument("--roots-only", action="store_true", help="Exclude subagent child threads.")
    p_search.add_argument("--json", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    topo = SurfaceTopology.discover(
        home=args.home,
        desktop_root=args.desktop_root,
        cli_root=args.cli_root,
        codex_root=args.codex_root,
    )
    data_dir = (args.data_dir or default_data_dir(topo.home)).resolve()
    index_path = data_dir / "unified_agy_history.sqlite"
    backup_dir = data_dir / "backups"
    receipts_dir = data_dir / "receipts"

    if args.command == "status":
        st = collect_status(
            topo, index_path, set(args.exclude_active), args.lock_window_seconds
        )
        if args.json:
            print(json.dumps(st, indent=2))
        else:
            d_info = st["surfaces"]["agy_desktop_and_ide"]
            c_info = st["surfaces"]["agy_cli"]
            sp = st["sync_parity"]
            print(f"AGY App/IDE ({d_info['root']}): {d_info['trajectory_db_files']} .db, {d_info['summary_rows']} summaries ({d_info['ghost_summary_rows_without_db']} ghost)")
            print(f"AGY CLI     ({c_info['root']}): {c_info['trajectory_db_files']} .db, {c_info['summary_rows']} summaries ({c_info['ghost_summary_rows_without_db']} ghost)")
            print(f"Parity: shared_dbs={sp['shared_trajectory_dbs']}, missing_in_cli={sp['eligible_missing_in_cli']}, missing_in_desktop={sp['eligible_missing_in_desktop']}, active_excluded={sp['excluded_active_or_locked']}")
            print(f"Unified Index: {st['unified_index']}")
        return 0

    if args.command == "sync":
        res = plan_and_run_sync(
            topo,
            apply=bool(args.apply),
            exclude_active=set(args.exclude_active),
            lock_window_seconds=args.lock_window_seconds,
            backup_base_dir=backup_dir,
        )
        if args.apply and not args.skip_index:
            idx_res = build_unified_index(topo, index_path, res.get("excluded_active", {}))
            res["unified_index"] = idx_res
        if args.apply:
            receipts_dir.mkdir(parents=True, exist_ok=True)
            rec_file = receipts_dir / f"sync_receipt_{utc_compact_stamp()}.json"
            rec_file.write_text(
                json.dumps(res, indent=2) + "\n", encoding="utf-8", newline="\n"
            )
            res["receipt_path"] = sanitize_path_display(rec_file, topo.home)

        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(
                f"[{res['mode'].upper()}] planned={res['planned_actions_total']} "
                f"(desktop->cli={res['planned_desktop_to_cli']}, cli->desktop={res['planned_cli_to_desktop']}), "
                f"excluded_active={len(res['excluded_active'])}"
            )
            if args.apply:
                print(f"  Copied .db: {res['copied_trajectory_dbs']}")
                print(f"  After counts: {res['after_counts']}")
                print(f"  Integrity: {res['integrity_checks']}")
        if args.apply and res.get("integrity_checks", {}).get("failures"):
            return 1
        return 0

    if args.command == "index":
        excl = compute_excluded_active_ids(
            [topo.desktop_root, topo.cli_root],
            set(args.exclude_active),
            lock_window_seconds=args.lock_window_seconds,
        )
        idx_res = build_unified_index(topo, index_path, excl)
        if args.json:
            print(json.dumps(idx_res, indent=2))
        else:
            print(json.dumps(idx_res, indent=2))
        return 0 if idx_res["integrity_check"] == "ok" else 1

    if args.command == "search":
        hits = search_unified_index(
            index_path,
            args.query,
            limit=args.limit,
            ecosystem=args.ecosystem,
            roots_only=args.roots_only,
        )
        if args.json:
            print(json.dumps(hits, indent=2))
        else:
            print(f"Found {len(hits)} match(es) for {args.query!r}:")
            for i, h in enumerate(hits, 1):
                surf = ",".join(h["surfaces"])
                title = h["title"] or "(untitled)"
                print(f"  {i}. [{surf}] {h['conversation_id']} | steps={h['steps_or_items']} | {title}")
                print(f"     Resume: {h['resume_cmd']}")
                if h["snippet"]:
                    print(f"     Snippet: {h['snippet'][:160]}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
