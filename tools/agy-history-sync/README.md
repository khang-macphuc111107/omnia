# Antigravity Multi-Surface History Sync & Unified FTS5 Search (`agy-history-sync`)

`agy_history_sync.py` unifies disconnected chat histories across **Antigravity CLI (`agy`)**, **Antigravity 2.0 Agent Desktop App**, and **Antigravity IDE**—while also indexing **Codex** threads read-only into a single cross-surface SQLite FTS5 search and resume index.

---

## Why Histories Were Disconnected

Forensic inspection of local Antigravity storage reveals how the three surfaces partition state under `~/.gemini/`:

| Surface | UI State Shell | Trajectory & Summary Root | Root Cause of Disconnection |
|---|---|---|---|
| **Antigravity 2.0 Agent App** | `%APPDATA%/Antigravity` (`app_storage.json`) | `~/.gemini/antigravity/` (`conversations/*.db`, `brain/*`, `conversation_summaries.db`, `agyhub_summaries_proto.pb`) | Imports `conversation_summaries` metadata stubs from `antigravity-cli` (`source='CORTEX_TRAJECTORY_SOURCE_CLI'`), **without** copying `conversations/<uuid>.db`, `brain/<uuid>/`, or `conversations_fts` body rows. |
| **Antigravity IDE** | `%APPDATA%/Antigravity IDE` (`state.vscdb`) | `~/.gemini/antigravity/` (post `~/.gemini/antigravity-ide/.ide_migration`) | Shares `~/.gemini/antigravity/` with the Desktop App, inheriting the same missing CLI `.db` / `brain/` ghost entries. |
| **Antigravity CLI (`agy`)** | `~/.gemini/antigravity-cli/settings.json` | `~/.gemini/antigravity-cli/` (`conversations/*.db`, `brain/*`, `conversation_summaries.db`, `jetbox_summaries_proto.pb`) | Zero reverse sync from `~/.gemini/antigravity/`: CLI `agy --conversation <uuid>` and `/resume` cannot see any conversation started in the Desktop App or IDE. |

---

## Safety Invariants

1. **Pre-Write Online Backups (`sqlite3.Connection.backup()`)**: Every `--apply` run creates a timestamped snapshot of `conversation_summaries.db` and `.pb` summary maps under `<data-dir>/backups/<UTC-timestamp>/` before mutating any target file.
2. **Active & WAL-Locked Conversation Exclusion**: Automatically skips:
   - Any conversation ID passed via `--exclude-active <uuid>` **plus all transitive child/subagent conversations** (`parent_conversation_id` ancestry).
   - Any conversation with `CASCADE_RUN_STATUS_RUNNING` or a `.db-wal` / `.db-shm` sidecar modified within `--lock-window-seconds` (default `600` seconds / 10 minutes).
3. **Monotonic Step-Count Merge**: Copies `<uuid>.db` (via atomic temp-file `.backup()` + `PRAGMA integrity_check` + `os.replace`) only when the destination lacks `<uuid>.db` or has strictly fewer `steps` rows—making repeated sync runs idempotent and preventing stale stubs from overwriting newer trajectories.
4. **Full Surface Searchability**: Populates `conversation_summaries`, `conversation_parents`, `conversations_fts` (FTS5 `unicode61 remove_diacritics 2`), and idle `jetbox_summaries_proto.pb`, then verifies `PRAGMA integrity_check` and FTS5 `'integrity-check'`.

---

## Usage (Python 3.15+ Stdlib Only)

```powershell
# 1. Inspect current multi-surface counts and sync parity
python tools/agy-history-sync/agy_history_sync.py status

# 2. Preview bidirectional sync plan without modifying any files
python tools/agy-history-sync/agy_history_sync.py sync --dry-run --exclude-active <active-uuid>

# 3. Backup, sync completed conversations bidirectionally, verify integrity, and rebuild unified FTS5 index
python tools/agy-history-sync/agy_history_sync.py sync --apply --exclude-active <active-uuid>

# 4. Search across Antigravity App, Antigravity IDE, Antigravity CLI, and Codex
python tools/agy-history-sync/agy_history_sync.py search "dynamic router quota" --roots-only

# 5. Run unit test suite
python -m unittest discover -s tools/agy-history-sync -p "test_*.py" -v
```

### Resuming Any Synced Conversation
- **In Antigravity CLI (`agy`)**: `agy --conversation <conversation_id>` (or `agy -c` for most recent).
- **In Antigravity Agent App / Antigravity IDE**: Open directly from the unified sidebar or search bar (`~/.gemini/antigravity` now holds both `.db` trajectory steps and `brain/<conversation_id>/` artifacts).
- **In Codex CLI**: `codex resume <thread_id>`.
