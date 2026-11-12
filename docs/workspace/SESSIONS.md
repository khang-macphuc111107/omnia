# Omnia multi-host session continuity index

**Index role:** Navigable map of multi-host AI coding session inventories (Codex, Antigravity Desktop/IDE/CLI, Claude), synchronization tooling, and next-session admission gates (`HISTORY-01..03`, `SESSION-01`, `DOD-09`, `DOD-16`).

## Multi-host session denominators (`2026-11-12` watermark)

Authoritative private watermark receipt: `D:\OmniaData\exports\history\WATERMARK_AND_DENOMINATORS.json` (`1,767` inventoried files hashed, `3,677,088,726` disk bytes / `3,916,097,544` decompressed bytes, `781,579` parsed records/steps, `PASS_ZERO_LEAKS` `sha256=a01b88f6...`). All multi-host conversation stores on `C:\` and `D:\` were verified 100% preserved across Wave 4 `C:\` and `D:\` deep-clean operations.

| Host surface | Denominator at watermark | Storage & sync status | Repo-safe / tool entrypoint |
|---|---|---|---|
| **Codex CLI & Desktop** (`~/.codex/`) | `956` rollout files (`853` `.jsonl` + `103` `.jsonl.zst`, `594,568` records; `46` root + `912` child threads; `state_5.sqlite` `958` rows incl. `2` zero-token aborted stubs; `goals_1.sqlite` `13/13` rows `token_budget IS NULL`) | Read-only SQLite + zstd extraction; flagship thread `01a1bce9-bcd9-75f3-b63a-28b855d6978f` (`124` user prompts, `7,559` items) fully indexed | [`../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md`](../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md) |
| **Antigravity 2.0 Agent App & IDE** (`~/.gemini/antigravity/`) | Reconciled from `119` DBs / `143` summaries (`24` ghost CLI rows) -> **`144` `.db` / `144` summaries (`0` ghost)** (`PRAGMA integrity_check = ok`) | Bidirectionally synced with pre-sync backup (`D:\OmniaData\exports\history\agy-sync\backups\`); active growing-tail swarm DBs safely excluded (`--exclude-active cbe73571-6d33-46a5-b1c9-c71d1b3ef8b5`) | [`../../tools/agy-history-sync/README.md`](../../tools/agy-history-sync/README.md) |
| **Antigravity CLI (`agy`)** (`~/.gemini/antigravity-cli/`) | Reconciled from `24` DBs / `24` summaries -> **`126` `.db` / `126` summaries (`0` ghost)** + rebuilt `jetbox_summaries_proto.pb` (`PRAGMA integrity_check = ok`) | Full completed-session parity (`shared_dbs=126`, `missing_in_cli=0`, `missing_in_desktop=0`) | [`../../tools/agy-history-sync/agy_history_sync.py`](../../tools/agy-history-sync/agy_history_sync.py) (`5/5` unit tests `OK`) |
| **Unified AGY + Codex FTS5 Index** | **`1,102` indexed threads** (`144` Antigravity + `958` Codex) | `D:\OmniaData\exports\history\agy-sync\unified_agy_history.sqlite` (`PRAGMA integrity_check = ok`) | `python -B tools/agy-history-sync/agy_history_sync.py search <query>` |
| **Claude CLI & Desktop** (`~/.claude/`, local app data) | `341` `.jsonl` files (`53` root + `287` subagent + `history.jsonl`, `66,442` records) + `53` session JSONs + `15` log files | Redacted Markdown exports under `D:\OmniaData\exports\history\claude\` | [`../handoff/COLLABORATOR_HANDOFF.md`](../handoff/COLLABORATOR_HANDOFF.md) |

## Collaborator & next-session handoff entrypoints

- **Collaborator (`HTMusTC`) executive orientation:** [`../handoff/COLLABORATOR_HANDOFF.md`](../handoff/COLLABORATOR_HANDOFF.md)
- **Cross-host engineering lessons & anti-patterns:** [`../handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md`](../handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md)
- **Session admission ledger (`SESSION-G01`..`SESSION-G07`):** [`SESSION_ADMISSION.json`](SESSION_ADMISSION.json) (`decision: "READY"` — `SESSION-G01..G07` satisfied; follow-up chat `threadId` launch pending)
- **Transfer contract & prepared launch prompt:** [`TRANSFER_CONTRACT.md`](TRANSFER_CONTRACT.md) & [`NEXT_SESSION_PROMPT.md`](NEXT_SESSION_PROMPT.md)
