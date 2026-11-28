# Changelog

All notable changes to **Omnia** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.1.0] - 2026-11-28

### Added

- **18th Pure Native Rust Crate — `omnia-computer` (`rust/omnia-computer/`)**:
  - Dedicated MTA COM + Per-Monitor-V2 DPI worker for Windows computer use (`#![forbid(unsafe_code)]` public boundary, non-Windows `Unsupported` stubs): cached 17-property Windows UI Automation tree with versioned `[ref=wNeM]` handles and pattern-first `computer_act`, DPI-clamped (`MAX_DIM = 8192`) `BitBlt`/`PrintWindow` screen capture, pure-Rust RGB/RGBA PNG codec + area-average downscaler (`flate2`/`crc32fast`), `SendInput` keyboard/mouse driver, Start-menu `.lnk` fuzzy launcher, and WinRT `Windows.Media.Ocr`.
  - Non-intrusive background window control (`computer_window_*`) via per-window DPI context (`DpiRestoreGuard`), `TokenElevation` UIPI guard, `ChildWindowFromPointEx`, `PostMessageW`, `GetGUIThreadInfo`, and `SendMessageTimeoutW`.
  - Defaults to Steer #22 YOLO posture (`ComputerPolicy::unrestricted_default()`) with unconditional UAC/secure-desktop `hard_blocked_apps()`, opt-in `strict_default()`, global `KillSwitch`, `GetProcessTimes` `ProcessIdentity` PID-reuse continuity (`StaleTarget`), and 21 tool specs (`14` foreground + `7` background; `66` tests: `65` active + `1` `#[ignore]`).
- **Upgraded `omnia-media-capture` Browser Engine & Dynamic WebView2 Discovery**:
  - Zero-race `--remote-debugging-port=0` + `DevToolsActivePort` polling, `256 MiB` `WebSocketConfig`, RAII `PendingCallGuard`, `CancelToken`, `8192`-slot event bus, multi-tab + OOPIF `Target.setAutoAttach`, WeakMap `[ref=eN]` ARIA + Shadow DOM + `<slot>` + same-origin iframe snapshot (`browser_snapshot.{js,rs}`), `2000`-entry `NetworkRing` (`replay_spec()`), pure-Rust median-cut GIF89a + LZW recorder & secret-redacted Playwright codegen (`browser_record.rs`), and batched automation (`execute_batch` / `browser_batch`).
  - Removed hardcoded runtime paths from `omnia-native/src/studio_host.rs` in favor of dynamic WebView2 installation discovery (preserving Thorium rejection).
- **SOTA Autonomous Harness Upgrades (`omnia-agent`)**:
  - `acp_http.rs`: `"solo"` alias and strict JSON-RPC `-32602` Invalid Params on unrecognized `session/set_mode` without silently downgrading active YOLO or `workspace_trusted` state.
  - `hooks.rs`: Race-free Windows `owned_hook_tree::StartGate` (`CreateEventW`) + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kill-on-drop guard, Unix `-pgid` cleanup, and trusted `plugin_roots` side-map (`OMNIA_PLUGIN_ROOT`).
  - `lsp.rs`: Server-to-client RPC handler, `-32801`/`-32802` busy retry loop, `$/cancelRequest` timeout handling, Condvar generation-settled diagnostics, and 10-minute `Weak` idle reaper.
  - `checkpoint.rs`: Monotonic compaction-safe timeline rebasing (`CompactionTimelineEntry`), 2-phase rewind (`prepare_conversation_rewind` / `confirm_history` / `cancel_pending_rewind`), Windows canonical path dedup (`canonical_path_identity`), and retry-safe partial rollback.
  - `builtin_stem.rs`, `office_reader.rs`, `tools.rs`, `eval_scripted.rs`: Zero-`eval()` pure-Rust STEM & claim verifier (`stem_verify`), 50 MiB zip-bomb-guarded pure-Rust `.docx`/`.xlsx`/`.pptx`/`.ipynb` reader, weak-ref `FileMutationLocks`, strictly opt-in `--sandbox` (`OMNIA_SANDBOX_STRICT=1`), and offline `ScriptedProvider`/`ScriptedApprover` harness evals.
- **Runtime, Routing, Graph Storage & Network Hardening**:
  - `omnia-runtime`: Default `ApprovalMode::Yolo` + `workspace_trusted: true` on `handle_runtime_agent_spawn`, `SecretRedactor`-scrubbed 512-entry `AgentEventRing`, persistent SQLite WAL `DynamicProviderRouter` (`upsert_candidate_preserving_state`), cache-shape digest telemetry, retirement notice translation (`404 model_retired`), and `POST /api/router/cancel`.
  - `omnia-routing`: 4-tier `softFail` (`5s` demotion window), monotonic `provider_quota_reset_until_ms` & pool quota reset telemetry, `NotServedTracker`, nested `ComboRegistry` + `30s` `ComboProbe`, 3-way `DispatchOutcomeClass::{Accepted,NotAccepted,Unknown}` post-dispatch safety, monotonic Anthropic `cache_control` TTL validation, and pure `std` zero-sleep TCP `ProviderFaultHarness` (`StageGate` + `SplitMix64` + `ProtocolBoundaries`).
  - `omnia-harness`: Pure-Rust zero-`unsafe` Model2Vec seek router (`m2v_router.rs`: `M2VV0001`/`M2VE0001`/`M2VS0001`, 134-vowel Vietnamese NFD->NFC, hybrid BM25+RRF & `GapRadar`), NotebookLM/Perplexity W3C `#:~:text=` 4-layer EN+VN citation verifier, unified 2-tier `sync_global_lessons` mirror + `evaluate_session_admission_gates`, and `deep_think.rs` `FormalProofAudit` (`AxiomFootprintAudit`, `MultiKernelReplayCheck`, `EpistemicBucket`, `AaronsonSignId`).
  - `omnia-storage`, `omnia-studio/ops_store.rs` & `omnia-workspace-ops`: `PRAGMA trusted_schema = OFF` + `PRAGMA secure_delete = ON`, RFC-2104 HMAC-SHA256 keyset graph cursors (`srgr1.*`), `ops_peer_mesh_*` cursor persistence + `GET /api/graph/peers/poll?since=`, live 30s Vixie cron `ops_routines` runner, RFC 5389 STUN + RFC 1035 NXDOMAIN hijack checks (`net_diag.rs`), and Unicode superscript/fullwidth DOS device blocking (`path_guard.rs`).
- **Atelier, OmniDrive & Flagship `ui-v5` P0 Closures**:
  - `omnia-notebook` & `routes_notebooks.rs`: Wired `SourceFilter.source_ids`/`only_checked`, `ContextualAskPreset`, and bilingual `EffortLevel` into LLM asks; added `/api/notebooks/:id/{ingest-repo,ingest-batch,rename,chat-settings,sources/:sid/checked,artifacts/:aid/audio}` (real WAV HTTP `206`/`416` Range streaming), `DELETE /api/btw/:id`, `SOURCES_INCOMPLETE` (`409`), 5-stage `UploadHealer`, and multi-encoding `decode_text_safely`.
  - `omnia-downloader` & `routes_downloads.rs`: Live `GET /api/omni-drive/aimd` AIMD/BDP telemetry, background `Weak<StudioState>` + `Notify` Tokio `DownloadScheduler` pump hydrating WAL policies, `DriveResolver` folder/confirm guards, `CoalescedDiskWriter`, DNS-pinned pools, pure-Rust RFC 1321 MD5 (`detect.rs`/`blob.rs`), dual-track `#EXT-X-MEDIA` HLS + `#EXT-X-SESSION-KEY` DRM non-bypass refusal, `#EXT-X-DISCONTINUITY` `moof->traf->tfdt` timestamp tracking, DASH `Period`/`SegmentBase` upgrades, and cancellable FFmpeg `-c copy`.
  - `ui-v5` (`2,564` Vite modules -> `D:\OmniaData\build\ui-dist`): 14-format `SourcePreviewModal` (RFC-4180 CSV/TSV, rich `.ipynb`, Zip inspector, 17-magic 16B hex dump, sandboxed HTML/SVG), zero-CDN pure-HTML/CSS `renderSemanticMathFallback`, 28%-72% `AtelierView` hairline split resizer, `window.getSelection()` Quote/BTW/Promote, recursive `collectDroppedFiles()` past Chromium's 100-entry directory cap, HTTP `206` audio player, `OmniDriveView` live AIMD/BDP + HLS/DASH selector + URL-safe FFprobe, 11-scope `CommandPalette` (10 single-char prefixes + Vietnamese IME safety), WCAG AAA high-contrast & Windows High Contrast `@media (forced-colors: active)`, `overflow: clip` fixing `scrollIntoView()` topbar clipping, `DiffCard` inline line comments, `IdeWorkbench` Git commit/worktree controls, `SwarmView` `/api/graph/peers/poll` live cursor view, and dynamic Studio-origin snippets in `AIStudioArenaView`.
- **Executable `omnia` Super-Commands, MCP Server, CI/Release & Benchmark Tooling**:
  - Added `omnia learn <add|sync|status> [--global]`, `omnia proceed [status|on|off|recommended-only|full]` (`tokenBudget: null`), `omnia --mcp` (4 bounded `< 15.5 KB` stdio JSON-RPC tools: `omni_search_skills`, `omni_load_skill`, `graphify_query`, `rag_search`), opt-in `--sandbox`, and TUI `/super-plan`, `/super-run`, `/auto-proceed`, `/learn --global` (`omnia.exe` **`12.763 MiB <= 14 MiB`**, `--profile-startup` **`0.11 ms` / `5.71 MiB` RSS**).
  - Updated `.github/workflows/release.yml` (Node.js 22 external `ui-v5` build -> `omnia-studio --features embed-ui` -> standalone `omnia-cli` LAST with `<= 14 MiB` size check) and `tools/maintained-scripts/stage-public-release.mjs` (`ui-v5/`, `platform/`, and all 18 Rust crates).
  - **Issue #8 & Issue #10 Foundations**: Raised `runner_v4.py` / `public_suites/common.py` `FINAL_ASSISTANT_TEXT_CAP` (`2,500 -> 8,000`), added `tools/omnia-benchmark/public_suites/container_runner.py` (`47/47` benchmark tests PASS, honest `DEFERRED_BOUNDARY` without Docker/WSL2), gated Windows `kernel32`/`winsqlite3` vs POSIX `#[link(name = "sqlite3")]` in `omnia-winsqlite/src/ffi.rs`, guarded MSVC `/DELAYLOAD` in `omnia-cli/build.rs`, and added `linux-native`/`macos-native` contracts to `platform/targets.json` (`14/14` tests PASS).

### Fixed & Closed

- **PR #1 `AUD-02`, `AUD-24` & `AUD-25` 100% Closed (`32/32`)**:
  - `AUD-02`: Strict bound-port loopback `Host` and `Origin` validation in `omnia-studio/src/http.rs` (rejecting wrong/bare loopback ports with `403`).
  - `AUD-24`: End-to-end chat, router reservation (`POST /api/router/cancel`), and Arena cancellation (`POST /api/v5/arena/cancel` + `/api/chat/stop` + `/api/agent/abort`) wired cleanly across Studio, `ui-v5`, and modular fallback `ui/` (`run-control.js`).
  - `AUD-25`: Transport reachability vs service health separation and live `GET /api/capabilities` Matrix UI implemented across both `ui-v5` (`SystemHardwarePanel.tsx` / `RouterLabPanel.tsx`) and modular fallback `ui/` (`capabilities.js`; `127/127` `node --test` PASS).
- **CI Portability & Integration Stabilization**: Resolved Windows 8.3 temp-path canonicalization (`1c9342c`) and Wave 1-3 cross-crate compile/clippy/test alignment (`734 passed, 0 failed, 1 ignored` across `50` suites / `18` crates, `0` Clippy warnings).

### Verification Status

- Verified at working tree over `1c9342c`: `18` Rust crates (`734 passed, 0 failed, 1 ignored`), `omnia-cli` (`20/20`), `omnia-studio --features embed-ui` (`34/34`), `3/3` `clippy -D warnings` clean, `5/5` staged release binaries (`omnia.exe` `12.763 MiB`, `omnia-studio.exe` `36.413 MiB`, `omnia-runtime.exe` `15.757 MiB`, `omnia-native.exe` `0.366 MiB`, `omnia_qa_seed.exe` `0.222 MiB`), `5/5` CLI smoke, `ui-v5` (`2,564` modules), `ui/` (`127/127`), `platform` (`14/14`), `omnia-benchmark` (`47/47`), `validate_skills.py` (`22/22`, `0` drift), `skill_router.py` (`16/16`), `qa-paths.tests.ps1` (`40/40`), `qa-capture.tests.ps1` (`14/14`), `audit.py --secret-scope all` (`0` secrets, `1,189` files), `git diff --check` (`0`), and `stage-public-release.test.mjs` (`9/10`; test #10 archives committed `HEAD` and awaits commit of `rust/omnia-computer/`).
- Remaining gates before next frozen tag / admission: live execution of the 5 Win32 QA workflows (`qa-{smoke,session,paging,guard,ownership}`), frozen commit sealing `v5.1.0`, and 3 consecutive frozen-snapshot Cleanroom Audit Rounds (`SESSION_ADMISSION.json` stays `DEFERRED`).

## [5.0.0] - 2026-11-28

### Added

- **Full Native Rust 17-Crate Cargo Workspace (`edition = "2021"`, `winsqlite3` FFI, `windows-sys`)**:
  - Core & subsystem crates: `omnia-winsqlite`, `omnia-core`, `omnia-storage`, `omnia-routing`, `omnia-graph`, `omnia-harness`, `omnia-connector-gateway`, `omnia-workspace-ops`, `omnia-media-capture`, `omnia-remote-control`, `omnia-agent`, `omnia-downloader`, `omnia-notebook`.
  - Release executables (`5` binaries): `omnia.exe` (**`12.389 MiB <= 14 MiB`**, warm `--version` **`8.29-10.40 ms <= 15 ms`**), `omnia-studio.exe` (`--features embed-ui`, `0` external CDN), `omnia-runtime.exe`, `omnia-native.exe`, and `omnia_qa_seed.exe`.
- **Default Full-Freedom Harness (`Steer #22`)**:
  - Default `ApprovalMode::Yolo` (`yolo | turbo | full-access | full | unrestricted | auto | auto-approve`) across CLI, `ratatui` TUI (`YOLO · AUTO`), ACP stdio/HTTP, Studio, and `ui-v5` (`SOLO`).
  - Empty `PermissionsEngine::default_rules()` (opt-in strict preset preserved in `PermissionsEngine::strict_safety_rules()` and `--approval-mode plan|always-ask|write`), unrestricted cross-workspace `resolve_tool_path`, `64 MiB` read cap, disabled heuristic taint downgrade in `Yolo`, and `EgressPolicy::unrestricted()` default for `web_fetch` / `research_vault`.
- **6-App Flagship Studio Fusion (`Steer #23`, `ui-v5` + `routes_arena_studio_v5.rs` + `ops_store.rs` + `omnia-notebook`)**:
  - **AI Studio & Parallel 2-4 Model Arena**: Concurrent multi-model comparison (`POST /api/v5/arena/compare` & `omnia arena`), TTFT/TPS/token/6-decimal USD cards, lexical side-by-side diff, winner voting with persisted SQLite WAL Elo leaderboard, Temperature/Top-P/Max-Tokens/Stop-Sequences/JSON-Schema inspector, live pre-send cost estimator, 1-click Get Code (`curl`, Python `httpx`/`openai`, TypeScript, Rust `reqwest`), and **Omnia Gems / Personas CRUD**.
  - **Live Artifact Canvas Split Pane (`ArtifactCanvasDrawer`)**: Auto-detected HTML/SVG/Mermaid/Markdown/Code/CSV/JSON artifacts, offline CSP `<iframe sandbox="allow-scripts">` live preview, editable code, split/diff view, version scrubber, download, and "Refine in Omnia".
  - **ChatGPT Tree Branching & Claude Thinking/Tool Accordions**: Edit & Branch, Regenerate, Fork Thread (`/api/v5/sessions/{id}/{branches,fork}`, TUI `/fork`), `< 1/N >` branch switcher, collapsible reasoning/tool timelines, voice dictation, and offline thread export (`MD`/`HTML`/`JSON`).
  - **Perplexity Pro Answer Engine**: Focus Modes (`web | academic | code | rag | deep`), source carousel with clickable `[S###]`/`[G###]` citations, auto-generated related follow-up chips, and editable multi-step Deep Research plans.
  - **NotebookLM++ (`AtelierView` + `omnia-notebook` v2 schemas)**: All `11/11` Studio artifact formats (adding `faq` & `timeline`), per-source grounding checkboxes, interactive SVG pan/zoom Mind Map, graded MCQ Quiz engine, spaced-repetition Flashcards, and 2-Host Podcast Audio Overview player with offline `SpeechSynthesis` and interactive "Join Podcast" follow-up.
- **10-Dimension Observatory & Native Network Diagnostics (`Steer #17`)**:
  - Lab telemetry (`p50/p90/p95/p99/IQR`, 6-decimal USD + KV savings), native zero-crate Rust IP/DNS/Proxy/TLS + on-demand Speedtest & Bufferbloat (`A+..F`), persistent SQLite Router Lab Trip/Reset, hardware/WAL/port gauges, Global Privacy Mask (`P` / `F5`), Smart Alerts, and live v5 Benchmark Scoreboard panel.
- **Default-ON Deep Research, Deep Think, Dual-Tier RAG & 12-Artifact Proactive Lifecycle OS (`Steers #18-#20`)**:
  - Local `[S###]` + Global `[G###]` SQLite WAL BM25+RRF RAG vault, 5-level evidence grading, PRISMA source ledger, persisted Deep Think SQLite WAL multi-branch falsification/red-team lab, 12 cross-linked workspace lifecycle artifacts, 1,001-skill external Cold Vault routing + `24` pipelines + `16/16` bilingual golden eval, and `22/22` 3-way synchronized skills (`0` drift).
- **Parallel 51-Model & 5-Effort Benchmark Suite (`Steers #15-#16`)**:
  - `omnia` ranked **#1 on Suite v5 (`69/76 = 90.79%`, `80.6 MB` med RSS, `77.95%` KV, McNemar `p < 1e-5` vs all 6 peers)**, #1 or tied #1 on `6/8` head-to-head Windows-runnable public suites, `51/51` HTMUSTC models probed (`20` live coding LLMs benchmarked in parallel), and all `5/5` efforts (`low`, `medium`, `high`, `xhigh`, `max`).
- **GitHub Engineering Infrastructure (`Steer #24`)**:
  - GitHub Actions CI (`ci.yml`), automated Windows x86_64 Release pipeline (`release.yml`), Wiki auto-sync (`wiki-sync.yml`), `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, Issue/PR templates, `CODEOWNERS`, Dependabot, and an 8-page `docs/wiki/` knowledge base.

### Changed & Merged

- **Semantic Merge of PR #1 (`thtt0120:master`, commit `04899e6`)**:
  - Merged refactored modular ES2022 fallback `ui/` (`70` files, `119/119` `node --test` PASS) and updated `platform/targets.json` recursive globs (`TRK-06`).
  - Semantically ported `29/32` `AUD-01..AUD-32` security & correctness fixes directly into the Pure-Rust workspace and `tools/agy-history-sync/` without reverting to retired C++20 or importing untracked Windows cache artifacts.
- **Win32 Native QA Hardening**:
  - Closed `QUALITY-01` (zero clipping, `WM_ERASEBKGND` ghost fix, dual `ControlType.Edit` + `ControlType.Document` UIA `uiaIssue: null`) and resolved Windows 11 Vietnamese IME `UAC_InputIndicatorOverlayWnd` HWND collisions across all `7/7` `pwsh` native QA suites (`90/90` PASS).

### Known Boundaries

- Official Linux container grades for `Terminal-Bench 4.1` and `SWE-bench Verified/Pro` remain `DEFERRED_BOUNDARY` on Windows hosts without Docker/Podman/WSL2.
- OmniDrive and Research Vault enforce non-bypass policy (`MANUAL_VISIBLE_BROWSER_ONLY`, `auto_solve_permitted: false`, `[BLOCKED_BY_CHALLENGE]`) for third-party login, CAPTCHA, and DRM gates.

## [archive/pre-cpp-rust-snapshot-20261112] - 2026-11-12

- Historical pre-Wave-4 Rust/Tauri snapshot preserved losslessly on tag `archive/pre-cpp-rust-snapshot-20261112` (`c3033728`).
