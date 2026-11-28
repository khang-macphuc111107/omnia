# Changelog

All notable changes to **Omnia** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
