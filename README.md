# Omnia

[![CI](https://github.com/khang-macphuc111107/omnia/actions/workflows/ci.yml/badge.svg)](https://github.com/khang-macphuc111107/omnia/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/khang-macphuc111107/omnia?display_name=tag)](https://github.com/khang-macphuc111107/omnia/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust 18-Crate Workspace](https://img.shields.io/badge/Rust-18%20Crates%20%7C%20Edition%202021-orange.svg)](Cargo.toml)
[![Suite v5 Benchmark](https://img.shields.io/badge/Suite%20v5-%231%2090.79%25%20(69%2F76)-brightgreen.svg)](docs/wiki/Benchmarks-v5-Scoreboard.md)

Windows-first **Full Native Rust Agentic Studio, SOTA Autonomous Harness (Default `YOLO / Turbo / Full-Access / Auto-Approve`), 6-App Flagship Web Workbench (`AI Studio Arena` + `Live Canvas` + `Perplexity Pro` + `NotebookLM++`), Pure-Rust Computer Use (`omnia-computer`), `ratatui` TUI & Win32 Mica Desktop Shell** (`v5.1.0`, `https://github.com/khang-macphuc111107/omnia`).

> **Quick Links:** [Wiki (`docs/wiki/`)](docs/wiki/Home.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releases](https://github.com/khang-macphuc111107/omnia/releases) · [Discussions](https://github.com/khang-macphuc111107/omnia/discussions) · [Issues](https://github.com/khang-macphuc111107/omnia/issues)

Under **Steer #14 -> Steer #25 (`v5.1.0`, `omnia-sota-harness`)**, Omnia runs as a **Full Native Rust 18-crate Cargo workspace** (`edition = "2021"`, `winsqlite3` FFI with `#[cfg(not(windows))]` POSIX `libsqlite3` foundation, `windows-sys` / `windows`, zero in-tree `.cpp`/`.hpp`/`CMake*` source files) paired with the **Flagship Studio UI** ("Obsidian Kinetic Atelier" under `ui/` and SolidJS/Tailwind `ui-v5/` embedded via `embed-ui`), **PowerShell 7** (`pwsh`) Win32 UIA/capture QA, and **Windows-native benchmark & Gemini share tooling** (`tools/omnia-benchmark/`, `tools/omnia-gemini-extractor/`). The superseded Wave 4 C++20 snapshot is backed up externally under `D:\OmniaData\backups\pre-full-rust-20261115\` (`55` files), and the earlier pre-C++20 Rust/Tauri workspace (`524/524` tests, `3/3` clean audit rounds) remains losslessly preserved on Git tag `archive/pre-cpp-rust-snapshot-20261112` (`c3033728abe6f0a4906a796bf7652c84408356d7`). Follow-up session admission ([`SESSION_ADMISSION.json`](docs/workspace/SESSION_ADMISSION.json)) remains `DEFERRED` until live Win32 QA completion, the final frozen commit, and 3 consecutive frozen-snapshot cleanroom audit rounds pass.

## Repository navigation

Whether you are collaborator **HTMusTC** onboarding from a fresh clone or a coding agent resuming execution, start with these entrypoints:

- **Agent & contributor contract**: [`AGENTS.md`](AGENTS.md), workspace skill manifest [`.agents/skills.json`](.agents/skills.json), line-ending enforcement [`.gitattributes`](.gitattributes), and all **`22` repository skills** under [`.agents/skills/`](.agents/skills/) (**16 curated workflow skills** — `additive-steer-queue`, `autonomous-power-continuity`, `codex-mcp-namespace-diagnostics`, `deep-clean`, `deep-cpp-native` [preserved for general/historical C++ diagnostics], `deep-general-graph-orchestration`, `deep-proposal`, `deep-research`, `deep-steer`, `deep-think`, `goal-plan-loop-dod`, `omni-bilingual-skill-router`, `omni-deterministic-verifiers`, `omnia-session-governance-handoff`, `super-plan-run-lifecycle`, `vietnamese-typo-intent-inference` — plus **6 source-pinned K-Dense research projections** `kdense-*` with `admission=research_projection_only`).
- **Collaborator handoff (`HTMusTC`)**: [`docs/handoff/`](docs/handoff/):
  - [`COLLABORATOR_HANDOFF.md`](docs/handoff/COLLABORATOR_HANDOFF.md) — executive Full Native Rust architecture, 17-crate target map, out-of-source Cargo/QA workflow, and Steer #15 v5 roadmap.
  - [`USER_PROMPT_REQUIREMENTS_MATRIX.md`](docs/handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md) — prompt-by-prompt traceability across 124 flagship Codex prompts + Antigravity additive steers (`Steer #1`..`Steer #25`).
  - [`BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md) — 2-way `PeerMeshGraph` (`A <-> B` duplex mesh) and deterministic `GraphifyIndex` forward/reverse provenance specification.
  - [`LESSONS_LEARNED_AND_ANTIPATTERNS.md`](docs/handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md) — cross-host engineering lessons, Cargo out-of-source/AdGuard/Win32 UIA/zero-secret invariants, and pitfalls to avoid.
- **Full Native Rust 18-crate workspace**: [`Cargo.toml`](Cargo.toml), [`Cargo.lock`](Cargo.lock), and [`rust/`](rust/):
  - `omnia-winsqlite` ([`rust/omnia-winsqlite/`](rust/omnia-winsqlite/)) — `winsqlite3` FFI wrapper (`#[cfg(windows)]`), POSIX `libsqlite3` foundation (`#[cfg(not(windows))]`), WAL configuration, and cooperative OS `LockFileEx` process-lease locking.
  - `omnia-core` ([`rust/omnia-core/`](rust/omnia-core/)) — RFC 8259 JSON parser/serializer, SHA-256/UUIDv4/Base64 helpers, UTF-8/UTF-16 + Vietnamese shorthand/typo normalization, and secret redactor.
  - `omnia-storage` ([`rust/omnia-storage/`](rust/omnia-storage/)) — `winsqlite3` WAL `SessionStore`, native `HarnessStore`/`Sessions`/`SessionWorker` persistence (`PRAGMA trusted_schema = OFF`, `secure_delete = ON`), bounded keyset pagination, and HMAC-SHA256 graph cursors (`graph_cursor.rs`; reference schema in [`docs/storage-schema.sql`](docs/storage-schema.sql)).
  - `omnia-routing` ([`rust/omnia-routing/`](rust/omnia-routing/)) — deterministic capability, quota, cost, latency, 4-tier `softFail`, nested `ComboRegistry`, monotonic Anthropic cache TTL validator, 3-way dispatch safety, and circuit-breaker `DynamicProviderRouter` (`token_budget = NULL` default) with zero-sleep `ProviderFaultHarness` and secret-free receipts.
  - `omnia-graph` ([`rust/omnia-graph/`](rust/omnia-graph/)) — 2-way all-to-all `PeerMeshGraph` (`A <-> B` duplex links, `disjoint_paths` single-writer guard, `max_hops`/`epoch` cycle fencing) and deterministic `GraphifyIndex` (`Forward` / `Reverse` / `Both` with `EXTRACTED` / `INFERRED` / `AMBIGUOUS` provenance).
  - `omnia-harness` ([`rust/omnia-harness/`](rust/omnia-harness/)) — hierarchical + cyclic `MemoryGraph` (`Working`/`Durable` tiers + `ErasureReceipt`), bilingual EN/VN `ProactiveRag`, `ResearchVault` w/ W3C `#:~:text=` 4-layer citation verifier, `DeepThink` w/ `FormalProofAudit`, pure-Rust Model2Vec seek router (`m2v_router.rs` + `GapRadar`), bounded `SkillRegistry` (22 active + 1,001 Cold Vault), `ArtifactOS` (2-tier `sync_global_lessons`), 15-template `ComposerModel` / `RichComposer`, and additive `SteerQueue` (`token_budget = NULL`).
  - `omnia-connector-gateway` ([`rust/omnia-connector-gateway/`](rust/omnia-connector-gateway/)) — AdGuard-tolerant loopback HTTP parser, RFC 9110 §5.3 multi-`Cookie` coalescing, 4-state `ProxyHealthState`, `codex_patched`, `opencode_compat`, `gemini_share`, and `artifact_intake` bridges.
  - `omnia-workspace-ops` ([`rust/omnia-workspace-ops/`](rust/omnia-workspace-ops/)) — canonical path/reparse/DOS-device containment (`path_guard`), safe UTF-8 LF atomic file operations with external rollback (`fs_ops`), hardware profiler (`hardware`), `net_diag` (Speedtest/Bufferbloat + RFC 5389 STUN + RFC 1035 NXDOMAIN), shell compactor (`shell_compactor`), and bounded subprocess control (`process_ops`).
  - `omnia-media-capture` ([`rust/omnia-media-capture/`](rust/omnia-media-capture/)) — zero-race CDP WebSocket engine (`browser_ws.rs`, `browser_batch`), WeakMap `[ref=eN]` ARIA/Shadow-DOM/iframe snapshots, `NetworkRing` (`2000` entries), GIF89a + Playwright codegen (`browser_record.rs`), desktop isolation, OBS v5 framing, and DPI-clamped window capture contracts (`DEFAULT_MAX_CAPTURE_DIMENSION = 8192`).
  - `omnia-computer` ([`rust/omnia-computer/`](rust/omnia-computer/)) — pure-Rust Windows computer-use crate: dedicated MTA COM + Per-Monitor-V2 DPI worker, 17-property cached UIA tree (`[ref=wNeM]`), non-intrusive background control (`PrintWindow` / `ChildWindowFromPointEx` / `PostMessageW`), pure-Rust PNG codec/downscaler (`flate2`/`crc32fast`), WinRT OCR, `KillSwitch`, `GetProcessTimes` `ProcessIdentity` PID-reuse continuity, YOLO default (`ComputerPolicy::unrestricted_default()`), and `21` tool schemas (`66` tests).
  - `omnia-remote-control` ([`rust/omnia-remote-control/`](rust/omnia-remote-control/)) — pairing, crypto, authenticated sequencing, replay rejection, and transport protocols.
  - `omnia-agent` ([`rust/omnia-agent/`](rust/omnia-agent/)) — Full Native Rust SOTA autonomous coding agent engine (`SuperHarnessManager`, `NativeSuperEngine`, ACP stdio/HTTP/WS w/ `-32602` on unknown mode, `StartGate` + `JobObject` hook trees, hardened `lsp.rs`, compaction-safe 2-phase rewind, zero-`eval()` `builtin_stem.rs`, 50 MiB zip-bomb-guarded `office_reader.rs`, weak-ref `FileMutationLocks`, `PermissionsEngine` [default `Yolo` + opt-in `--sandbox`], QuickJS PTC sandbox, offline `eval_scripted.rs`, and `Trajectory`).
  - `omnia-downloader` ([`rust/omnia-downloader/`](rust/omnia-downloader/)) — Full Native Rust multi-stream segmented HTTP & Google Drive downloader (`OmniDownloader Pro` / `OmniDrive`: `DriveResolver`, background Tokio `DownloadScheduler`, `CoalescedDiskWriter`, DNS-pinned pools, `detect.rs`/`blob.rs` w/ MD5, dual-track HLS + `moof->traf->tfdt` splitting + DASH + FFmpeg `-c copy`, pacing, `SitePolicyRegistry`, and strict non-bypass DRM/captcha gates).
  - `omnia-notebook` ([`rust/omnia-notebook/`](rust/omnia-notebook/)) — Full Native Rust Gemini Notebook & Atelier Research Studio engine (`source_ids`/`only_checked`/bilingual `EffortLevel`, 5-stage `UploadHealer`, `decode_text_safely`, fail-closed `SOURCES_INCOMPLETE`, HTTP `206` WAV streaming, Whisper bridge, and `11/11` Studio artifacts).
  - `omnia-cli` ([`rust/omnia-cli/`](rust/omnia-cli/) -> `omnia.exe`) — headless Full Native Rust CLI (`mimalloc`, MSVC-gated `/DELAYLOAD` omitting `ws2_32.dll`, `omnia run`, `omnia tui`, `omnia arena`, `omnia learn`, `omnia proceed`, `omnia rewind`, `omnia --acp`, `omnia --acp-http`, `omnia --mcp`, `--sandbox`, `--profile-startup`, `--version`) with integrated `ratatui` TUI.
  - `omnia-runtime` ([`rust/omnia-runtime/`](rust/omnia-runtime/) -> `omnia-runtime.exe`) — provider/connector HTTP runtime (default `ApprovalMode::Yolo`, `512`-entry `AgentEventRing`, SQLite WAL `DynamicProviderRouter`, `30_000` ms default timeout, `NVIDIA` catalog bridge, `/api/router/cancel`).
  - `omnia-studio` ([`rust/omnia-studio/`](rust/omnia-studio/) -> `omnia-studio.exe`) — loopback HTTP/JSON-RPC/WS Studio host on `127.0.0.1` unified on `SuperHarnessManager`, serving [`ui-v5/`](ui-v5/) (`D:\OmniaData\build\ui-dist` / compile-time `rust-embed` `embed-ui` priority before falling back to [`ui/`](ui/)) and `/api/*` endpoints (strict bound-port `AUD-02` `Origin`/`Host` pins, `AUD-24` cancel endpoints, `AUD-25` `/api/capabilities`, 30s Vixie cron `ops_routines`, `ops_peer_mesh_*` polling, downloader/notebook routes).
  - `omnia-native` ([`rust/omnia-native/`](rust/omnia-native/) -> `omnia-native.exe`, `omnia_qa_seed.exe`) — Win32 + DWM Dark/Mica + Direct2D + server-side COM UIA + `WH_CBT` `#32770` desktop shell (plus `--studio` WebView2 host with dynamic runtime discovery) and 125-row SQLite fixture seeder, embedding [`native/app.manifest`](native/app.manifest).
- **Flagship Studio UI ("Obsidian Kinetic Atelier" & `ui-v5/`)**: [`ui-v5/`](ui-v5/) (SolidJS + Tailwind + Vite externalized via `D:\OmniaData\build\ui-deps` -> `D:\OmniaData\build\ui-dist`, fusing OMP Desktop/CLI/`omp-omni` with Trae `Chat/Builder/SOLO` & VS Code IDE `Chat | IDE | Browser` across 4 WCAG themes incl. `Titanium`, AAA high-contrast, Windows High Contrast, 14-format `SourcePreviewModal`, zero-CDN math, 11-scope palette, and `AUD-24`/`AUD-25` parity), [`ui/`](ui/) ([`ui/index.html`](ui/index.html), [`ui/styles/`](ui/styles/), [`ui/app/`](ui/app/)) zero-bundler fallback (`127/127` `node --test` PASS), [`docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md), and [`docs/ui-direction/DIRECTION_DECISION.md`](docs/ui-direction/DIRECTION_DECISION.md).
- **Maintained tools & packaging contracts**:
  - [`tools/`](tools/) hosts `agy-history-sync`, `omnia-history-import`, `omnia-connector-intake`, `omnia-runtime-compat`, `omnia-consolidated-audit`, `omnia-skill-parity`, `maintained-scripts`, plus:
    - [`tools/omnia-benchmark/`](tools/omnia-benchmark/) — Windows-native multi-axis agent harness benchmark suite (`METHODOLOGY.md`, `runner_v4.py`, `scorer_v4.py`, `bench_telemetry_proxy.py`, `bench_zero_ai_loopback.py`, `proc_monitor.py`, `validate_suite.py`, `cleanroom.py`, `stage0_smoke.py`, `public_suites/container_runner.py`, `suite/manifest.json`, and `47/47` unit tests PASS), Suite v5 (`33` tasks) and frontier AA/public suites.
    - [`tools/omnia-gemini-extractor/`](tools/omnia-gemini-extractor/) — zero-dependency Python 3 + Node v28 public Gemini share extractor (`cli.py`, `extractor.py`, `cdp_capture.mjs`, `test_extractor.py`) enforcing strict `auth_required` / `captcha_blocked` non-bypass policy and secret redaction.
  - [`platform/`](platform/) holds packaging target manifests (`targets.json`, `validate_targets.py`, `test_validate_targets.py`, incl. `linux-native` & `macos-native` `14/14` PASS).
- **Workspace governance, indexes & deep-clean audit reports**: [`docs/workspace/`](docs/workspace/) and [`docs/architecture/`](docs/architecture/):
  - **Authoritative ledgers**: [`GOAL.md`](docs/workspace/GOAL.md), [`DOD.md`](docs/workspace/DOD.md), [`CHECKPOINT.md`](docs/workspace/CHECKPOINT.md), [`DECISIONS.md`](docs/workspace/DECISIONS.md), [`SESSION_ADMISSION.json`](docs/workspace/SESSION_ADMISSION.json), [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md), [`CLEANUP_STATUS_20261112.md`](docs/workspace/CLEANUP_STATUS_20261112.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md), [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_C_DRIVE.md).
  - **Navigable indexes**: [`STATUS.md`](docs/workspace/STATUS.md), [`PLAN.md`](docs/workspace/PLAN.md), [`TASKS.md`](docs/workspace/TASKS.md), [`PROMPTS.md`](docs/workspace/PROMPTS.md), [`SESSIONS.md`](docs/workspace/SESSIONS.md), [`SOURCES.md`](docs/workspace/SOURCES.md), [`REFS.md`](docs/workspace/REFS.md), [`STEER_QUEUE.md`](docs/workspace/STEER_QUEUE.md), [`TRANSFER_CONTRACT.md`](docs/workspace/TRANSFER_CONTRACT.md).
  - **Subsystem contracts & disposition maps**: [`COMPOSER_REQUIREMENTS.md`](docs/workspace/COMPOSER_REQUIREMENTS.md), [`DYNAMIC_ROUTING_REQUIREMENTS.md`](docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md), [`OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md`](docs/architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md), [`SOTA_V4_OMNIA_UPGRADE_SPEC.md`](docs/architecture/SOTA_V4_OMNIA_UPGRADE_SPEC.md), [`SOTA_V3_ENHANCEMENT_SPEC.md`](docs/architecture/SOTA_V3_ENHANCEMENT_SPEC.md), [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json), [`SOURCE_DISPOSITION_LEDGER.json`](docs/workspace/SOURCE_DISPOSITION_LEDGER.json), [`NEXT_SESSION_PROMPT.md`](docs/workspace/NEXT_SESSION_PROMPT.md).

## External build rules and Full Native Rust development

**Mandatory out-of-source build rule (`DOD-06`)**: Never create `target/`, `build/`, `__pycache__/`, `Roaming/`, SQLite test fixtures, logs, or QA screenshots inside the repository checkout. Always point Cargo to an external target directory (`$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace'`, or `..\OmniaData\build\omnia-rust-workspace` from a fresh checkout).

From a Windows terminal with **Rust (`rustc` / `cargo`, edition 2021)**, **Windows 11 SDK** (`winsqlite3`), **PowerShell 7 (`pwsh`)**, and **Python 3 (`python -B`)**:

```powershell
# 1. Unified out-of-source Cargo verification across all 18 workspace crates
$env:CARGO_TARGET_DIR = (Resolve-Path '..\OmniaData\build' -ErrorAction SilentlyContinue)?.Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace' } else { $env:CARGO_TARGET_DIR = Join-Path $env:CARGO_TARGET_DIR 'omnia-rust-workspace' }

cargo check --workspace --offline --locked
cargo clippy --workspace --offline --locked -- -D warnings
cargo test --workspace --offline --locked
cargo build --workspace --release --offline --locked
cargo build -p omnia-studio --release --offline --locked --features embed-ui
cargo build -p omnia-cli --release --offline --locked

# 2. Launch Omnia CLI, Flagship Studio server (http://127.0.0.1:8787), runtime sidecar, or Win32 native shell
& "$env:CARGO_TARGET_DIR\release\omnia.exe" --version
& "$env:CARGO_TARGET_DIR\release\omnia-studio.exe"
& "$env:CARGO_TARGET_DIR\release\omnia-runtime.exe"
& "$env:CARGO_TARGET_DIR\release\omnia-native.exe"

# 3. Validate 22/22 skill parity, Python test suites, UI JS syntax/tests, and strict consolidated audit
python -B tools/omnia-skill-parity/validate_skills.py --strict-all-skills
python -B -m unittest discover -s tools/agy-history-sync -p "test_*.py"
python -B -m unittest discover -s tools/omnia-benchmark -p "test_*.py"
python -B -m unittest discover -s tools/omnia-gemini-extractor -p "test_*.py"
node --test ui/tests/*.test.js
python -B tools/omnia-consolidated-audit/audit.py --secret-scope all --strict --strict-scope full
```

See [`native/README.md`](native/README.md) for `--session-db` usage, `LockFileEx` cooperative store locking, external `D:\OmniaData\build\omnia-rust-native-{release,debug}` staging, and Win32 control IDs.

## Native QA scripts (`native/qa-*.ps1`)

All 7 native QA workflows must be invoked with **PowerShell 7 (`pwsh`)** and enforce external executable, external SQLite fixture, reparse-ancestor, and fresh non-overwriting output-directory guards via [`native/qa-paths.ps1`](native/qa-paths.ps1) and window/DPI verification via [`native/qa-capture.ps1`](native/qa-capture.ps1):

| Script | Scope | Typical inputs |
|---|---|---|
| [`native/qa-paths.tests.ps1`](native/qa-paths.tests.ps1) | 40-case external-path, reparse, and sidecar guard suite | Isolated temp fixtures (no app launch) |
| [`native/qa-capture.tests.ps1`](native/qa-capture.tests.ps1) | 14-case HWND/PID ownership, bounds, DPI-restore, and no-overwrite capture suite | External `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-smoke.ps1`](native/qa-smoke.ps1) | 4-case shell modes, UIA `Edit` composer discovery (`uiaIssue: null`), draft retention, capture, and process sample | Release `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-session.ps1`](native/qa-session.ps1) | 5-case session metadata CRUD, settings, Unicode persistence, and reopen via Windows UIA | Release `omnia-native.exe` (`-KeepOpen` optional) |
| [`native/qa-paging.ps1`](native/qa-paging.ps1) | 9-case 125-row keyset pagination and background worker checks | Release `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-guard.ps1`](native/qa-guard.ps1) | 12-case unsaved-form `#32770` modal discard/cancel (`WH_CBT` UIA invoke) and failed-selection guards | Debug/Release `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-ownership.ps1`](native/qa-ownership.ps1) | 6-case competing process `HarnessStore` exclusion and successor reopen | Debug/Release `omnia-native.exe` + new DB + `-OutputPrefix` |

Example external QA run from the repository root (`pwsh`):

```powershell
$TargetDir  = 'D:\OmniaData\build\omnia-rust-workspace'
$ReleaseExe = (Resolve-Path "$TargetDir\release\omnia-native.exe").Path
$SeedExe    = (Resolve-Path "$TargetDir\release\omnia_qa_seed.exe").Path
$DebugExe   = (Resolve-Path "$TargetDir\debug\omnia-native.exe").Path
$QaRoot     = 'D:\OmniaData\qa\native-rust-run-01'

pwsh -NoProfile -File native/qa-paths.tests.ps1
pwsh -NoProfile -File native/qa-capture.tests.ps1 -Executable $DebugExe -OutputDirectory "$QaRoot\capture-tests"
pwsh -NoProfile -File native/qa-smoke.ps1 -Executable $ReleaseExe -OutputDirectory "$QaRoot\smoke"
pwsh -NoProfile -File native/qa-session.ps1 -Executable $ReleaseExe -OutputDirectory "$QaRoot\session"

# Seed fresh external 125-row SQLite fixtures before running paging and guard QA
& $SeedExe "$QaRoot\paging-fixture"
pwsh -NoProfile -File native/qa-paging.ps1 -Executable $ReleaseExe -Database "$QaRoot\paging-fixture\sessions.sqlite3" -OutputDirectory "$QaRoot\paging"

& $SeedExe "$QaRoot\guard-fixture"
pwsh -NoProfile -File native/qa-guard.ps1 -Executable $DebugExe -Database "$QaRoot\guard-fixture\sessions.sqlite3" -OutputDirectory "$QaRoot\guard"

pwsh -NoProfile -File native/qa-ownership.ps1 -Executable $DebugExe -Database "$QaRoot\ownership-fixture\sessions.sqlite3" -OutputPrefix "$QaRoot\ownership\run"
```

## Delivery status and boundaries

- **Tracked root source**: [`Cargo.toml`](Cargo.toml), [`Cargo.lock`](Cargo.lock), [`.gitattributes`](.gitattributes), [`rust/`](rust/) (`18` crates), [`native/`](native/), [`ui-v5/`](ui-v5/) & legacy [`ui/`](ui/), [`platform/`](platform/), `22` repository skills in [`.agents/skills/`](.agents/skills/), [`tools/`](tools/), [`docs/handoff/`](docs/handoff/), [`docs/ui-direction/`](docs/ui-direction/), [`docs/architecture/`](docs/architecture/), [`docs/storage-schema.sql`](docs/storage-schema.sql), and [`docs/workspace/`](docs/workspace/) live directly at the repository root.
- **Externalized non-product state & disk reclamation**: Research archives, the structured `100`-category / `1,001`-skill catalog (`omni-deep-1000-catalog.json`), the 22-shard `mega-deep-read` corpus (`D:\OmniaData\research\mega-deep-read-20261128\`), relocated historical worktrees (`D:\OmniaData\repos\omnia`, `D:\OmniaData\worktrees\publish-worktree`), out-of-source Cargo target directories (`D:\OmniaData\build\`), UI builds (`D:\OmniaData\build\ui-dist`, embedded into `omnia-studio.exe` via `rust-embed` `embed-ui` priority), QA receipts (`D:\OmniaData\qa\`), external Wave 4 C++20 backup (`D:\OmniaData\backups\pre-full-rust-20261115\`), quarantined `Roaming/` test cache (`D:\OmniaData\quarantine\roaming-20261124\`), and recovery snapshots live outside the product tree under `D:\OmniaData` (mapped in [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md) `+778.15 GiB` physical reclaimed -> `837.57 GiB` free, and [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_C_DRIVE.md) `+166.14 GiB` physical reclaimed -> `189.60 GiB` free).
- **Privacy & publication (`DELIVERY-01` / `DOD-15`)**: Private chat transcripts, credentials, API keys, cookies, and browser profiles stay strictly outside published Git. Shared handoff documents under [`docs/handoff/`](docs/handoff/) and tests/fixtures must pass zero-secret scans (`audit.py --secret-scope all`) for publication to `https://github.com/khang-macphuc111107/omnia` (see [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md)).
- **Honest verification scope**: At the current **`v5.1.0`** working tree over `1c9342c` (following Steer #15–#21 `6a82180` 3/3 cleanroom and Steer #22–#23 `a41c4d6` Phase 4 verification), all **18 Rust crates** compile and pass strict checks (`cargo check --workspace --all-targets`, `3/3` `clippy --all-targets -- -D warnings`, **`734 passed / 0 failed / 1 ignored`** across `50` suites, `omnia-cli` `20/20`, `omnia-studio --features embed-ui` `34/34`), `ui-v5` builds cleanly (`2,564` modules), all **`5/5`** release binaries are staged (`omnia.exe` `12.763 MiB <= 14 MiB` / `--profile-startup` `0.11 ms` / `5.71 MiB` RSS + `5/5` CLI smoke; `omnia-studio.exe` `embed-ui` `36.413 MiB`; `omnia-runtime.exe` `15.757 MiB`; `omnia-native.exe` `0.366 MiB`; `omnia_qa_seed.exe` `0.222 MiB`), modular fallback `ui/` passes **`127/127`** `node --test`, `qa-paths.tests.ps1` (`40/40`) and `qa-capture.tests.ps1` (`14/14`) pass on staged `omnia-native.exe`, PR #1 `AUD-01..32` reaches **`32/32` closed** (`AUD-02`/`24`/`25` closed), `validate_skills.py` passes **`22/22`** (`0` drift), `skill_router.py golden-eval` passes **`16/16` (`100%`)**, `platform/validate_targets.py` passes **`14/14`**, `tools/omnia-benchmark/public_suites` + benchmark unit suites pass (`47/47` benchmark tests incl. Issue #8 `container_runner.py`, keeping Dockerless `Terminal-Bench 4.1` and `SWE-bench` honestly `DEFERRED_BOUNDARY`), `audit.py --secret-scope all` passes (`0` findings across `1,189` files), `git diff --check` exits `0`, and `stage-public-release.test.mjs` passes `9/10` (with `#10` awaiting the commit adding `rust/omnia-computer/`). Remaining live execution of `qa-{smoke,session,paging,guard,ownership}` on the v5.1.0 binaries, the final frozen commit, and `3` consecutive frozen-snapshot cleanroom audits keep [`SESSION_ADMISSION.json`](docs/workspace/SESSION_ADMISSION.json) in `DEFERRED`.

## Export a committed source candidate

After reviewing and committing intended changes:

```powershell
node tools/maintained-scripts/stage-public-release.mjs
node --test tools/maintained-scripts/stage-public-release.test.mjs
```

The export reads `HEAD` (excluding uncommitted working-tree edits) and writes a clean candidate directory plus an adjacent receipt under `D:\OmniaData\exports` (configurable via `OMNIA_SOURCE_ROOT`, `OMNIA_EXPORT_REVISION`, `OMNIA_DATA_ROOT`, and `OMNIA_EXPORT_DESTINATION`). Review privacy, licenses, and clean-clone build results before pushing.
