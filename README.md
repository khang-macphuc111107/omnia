# Omnia

Windows-first native Rust AI workspace under active development (`https://github.com/khang-macphuc111107/omnia`).

## Repository navigation

Whether you are collaborator **HTMusTC** onboarding from a fresh clone or a coding agent resuming execution, start with these entrypoints:

- **Agent & contributor contract**: [`AGENTS.md`](AGENTS.md), workspace manifest [`.agents/skills.json`](.agents/skills.json), and the **12 curated workflow skills** under [`.agents/skills/`](.agents/skills/) (`additive-steer-queue`, `autonomous-power-continuity`, `codex-mcp-namespace-diagnostics`, `deep-clean`, `deep-general-graph-orchestration`, `deep-proposal`, `deep-steer`, `goal-plan-loop-dod`, `omni-bilingual-skill-router`, `omni-deterministic-verifiers`, `omnia-session-governance-handoff`, `vietnamese-typo-intent-inference`).
- **Collaborator handoff (`HTMusTC`)**: [`docs/handoff/`](docs/handoff/):
  - [`COLLABORATOR_HANDOFF.md`](docs/handoff/COLLABORATOR_HANDOFF.md) — executive architecture, crate/native map, build/QA workflow, and priority roadmap.
  - [`USER_PROMPT_REQUIREMENTS_MATRIX.md`](docs/handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md) — prompt-by-prompt traceability across 124 flagship Codex prompts + 8 Antigravity additive steers.
  - [`BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md) — 2-way `PeerMeshGraph` (`A <-> B` duplex mesh) and deterministic `Graphify` forward/reverse provenance specification.
  - [`LESSONS_LEARNED_AND_ANTIPATTERNS.md`](docs/handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md) — cross-host engineering lessons and pitfalls to avoid.
- **UI direction & anti-slop contract**: [`docs/ui-direction/DIRECTION_DECISION.md`](docs/ui-direction/DIRECTION_DECISION.md) — three-candidate style evaluation, weighted decision matrix, measurable WCAG 2.2 token seeds, and `PENDING_USER_REVIEW` brief (standalone interactive HTML/CSS/JS prototypes live externally under `D:\OmniaData\qa\ui-direction-20261112\`).
- **Native Windows shell (`omnia-native`)**: [`native/`](native/) ([`native/Cargo.toml`](native/Cargo.toml), [`native/README.md`](native/README.md)) — independent Rust/Win32 desktop executable, rich prompt composer & dual-mode inline/tray attachment model ([`native/src/composer.rs`](native/src/composer.rs)), server-side COM UIA provider & `WH_CBT` modal dialog hook ([`native/src/uia_edit.rs`](native/src/uia_edit.rs)), and externalized PowerShell QA scripts (`native/qa-*.ps1`).
- **Shared Rust domain crates**: [`src-tauri/crates/`](src-tauri/crates/) — workspace crates shared by `native/` without requiring a Tauri WebView runtime:
  - [`omnia-harness`](src-tauri/crates/omnia-harness) — orchestration, 2-way `PeerMeshGraph` & `GraphifyIndex` ([`agent_graph.rs`](src-tauri/crates/omnia-harness/src/agent_graph.rs)), bounded `1024`-skill loader ([`skills.rs`](src-tauri/crates/omnia-harness/src/skills.rs)), hierarchical + cyclic graph memory ([`memory.rs`](src-tauri/crates/omnia-harness/src/memory.rs)), and proactive EN/VN multi-query search/RAG ([`proactive_rag.rs`](src-tauri/crates/omnia-harness/src/proactive_rag.rs)).
  - [`omnia-provider-services`](src-tauri/crates/omnia-provider-services) — provider adapters, credential references, and deterministic dynamic quota/cost/latency/circuit-breaker routing ([`dynamic_router.rs`](src-tauri/crates/omnia-provider-services/src/dynamic_router.rs)).
  - [`omnia-session-store`](src-tauri/crates/omnia-session-store) — SQLite session storage, cooperative store locking, and keyset pagination.
  - [`omnia-browser`](src-tauri/crates/omnia-browser), [`omnia-computer`](src-tauri/crates/omnia-computer), and [`omnia-download`](src-tauri/crates/omnia-download) — browser, desktop/accessibility, and download primitives.
- **Maintained tools**: [`tools/agy-history-sync/`](tools/agy-history-sync/) ([`README.md`](tools/agy-history-sync/README.md)) — zero-dependency Python 3.15 bidirectional Antigravity 3-surface (`Agent App` / `IDE` / `CLI`) history synchronizer and unified FTS5 search indexer; [`tools/maintained-scripts/`](tools/maintained-scripts/) — committed release candidate exporter.
- **Compatibility projection**: [`src/`](src/), [`src-tauri/`](src-tauri/) ([`src-tauri/Cargo.toml`](src-tauri/Cargo.toml)), [`docs/storage-schema.sql`](docs/storage-schema.sql), and [`package.json`](package.json). Retained as a compatibility baseline while native Rust parity is verified; compatibility code does not establish native runtime completion.
- **Workspace governance, indexes & continuation state**: [`docs/workspace/`](docs/workspace/):
  - **Authoritative ledgers**: [`GOAL.md`](docs/workspace/GOAL.md), [`DOD.md`](docs/workspace/DOD.md), [`CHECKPOINT.md`](docs/workspace/CHECKPOINT.md), [`DECISIONS.md`](docs/workspace/DECISIONS.md), [`SESSION_ADMISSION.json`](docs/workspace/SESSION_ADMISSION.json), [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md), [`CLEANUP_STATUS_20261112.md`](docs/workspace/CLEANUP_STATUS_20261112.md).
  - **Navigable indexes**: [`STATUS.md`](docs/workspace/STATUS.md), [`PLAN.md`](docs/workspace/PLAN.md), [`TASKS.md`](docs/workspace/TASKS.md), [`PROMPTS.md`](docs/workspace/PROMPTS.md), [`SESSIONS.md`](docs/workspace/SESSIONS.md), [`SOURCES.md`](docs/workspace/SOURCES.md), [`REFS.md`](docs/workspace/REFS.md), [`STEER_QUEUE.md`](docs/workspace/STEER_QUEUE.md), [`TRANSFER_CONTRACT.md`](docs/workspace/TRANSFER_CONTRACT.md).
  - **Subsystem contracts & disposition maps**: [`COMPOSER_REQUIREMENTS.md`](docs/workspace/COMPOSER_REQUIREMENTS.md), [`DYNAMIC_ROUTING_REQUIREMENTS.md`](docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md), [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json), [`SOURCE_DISPOSITION_LEDGER.json`](docs/workspace/SOURCE_DISPOSITION_LEDGER.json), [`NEXT_SESSION_PROMPT.md`](docs/workspace/NEXT_SESSION_PROMPT.md).

## External build rules and native development

**Mandatory external build rule (`DOD-06`)**: Never write Cargo `target/` artifacts, SQLite test fixtures, logs, or QA screenshots inside the repository checkout. Always point `CARGO_TARGET_DIR` to a directory outside the repository root (`D:\OmniaData\tools\cargo-target` on the primary workstation, or a sibling folder such as `..\OmniaData\tools\cargo-target` on a fresh clone) and serialize Cargo builds on 16 GB RAM machines.

From the repository root on Windows with Rust and the MSVC C/C++ build tools:

```powershell
# Primary workstation target cache (or set to any external path outside your clone, e.g. ..\OmniaData\tools\cargo-target)
$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'

# 1. Verify formatting and locked manifest closure (native + shared/compatibility workspaces)
cargo fmt --manifest-path native/Cargo.toml --all --check
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo metadata --manifest-path native/Cargo.toml --locked --no-deps --format-version 1
cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1

# 2. Build and test native Windows package (29 tests)
cargo check --manifest-path native/Cargo.toml --all-targets --locked
cargo test --manifest-path native/Cargo.toml --locked
cargo build --manifest-path native/Cargo.toml --locked --release

# 3. Test shared Rust crates (run serially after native build finishes: 495 crate tests; 524 total with native)
cargo check --manifest-path src-tauri/Cargo.toml --workspace --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked -p omnia-provider-services -p omnia-harness -p omnia-session-store

# 4. Launch native executable from external target directory
& (Join-Path $env:CARGO_TARGET_DIR 'release/omnia-native.exe')
```

See [`native/README.md`](native/README.md) for `--session-db` usage, cooperative store locking, and current shell boundaries.

## Native QA scripts (`native/qa-*.ps1`)

All 7 native QA workflows (`90/90` cases verified `rc=0`) enforce external executable, external SQLite fixture, reparse-ancestor, and fresh non-overwriting output-directory guards via [`native/qa-paths.ps1`](native/qa-paths.ps1) and window/DPI verification via [`native/qa-capture.ps1`](native/qa-capture.ps1):

| Script | Scope | Typical inputs |
|---|---|---|
| [`native/qa-paths.tests.ps1`](native/qa-paths.tests.ps1) | 40-case external-path, reparse, and sidecar guard suite | Isolated temp fixtures (no app launch) |
| [`native/qa-capture.tests.ps1`](native/qa-capture.tests.ps1) | 14-case HWND/PID ownership, bounds, DPI-restore, and no-overwrite capture suite | External `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-smoke.ps1`](native/qa-smoke.ps1) | 4-case shell modes, UIA `Edit` composer discovery (`uiaIssue: null`), draft retention, capture, and process sample | Release `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-session.ps1`](native/qa-session.ps1) | 5-case session metadata CRUD, settings, Unicode persistence, and reopen via Windows UIA | Release `omnia-native.exe` (`-KeepOpen` optional) |
| [`native/qa-paging.ps1`](native/qa-paging.ps1) | 9-case 125-row keyset pagination and background worker checks | Release `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-guard.ps1`](native/qa-guard.ps1) | 12-case unsaved-form `#32770` modal discard/cancel (`WH_CBT` UIA invoke) and failed-selection guards | Debug `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-ownership.ps1`](native/qa-ownership.ps1) | 6-case competing process `HarnessStore` exclusion and successor reopen | Debug `omnia-native.exe` + new DB + `-OutputPrefix` |

Example external QA run from the repository root:

```powershell
$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'
$ReleaseExe = Join-Path $env:CARGO_TARGET_DIR 'release/omnia-native.exe'
$DebugExe   = Join-Path $env:CARGO_TARGET_DIR 'debug/omnia-native.exe'
$QaRoot     = 'D:\OmniaData\qa\native-run-01'

pwsh -NoProfile -File native/qa-paths.tests.ps1
pwsh -NoProfile -File native/qa-capture.tests.ps1 -Executable $DebugExe -OutputDirectory "$QaRoot\capture-tests"
pwsh -NoProfile -File native/qa-smoke.ps1 -Executable $ReleaseExe -OutputDirectory "$QaRoot\smoke"
pwsh -NoProfile -File native/qa-session.ps1 -Executable $ReleaseExe -OutputDirectory "$QaRoot\session"

# Seed fresh external fixtures before running paging and guard QA
cargo run --manifest-path native/Cargo.toml --locked --example qa_seed -- "$QaRoot\paging-fixture"
pwsh -NoProfile -File native/qa-paging.ps1 -Executable $ReleaseExe -Database "$QaRoot\paging-fixture\sessions.sqlite3" -OutputDirectory "$QaRoot\paging"

cargo run --manifest-path native/Cargo.toml --locked --example qa_seed -- "$QaRoot\guard-fixture"
pwsh -NoProfile -File native/qa-guard.ps1 -Executable $DebugExe -Database "$QaRoot\guard-fixture\sessions.sqlite3" -OutputDirectory "$QaRoot\guard"

pwsh -NoProfile -File native/qa-ownership.ps1 -Executable $DebugExe -Database "$QaRoot\ownership-fixture\sessions.sqlite3" -OutputPrefix "$QaRoot\ownership\run"
```

## Delivery status and boundaries

- **Tracked root source**: `native/`, shared crates under `src-tauri/crates/`, `12` curated skills in `.agents/skills/`, `tools/`, `docs/handoff/`, `docs/ui-direction/`, and `docs/workspace/` live directly at the repository root alongside the retained compatibility projection.
- **Externalized non-product state**: Research archives, the structured `100`-category / `1,001`-skill catalog (`omni-deep-1000-catalog.json`), quarantined build caches (`+10.125 GiB` reclaimed), relocated historical worktrees (`D:\OmniaData\repos\omnia`, `D:\OmniaData\worktrees\publish-worktree`), QA outputs, and recovery snapshots live outside the product tree under `D:\OmniaData` (mapped in [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json) and reconciled in [`SOURCE_DISPOSITION_LEDGER.json`](docs/workspace/SOURCE_DISPOSITION_LEDGER.json)).
- **Privacy & publication (`DELIVERY-01` / `DOD-15`)**: Private chat transcripts, credentials, API keys, cookies, and browser profiles stay strictly outside published Git. Shared handoff documents in [`docs/handoff/`](docs/handoff/) passed automated zero-secret redaction scans (`leak_count=0`) for publication to `https://github.com/khang-macphuc111107/omnia` (see [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md)).
- **Honest verification scope**: Unit/integration tests (`524/524`), locked metadata checks, 3 interactive UI candidates (`PENDING_USER_REVIEW`), and `7/7` native Win32 QA workflows (`90/90` cases `rc=0`) prove their stated scope; live third-party provider streaming, full WebView-free Browser/IDE parity, packaged installer resource benchmarks, and 3-round frozen-snapshot whole-goal clean audits remain governed by [`DOD.md`](docs/workspace/DOD.md) and [`TRANSFER_CONTRACT.md`](docs/workspace/TRANSFER_CONTRACT.md).

## Export a committed source candidate

After reviewing and committing intended changes:

```powershell
node tools/maintained-scripts/stage-public-release.mjs
node --test tools/maintained-scripts/stage-public-release.test.mjs
```

The export reads `HEAD` (excluding uncommitted working-tree edits) and writes a clean candidate directory plus an adjacent receipt under `D:\OmniaData\exports` (configurable via `OMNIA_SOURCE_ROOT`, `OMNIA_EXPORT_REVISION`, `OMNIA_DATA_ROOT`, and `OMNIA_EXPORT_DESTINATION`). Review privacy, licenses, and clean-clone build results before pushing.
