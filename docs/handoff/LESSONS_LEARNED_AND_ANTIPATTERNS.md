# Omnia — Lessons Learned & Engineering Anti-Patterns

This postmortem handbook distills **23 costly failure modes and architectural lessons caught across Omnia's Codex, Antigravity (App, IDE & CLI), and Claude histories (including Wave 5 Full Native Rust migration & Steer #15–#21)** into concrete, enforceable rules so collaborator **HTMusTC** and future AI agents never repeat them.

---

## Quick Reference Checklist

| # | Anti-Pattern | Permanent Guardrail |
|---|---|---|
| 1 | Polluting `D:\Omnia` with `target/`, `build/`, `.exe`, `.tmp-*`, `__pycache__/`, screenshots, or nested worktrees | Set `$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace'`, run Python via `python -B`, and route runtime/QA/research/worktrees to `D:\OmniaData\*`. |
| 2 | Shipping template "AI slop" UI without preview candidates, DPI/resize checks, or server-side UIA | Enforce anti-slop tokens (`0` gradients/blur/`9999px` pills), WCAG 2.2 contrast, cropped DPI-clamped (`8192`) captures, and split `Edit` vs `Document` UIA + `WH_CBT` `#32770`. |
| 3 | Proliferating overlapping `deep-*` stub skills & >300-char frontmatter truncation | Keep repo skills concise (`16` curated + `6` `kdense-*` projections = `22` total, `0` synthetic stubs, read-only external Cold Vault) with `short_description` in `25..64` chars and `1024`-char capped `SkillRegistry`. |
| 4 | Treating mid-run `steer` as "replace & forget" or setting silent `token_budget` caps | Treat every steer as `ADDITIVE_INTAKE` (`SteerQueue` in `rust/omnia-harness/src/steer_queue.rs`); resume all unfinished backlog and keep `token_budget = NULL` / `tokenBudget: null`. |
| 5 | Globbing only `*.jsonl` (missing 103 `.jsonl.zst` rollouts) or ignoring SQLite `.db` protobufs | Always inventory compressed archives (`.jsonl.zst`) and SQLite wire-format `.db` steps (`step_type=17` 429 errors); never claim semantic coverage from hashes alone. |
| 6 | PowerShell double-quoted here-string (`@"..."@`) interpolation corrupting Markdown & code | Always use single-quoted literal here-strings (`@'...'@`) or Python UTF-8 `LF` writers (`\n`), followed by `git diff --check`. |
| 7 | Misreporting same-drive quarantine moves (`D:\` -> `D:\`) as freed disk space | Verify actual volume free bytes (`Get-PSDrive`) before and after cleanup; same-volume moves relocate clutter (`0 B` freed), not reclaim space. |
| 8 | Hijacking physical mouse/keyboard focus during `computer-use` / browser QA | Default to headless Edge CDP, `PrintWindow` (`pwsh -File native/qa-capture.ps1`), and server-side COM UIA—never steal physical cursor focus unprompted. |
| 9 | Mutating source Git trees during "read-only" checks or pushing unauthorized side branches | Never run side-effecting `git` commands on reference trees; open SQLite with `?mode=ro` / `?immutable=1` (and check `wal.st_size > 0`); verify `khang-macphuc111107`. |
| 10 | Hardcoding models, regex-blocking `gpt` model IDs, or stalling on HTTP 429 walls | Route through Rust `DynamicProviderRouter` (`rust/omnia-routing/src/lib.rs`) with explicit `QuotaState`, atomic reservations, emergency reserve, and circuit breakers. |
| 11 | Mixing inline paste and attachment-tray semantics or duplicating binary blobs | Preserve dual-mode semantics (`inline-at-caret` vs `tray`, `Esc` -> cancel zero-mutation in `rich_composer.rs`) backed by one SHA-256 `payload_id`. |
| 12 | Allowing transient chat credentials, browser cookies, or API keys near exports/repos or realistic test tokens failing scanners | Scrub via `rust/omnia-core/src/redactor.rs` + `audit.py --secret-scope all`; use unmistakable dummy/RFC-2606 hosts/tokens in fixtures (avoid `"Test"`/`"abc123"`/`user:pass@non-example`); push via OS Git Credential Manager. |
| 13 | In-tree builds or parallel compiler lock collisions (`target/`, shared build locks) | Build strictly out-of-source (`D:\OmniaData\build\omnia-rust-workspace`, UI `D:\OmniaData\build\ui-dist`) and serialize workspace-wide `cargo` invocations via `@build-gate`. |
| 14 | Traversing NTFS junctions during disk audits or stalling for 20+ min deleting millions of cached files | Check `FILE_ATTRIBUTE_REPARSE_POINT (0x400)` before recursing, and purge multi-million-file cache/backup dirs via `robocopy <empty> <dir> /MIR /XJ /MT:32` + `rd /s /q`. |
| 15 | Cross-host skill drift (`$HOME` / dual-drive `E:\Users\<user>` quirk on Windows, trailing whitespace, or >64-char `short_description`) | Keep all `22` repo skills (`16` curated + `6` `kdense-*`) byte-identical (`LF`, `0` trailing spaces, `short_description <= 64`) across Omnia, `~/.codex/skills`, and `~/.agents/skills` (`validate_skills.py --strict-all-skills` exit `0`). |
| 16 | Running `qa-*.ps1` under PS 5.1, CRLF drift, stripping AdGuard cookies naively, or mixing short probe vs chat timeouts | Always run QA under PowerShell 7 (`pwsh`); enforce `text eol=lf` in `.gitattributes`; coalesce RFC 9110 multi-`Cookie` headers cleanly (`; `) while preserving smuggling checks; keep short `~3s` probes separate from `65,000 ms` chat timeouts. |
| 17 | Assuming generic Cold-Vault JSON keys or leaving `targets.json` flat after JS modularization | Inspect exact external catalog keys (`skills_catalog[]` `focus_en`/`description_vi` + `categories_100[]`) verified by `golden-eval` (`16/16` `100%`), and update `platform/targets.json` to recursive `**/*.js` globs whenever flat UI trees modularize (`TRK-06` `1a1e423`). |
| 18 | Unchecked JSON integer casts, loose loopback port checks, silent `..` path drops, un-rolled-back SQLite `COMMIT`, or FTS active-ID leaks | Validate JSON integers before mutating state (`AUD-29`), bind loopback `Host`/`Origin` to the exact bound listener port (`AUD-02`), reject `..`/absolute/mid-wildcard paths & non-recipient replies (`AUD-26`/`28`), `ROLLBACK` failed SQLite `COMMIT`, and fence `excluded_ids` + SHA-256 `omnia_fts_revisions` before FTS rebuilds (`AUD-30`/`31`). |

---

## Detailed Postmortems

### 1. Repository Root Pollution (`ROOT-01`..`ROOT-06`)
- **Provenance**: Codex `01a1bce9` Prompts `#2`, `#21`, `#94`–`#100`, `#115`, `#121`; Claude `be2beaab`, `308b37b9`; Wave 4 `#74`; Wave 5 `Steer #14`.
- **What Went Wrong**: Parallel agents previously dumped build directories, `.tmp-*` probe scripts, `__pycache__/`, screenshots, beside-source `.bak`/copy files, and nested worktree clones directly inside `D:\Omnia`.
- **Permanent Rule**:
  1. `D:\Omnia` is **strictly** for tracked Rust/UI/tool/packaging source, `Cargo.toml` / `Cargo.lock`, `.gitattributes`, `22` `.agents/skills/*`, and canonical docs (`docs/{workspace,ui-direction,architecture,handoff}`).
  2. Set `$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace'` and always run Python with `python -B` (`0` `__pycache__`).
  3. Store all runtime DBs, QA screenshots, UI candidate/dist bundles (`D:\OmniaData\build\ui-dist`), backups (`pre-full-rust-20261115/`), quarantined caches (`roaming-20261124/`), research clones, and worktrees under `D:\OmniaData\`.

---

### 2. Blind UI Implementation, Status-Panel Clipping, DPI Scaling & Split UIA Controls
- **Provenance**: Codex `01a1bce9` Prompts `#5`, `#23`, `#109`, `#110`, `#113`; Wave 2–4 `#46`/`#49`/`#72`; Wave 5 `qa-capture.ps1` / `qa-smoke.ps1` / `qa-session.ps1`.
- **What Went Wrong**:
  - Earlier web iterations produced low-contrast gradient cards and overflowing containers.
  - Early Win32 builds hid status-panel clipping, missing `ControlType.Edit` UIA providers, background `#32770` modal button failures, or stale process DPI context if capture crashed before restoring DPI awareness.
- **Permanent Rule**:
  1. Enforce the anti-AI-slop specification ([FLAGSHIP_STUDIO_UI_SPEC.md](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md)): `0` gradients, `0` blur, `0` `9999px` pills, WCAG 2.2 contrast across all 3 themes, and `0 px` horizontal overflow.
  2. In `rust/omnia-native/`, expose server-side COM `IRawElementProviderSimple` + `IValueProvider` / `IInvokeProvider` with distinct single-line `ControlType.Edit` (`qa-smoke.ps1`) vs multiline `ControlType.Document` (`TextPattern`, `qa-session.ps1`) and thread-scoped `WH_CBT` `#32770` modal button providers. In `qa-capture.ps1`, clamp captures (`MaximumDimension = 8192`) and always restore DPI awareness in `finally`.

---

### 3. Skill Catalog Explosion & Frontmatter Validation Limits
- **Provenance**: Collaborator spec chat (`6e51d544` `Pasted text.txt` L15–L19); Codex `01a1bce9` Prompts `#2`, `#114`, `#124`; Wave 2 `#42` & Wave 5 `validate_skills.py`.
- **What Went Wrong**: Dumping hundreds of overlapping `deep-*` stub folders into a repository bloats prompt indexes, while >64-char `interface.short_description` in `agents/openai.yaml` or trailing whitespace triggers strict validation warnings/errors.
- **Permanent Rule**:
  1. Keep external 1,000-spec domain taxonomies in structured research catalogs (`D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json`)—**never** dump synthetic stub folders into `.agents/skills/`.
  2. Maintain concise YAML `description` fields (`<= 1024` chars, UTF-8 codepoint-boundary safe in `rust/omnia-harness/src/skill_registry.rs`), `interface.short_description` within `25..64` chars, and pure `LF` with zero trailing whitespace.

---

### 4. Dropping Unfinished Backlog on Mid-Run `Steer` & Unauthorized `token_budget` Caps
- **Provenance**: Codex `01a1bce9` Prompts `#20`, `#98`, `#102`, `#114`; `goals_1.sqlite` history; [steer_queue.rs](../../rust/omnia-harness/src/steer_queue.rs).
- **What Went Wrong**: Agents previously treated mid-run user steers as replacements that dropped prior unfinished tasks, or set finite `token_budget` caps that halted long-running goals prematurely.
- **Permanent Rule**:
  1. **Additive Steer Invariant (`ADDITIVE_INTAKE`)**: Push every mid-run steer onto [STEER_QUEUE.md](../workspace/STEER_QUEUE.md) / `SteerQueue`, reconcile conflicts against completed/in-progress items, and resume all remaining unfinished tasks until every DoD gate passes.
  2. **Unlimited Default Budget**: Keep `token_budget = NULL` / `tokenBudget: null` unless the user explicitly requests a cap.

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
  - Use headless Edge CDP for studio/web QA and `PrintWindow` ([qa-capture.ps1](../../native/qa-capture.ps1)) + server-side COM `WM_GETOBJECT` UIA (`rust/omnia-native/`) for Win32 QA—never move the physical OS cursor unprompted.

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
  - Route through Rust `DynamicProviderRouter` ([rust/omnia-routing/src/lib.rs](../../rust/omnia-routing/src/lib.rs)) with explicit `QuotaState::{Known,Unknown,Stale,Contradictory}`, idempotent reservations, interactive emergency reserve, and `Closed`/`Open`/`HalfOpen` circuit breakers.

---

### 11. Collapsing Inline Paste & Attachment Tray into One Lossy Bucket
- **Provenance**: Codex `01a1bce9` Prompt `#97`; [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md).
- **What Went Wrong**: Dumping every pasted image into a bottom strip destroyed inline positional meaning, whereas duplicating bytes across inline + tray wasted storage.
- **Permanent Rule**:
  - Preserve dual-mode paste (`inline-at-caret` vs `tray`, `Esc` zero-mutation cancel) backed by a single SHA-256 `payload_id` ([rich_composer.rs](../../rust/omnia-harness/src/rich_composer.rs), [composer_model.rs](../../rust/omnia-harness/src/composer_model.rs)).

---

### 12. Plaintext Credentials, Unscrubbed Backup Freelists & Realistic Test Tokens Tripping Scanners
- **Provenance**: Codex `01a1bce9` Prompt `#119`; Wave 2 `#39` SQLite `.backup()` FTS scrub + `VACUUM`; Wave 5 `audit.py --secret-scope all`.
- **What Went Wrong**: Plaintext passwords shared in historical chat prompts appeared inside FTS5 shadow tables without `VACUUM;`, and test fixtures using realistic key/token shapes with words like `"test"`/`"sample"` triggered `audit.py --secret-scope all`.
- **Permanent Rule**:
  1. Scrub sensitive tokens via [redactor.rs](../../rust/omnia-core/src/redactor.rs), and **always run `VACUUM;`** after deleting sensitive rows from exported SQLite backup copies.
  2. Use unmistakable dummy/sequential placeholders or RFC-2606 `example.com` / loopback hosts in unit-test fixtures so `audit.py --secret-scope all` passes with `0` findings (`PASS_ZERO_LEAKS`, `leak_count = 0`).

---

### 13. Out-of-Source `CARGO_TARGET_DIR`, Offline `serde`, `pwsh` QA & AdGuard Loopback Hardening
- **Provenance**: Wave 4 `#71`–`#86`; Wave 5 `Steer #14` (`Cargo.toml`, `rust/omnia-runtime/src/main.rs`, `rust/omnia-connector-gateway/`, `ui/app/api.js`, `native/qa-*.ps1`).
- **What Went Wrong**: Building Cargo inside `D:\Omnia` dirties `target/`; assuming `serde_derive` fails in offline `--locked` builds; running `native/qa-*.ps1` on PowerShell 5.1 fails PowerShell 7 checks; AdGuard for Windows injects extra spaces in HTTP request lines and up to 15 `Cookie:` headers while short probe timeouts collide with chat timeouts if shared.
- **Permanent Rule**:
  1. Configure every Cargo build out-of-source via `$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace'` (`--offline --locked`) and implement manual `Serialize`/`Deserialize` when `serde_derive` is absent offline.
  2. Invoke all `native/qa-*.ps1` suites explicitly via PowerShell 7 (`pwsh -NoProfile -File ...`).
  3. Tolerate extra HTTP request-line whitespace and coalesce RFC 9110 §5.3 multi-`Cookie` headers (`; `) while preserving strict request-smuggling rejection (`parse_adguard_tolerant_http_head` in `rust/omnia-connector-gateway/src/lib.rs`), and keep short probe timeouts (`2400–3200 ms`, `resolveTimeoutMs` `[100, 120000] ms`) separate from `65,000 ms` chat/forwarding timeouts.

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

### 15. `22`-Skill 3-Way Cross-Host Parity (`validate_skills.py --strict-all-skills` & Windows `skills.json`)
- **Provenance**: Wave 2 `#44`/`#48`, Final Audit `#60` (`ERR-R1-01`), Wave 4 `#74`/`#77`/`#78`, Wave 5 `Steer #14..#20` (`validate_skills.py --strict-all-skills`).
- **What Went Wrong**:
  1. On Windows, Antigravity's `~/.gemini/config/skills.json` did not expand `~` or `$HOME` reliably when resolving multi-root skill directories, initially hiding `.codex/skills` and `D:/Omnia/.agents/skills` from live `<skills>` discovery until drive-absolute forward-slash paths (`C:/Users/...`, `D:/Omnia/.agents/skills`) were configured.
  2. Trailing whitespace in `kdense-*` reference/script files and `interface.short_description` > 64 chars broke strict audit / skill parity checks across hosts.
- **Permanent Rule**:
  1. Maintain **3-way byte-for-byte pure UTF-8 `LF` parity** across `D:\Omnia\.agents\skills`, `~/.codex/skills`, and `~/.agents/skills` for all **`22` repository skills** (`16` curated workflows incl. `deep-research`, `deep-think`, `super-plan-run-lifecycle` + `6` `kdense-*` research projections, with `deep-cpp-native` preserved for general/historical C++ diagnostics), validated with `python -B tools/omnia-skill-parity/validate_skills.py --strict-all-skills` (`0` cross-host drift, `0` `__pycache__`) and Windows drive-absolute `~/.gemini/config/skills.json`.
  2. Strip trailing whitespace (`git diff --check`) before committing or running `--strict --strict-scope full`, and serialize skill writes across commits.

---

### 16. Cargo Workspace Feature Unification & Delay-Load Cold Start (`6d15a40`)
- **Provenance**: Wave 2 `wave2-816626d-systems.json` (`15.856 MiB`, `26.47 ms`); Wave 3 commit `6d15a40` (`Cargo.toml`, `rust/omnia-{cli,agent,graph}/Cargo.toml`, `rust/omnia-cli/build.rs`).
- **What Went Wrong**: `cargo build --workspace --release` unifies features across all workspace crates, re-enabling optional heavy C/C++ `tree-sitter` parse tables (`~4.3 MB` in `.rdata`) onto `omnia.exe` even when `omnia-cli/Cargo.toml` sets `omnia-agent = { default-features = false }`, while eager PE imports (`winsqlite3`, `shell32`, `combase`, `user32`, `ws2_32`, `bcrypt`, `psapi`, `userenv`) pushed cold `omnia --version` past `26 ms`.
- **Permanent Rule**:
  - Gate `tree-sitter-c` / `tree-sitter-cpp` cleanly behind `cpp-c-ast` (default ON in `omnia-agent` & `omnia-graph`, OFF in `omnia-cli`), enable `lto = "fat"` + MSVC `/DELAYLOAD` (`delayimp.lib`) in `rust/omnia-cli/build.rs`, and **always run standalone `cargo build -p omnia-cli --release --offline --locked` AFTER `--workspace --release`** (`11.409 MiB < 14 MiB`, `8.18 ms < 15 ms` `--version` median, `0.06 ms` startup).

---

### 17. Windows ConPTY Key Release Duplicates, RSS Throttling & Custom Test Gates (`fc35fd0`, `816626d`)
- **Provenance**: Wave 2 TUI & checkpoint fixes (`fc35fd0`, `816626d`: `rust/omnia-cli/src/tui.rs`, `rust/omnia-agent/src/{engine,checkpoint}.rs`).
- **What Went Wrong**: Windows ConPTY fires `KeyEventKind::Release` events alongside `Press` (causing duplicate characters in TUI editors), per-frame RSS syscalls and unbatched resize events lagged PTY redraws, and custom `test_*.py`/`verify*.py`/`*.test.*` scripts exiting `0` were sometimes missed as passing verification evidence unless treated symmetrically with `cargo`/`pytest`.
- **Permanent Rule**:
  - Match only `KeyEventKind::Press | KeyEventKind::Repeat` in crossterm TUI loops, rate-limit RSS polling (`>= 2s` cooldown) and drain up to `256` queued events with `terminal.autoresize()`, and recognize standard + custom test scripts with `exit_code == 0` while still failing on `Traceback`/`AssertionError`.

---

### 18. Empty-SSE Watchdog Budget Reservation, Prefix-0 Retry Step-Down & `56 KB` PTC Exemption (`6d07620`, `2b89875`, `6d15a40`)
- **Provenance**: Wave 3 forensics (`D:\OmniaData\research\v5\10_WAVE3_EMPTY_SSE_WATCHDOG_AND_2026_COMPACTION_SYNTHESIS.md`) and commits `6d07620`, `2b89875`, `6d15a40` (`rust/omnia-agent/src/{engine,tools}.rs`).
- **What Went Wrong**: A single wedged `http=200, out=0` empty SSE stream could hold `61–158s` on Attempt 0 (exhausting the `297s` wall budget and diluting `kv_cache_hit_rate_ge2` with `cr=0` stalled retries), Anthropic `message_delta.usage` token fields were missed unless parsed via a shared helper, and premature RTK/6 KB truncation dropped symbol definitions on batch `read_file` PTC calls.
- **Permanent Rule**:
  - Cap Attempt-0 keepalive/attempt wait (`clamp(rem * 0.45..0.65)`) when retries remain (scoping tight-budget step-down acceleration to `total_run_budget >= 120s`), preserve Prefix-0 byte identity across retry effort step-down (`High -> Medium -> Low`), parse `message_delta.usage` uniformly (`apply_anthropic_usage_fields`), retain pre-tool `<512 B` keepalive continuity, and exempt `run_code` batch `read_file` outputs up to `56 KB` (`MAX_BATCH_READ_CHARS`) while truncating generic noisy outputs cleanly (`40%` head / `57%` tail).

---

### 19. Cleanroom Telemetry Parity: PID-Reuse Guard, Atomic Proxy Close & Standalone Harnesses (`a793bb7`, `a6d0a48`, `8e9b883`)
- **Provenance**: Wave 3 cleanroom trace audits (`D:\OmniaData\qa\v5-verify\audit_bench_traces.py`) & commits `a793bb7`, `a6d0a48`, `8e9b883`.
- **What Went Wrong**: Windows Toolhelp32 `th32ParentProcessID` PID reuse linked unrelated desktop apps (false `non_loopback_leak`), daemon threads waking after `proxy.stop()` appended out-of-window rows to `.wire.jsonl` (`summary=10 != jsonl=11`), `opencode` auto-attached to a host managed service port (`28894`) without `--standalone`, and `sys.executable` subprocess checks failed under system `python -B` without a `.venv` `site-packages` fallback.
- **Permanent Rule**:
  - Reject any Toolhelp32 child whose `GetProcessTimes` creation ticks precede its parent (`child_ct < min_ct`), close telemetry proxy recording atomically (`closed = true` under `self.lock`) before computing summaries, pass `--standalone` to daemonizing cleanroom harnesses (`opencode`), keep Studio-read scoreboards under `2 MiB`, and append `D:\omnia-bench\.venv` fallback `site-packages` safely in standalone CLI tests.

---

### 20. MSVC `/DELAYLOAD:ws2_32.dll` Dual-Casing Crash (`0xc0000005`) & `windows-sys 0.61` Dynamic FFI (`13699a8`)
- **Provenance**: Steer #17 commit `13699a8` (`rust/omnia-cli/build.rs`, `rust/omnia-workspace-ops/src/{net_diag.rs,hardware.rs}`).
- **What Went Wrong**: Delay-loading `ws2_32.dll` in Rust MSVC `build.rs` crashed `omnia.exe` with `STATUS_ACCESS_VIOLATION` (`0xc0000005`) inside `__delayLoadHelper2` on `std::net::TcpStream::connect_timeout` (`select`) because Rust `std::net` imports `WS2_32.dll` (uppercase) while `windows-sys`/`mio` import `ws2_32.dll` (lowercase), causing an IAT-offset underflow. Separately, `FreeLibrary` in `windows-sys 0.61` lives under `Win32::Foundation` (not `Win32::System::LibraryLoader`).
- **Permanent Rule**:
  - **Never** pass `/DELAYLOAD:ws2_32.dll` in Rust MSVC `build.rs` — keep `ws2_32.dll` eagerly linked and delay-load only clean single-cased subsystem DLLs (`winsqlite3`, `shell32`, `combase`, `user32`, `bcrypt`, `psapi`, `userenv`).
  - Use dynamic `LoadLibraryW` + `windows_sys::Win32::Foundation::FreeLibrary` + `std::net` for native diagnostics so zero new Cargo crates enter `Cargo.lock` and standalone `omnia.exe` stays `<= 14 MiB` (`11.693 MiB`).

---

### 21. Win32 `WS_CLIPCHILDREN` Ghost Bleed-Through, `embed-ui` Build Order & Provider-Sharded Parallel Benchmarks (`552438a`, `35d73ce`, `71932c1`)
- **Provenance**: Steer #16 + #17 commits `71932c1`, `35d73ce`, `552438a`, `13699a8` (`rust/omnia-native/src/{dpi,session_panel,studio_host}.rs`, `native/qa-smoke.ps1`, `rust/omnia-agent/src/engine.rs`, `ui-v5/src/components/workbenches/obs/VaultDiffExportPanel.tsx`).
- **What Went Wrong**: `OmniaNativeSessionPanel` registered `hbrBackground: null_mut()` without `WM_ERASEBKGND` inside a `WS_CLIPCHILDREN` parent (leaving ghost framebuffer pixels between child controls), `qa-smoke.ps1` lacked `UIAutomationClientsideProviders` (hiding `112` `ControlType.Document`), JSX placeholder text matching `Token <word>` tripped `bearer_token` in `audit.py --secret-scope all`, and silent post-first-byte `/v1/responses` streams hung `145–205s` on `swe_atlas_qna_aa` while healthy max-effort Anthropic turns legitimately think `140–170s` over `: ping` keepalives.
- **Permanent Rule**:
  - Always handle `WM_ERASEBKGND`/`WM_PAINT` card fills on custom Win32 child containers under `WS_CLIPCHILDREN`, register `UIAutomationClientsideProviders` in smoke QA asserting both `Edit` (`114`) and `Document` (`112`), build Vite `ui-v5` -> `D:\OmniaData\build\ui-dist` *before* `cargo build -p omnia-studio --release --features embed-ui`, avoid `Token <word>` JSX placeholders, shard parallel benchmarks by provider (`OpenAI`/`Anthropic`/`Gemini`) with jittered 429 backoff, and pair a `<=55s` post-first-byte wire-idle watchdog on `/v1/responses` with keepalive-preserving `180s` Attempt-0 headroom on max-effort `/v1/messages`.

---

### 22. Cold-Vault Catalog Schema Inspection & Recursive Packaging Globs (`1a1e423`, `01e226b`)
- **Provenance**: Steer #18–#21 commits `1a1e423` (`platform/targets.json`, `platform/validate_targets.py`), `f76b4a5` (modular `ui/`), and `01e226b` (`omni-bilingual-skill-router/scripts/skill_router.py`, `omnia-harness/src/skill_registry.rs`).
- **What Went Wrong**: Reading `focus`/`description` instead of `omni-deep-1000-catalog.json`'s actual `skills_catalog[]` fields (`focus_en`, `description_vi`, `artifacts`) plus `categories_100[]` dropped semantic body terms and misranked Vietnamese HTTP-range transfer queries onto unrelated skills. Separately, modularizing flat `ui/app/*.js` into `ui/app/{core,lib,views}/**/*.js` immediately broke `platform/targets.json` until updated to recursive `**/*.js` globs plus `omnia.exe`, `omnia_qa_seed.exe`, and `ui-v5/`.
- **Permanent Rule**:
  - Inspect exact external catalog schemas before building read-only Cold-Vault indexers (`0` in-repo synthetic stub folders) and verify routing with automated bilingual `golden-eval` (`16/16` `100% >= 95%`).
  - Whenever an asset/source folder reorganizes into nested directories, update `platform/targets.json` + `platform/validate_targets.py` in lockstep (`14/14` tests PASS, closing `TRK-06`).

---

### 23. Defensive PR #1 `AUD-01..32` Rust, SQLite, HTTP, PeerMesh & FTS Invariants (`01e226b`, `f76b4a5`)
- **Provenance**: Steer #21 semantic port of collaborator PR #1 (`origin/pr-1` = `04899e6`) into Full Native Rust (`01e226b`: `omnia-{core,winsqlite,storage,runtime,routing,graph,studio}`, `tools/agy-history-sync`) and modular fallback `ui/` (`f76b4a5`, `119/119` `node --test`).
- **What Went Wrong**: Across audit items `AUD-01..32`, subtle defensive holes appeared when converting inputs or mutating state: failed SQLite `COMMIT` left connections mid-transaction without `ROLLBACK`; unchecked JSON numeric coercion admitted floats/`1e100`/`u64::MAX` after mutating circuit state (`AUD-29`); loopback `Host`/`Origin` checks accepted arbitrary unrelated local ports (`AUD-02`); `PeerMeshGraph::normalize_repo_path` silently dropped `../` escapes instead of rejecting them and `reply()` skipped recipient/epoch validation (`AUD-26`/`AUD-28`); `simulate: true` mutated reservations unless fenced (`AUD-09`), and non-excluded FTS backfills leaked active conversations or left growing trajectories stale (`AUD-30`/`AUD-31`).
- **Permanent Rule**:
  - Execute explicit `ROLLBACK` when a SQLite `COMMIT` fails; validate checked JSON integers (`try_i64`/`try_u64`), pagination cursors/limits (`AUD-32`), and `simulate` zero-mutation fences *before* any state change; bind loopback `Host`/`Origin` authorities to the **actual bound listener port** (`AUD-02`, verified in `omnia-runtime`; tracked as `PARTIAL_IN_RUST` for `omnia-studio/src/http.rs` alternate-port tightening); reject `../`/absolute/mid-wildcard paths, overlap-on-reactivation, and non-recipient/stale-epoch replies in `PeerMeshGraph` (`AUD-26..28`); and pass `excluded_ids` + SHA-256 `omnia_fts_revisions` into transactional FTS refreshes (`AUD-30`/`AUD-31`, `7/7` tests PASS).
