# Omnia — Lessons Learned & Engineering Anti-Patterns

This postmortem handbook distills **15 costly failure modes and architectural lessons caught across Omnia's Codex, Antigravity (App, IDE & CLI), and Claude histories** into concrete, enforceable rules so collaborator **HTMusTC** and future AI agents never repeat them.

---

## Quick Reference Checklist

| # | Anti-Pattern | Permanent Guardrail |
|---|---|---|
| 1 | Polluting `D:\Omnia` with `build/`, `CMakeFiles/`, `.obj`/`.exe`, `.tmp-*`, screenshots, or nested worktrees | Configure CMake out-of-source into `D:\OmniaData\build\*` ([CMakePresets.json](../../CMakePresets.json)); route all runtime/QA/research/worktrees to `D:\OmniaData\*`. |
| 2 | Shipping template "AI slop" UI without preview candidates, DPI/resize checks, or server-side UIA | Enforce anti-slop tokens (`0` gradients/blur/`9999px` pills), WCAG 2.2 contrast, cropped captures, and COM `WM_GETOBJECT` + `WH_CBT` `#32770` UIA (`uia_provider.cpp`). |
| 3 | Proliferating overlapping `deep-*` stub skills & >300-char frontmatter truncation | Keep curated repo skills orthogonal (`13` skills in `.agents/skills/`, `0` synthetic stubs) with front-loaded trigger descriptions (`skill_registry.cpp`). |
| 4 | Treating mid-run `steer` as "replace & forget" or setting silent `token_budget` caps | Treat every steer as `ADDITIVE_INTAKE` (`SteerQueue`); reconcile conflicts, resume all unfinished backlog, and keep `token_budget = NULL` unless user-specified. |
| 5 | Globbing only `*.jsonl` (missing 103 `.jsonl.zst` rollouts) or ignoring SQLite `.db` protobufs | Always inventory compressed archives (`.jsonl.zst`) and SQLite wire-format `.db` steps (`step_type=17` 429 errors); never claim semantic coverage from hashes alone. |
| 6 | PowerShell double-quoted here-string (`@"..."@`) interpolation corrupting Markdown & code | Always use single-quoted literal here-strings (`@'...'@`) or Python UTF-8 file writers (`\n`), followed by `git diff --check`. |
| 7 | Misreporting same-drive quarantine moves (`D:\` -> `D:\`) as freed disk space | Verify actual volume free bytes (`Get-PSDrive`) before and after cleanup; same-volume moves relocate clutter (`0 B` freed), not reclaim space. |
| 8 | Hijacking physical mouse/keyboard focus during `computer-use` / browser QA | Default to headless Edge CDP, `PrintWindow` (`qa-capture.ps1`), and server-side COM UIA—never steal physical cursor focus unprompted. |
| 9 | Mutating source Git trees during "read-only" checks or pushing unauthorized side branches | Never run side-effecting `git` commands on reference trees; open SQLite with `?mode=ro` / `?immutable=1` (and check `wal.st_size > 0`); verify `khang-macphuc111107`. |
| 10 | Hardcoding models, regex-blocking `gpt` model IDs, or stalling on HTTP 429 walls | Route through C++20 `DynamicProviderRouter` (`dynamic_router.hpp`) with explicit `QuotaState`, `std::mutex` reservations, emergency reserve, and circuit breakers. |
| 11 | Mixing inline paste and attachment-tray semantics or duplicating binary blobs | Preserve dual-mode semantics (`inline-at-caret` vs `tray`, `Esc` -> `PasteDestination::Cancel` zero-mutation) backed by one BCrypt SHA-256 `payload_id`. |
| 12 | Allowing transient chat credentials, browser cookies, or API keys near exports/repos | Scrub via `SecretRedactor` (`redactor.hpp`) + `verify_zero_secrets.py` (`PASS_ZERO_LEAKS`), never store plaintext keys on disk, and push via OS Git Credential Manager. |
| 13 | In-tree C++ builds or parallel subproject lock collisions (`CMakeFiles/`, `.pdb` locks) | Build strictly out-of-source in disjoint `D:\OmniaData\build\omnia-cpp-*` roots with `/std:c++20 /utf-8 /W4 /WX` and gate subprojects via `OMNIA_BUILD_NATIVE_SHELL`. |
| 14 | Traversing NTFS junctions during disk audits or stalling for 20+ min deleting millions of cached files | Check `FILE_ATTRIBUTE_REPARSE_POINT (0x400)` before recursing, and purge multi-million-file cache/backup dirs via `robocopy <empty> <dir> /MIR /XJ /MT:32` + `rd /s /q`. |
| 15 | Cross-host skill drift (`$HOME` quirk on Windows Antigravity or mid-audit `/learn` edits) | Keep all `13` curated skills byte-identical across Omnia, Codex, and `~/.agents`, use drive-absolute forward-slash paths in Windows `~/.gemini/config/skills.json`, and serialize commits. |

---

## Detailed Postmortems

### 1. Repository Root Pollution (`ROOT-01`..`ROOT-06`)
- **Provenance**: Codex `01a1bce9` Prompts `#2`, `#21`, `#94`–`#100`, `#115`, `#121`; Claude `be2beaab`, `308b37b9`; Wave 4 `#74`.
- **What Went Wrong**: Parallel agents previously dumped build directories, `.tmp-*` probe scripts, full-screen PNG captures, beside-source `.bak`/copy files, `.claude`/`.agents` scratchpads, and nested worktree clones directly inside `D:\Omnia`. This bloated `D:\`, slowed IDE indexing/ripgrep, and risked staging scratch artifacts to GitHub.
- **Permanent Rule**:
  1. `D:\Omnia` is **strictly** for tracked C++20/UI/tool source, `CMakeLists.txt` / `CMakePresets.json`, `13` curated `.agents/skills/*`, and canonical docs (`docs/{workspace,ui-direction,handoff}`).
  2. Configure all CMake builds into `D:\OmniaData\build\...`—never inside `D:\Omnia`.
  3. Store all runtime DBs, QA screenshots, UI candidate bundles, research clones, and worktrees under `D:\OmniaData\`.

---

### 2. Blind UI Implementation, Status-Panel Clipping & Missing UIA Controls
- **Provenance**: Codex `01a1bce9` Prompts `#5`, `#23`, `#109`, `#110`, `#113`; Antigravity CLI `c2cc6103`; Wave 2 `#46`/`#49` & Wave 4 `#72`/`#73`/`#81`/`#86`.
- **What Went Wrong**:
  - Earlier web iterations produced generic dark-gradient "AI slop" cards with low-contrast muted text and overflowing containers.
  - Early Win32 builds hid three subtle UX/automation defects caught only by region-cropped capture + UI Automation (`UIA`) inspection: (a) right/bottom status-panel text clipping at `1220x820`, (b) custom composer controls missing a server-side `UIA Edit` provider (`Missing UIA control: Edit`), and (c) background UIA `InvokePattern.Invoke()` failing on standard Win32 `#32770` `MessageBoxW` modal buttons when unfocused.
- **Permanent Rule**:
  1. Enforce the anti-AI-slop specification ([FLAGSHIP_STUDIO_UI_SPEC.md](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md) & [DIRECTION_DECISION.md](../ui-direction/DIRECTION_DECISION.md)): `0` gradients, `0` blur, `0` `9999px` pills, WCAG 2.2 verified across every theme (`Obsidian`, `Alabaster`, `Blueprint`), and `0 px` horizontal overflow across `45` Edge CDP states.
  2. In Win32 C++20 ([uia_provider.cpp](../../native/src/uia_provider.cpp)), expose server-side COM `IRawElementProviderSimple` + `IValueProvider` / `IInvokeProvider` via `WM_GETOBJECT` and wrap modal `MessageBoxW` calls with a thread-scoped `WH_CBT` (`HCBT_ACTIVATE`) `#32770` button provider (`GetPropW` duplicate-subclass guard + `SetActiveWindow(GetAncestor(hwnd, GA_ROOT))` before `BM_CLICK`).

---

### 3. Skill Catalog Explosion & Frontmatter Truncation
- **Provenance**: Collaborator spec chat (`6e51d544` `Pasted text.txt` L15–L19); Codex `01a1bce9` Prompts `#2`, `#114`, `#124`; Wave 2 `#42` & Wave 4 `#83` ([skill_registry.hpp](../../cpp/include/omnia/harness/skill_registry.hpp)).
- **What Went Wrong**: Dumping hundreds of overlapping `deep-*` stub folders into a repository bloats prompt indexes, truncates trailing trigger clauses, and causes LLM skill-selection hallucination.
- **Permanent Rule**:
  1. Keep external 1,000-spec domain taxonomies in structured research catalogs (`D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json`)—**never** dump synthetic stub folders into `.agents/skills/`.
  2. Maintain concise, front-loaded YAML `description` fields (`<= 1024` chars, UTF-8 codepoint-boundary safe in `SkillRegistry`) with explicit trigger actions and boundaries.

---

### 4. Dropping Unfinished Backlog on Mid-Run `Steer` & Unauthorized `token_budget` Caps
- **Provenance**: Codex `01a1bce9` Prompts `#20`, `#98`, `#102`, `#114`; `goals_1.sqlite` history; [composer_steer.hpp](../../cpp/include/omnia/harness/composer_steer.hpp).
- **What Went Wrong**: Agents previously treated mid-run user steers as replacements that dropped prior unfinished tasks, or set finite `token_budget` caps that halted long-running goals prematurely.
- **Permanent Rule**:
  1. **Additive Steer Invariant (`ADDITIVE_INTAKE`)**: Push every mid-run steer onto [STEER_QUEUE.md](../workspace/STEER_QUEUE.md) / `SteerQueue`, reconcile conflicts against completed/in-progress items, and resume all remaining unfinished tasks until every DoD gate passes.
  2. **Unlimited Default Budget**: Keep `token_budget = NULL` unless the user explicitly requests a cap.

---

### 5. Incomplete History Globbing (`*.jsonl` Missing `.jsonl.zst`), SQLite WAL Self-Locking & Hash-Only Overclaiming
- **Provenance**: `D:\OmniaData\exports\history\WATERMARK_AND_DENOMINATORS.json`; [agy_history_sync.py](../../tools/agy-history-sync/agy_history_sync.py); [DOD.md](../workspace/DOD.md) `DOD-09` & `DOD-10`.
- **What Went Wrong**:
  - Globbing only `*.jsonl` missed `103` zstd-compressed `.jsonl.zst` Codex rollouts; reading only JSONL transcripts missed Antigravity `.db` `step_type=17` HTTP 429 protobuf payloads.
  - On Windows, opening a WAL-mode SQLite `.db` via `?mode=ro` creates/touches a `0`-byte `.db-wal` and `32 KB` `.db-shm` with `mtime = now`, causing naive `mtime`-based lock detectors to self-lock idle conversations right after `--dry-run`!
- **Permanent Rule**:
  1. Decode `.jsonl.zst` (`compression.zstd`) and SQLite protobuf blobs via `?mode=ro` / `?immutable=1`.
  2. Check `wal_p.exists() and wal_p.stat().st_size > 0` (not `0`-byte `-wal` or `-shm` touch times) when detecting active SQLite WAL writers.

---

### 6. PowerShell Double-Quoted Here-String (`@"..."@`) Escaping Corruption
- **Provenance**: [CHECKPOINT.md](../workspace/CHECKPOINT.md) historical edits (`\native` turned into `<newline>ative`, backticks stripped, `$PID`/`$env` expanded to empty strings).
- **What Went Wrong**: Writing Markdown or C++/JSON files via PowerShell double-quoted `@"..."@` caused silent variable/backtick interpolation and `CRLF` drift.
- **Permanent Rule**:
  1. Use structured edit tools or Python `Path.write_bytes(...)` enforcing pure UTF-8 `LF` (`\n`).
  2. Always run `git diff --no-index --check` (or `git diff --cached --check`) to catch trailing whitespace on untracked as well as tracked files before committing.

---

### 7. Confusing Same-Volume Quarantine Moves with Disk Reclamation (`DRIVE-02`)
- **Provenance**: Codex `01a1bce9` storage audits (`CLEAN-08`, `CLEAN-11`, `CLEAN-13`, `CLEAN-16`, `CLEAN-19`).
- **What Went Wrong**: Moving directories from `D:\Omnia\...` to `D:\OmniaData\...` cleaned the git working tree (`ROOT-*`) while freeing `0 bytes` on `D:`.
- **Permanent Rule**:
  - Distinguish **repo externalization** (`0 B` volume delta) from **true capacity reclamation** (purging proven regenerable caches/duplicate update snapshots with pre/post `Get-PSDrive` free-byte receipts).

---

### 8. Stealing Physical Mouse/Keyboard Focus During Desktop & Browser Automation
- **Provenance**: Codex `01a19808`, `01a1bb7b`, `01a1bce9` Prompts `#5`, `#23`; Antigravity `061ffa08`; Claude `6f2d773c`.
- **What Went Wrong**: Foreground `pyautogui` / `SetCursorPos` scripts hijacked the user's cursor and focus mid-work.
- **Permanent Rule**:
  - Use headless Edge CDP for studio/web QA and `PrintWindow` ([qa-capture.ps1](../../native/qa-capture.ps1)) + server-side COM `WM_GETOBJECT` UIA ([uia_provider.cpp](../../native/src/uia_provider.cpp)) for Win32 QA—never move the physical OS cursor unprompted.

---

### 9. Accidental Source-Tree Mutations & GitHub Handle / Branch Mistakes
- **Provenance**: [CHECKPOINT.md](../workspace/CHECKPOINT.md) round 10; Codex `01a1bb7b` Prompt `#7` (`khang-macphuc11107` typo vs `khang-macphuc111107`).
- **What Went Wrong**: Side-effecting `git` commands dirtied reference checkouts, and dropping one `1` in `khang-macphuc111107` broke push configuration.
- **Permanent Rule**:
  - Use `git --no-optional-locks` for read-only checks, `?immutable=1` for read-only SQLite audits, and canonical remote `https://github.com/khang-macphuc111107/omnia` (preserving legacy baselines on annotated/pushed tags like `archive/pre-cpp-rust-snapshot-20261112`).

---

### 10. Static Model Hardcoding, Coercing `Unknown` Quota to `0` & HTTP 429 Storms
- **Provenance**: Claude `9659b2b4`, `25b55b68`; Antigravity `.db` `step_type=17`; Codex `01a1bce9` Prompts `#108`, `#122`.
- **What Went Wrong**: Prefix regexes blocked valid proxy models (`htmustc-proxy`), and coercing missing quota headers to `0` starved healthy accounts or hid stale telemetry.
- **Permanent Rule**:
  - Route through C++20 `DynamicProviderRouter` ([dynamic_router.hpp](../../cpp/include/omnia/routing/dynamic_router.hpp)) with explicit `QuotaState::{Known,Unknown,Stale,Contradictory}`, idempotent `std::mutex` reservations, interactive emergency reserve, and `Closed`/`Open`/`HalfOpen` circuit breakers.

---

### 11. Collapsing Inline Paste & Attachment Tray into One Lossy Bucket
- **Provenance**: Codex `01a1bce9` Prompt `#97`; [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md).
- **What Went Wrong**: Dumping every pasted image into a bottom strip destroyed inline positional meaning, whereas duplicating bytes across inline + tray wasted storage.
- **Permanent Rule**:
  - Preserve dual-mode paste (`inline-at-caret` vs `tray`, `Esc` -> `PasteDestination::Cancel` zero-mutation) backed by a single BCrypt SHA-256 `payload_id` ([sha256.hpp](../../cpp/include/omnia/core/sha256.hpp), [composer_steer.hpp](../../cpp/include/omnia/harness/composer_steer.hpp)).

---

### 12. Plaintext Credentials, Session Cookies & Unscrubbed Backup Freelists
- **Provenance**: Codex `01a1bce9` Prompt `#119`; Wave 2 `#39` SQLite `.backup()` FTS scrub + `VACUUM`.
- **What Went Wrong**: Plaintext passwords shared in historical chat prompts appeared inside FTS5 shadow tables when raw `conversation_summaries.db` files were snapshotted; deleting rows without `VACUUM` leaves plaintext bytes in SQLite freelist pages!
- **Permanent Rule**:
  1. Scrub sensitive tokens via [redactor.hpp](../../cpp/include/omnia/core/redactor.hpp) / `sanitize_index_text`, and **always run `VACUUM;`** after deleting sensitive rows from exported SQLite backup copies.
  2. Verify every export and repo path with `verify_zero_secrets.py` (`PASS_ZERO_LEAKS`, `leak_count = 0`).

---

### 13. C++20 Out-of-Source `CMake` + `Ninja` Build Roots & Subproject Lock Isolation
- **Provenance**: Wave 4 `#71`, `#72`, `#83`, `#86`; [CMakeLists.txt](../../CMakeLists.txt), [CMakePresets.json](../../CMakePresets.json), [deep-cpp-native](../../.agents/skills/deep-cpp-native/SKILL.md).
- **What Went Wrong**: In multi-agent C++ workspaces, running `cmake` in-tree pollutes git status with `CMakeFiles/`, `CMakeCache.txt`, `.ninja_log`, `.obj`, and `.pdb` files, while two agents building overlapping targets into one shared binary directory collide on MSVC `.pdb` / Ninja lockfiles (and earlier shared debug `.exe` relinking invalidated captured SHA-256 digests mid-audit in `#60` `WARN-R1-02`).
- **Permanent Rule**:
  1. Configure every CMake build strictly out-of-source under disjoint directories in `D:\OmniaData\build\` (`omnia-cpp-core-{release,debug}`, `omnia-cpp-native-{release,debug}`, `omnia-full-release`).
  2. Gate parallel subprojects cleanly in root `CMakeLists.txt` (`option(OMNIA_BUILD_NATIVE_SHELL "Build Win32 shell" ON)`) under `/std:c++20 /utf-8 /EHsc /W4 /WX /Zc:__cplusplus /permissive-` (`0` warnings), and never recompile into an audited binary directory while frozen hash verification is in flight.

---

### 14. Windows NTFS Reparse-Safe Auditing (`0x400`) & Multi-Threaded `robocopy /MIR /XJ /MT:32` Purging
- **Provenance**: Wave 4 `#74`, `#79`, `#80`; `docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md`, `docs/workspace/DEEP_CLEAN_AUDIT_C_DRIVE.md`, [deep-clean](../../.agents/skills/deep-clean/SKILL.md).
- **What Went Wrong**:
  1. Naive recursive directory walkers on Windows follow NTFS junctions, directory symlinks, and `pnpm`/WinSxS/AppData reparse points—either double-counting gigabytes or risking catastrophic deletion inside linked live user data!
  2. Conversely, hidden rolling auto-update snapshots (`285` × `1.85 GiB` `CodexBetaPatched\backup\updates\app.*` folders = `529+ GiB` / `2.9M` files) and external git-ignored `target` directories (`221.7 GiB`) silently consumed ~99% of `D:\`, where single-threaded Python `shutil.rmtree` or PowerShell `Remove-Item -Recurse` stalls for 20+ minutes on NTFS metadata locks.
- **Permanent Rule**:
  1. **Reparse Point Guard First**: Always test `(attrs & 0x400) != 0` (`FILE_ATTRIBUTE_REPARSE_POINT`) before recursing during disk inventory or cleanup, and pass `/XJ` (exclude junctions) to tools.
  2. **Provenance Before Deletion**: Verify `0` open process handles, `git check-ignore -v` on build caches, and keep at least the latest rollback snapshot (`app.20261013-163324` + `.asar.original`) plus `100%` of user repos and historical/QA ledgers.
  3. **Fast Multi-Threaded NTFS Purge**: Purge verified multi-million-file cache/backup trees using an empty scratch directory: `robocopy <empty_dir> <target_dir> /MIR /XJ /MT:32 /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP` followed by `cmd /c rd /s /q <target_dir>`.

---

### 15. `deep-cpp-native` & 4-Way Cross-Host Skill Parity (`13` Curated Skills, Windows `skills.json` Paths)
- **Provenance**: Wave 2 `#44`/`#48`, Final Audit `#60` (`ERR-R1-01`), Wave 4 `#74`/`#77`/`#78`.
- **What Went Wrong**:
  1. On Windows, Antigravity's `~/.gemini/config/skills.json` did not expand `~` or `$HOME` reliably when resolving multi-root skill directories, initially hiding `.codex/skills` and `D:/Omnia/.agents/skills` from live `<skills>` discovery until drive-absolute forward-slash paths (`C:/Users/...`, `D:/Omnia/.agents/skills`) were configured.
  2. An external `/learn` sync updated `.agents/skills/omni-deterministic-verifiers/SKILL.md` 4 minutes after a clean `git push`, dirtying the working tree mid-audit.
- **Permanent Rule**:
  1. Maintain **4-way byte-for-byte pure UTF-8 `LF` parity** across `D:\Omnia\.agents\skills`, `~/.codex/skills`, `~/.agents/skills`, and Windows drive-absolute `~/.gemini/config/skills.json` across all **`13` curated skills** (including [deep-cpp-native](../../.agents/skills/deep-cpp-native/SKILL.md) and [deep-proposal](../../.agents/skills/deep-proposal/SKILL.md)), validated with `python -B quick_validate.py` (`0` `__pycache__`).
  2. Freeze external `/learn` writes into `D:\Omnia\.agents\skills` while an immutable git commit/audit streak is running, staging skill updates through serialized commits.
