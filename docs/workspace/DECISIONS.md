# Workspace decisions

## 2026-11-11 — Root Git boundary

- Historical decision: initialize Git at `D:\Omnia` as a workspace control-plane repository.
- Rationale: provide one clean, auditable place for topology, ownership and receipts without flattening independent product/research repos or deleting their history.
- Consequence: child repos remain independently testable and may remain dirty; root status is intentionally scoped to governance files.
- Revisit when a complete source-preserving flattened snapshot and restore test exists.

### Supersession — actual product root

The user's later requirement supersedes the governance-only end state.
`D:\Omnia` now tracks native and retained compatibility source directly.
The older checkouts remain recovery/reconciliation owners, not the root
entrypoint. Reconciliation and restore gates remain mandatory before retiring
their metadata. Bulk nonproduct material is moved outside the product tree.

## 2026-11-11 — Native source admission

- Decision: admit the rebuild checkout's `native/` and its shared crate
  dependency closure directly under `D:\Omnia`, excluding `.git`, `target`,
  `node_modules`, caches and reparse points.
- Rationale: the user requires actual product source at the root; promoting
  only `repos\omnia` would omit the newer native Rust lane and provider/session
  services.
- Evidence: external `handoff-intake/NATIVE_ADMISSION.json`; 197 files and
  2,588,993 bytes verified by SHA-256 before and after copy.
- Limits: this is not a semantic merge of divergent checkouts, and it gives
  no credit for final UI, provider delivery, packaging, performance or
  feature parity. Existing dirty sources remain preserved until disposition.

## 2026-11-11 — D: cleanup boundary

- Decision: inventory D: and classify ownership before reclaiming space.
- Rationale: same-volume moves do not free space and broad deletion could
  destroy unrelated projects, recovery data or active work.
- Rule: only regenerate/delete a candidate after owner, reproducibility,
  retention and containment are recorded; otherwise quarantine or retain it.

## 2026-11-11 — Queued additive steer

- Decision: finish an interrupted deliverable before consuming new additive
  prompts. The user explicitly uses steer as quick queue intake.
- Corrections affecting current work apply at a safe boundary; explicit
  stop/cancel/replacement supersedes the named work.
- Evidence: current chat correction and GOAL revision 2, commit `3058494`.
- Scope: planning/continuation behavior; a file-backed queue is not a durable
  runtime scheduling receipt.

## 2026-11-11 — External data and generated cache

- Decision: retain classified archive/research/quarantine/legacy tooling under
  `D:\OmniaData`, outside the product checkout. Record exact old/current
  mappings in `EXTERNAL_LAYOUT.json`; retain private detailed manifests.
- Method: same-volume `Move-Item` with destination collision checks, full
  relative-path/type/size/mtime comparisons, nonzero directory identities and
  selected anchor hashes. Before-file identity fields were zero; no per-file
  NTFS identity proof is carried. The separate correction receipt preserves
  that limitation. This is not a full content hash sweep or a backup restore drill.
- Generated output: after validating Cargo cache markers, zero tracked files,
  reparse boundaries and no observed Cargo/Rust/Omnia process, use `cargo clean`
  on the old native integration target.
- Limits: moving data earns no reclaimed-capacity credit. Cargo's reported
  logical bytes and measured drive free-space delta are separate.

## 2026-11-11 — Preserve bytes and Git state as separate restore claims

- Decision: keep raw common/linked Git metadata and source bytes; qualify
  restored status under recorded source semantics and separately retain content
  reevaluation. Do not normalize source/index to make a restore appear clean.
- Evidence: CHECKPOINT's r10 preservation section routes to the private base
  snapshot, trailing-space supplement, 20-comparison R2 receipt and correction.
- Correction: all three linked indexes were already captured. Source-side
  sparse-checkout reapply was accidentally invoked by one diagnostic; the
  recorded postconditions do not justify calling the continuation read-only.
- Primary regular bytes and the trailing-space supplement now have isolated
  size/SHA-256 readback; reuse the existing restore rather than making another
  full copy. CHECKPOINT owns the exact materialization receipt and denominator.
- Limits: inherited EOL/stat-cache differences remain findings. Primary Git-state
  comparison and excluded-owner/consumer preservation are pending; retirement
  remains false.

## 2026-11-11 — Atomic UI direction and routing contracts

- Decision: add one focused `deep-ui-direction` skill under
  `C:\Users\khang\.codex\skills` and route its outputs through the existing
  quantitative UI, technical design and behavioral QA skills.
- Rationale: the user's “good taste / anti-AI-slop / preview first” request is a
  distinct decision workflow, while token selection, measurement and functional
  QA already have owning skills. Synonym-only deep skills would make routing
  noisier and increase false confidence.
- Evidence: the skill passed
  `C:\\Users\\khang\\\.codex\\skills\\\.system\\skill-creator\\scripts\\quick_validate\.py`.
  A bounded external receipt outside the product tree records 10 GitHub queries,
  68 unique repository identities, 8 official pages and 11 selected README
  retrievals. The receipt is discovery/content-extract evidence, not exhaustive
  source review or runtime proof; social/video links remain unreviewed.
- Decision: add `DYNAMIC_ROUTING_REQUIREMENTS.md` as the product specification
  for quota/cost/latency/model/provider routing before implementation. Reuse
  existing provider/profile/token/cost/run-journal foundations only after a
  schema and ownership review; do not create duplicate ledgers by assumption.
- Limits: neither contract has Omnia runtime, preview, user-review, provider
  delivery or performance credit yet. Research, implementation, loading and
  invocation remain separate states.


## 2026-11-11 — Bounded UI-style research receipt

- Evidence: external receipt C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json records 10 GitHub queries, 68 unique repository identities, 8 official pages fetched and 11 selected README retrievals. A content-extract receipt records the actual inspected text ranges and access limitations.
- Admission: retain only general workflow lessons—explicit reference provenance, layered tokens, accessible primitives, state coverage, preview before implementation and separate visual/behavioral gates. Do not vendor repository code, assets, fonts or copied visual identity.
- Limits: GitHub search results are discovery evidence; selected README inspection is high-level and official pages are not exhaustive. Social/video sources and named terms remain unreviewed. No Omnia runtime, UI preview, user approval or performance credit is earned.

## 2026-11-12 — Four-keyword research and reversible Cargo quarantine

- Decision: preserve the four exact GitHub searches as external discovery
  evidence, then inspect only a bounded, explicitly selected top-five subset
  per keyword. Do not imply that 400 search rows or 324 deduplicated
  repositories were fully read.
- Evidence: `github-four-keywords.json` and
  `github-four-keywords-unique.json` record 100 results for each of `agent`,
  `memory`, `code` and `open`, sorted by stars descending. The bounded ledger
  records README hashes, license endpoint results and tree metadata for 16
  unique repositories.
- Admission rule: no external source code, assets, credentials, private
  transcripts, issue/comment bodies or runtime behavior are admitted from this
  research batch. Any later reuse requires a separate license, privacy,
  security, compatibility and implementation review.
- Decision: externalize three generated Cargo target caches from the dirty
  child repository to `D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets`
  by exact path after a receipt proved containment, ignore state, zero tracked
  files, zero status entries, ordinary directories and no observed Cargo/rustc
  process.
- Limits: the move is reversible and same-volume. File counts and logical
  bytes read back exactly, but free-space delta is zero and no deletion or
  reclamation credit is earned. Child status remains dirty and missing
  directory warnings remain. Future cleanup must be candidate-by-candidate.

## 2026-11-12 — Pytest cache quarantine

- Decision: move the two small pytest cache directories out of the child source
  tree after path-specific checks. The status-visible `.pytest-cache` marker is
  retained in external quarantine rather than silently discarded.
- Evidence: `cleanup-receipt-pytest-cache-move.json` records one five-byte file
  and four standard pytest cache files, zero tracked files, exact containment,
  ordinary-directory checks and zero same-volume free-space delta.
- Limits: producer provenance for the marker is not proven; no deletion or
  disk-reclamation credit is claimed. The child repository remains dirty and
  all larger or mixed-ownership candidates remain preserved.

## 2026-11-12 — Graphify bounded admission and Vite output quarantine

- Decision: record Graphify as `RESEARCH_ONLY`. Public API metadata, README,
  license and six selected canonical files support reusable design hypotheses,
  not source or runtime admission. The candidate lessons are deterministic
  indexing, explicit edge provenance, bounded query settings, graph-first
  navigation and opt-in query logging.
- Evidence: external files under
  `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\supplement-20261112\graphify`.
  The recursive tree had 1,306 entries and was not truncated, but only six
  files were opened. Issues, comments, media and runtime were not reviewed.
- Decision: externalize `dist` from the child repository after proving it is
  generated Vite output, ignored, untracked, non-reparse, status-free and not
  referenced by a running process at the final check.
- Evidence: pre/move receipts bind 140 files and 6,924,863 logical bytes;
  readback matches and the exact reverse move is recorded.
- Limit: quarantine is on D:, so free-space delta is zero. No deletion,
  recycle-bin purge or capacity credit is implied. All mixed-ownership and
  potentially active candidates remain retained.


## 2026-11-12 — Node dependency quarantine

- Decision: move `node_modules` out of the child source tree as a reversible
  generated-output unit. It was ignored, untracked, non-reparse, status-free and
  not referenced by a running process at the final gate.
- Evidence: pre/move receipts record 12,111 files and 194,672,966 logical bytes;
  readback matches. `package-lock.json` hash and `npm ci` regeneration route are
  recorded. The exact reverse move is the restore path.
- Limit: same-volume move changed free space by 0 bytes. No deletion or
  capacity credit is claimed. Keep source, lockfile and quarantine provenance;
  do not delete the quarantine until a restore/build check qualifies it.

## 2026-11-12 — OpenHands uv cache quarantine

- Decision: move `D:\Omnia\repos\omnia\.toolchains\openhands-uv-cache` out of the child source tree as one reversible generated-cache unit.
- Evidence: the pre-move receipt records 85,557 entries, 71,261 files and 2,083,312,334 logical bytes; the directory was ignored, untracked, status-free, ordinary, non-reparse and not referenced by an active process at the final gate. The move receipt confirms matching readback, source absence and the exact reverse move command.
- Producer and recovery: uv/OpenHands package-cache markers and the supported uv regeneration route remain documented; no lockfile, source, nested repository, profile or worktree was changed.
- Limit: quarantine is on D:, so the free-space delta is 0 bytes. No deletion, recycle-bin purge or capacity credit is implied. Retain the quarantine until a controlled restore/build check and retention decision are complete.

## Root scratch quarantine — 2026-11-12

Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.

## 2026-11-12 — Source focus reconciliation, worktree relocation and D: cache reclamation

- Decision: classify all `138` differing focus rows in `SOURCE_DISPOSITION_LEDGER.json` (`127` `incorporated`, `8` `superseded-with-evidence`, `3` `retained-recovery`, `0` `unreviewed`) while preserving `57` unique source files and `27` patches (`84/84` SHA-256 verified) under `D:\OmniaData\recovery\unique-source-deltas-20261112\`.
- Decision: externalize `12` non-product clutter directories from `D:\Omnia` to `D:\OmniaData\externalized-20261112\` (`187,694` files, `0` capacity credit), relocate `publish-worktree` and `repos\omnia` to `D:\OmniaData\{worktrees,repos}\` with `git worktree repair` across all `4` checkouts, and reclaim only the `4` proven regenerable quarantined build caches (`cargo-targets`, `openhands-uv-cache`, `node_modules`, `dist` -> **`+10.125 GiB`** net free space on `D:\`, keeping `.pytest-cache` and `root-scratch-*` preserved).
- Limit: keep `retirementEligible=false` for excluded primary boundaries (`~20,198` unnormalized internal junctions under `upstream_extractions/`) and document `D:\Omnia\Roaming` honestly as an orphaned-SID ACL boundary (`WinError 5`, ignored in `.gitignore` pending an elevated UAC move).

## 2026-11-12 — Curated 12-skill repo parity vs external 1,001-skill catalog and Windows Antigravity mount

- Decision: track `12` validated, byte-identical pure `LF` skills under `.agents/skills/` (`!.agents/skills/**` + `!.agents/skills.json`, including `deep-proposal`, `deep-general-graph-orchestration`, `omni-bilingual-skill-router`, `omni-deterministic-verifiers`, `omnia-session-governance-handoff`, `vietnamese-typo-intent-inference`) while storing the extracted `100`-category / `1,001`-skill *Khởi động và Quy trình Omnia* blueprint externally in `D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json`.
- Rationale: preserves complete specification fidelity without polluting the product repository or agent context budget with 1,000 synthetic stub folders.
- Windows runtime fix: use drive-absolute forward-slash paths (`C:/...`, `D:/...`) in machine-local `~/.gemini/config/skills.json` because Go `filepath.IsAbs` rejects `~/` when `$env:HOME` is unset on Windows, while keeping repo `.agents/skills.json` portable (`{"entries": [{"path": ".agents/skills"}]}`).

## 2026-11-12 — Bidirectional PeerMeshGraph, Graphify provenance, server-side Win32 UIA and AGY 3-surface sync

- Decision: model multi-agent coordination in `omnia-harness/src/agent_graph.rs` as a 2-way all-to-all `PeerMeshGraph` (`A <-> B` duplex links, `disjoint_paths` single-writer guard, `max_hops`/`epoch` cycle bounds) paired with `GraphifyIndex` (`Forward`/`Reverse`/`Both` traversal with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` provenance).
- Decision: implement server-side COM `IRawElementProviderSimple` (`IValueProvider` + `IInvokeProvider`) and a thread-scoped `WH_CBT` (`HCBT_ACTIVATE`) `#32770` modal hook in `native/src/uia_edit.rs` so Windows UI Automation discovers `ControlType.Edit` and invokes modal confirmation buttons reliably even when the window is non-foreground (`7/7` native QA workflows, `90/90` cases `rc=0`).
- Decision: maintain `tools/agy-history-sync/` in-repo (`0` external dependencies, `Path.home()` portable) to reconcile Antigravity Desktop/IDE (`~/.gemini/antigravity`) and CLI (`~/.gemini/antigravity-cli`) SQLite/protobuf stores (`0` ghost summaries, active growing-tail sessions excluded) and build a unified FTS5 search index.
- Decision: split workspace navigation into concise single-purpose index files (`PLAN.md`, `TASKS.md`, `PROMPTS.md`, `SESSIONS.md`, `SOURCES.md`, `REFS.md`, `STEER_QUEUE.md`, `TRANSFER_CONTRACT.md`) routing to one authoritative owner per fact, and updated local Git identity to `khang-macphuc111107 <khang.macphuc111107@gmail.com>` targeting `https://github.com/khang-macphuc111107/omnia`.

## 2026-11-12 — Wave 4 ADR: Full Native C++20 migration, Flagship Studio UI ("Obsidian Kinetic Atelier"), 13-skill parity and exhaustive C:/D: reclamation (+944.29 GiB)

- **Decision 1 (Explicit User Architectural Replacement — Rust/Tauri -> Modern Native C++20)**:
  - Per explicit Wave 4 user mandate, supersede the entire Rust/Tauri and legacy web compatibility tree (`src-tauri/`, `src/`, `scripts/`, `tests/`, `design/`, `package*.json`, `vite.config.ts`, `tsconfig*.json`, `1,937` tracked files / `32,782,598 B`) with a **100% Modern C++20 (`MSVC 19.51.36260` + `CMake 4.3.1` + `Ninja 1.13.2` + Windows 11 SDK `10.0.26100.0`)** product implementation (`0` `.rs` files, `0` `Cargo.*` files, `0` external C++ package downloads, compiled cleanly under `/std:c++20 /utf-8 /EHsc /W4 /WX /Zc:__cplusplus /permissive-`).
  - **Lossless preservation**: Before removing a single legacy file, the `3/3`-audited pre-C++20 Rust baseline (`524/524` Cargo tests, `round-{1,2,3}-v2-receipt.json` `errors=0, warnings=0`) was archived and pushed on immutable Git tag `archive/pre-cpp-rust-snapshot-20261112` (`c3033728abe6f0a4906a796bf7652c84408356d7`), and the `2` formerly git-ignored research helper scripts were preserved with SHA-256 readback in `D:\OmniaData\recovery\pre-cpp-ignored-files-20261112\MANIFEST.json` (`sha256=0da021493635b1861e0fa21106abaf285dd175cc5080027f7677446b79a53709`).
  - **C++20 architecture**:
    - `cpp/` (`37` root/core files, `10,287` LOC): `omnia_core` (RFC 8259 JSON, CNG `bcrypt` SHA-256, UTF-8/16 + Vietnamese typo/shorthand normalization, secret redactor), `omnia_storage` (`winsqlite3` WAL + cooperative process leases + keyset pagination), `omnia_routing` (`DynamicProviderRouter` covering all 10 routing scenarios), `omnia_graph` (`PeerMeshGraph` 2-way `A <-> B` duplex mesh + `GraphifyIndex` `Forward`/`Reverse`/`Both`), `omnia_harness` (`MemoryGraph`, EN/VN `ProactiveRag`, `1024`-char `SkillRegistry`, 15-template `ComposerModel`, additive `SteerQueue`), and `omnia-studio.exe` (`687,616 B` Release `fb787243...`, `9.30 MiB` live working set, `12` `/api/*` endpoints with `403` `Origin`/`Host`/path-traversal guards; `6/6` CTest suites PASS).
    - `native/` (`30` files): `omnia-native.exe` (`289,792 B` Release `41030923...`, Win32 + DWM Dark/Mica + Direct2D + server-side COM UIA `IRawElementProviderSimple`/`IValueProvider`/`IInvokeProvider` + thread-scoped `WH_CBT` `#32770` modal button subclassing), `omnia_qa_seed.exe` (`142,336 B`), and `omnia_native_tests.exe` (`29/29` CTest cases PASS; unified root `ctest` `35/35` PASS; `7/7` PowerShell Win32 QA workflows `90/90` cases `rc=0` in `QA_SUITE_SUMMARY_RECEIPT.json` `sha256=6f668cb0...`).
- **Decision 2 (Flagship Studio UI — "Obsidian Kinetic Atelier")**:
  - Synthesize the strongest architectural qualities of Candidates A/B/C in `docs/ui-direction/DIRECTION_DECISION.md` into a zero-bundler ES2022/CSS/SVG Flagship Studio frontend under `ui/` (`13` files, `8/8` `node --check` `rc=0`) and `docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md` (`sha256=db381ed0...`), served directly by `omnia-studio.exe` (`127.0.0.1:8787`) across 3 WCAG 2.2-verified themes (`Obsidian Atelier`, `Alabaster Editorial`, `Midnight Blueprint`; `87/87` contrast checks `>= 5.12:1`, `45/45` headless Edge CDP states `maxOverflowX = 0 px`, `0` external CDNs).
- **Decision 3 (13-Skill 4-Way Parity — `deep-cpp-native`)**:
  - Author `deep-cpp-native` (`SKILL.md` `sha256=b87fd5ca...`) and update `omni-bilingual-skill-router` (`SKILL.md` `sha256=e65f88d0...`, `skill_router.py` `sha256=d415454e...` adding `omnia-cpp20-flagship-studio`), synchronizing all **13** curated skills (`29` files/root) byte-identically across `D:\Omnia\.agents\skills`, `~/.codex/skills`, `~/.agents/skills`, and `~/.gemini/config/skills.json` (`39/39` `quick_validate.py` `rc=0`, `274` unique live skills; `cpp-skill-sync-receipt.json` `sha256=27df8cf8...`).
- **Decision 4 (Exhaustive Evidence-Backed `D:\` + `C:\` Deep-Clean Reclamation — `+944.29 GiB` Physical)**:
  - Reclaim proven disposable duplicate update snapshots, abandoned staging folders, orphaned Rust/Node/ASAR caches, crash dumps, and package/temp caches across both volumes with `FILE_ATTRIBUTE_REPARSE_POINT` (`0x400`) non-traversal guards and zero impact on credentials, chat histories, recovery snapshots, or Git worktrees:
    - **`D:\` volume**: `59.4168 GiB -> 837.5680 GiB` free (**`+778.1512 GiB` physical / `799.1901 GiB` logical** across `3,344,757` files; `DEEP_CLEAN_AUDIT_D_DRIVE.md` `sha256=a51f017a...`, `D_DRIVE_DEEP_CLEAN_RECEIPT.json` `sha256=70f2781d...`).
    - **`C:\` volume**: `23.4682 GiB -> 189.6039 GiB` free (**`+166.1357 GiB` physical / `183.6900 GiB` logical** across `1,371,966` files; `DEEP_CLEAN_AUDIT_C_DRIVE.md` `sha256=1a88e1fe...`, `C_DRIVE_DEEP_CLEAN_RECEIPT.json` `sha256=ee08c5a0...`).
  - **Zero-bloat clean-clone policy**: Immediately delete temporary clean-clone checkouts and temporary build trees after writing SHA-256 verification receipts (`GITHUB_CPP20_DELIVERY_RECEIPT.json`) so QA never accumulates multi-gigabyte clone duplicates.
