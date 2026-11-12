# Omnia

Windows-first **Native C++20 Agentic Studio & Win32 Desktop Shell** (`v4.0.0`, `https://github.com/khang-macphuc111107/omnia`).

Omnia compiles directly with **MSVC C++20 + CMake + Ninja + Windows 11 SDK** (`winsqlite3`, `bcrypt`, `ws2_32`, `dwmapi`, `d2d1`, `dwrite`, `uiautomationcore`) with **zero external C++ package downloads**, **zero Rust/Cargo files** (`0` `.rs`, `0` `Cargo.*`), and **zero Node/Electron/WebView bundler dependencies**. The prior audited Rust/Tauri workspace (`524/524` tests, `3/3` clean audit rounds) is archived losslessly on Git tag `archive/pre-cpp-rust-snapshot-20261112` (`c3033728abe6f0a4906a796bf7652c84408356d7`).

## Repository navigation

Whether you are collaborator **HTMusTC** onboarding from a fresh clone or a coding agent resuming execution, start with these entrypoints:

- **Agent & contributor contract**: [`AGENTS.md`](AGENTS.md), workspace skill manifest [`.agents/skills.json`](.agents/skills.json), and the **13 curated workflow skills** under [`.agents/skills/`](.agents/skills/) (`additive-steer-queue`, `autonomous-power-continuity`, `codex-mcp-namespace-diagnostics`, `deep-clean`, `deep-cpp-native`, `deep-general-graph-orchestration`, `deep-proposal`, `deep-steer`, `goal-plan-loop-dod`, `omni-bilingual-skill-router`, `omni-deterministic-verifiers`, `omnia-session-governance-handoff`, `vietnamese-typo-intent-inference`).
- **Collaborator handoff (`HTMusTC`)**: [`docs/handoff/`](docs/handoff/):
  - [`COLLABORATOR_HANDOFF.md`](docs/handoff/COLLABORATOR_HANDOFF.md) — executive C++20 architecture, target map, out-of-source build/CTest/QA workflow, and priority roadmap.
  - [`USER_PROMPT_REQUIREMENTS_MATRIX.md`](docs/handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md) — prompt-by-prompt traceability across 124 flagship Codex prompts + 12 Antigravity additive steers (`Steer #1`..`Steer #12`).
  - [`BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md) — 2-way `PeerMeshGraph` (`A <-> B` duplex mesh) and deterministic `GraphifyIndex` forward/reverse provenance specification.
  - [`LESSONS_LEARNED_AND_ANTIPATTERNS.md`](docs/handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md) — cross-host engineering lessons, MSVC/Win32 UIA invariants, and pitfalls to avoid.
- **Native C++20 core, harness & Studio host (`omnia-studio.exe`)**: [`CMakeLists.txt`](CMakeLists.txt), [`CMakePresets.json`](CMakePresets.json), and [`cpp/`](cpp/) ([`cpp/CMakeLists.txt`](cpp/CMakeLists.txt)):
  - `omnia_core` ([`cpp/include/omnia/core/`](cpp/include/omnia/core/)) — RFC 8259 JSON parser/serializer, Windows CNG `bcrypt` SHA-256, UTF-8/UTF-16 + Vietnamese Telex/VNI/shorthand normalization, and secret redactor.
  - `omnia_storage` ([`cpp/include/omnia/storage/session_store.hpp`](cpp/include/omnia/storage/session_store.hpp)) — `winsqlite3` WAL session store, cooperative process lease locking, and keyset pagination (reference schema in [`docs/storage-schema.sql`](docs/storage-schema.sql)).
  - `omnia_routing` ([`cpp/include/omnia/routing/dynamic_router.hpp`](cpp/include/omnia/routing/dynamic_router.hpp)) — deterministic capability, quota, cost, latency, and circuit-breaker `DynamicProviderRouter` covering all 10 routing scenarios with secret-free decision/outcome receipts.
  - `omnia_graph` ([`cpp/include/omnia/graph/`](cpp/include/omnia/graph/)) — 2-way all-to-all `PeerMeshGraph` (`A <-> B` duplex links, `disjoint_paths` single-writer guard, `max_hops`/`epoch` cycle fencing) and deterministic `GraphifyIndex` (`Forward` / `Reverse` / `Both` with `EXTRACTED` / `INFERRED` / `AMBIGUOUS` provenance).
  - `omnia_harness` ([`cpp/include/omnia/harness/`](cpp/include/omnia/harness/)) — hierarchical + cyclic `MemoryGraph` (`Working`/`Durable` tiers + `ErasureReceipt`), bilingual EN/VN `ProactiveRag`, bounded `1024`-char `SkillRegistry` (`13` repo skills loaded live), 15-template Math/Physics/Chemistry `ComposerModel`, and additive `SteerQueue` (`token_budget = NULL`).
  - `omnia-studio.exe` ([`cpp/apps/omnia_studio/main.cpp`](cpp/apps/omnia_studio/main.cpp), [`cpp/src/studio/studio_server.cpp`](cpp/src/studio/studio_server.cpp)) — `671.5 KB` Release WinSock2 HTTP/JSON-RPC host on `127.0.0.1:8787` (`9.30 MiB` working set) serving [`ui/`](ui/) and `12` live `/api/*` endpoints with `403` `Origin`/`Host` and path-traversal guards (`6/6` CTest suites in [`cpp/tests/`](cpp/tests/)).
- **Native C++20 Win32 desktop shell (`omnia-native.exe`)**: [`native/`](native/) ([`native/CMakeLists.txt`](native/CMakeLists.txt), [`native/README.md`](native/README.md)) — `283 KiB` Release Win32 + DWM Dark/Mica + Direct2D desktop shell, rich prompt composer & dual-mode inline/tray attachment model ([`native/src/composer.cpp`](native/src/composer.cpp)), server-side COM UIA provider (`IRawElementProviderSimple`, `IValueProvider`, `IInvokeProvider` + thread-scoped `WH_CBT` `#32770` modal button subclassing in [`native/src/uia_provider.cpp`](native/src/uia_provider.cpp)), 125-row SQLite fixture seeder `omnia_qa_seed.exe` ([`native/src/qa_seed.cpp`](native/src/qa_seed.cpp)), `29`-case CTest runner `omnia_native_tests.exe` ([`native/tests/test_native_cpp.cpp`](native/tests/test_native_cpp.cpp)), and `7` PowerShell QA workflows (`native/qa-*.ps1`).
- **Flagship Studio UI ("Obsidian Kinetic Atelier")**: [`ui/`](ui/) ([`ui/index.html`](ui/index.html), [`ui/styles/`](ui/styles/), [`ui/app/`](ui/app/)), [`docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md), and [`docs/ui-direction/DIRECTION_DECISION.md`](docs/ui-direction/DIRECTION_DECISION.md) — zero-bundler ES2022/CSS/SVG multi-pane studio (`Chat & Rich Composer`, `2-Way Peer-Mesh & Graphify Inspector`, `Dynamic Router & Quota Lab`, `Workspace / IDE / Diff Explorer`, `Memory, Skills & Steer Vault`, `Ctrl+K` Command Palette) across 3 WCAG 2.2-verified themes (`Obsidian Atelier`, `Alabaster Editorial`, `Midnight Blueprint`; `87/87` contrast checks `>= 5.12:1`, `45/45` headless Edge CDP states with `maxOverflowX = 0 px`).
- **Maintained tools**: [`tools/agy-history-sync/`](tools/agy-history-sync/) ([`README.md`](tools/agy-history-sync/README.md)) — zero-dependency Python 3 bidirectional Antigravity 3-surface (`Agent App` / `IDE` / `CLI`) history synchronizer and unified FTS5 search indexer; [`tools/maintained-scripts/`](tools/maintained-scripts/) — committed source release candidate exporter.
- **Workspace governance, indexes & deep-clean audit reports**: [`docs/workspace/`](docs/workspace/):
  - **Authoritative ledgers**: [`GOAL.md`](docs/workspace/GOAL.md), [`DOD.md`](docs/workspace/DOD.md), [`CHECKPOINT.md`](docs/workspace/CHECKPOINT.md), [`DECISIONS.md`](docs/workspace/DECISIONS.md), [`SESSION_ADMISSION.json`](docs/workspace/SESSION_ADMISSION.json), [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md), [`CLEANUP_STATUS_20261112.md`](docs/workspace/CLEANUP_STATUS_20261112.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md), [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_C_DRIVE.md).
  - **Navigable indexes**: [`STATUS.md`](docs/workspace/STATUS.md), [`PLAN.md`](docs/workspace/PLAN.md), [`TASKS.md`](docs/workspace/TASKS.md), [`PROMPTS.md`](docs/workspace/PROMPTS.md), [`SESSIONS.md`](docs/workspace/SESSIONS.md), [`SOURCES.md`](docs/workspace/SOURCES.md), [`REFS.md`](docs/workspace/REFS.md), [`STEER_QUEUE.md`](docs/workspace/STEER_QUEUE.md), [`TRANSFER_CONTRACT.md`](docs/workspace/TRANSFER_CONTRACT.md).
  - **Subsystem contracts & disposition maps**: [`COMPOSER_REQUIREMENTS.md`](docs/workspace/COMPOSER_REQUIREMENTS.md), [`DYNAMIC_ROUTING_REQUIREMENTS.md`](docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md), [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json), [`SOURCE_DISPOSITION_LEDGER.json`](docs/workspace/SOURCE_DISPOSITION_LEDGER.json), [`NEXT_SESSION_PROMPT.md`](docs/workspace/NEXT_SESSION_PROMPT.md).

## External build rules and native C++20 development

**Mandatory out-of-source build rule (`DOD-06`)**: Never create `build/`, `CMakeFiles/`, `CMakeCache.txt`, `.vs/`, SQLite test fixtures, logs, or QA screenshots inside the repository checkout. Always place CMake `-B` build directories outside the repository root (for example `..\OmniaData\build\omnia-full-release` via [`CMakePresets.json`](CMakePresets.json), or `D:\OmniaData\build\...` on the primary workstation).

From a Windows terminal with Visual Studio 2022 / Build Tools (`MSVC` C++20 + Windows 11 SDK), `CMake >= 3.24`, and `Ninja`:

```powershell
# Locate vcvars64.bat via vswhere (works across VS 2022 / VS 18 Community, BuildTools, Enterprise)
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$VcVars  = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find "VC\Auxiliary\Build\vcvars64.bat" | Select-Object -First 1

# 1. Unified out-of-source Release build & 35/35 CTest suite (6 core suites + 29 native cases)
$BuildDir = '..\OmniaData\build\omnia-full-release'
cmd /c "`"$VcVars`" >nul && cmake -G Ninja -S . -B `"$BuildDir`" -DCMAKE_BUILD_TYPE=Release -DOMNIA_BUILD_CPP_CORE=ON -DOMNIA_BUILD_NATIVE_SHELL=ON && cmake --build `"$BuildDir`" && ctest --test-dir `"$BuildDir`" --output-on-failure"

# 2. Standalone native Release & Debug builds used by native/qa-*.ps1 defaults
cmd /c "`"$VcVars`" >nul && cmake -G Ninja -S native -B ..\OmniaData\build\omnia-cpp-native-release -DCMAKE_BUILD_TYPE=Release && cmake --build ..\OmniaData\build\omnia-cpp-native-release"
cmd /c "`"$VcVars`" >nul && cmake -G Ninja -S native -B ..\OmniaData\build\omnia-cpp-native-debug -DCMAKE_BUILD_TYPE=Debug && cmake --build ..\OmniaData\build\omnia-cpp-native-debug"

# 3. Launch Flagship Studio server (http://127.0.0.1:8787) or Win32 native shell
& "$BuildDir\cpp\omnia-studio.exe" --root . --port 8787
& "$BuildDir\native\omnia-native.exe"
```

See [`native/README.md`](native/README.md) for `--session-db` usage, `LockFileEx` cooperative store locking, and Win32 control IDs.

## Native QA scripts (`native/qa-*.ps1`)

All 7 native QA workflows (`90/90` cases verified `rc=0`) enforce external executable, external SQLite fixture, reparse-ancestor, and fresh non-overwriting output-directory guards via [`native/qa-paths.ps1`](native/qa-paths.ps1) and window/DPI verification via [`native/qa-capture.ps1`](native/qa-capture.ps1):

| Script | Scope | Typical inputs |
|---|---|---|
| [`native/qa-paths.tests.ps1`](native/qa-paths.tests.ps1) | 40-case external-path, reparse, and sidecar guard suite | Isolated temp fixtures (no app launch) |
| [`native/qa-capture.tests.ps1`](native/qa-capture.tests.ps1) | 14-case HWND/PID ownership, bounds, DPI-restore, and no-overwrite capture suite | External Debug `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-smoke.ps1`](native/qa-smoke.ps1) | 4-case shell modes, UIA `Edit` composer discovery (`uiaIssue: null`), draft retention, capture, and process sample | Release `omnia-native.exe` + fresh `-OutputDirectory` |
| [`native/qa-session.ps1`](native/qa-session.ps1) | 5-case session metadata CRUD, settings, Unicode persistence, and reopen via Windows UIA | Release `omnia-native.exe` (`-KeepOpen` optional) |
| [`native/qa-paging.ps1`](native/qa-paging.ps1) | 9-case 125-row keyset pagination and background worker checks | Release `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-guard.ps1`](native/qa-guard.ps1) | 12-case unsaved-form `#32770` modal discard/cancel (`WH_CBT` UIA invoke) and failed-selection guards | Debug `omnia-native.exe` + seeded external SQLite DB |
| [`native/qa-ownership.ps1`](native/qa-ownership.ps1) | 6-case competing process `HarnessStore` exclusion and successor reopen | Debug `omnia-native.exe` + new DB + `-OutputPrefix` |

Example external QA run from the repository root:

```powershell
$ReleaseExe = (Resolve-Path '..\OmniaData\build\omnia-cpp-native-release\omnia-native.exe').Path
$SeedExe    = (Resolve-Path '..\OmniaData\build\omnia-cpp-native-release\omnia_qa_seed.exe').Path
$DebugExe   = (Resolve-Path '..\OmniaData\build\omnia-cpp-native-debug\omnia-native.exe').Path
$QaRoot     = Join-Path (Resolve-Path '..\OmniaData').Path 'qa\native-run-01'

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

- **Tracked root source**: [`CMakeLists.txt`](CMakeLists.txt), [`CMakePresets.json`](CMakePresets.json), [`cpp/`](cpp/), [`native/`](native/), [`ui/`](ui/), `13` curated skills in [`.agents/skills/`](.agents/skills/), [`tools/`](tools/), [`docs/handoff/`](docs/handoff/), [`docs/ui-direction/`](docs/ui-direction/), [`docs/storage-schema.sql`](docs/storage-schema.sql), and [`docs/workspace/`](docs/workspace/) live directly at the repository root.
- **Externalized non-product state & disk reclamation**: Research archives, the structured `100`-category / `1,001`-skill catalog (`omni-deep-1000-catalog.json`), relocated historical worktrees (`D:\OmniaData\repos\omnia`, `D:\OmniaData\worktrees\publish-worktree`), out-of-source CMake builds (`D:\OmniaData\build\`), QA receipts (`D:\OmniaData\qa\`), and recovery snapshots live outside the product tree under `D:\OmniaData` (mapped in [`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md) `+778.15 GiB` physical reclaimed -> `837.57 GiB` free, and [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](docs/workspace/DEEP_CLEAN_AUDIT_C_DRIVE.md) `+166.14 GiB` physical reclaimed -> `189.60 GiB` free).
- **Privacy & publication (`DELIVERY-01` / `DOD-15`)**: Private chat transcripts, credentials, API keys, cookies, and browser profiles stay strictly outside published Git. Shared handoff documents in [`docs/handoff/`](docs/handoff/) passed automated zero-secret redaction scans (`leak_count=0`) for publication to `https://github.com/khang-macphuc111107/omnia` (see [`REMOTE_SETUP.md`](docs/workspace/REMOTE_SETUP.md)).
- **Honest verification scope**: Unified C++20 `CTest` (`35/35` cases), `7/7` native Win32 QA workflows (`90/90` cases `rc=0`), `45/45` Edge CDP Flagship Studio UI states + `87/87` WCAG 2.2 checks, `5/5` Python history-sync tests, and `13/13` skill validations prove their stated scope; live third-party LLM API billing/streaming, physical Vietnamese IME/Narrator E2E matrices, excluded primary worktree boundaries (`retirementEligible=false`), and 3-round frozen-snapshot whole-goal clean audits remain governed by [`DOD.md`](docs/workspace/DOD.md) and [`TRANSFER_CONTRACT.md`](docs/workspace/TRANSFER_CONTRACT.md).

## Export a committed source candidate

After reviewing and committing intended changes:

```powershell
node tools/maintained-scripts/stage-public-release.mjs
node --test tools/maintained-scripts/stage-public-release.test.mjs
```

The export reads `HEAD` (excluding uncommitted working-tree edits) and writes a clean candidate directory plus an adjacent receipt under `D:\OmniaData\exports` (configurable via `OMNIA_SOURCE_ROOT`, `OMNIA_EXPORT_REVISION`, `OMNIA_DATA_ROOT`, and `OMNIA_EXPORT_DESTINATION`). Review privacy, licenses, and clean-clone build results before pushing.
