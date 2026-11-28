# Wave 1 Deep-Read Report — Shard 05: Downloads Markdown Part 1

- **Author Role**: `@studio-net-api` (Wave 1 read-only exhaustive deep-read per board `#404`)
- **Generated**: `2026-11-28`
- **Target Output**: `D:\OmniaData\research\mega-deep-read-20261128\05_downloads_md_part1.md`
- **Workspace Integrity**: Strictly read-only on `D:\Omnia` and `C:\Users\khang\.gemini`; zero credential, cookie, `.pb`, or `oauth_creds.json` reads; pure UTF-8 no-BOM with Unix `LF` line endings.

---

## 1. Complete Coverage Ledger (Zero-Skip Verification)

| File | Exact Path | Size (Bytes) | Lines Read | Special / Non-Prose Lines | Skip Count | Status |
| :--- | :--- | ---: | ---: | :--- | ---: | :--- |
| File 1 | `C:\Users\khang\Downloads\Omnia\App Codex Desktop Siêu Nhẹ.md` | `248,729` | `1..226` (`226 / 226`, 100%) | `L224`: `[image1]` inline PNG `data:image/png;base64,...` (`150,422` B); `L225`: blank; `L226`: `[image2]` inline PNG `data:image/png;base64,...` (`77,166` B) — inspected lengths/prefixes via Python | `0` | **COMPLETE (100%)** |
| File 2 | `C:\Users\khang\Downloads\Omnia\Khởi động và Quy trình Omnia.md` | `580,612` | `1..4,929` (`4,929 / 4,929`, 100%) | Read sequentially in 16 byte-safe `read_file` slices (`<38 KB` each, zero truncation) | `0` | **COMPLETE (100%)** |
| **Total** | **2 Markdown Sources** | **`829,341`** | **`5,155 / 5,155`** | **`2` embedded PNG screenshots inspected** | **`0`** | **100% ZERO-SKIP VERIFIED** |

### Forensic Provenance Note on File 2 vs Existing Omnia Cold Vault
- Direct byte/line comparison confirms `C:\Users\khang\Downloads\Omnia\Khởi động và Quy trình Omnia.md` (`580,612` B, `4,929` lines) is the Google Docs Markdown export (including the Gemini conversation URL on `L3`, two trailing spaces per line, and Google Docs backslash escapes such as `\_`, `\*`, `\[`, yielding `3,046` single backslashes) of the same source document ("Khởi động và Quy trình Omnia", Google Doc `1YSBWAIIFERK_ekjVxYUGwehQCxARZN8UMALa1AGGF2s`) previously sanitized in `D:\OmniaData\research\omnia-clean-2026-11-12\GDOC_1YSB_SANITIZED.md` (`545,379` B, `4,651` lines) and indexed into `D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json` (`708,764` B).
- **Denominator Verification**: Across `Khởi động và Quy trình Omnia.md`, `L95..655` defines `250` unique skills in `RAW_CATALOG` (`L656..1641`, `01..24`, despite early table prose saying `245` / `249` and `L394` having a whitespace typo `deep-container- slimming`), `L1642..1845` (`25..38`) adds `148`, `L1848..2075` (`39..54`) adds `167`, `L2078..2764` (`55..72`) adds `185`, `L3104..3345` (`73..90`) adds `180`, and `L4153..4252` (`91..100`) adds `71` (`9*7 + 8 = 71`) -> **`1,001` authentic unique `deep-*` skills across `100` categories** (`3,003` generated files), matching `omni-deep-1000-catalog.json` (`summary_counts.actual_unique_catalog_skills = 1001`).

---

## 2. Exhaustive Extraction from File 1 — `App Codex Desktop Siêu Nhẹ.md` (`L1..226`)

### 2.1 Evaluated Lightweight Desktop Coding-Agent Apps & Architecture Patterns (`L1..211`)

1. **CodexMonitor (Tauri + Rust + WebView2, `L12..41`)**
   - Architecture: Rust backend + native Windows **WebView2** (no bundled Chromium/Node per Electron window), **~50–100 MB RAM**, <1s startup, 0% CPU idle when waiting on streams.
   - Features: Multi-thread management, **git worktree isolation**, git diff viewer/drawer, integrated terminal, reading `~/.codex/config.toml` & `~/.codex/auth.json`, **Whisper voice-to-prompt**, and **Remote / Tailscale daemon** mode.
   - Limitations noted: Maintenance slowed/paused around Q1/2026; **lacks Automations (cron/scheduled agents)** and **built-in Browser / Computer Use**.
2. **CodexGui (Avalonia / .NET native, `L42..55`)**
   - Native desktop UI (no Electron), thread sidebar + chat + integrated terminal, lightweight Windows rendering.
3. **T3 Code (`pingdotgg/t3code`) & Pivot (`K-code` fork) (`L56..114`, `L224` `[image1]`, `L226` `[image2]`)**
   - Engineering bar: *"every single dropped frame is considered a bug"*. Thin React UI + headless Node/Effect server (`~120–180 MB` RAM without bloated IDE extension hosts).
   - **Mid-thread Multi-Agent Handoff**: Seamless mid-conversation switching across Codex, Claude, OpenCode, Kiro, Antigravity, and Copilot while keeping thread continuity.
   - **Smooth Windows WSL Execution**: Clean distro selection without ChatGPT Desktop's Windows-path/WSL2 friction.
   - **Git Worktree + 1-Click Commit / Push / PR**: First-class worktree-per-thread plus immediate Commit/Push/PR actions right from the header/diff panel.
   - **Mobile & Remote Web Access**: Accessible via **Tailscale** or local tunnel from iOS/Android browsers.
   - **Pivot (`K-code`)**: Fork combining T3 Code's low-latency desktop shell with **Oh My Pi (`omp --mode rpc`)** headless engine (`L226` screenshot).
4. **Orca (`stablyai/orca`, `L115..140`)**
   - Combines **multi-agent parallel git worktrees**, **Automations (cron / scheduled / webhook triggers)**, **built-in Browser preview**, and **Desktop Computer Use**.
5. **Zed Agent Panel (`L141..155`)**
   - Pure Rust GPU-rendered editor (`~80–150 MB` RAM), **Agent Client Protocol (ACP)** plugin host for external agents + **linked git worktrees**.
6. **Conductor (`L156..169`)**
   - Parallel worktrees + multi-agent orchestration (Claude Code + Codex), **macOS-only** (not Windows).
7. **Claude Desktop (Code & Cowork Tabs, `L170..190`)**
   - **Inline Diff Line Comments**: Click any line in a changed file diff to attach PR-style review comments and batch-send them back to the AI.
   - **Built-in Dev-Server Browser Preview**, **WSL/SSH execution**, **Computer Use**, and **Cowork** automation tab.
8. **ChatGPT Desktop Codex (`L191..211`)**
   - Heavy Electron/Chromium runtime overhead on Windows and documented WSL2 path/sandbox friction, though feature-rich (Worktrees, Automations, Computer Use).

### 2.2 Deferred Deep Research Prompt (`L212..220`)
- User requested a deep comparative ranking across all AI coding-agent desktop apps & harnesses (Claude Desktop Code/Cowork, ChatGPT Desktop Codex, Antigravity, Cursor, Windsurf, Zed, T3 Code, Conductor, Orca, OpenCode, `oh-my-pi`, Codex CLI, Claude Code) scored on deep AI orchestration, harness engineering, context/KV-cache discipline, parallelism, browser/computer use, and extensibility. The document contains the prompt + "thinking/research completed" placeholder without the full response table (`L220..226`).

---

## 3. Exhaustive Extraction from File 2 — `Khởi động và Quy trình Omnia.md` (`L1..4,929`)

### 3.1 Omnia `SESSION-G07` Boot, Governance & Harness Specification (`L1..94`)
1. **Session Admission & Deferred Launch (`L1..14`)**:
   - Goal tool state discipline (`active` vs `goal_complete` vs deferred follow-up launches).
   - `SESSION_ADMISSION.json` strict `openTransfer` gating (`DEFERRED` until frozen commit + 3 consecutive zero-defect cleanroom audits pass).
2. **Preservation, Cleanroom & Externalized Storage (`L15..24`)**:
   - Preserve dirty/index/untracked/stash work (`SOURCE_DISPOSITION_LEDGER.json`), inspect all 49-file diff classes before retiring any copy.
   - Keep `D:\Omnia` source checkout clean: out-of-source builds, caches, SQLite QA fixtures, and captures in `D:\OmniaData\`.
3. **Multi-Host History Hydration (`L25..31`)**:
   - Ingest & deduplicate session histories across Codex, OpenCode, Antigravity (`.pb`/transcripts), ChatGPT, and Downloads using per-source high-water marks and zero-secret redaction.
4. **Native Engine, Composer, Routing & Anti-Slop UI (`L32..42`)**:
   - Strict native Rust resource budgets (idle CPU, RAM, binary footprint, cold launch).
   - Caret-accurate rich Composer with Markdown/LaTeX/symbol palettes and dual attachment mode (inline-at-caret vs bottom tray).
   - `PRODUCT-CHAT`: Deterministic dynamic multi-provider routing (`quota reservations`, `circuit breakers`, secret-free routing receipts).
   - Anti-slop UI pipeline (`deep-ui-direction` -> `deep-ui-tokens` -> `deep-ui-quantitative` -> `deep-ui-qa`).
5. **Additive Steer, Triple Audit & 6-State Honesty (`L43..50`)**:
   - `ADDITIVE_INTAKE` queue, `token_budget = NULL`, reconcile before resuming backlog, 3-streak frozen cleanroom audit, and 6-state honest reporting (`Verified` / `Partial` / `Unresolved` / `Blocked` / `Next` / `Exact Practical Limits`).
6. **43-File Canonical Repository Governance Taxonomy (`L51..91`)**:
   - **Group 1 — Startup, Transfer & Session Admission (`6`)**: `AGENTS.md`, `SESSION_ADMISSION.json`, `TRANSFER_CONTRACT.md`, `DISPATCH.json`, `DEFERRED_LAUNCH.md`, `SESSION_RECORD.jsonl`.
   - **Group 2 — Goals, Planning, Tracking & Steering (`8`)**: `GOAL.md`, `PLAN.md`, `TASKS.md`, `CHECKPOINT.md`, `STATE.json`, `RUN_JOURNAL.md`, `BACKLOG.md`, `ROADMAP.md` / `STEER_QUEUE.md`.
   - **Group 3 — Verification, Receipts, Audits & Risks (`8`)**: `DOD.md`, `ACCEPTANCE_CRITERIA.md`, `RECEIPTS.json`, `EVIDENCE_LEDGER.md`, `AUDIT_LOG.md`, `FAILURE_MODES.md`, `RISK_REGISTER.md`, `POSTMORTEM.md`, `LESSONS.md`.
   - **Group 4 — Architecture, Routing, Performance & Budgets (`5`)**: `ADR.md`, `ARCHITECTURE.md`, `PROVIDER_ROUTING.json`, `DATA_FLOW.md`, `BUDGETS.md`.
   - **Group 5 — Skills, Tools, Prompts & Evaluation (`6`)**: `SKILLS.md`, `SKILL_INDEX.json`, `TOOL_DECLARATIONS.json`, `EVALS.md`, `PROMPTS.md`, `FEW_SHOTS.json`.
   - **Group 6 — Memory, Scratchpad & Context Watermarks (`6`)**: `MEMORY.md`, `SHORT_TERM_MEMORY.md`, `SCRATCHPAD.md`, `WORKSPACE_SNAPSHOT.md`, `WATERMARK.json`, `HISTORY_MANIFEST.json`.
   - **Group 7 — Source Preservation, Cleanup, Security & Secrets (`5`)**: `PRESERVATION.md`, `DISPOSITION_LEDGER.json`, `GIT_RECOVERY.md`, `CLEANUP_POLICY.md`, `QUARANTINE.md`, `SECURITY.md`, `ENV_TEMPLATE.env`.

### 3.2 4-Tier `Omni deep-*` Architecture (`L95..4,929`)

| Tier | Components in Doc (`L95..4,929`) | Exact Scale / Quantitative Bounds | Core Mechanism |
| :--- | :--- | :--- | :--- |
| **Tier 1: Knowledge Vault** | `bootstrap_deep_skills.py` (`L656..1641`), `compile_omni_750.py` (`L2136..3089`), `patch_profiles_73_90.py` (`L3358..3571`), `omni_upgrade_1000.py` (`L4631..4916`) | `100` categories (`01..100`), `1,001` unique `deep-*` skills (`250 + 148 + 167 + 185 + 180 + 71`), 3 files/skill (`SKILL.md`, `references/invariants.md`, `templates/receipt.template.md`) | Progressive disclosure: `<=90–110` tok YAML frontmatter, `<=3,500` tok body, `<5,000` tok single-read ceiling, 5-phase contract + 6-state receipt |
| **Tier 2: Zero-Bloat Runtime** | `omni_router.py` (`L3579..3871`), `omni_mcp_server.py` (`L3877..4003`), `omni_doctor.py` (`L4015..4112`), NTFS `/J` Junction bridge (`L653`, `L3735..3758`) | Startup mount: `12` core skills (`<1,000` tokens vs `~75k` tokens unsplit); BM25 query `<8 ms`; MCP output cap `MAX_CHARS_SAFE = 15,500` (~3.9k tok) | `.agents/vault/skills/` Cold Vault + `.agents/skills/` hot mounts + `VN_EN_SYNONYMS` (`30` VN->EN expansions) + NFD accent stripping + `3x` slug/`2x` artifact weighting + 4-stage `compose_dag` + JSON-RPC stdio MCP server (`omni_search_skills`, `omni_load_skill`) |
| **Tier 3: Deterministic Verifiers** | `omni_verifiers.py` (`L4258..4473`) | `6` subcommands (`preservation`, `contrast`, `bakers`, `tokens`, `secrets`, `cp-stress`) | Zero-dependency Phase-3 machine checks: SHA-256 + CRLF/LF preservation, WCAG 2.1 contrast (`>=4.5` / `>=7.0`), secret regex scan, token truncation budget, high-hydration dough DDT math, C++20 `gen`/`brute`/`sol` differential stress testing |
| **Tier 4: Pipelines, Golden Eval & Deepening** | `omni_pipelines.py` (`L4481..4625`), `omni_upgrade_1000.py` (`L4631..4916`), `expand_skills_batch.py` (`L1379..1590`) | `24` pre-wired multi-skill DAG pipelines (`OMNI_PIPELINES.json`), `16` bilingual golden eval queries (`>=95%` Top-5 recall gate), Merkle `SKILL_LOCK.json`, watermarked batch enricher (`EXPAND_WATERMARK.json`) | Numeric `int(category_id)` ordering (`01..100`), Merkle SHA-256 attestation root, 1-command multi-stage DAG mounts, and Tier-2 playbook deepener (`DEEP_EXPANDER_PROMPT.md`) replacing uniform category boilerplate with per-skill equations/tables/checklists/verifiers |

#### High-Signal Specialized Domain Packs Highlighted in `Khởi động và Quy trình Omnia.md`
- **Cat 26 (`L1664..1679`) AI Agent Harnesses & Context Economics**: `deep-prompt-cache-economics` (`>=90%` KV-cache hit rate via static Prefix-0), `deep-tool-truncation-guard` (`5k`-token head+tail preservation), `deep-compaction-continuity` (`200k` context auto-compaction preserving active goals/decisions), `deep-ast-lsp-navigation`, `deep-effort-budget-tuning`.
- **Cat 89 (`L3321..3333`) Epistemic Rigor & Anti-Hallucination**: `deep-meta-premise-trap-immunity`, `deep-meta-independent-recalc`, `deep-meta-brier-calibration`, `deep-meta-unknown-unknowns-scan`, `deep-meta-zero-truncation-pledge`, `deep-meta-adversarial-self-play`.
- **Cat 86 (`L3282..3293`) & Cat 97 (`L4213..4221`) Vietnamese-First Heritage & NLP**: UTC+7 (`105E`) Vietnamese lunisolar calendar vs UTC+8 Chinese divergence, NFC/NFD + tone normalization, compound word segmentation, streaming ASR hotwords, Vietnamese diacritic Bezier/typography collision clearance (`Cat 99`).
- **Cat 100 (`L4243..4252`) Self-Evolving Skill Governance**: `deep-omni-gap-radar-evolver` (low-score routing telemetry -> non-duplicative skill proposals), `deep-omni-golden-routing-eval`, `deep-omni-lockfile-attestation`, `deep-omni-conflict-deduplicator`, `deep-omni-supreme-closure-gate`.

---

## 4. `D:\Omnia` Cross-Check Matrix (`ALREADY_IN_OMNIA` vs `MISSING` / `UPGRADABLE`)

### 4.1 Native Desktop, Multi-Agent UI & Harness Features (File 1 + File 2 §1)

| Extracted Capability / Decision | Current `D:\Omnia` Locator / Reality | Status | Concrete Upgrade / Integration Action |
| :--- | :--- | :--- | :--- |
| **Ultra-light pure-Rust + WebView2 / Mica native desktop host** (vs heavy Electron) | `rust/omnia-native/src/studio_host.rs:1-42` (`OmniaNativeStudioMicaHost`, Win32 DWM Mica + WebView2), `rust/omnia-studio/` (`embed-ui`, SolidJS `ui-v5`, zero Electron) | **ALREADY_IN_OMNIA** | Already realized and exceeds Electron competitors (`omnia.exe` headless CLI + `omnia-studio` + `omnia-native --studio`). Measure & publish idle RAM/cold-start telemetry badge in Observatory System panel (`ui-v5/.../SystemHardwarePanel.tsx`). |
| **Multi-backend engine & ACP support** (Codex / Claude / OpenCode / Antigravity / `omp --mode rpc` + **mid-thread handoff**) | `rust/omnia-agent/src/acp.rs` defines `HarnessBackendId` (`OmniSuper`, `OmpRpc`, `GooseAcp`, `AgyAcp`, `CodexAcp`, `ClaudeAcp`); `/api/agent/backends` in `routes_studio_v5.rs:84` | **UPGRADABLE** | Backend enum + ACP protocol exist, **but** `ui-v5` Chat/TopBar lacks a **1-click mid-thread Engine/Backend Switcher** (T3 Code / Pivot UX) and `AgentSessionState` transcript handoff converter when switching backends mid-conversation. |
| **Parallel Git Worktree Isolation** (per-thread / per-agent) | `rust/omnia-agent/src/swarm_runtime.rs:32-85` (`WorktreeManager` -> `D:\OmniaData\worktrees\`); `ops_store.rs:98` (`isolation_mode DEFAULT 'worktree'`) | **UPGRADABLE** | `WorktreeManager` exists for swarm/agents, **but** `ui-v5` (`Composer.tsx`, `IdeWorkbench.tsx`, `SessionSidebar.tsx`) has **no per-thread Worktree toggle/branch badge or worktree cleanup drawer** (T3 Code / CodexMonitor / Orca UX). |
| **1-Click Git Commit / Push / PR** in Diff/IDE Workbench | `routes_studio_v5.rs` only exposes read-only `/api/git/status` & `/api/git/diff`; `IdeWorkbench.tsx` has no stage/commit/push/PR action | **MISSING** | Add explicit, gated `/api/git/stage`, `/api/git/commit`, `/api/git/push` endpoints (preserving `Yolo`/explicit confirmation safety) + Commit/Push button bar in `IdeWorkbench.tsx` Git panel. |
| **PR-Style Inline Diff Line Comments -> Resend to AI** (Claude Desktop Code tab) | `ui-v5/src/components/chat/DiffCard.tsx:1-72` uses `@pierre/diffs` read-only (`IdeWorkbench.tsx` only accepts/rejects patch) | **MISSING** | Add click-to-comment line annotations on `DiffCard.tsx` + batch "Send Review Comments to Composer/Chat" flow. |
| **Scheduled Automations / Cron Execution Daemon** (Orca / Antigravity 2.0) | `ops_store.rs:92-104` (`ops_routines` table) & `routes_studio_v5.rs:2548-2581` (`GET`/`POST /api/routines`), `recall_store.rs:761` (`record_routine_run`) | **UPGRADABLE** | **Schema + CRUD exist, but NO active background cron ticker in `omnia-studio/src/main.rs` nor any `ui-v5` UI** (`ui-v5/src` has 0 hits for `routines`!). Wire a Tokio cron scheduler task + `MissionLifecycleView` / `SwarmView` Routines panel. |
| **Smooth Windows WSL Distro Picker & Execution** (T3 Code) | `net_diag.rs:643` detects `WSL / vEthernet` NICs; `native_types.rs:21` has `HarnessEnvironment::Wsl` enum | **UPGRADABLE** | Add `wsl.exe -l -q` distro discovery + workspace path translator (`D:\...` <-> `/mnt/d/...`) + WSL shell target in `omnia-workspace-ops/src/process_ops.rs` and `IdeWorkbench` terminal selector. |
| **Whisper Offline Voice-to-Prompt in Chat Composer** (CodexMonitor) | `omnia-notebook/src/whisper_bridge.rs` + `routes_atelier_drive_v5.rs:306` wire Whisper **only for Notebook Atelier**; `Composer.tsx:251-302` falls back to `window.SpeechRecognition` (often unavailable in WebView2/headless) | **UPGRADABLE** | Expose `/api/audio/transcribe` (reusing `omnia-notebook::whisper_bridge`) so Chat `Composer.tsx` `Mic` button uses local Whisper/MediaRecorder seamlessly when `SpeechRecognition` is absent or offline. |
| **Built-in Live Dev-Server Browser Preview** (Claude Desktop) + **Browser CDP** | `BrowserWorkbench.tsx:1-418` + `routes_studio_v5.rs:1843-1960` implement isolated CDP browser launch/click/type/screenshot (live Thorium blocked) | **ALREADY_IN_OMNIA** (CDP) / **UPGRADABLE** (Dev-server UX) | Add auto-detected localhost dev-server port selector & side-by-side preview toggle in `IdeWorkbench.tsx` -> `BrowserWorkbench.tsx`. |
| **Desktop Computer Use** (Orca / Claude Cowork mouse/keyboard automation) | `omnia-media-capture/src/desktop_isolation.rs:359` only references virtual desktop capture; zero `SendInput` input-automation tool | **MISSING** (Intentionally scoped) | If desired later, design behind an opt-in virtual-desktop-isolated UIA/SendInput sandbox with explicit pause/kill hotkey (never touch user's active desktop silently). |
| **Remote / Mobile / Tailscale Access** (CodexMonitor / T3 Code) | `omnia-remote-control` crate (`crypto.rs`, `pairing.rs`, `protocol.rs`, `replay.rs`, `transport.rs`) + `routes_capabilities.rs:195-221` (`/api/remote/{status,audit,pair,session,input,frame}`) | **UPGRADABLE** | Backend pairing + encrypted frame/replay protocol is built; `ui-v5/src/api/client.ts:688` only calls `/api/remote/pair` with no full Remote Pairing/Mobile QR/Tailscale workbench UI or CLI remote daemon command. |
| **Rich Caret Composer + Dynamic Provider Router + Telemetry** | `Composer.tsx` (`LATEX_15_TEMPLATES`, inline `@[name](sha256:...)` vs tray, `4096`B paste prompt), `omnia-routing` (`DynamicProviderRouter`, quota reservations, circuit breakers), `ObservabilityView.tsx` (6 sub-tabs) | **ALREADY_IN_OMNIA** | Preserves all Steer #15–#23 guarantees; keep aligned during future UI additions. |
| **Default Execution Mode (`Yolo` vs `request-review`)** | `PermissionsEngine::default_rules()` runs `ApprovalMode::Yolo` (`Steer #22` `05eafbb`) | **COMPATIBILITY_GUARD** | Keep `Yolo` default intact; never regress Steer #22 tests when porting strict rules (`opt-in` only). |

### 4.2 4-Tier `Omni deep-*` Skills, Verifiers & Governance Architecture (File 2 `L51..4,929`)

| Doc Artifact / Pattern (`Khởi động và Quy trình Omnia.md`) | Current `D:\Omnia` Locator / Reality | Status | Concrete Notes & Upgrade Path |
| :--- | :--- | :--- | :--- |
| **External Cold Vault `1,001` Skills (`0` Repo Stubs)** (`L3349..3352`) | `D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json` (`100` cats, `1,001` skills) + `omnia-harness/src/skill_registry.rs:18-21,441-520` + `D:\Omnia\.agents\skills\` (`22` curated atomic skills) | **ALREADY_IN_OMNIA** (Superior hygiene!) | Omnia deliberately improved on the doc by loading the 1,001 catalog as read-only JSON (`DEFAULT_COLD_VAULT_PATHS`) instead of creating 3,003 stub files inside the tracked Git checkout. `KnowledgeExtensionsView.tsx:887` (`skills_vault` tab) already renders Hot/Cold + token gauge + 24 pipelines. |
| **Bilingual BM25 + Fuzzy Router & 4-Stage DAG** (`omni_router.py` `L3579..3871`) | `.agents/skills/omni-bilingual-skill-router/scripts/skill_router.py` (`702` lines) & `omnia-harness/src/skill_registry.rs:202,672` (`37` `VN_EN_SYNONYMS` pairs, bounded Levenshtein fuzzy matching, 4-stage DAG) | **ALREADY_IN_OMNIA** (Extended) | Omnia's `skill_router.py` & Rust `SkillRegistry` already exceed the doc's 30-entry map (`37` Rust entries, more in Python, plus `typo` VNI/Telex/fuzzy dist<=1). |
| **24 Pre-Wired DAG Pipelines & 16-Case Golden Eval** (`L4481..4916`) | `skill_registry.rs:1256-1365` (`default_24_pipelines()`, `golden_16_bilingual_routing_benchmark_meets_95_percent_top5_recall`) & `skill_router.py:75,656` | **ALREADY_IN_OMNIA** | Implemented in both Rust unit-tested `SkillRegistry` and Python `skill_router.py`. Keep the golden eval running against the **full merged active+cold-vault 1,023-skill index** in CI (not only synthetic 16-skill subsets!). |
| **Skill Doctor & Parity Validator** (`omni_doctor.py` `L4015..4112`) | `skill_registry.rs:732-780` (`<=110`/`<=3500` tok + Merkle SHA-256) + `tools/omnia-skill-parity/validate_skills.py` (`22/22` 3-host sync, mojibake detector, reparse-point safety) | **ALREADY_IN_OMNIA** | Omnia's `validate_skills.py` adds CP1252/double-UTF-8 mojibake detection and Windows reparse-point safety beyond the doc. |
| **Deterministic Phase-3 Verifiers** (`omni_verifiers.py` `L4258..4473`) | `.agents/skills/omni-deterministic-verifiers/scripts/verify_pack.py` (`preservation`, `contrast`, `secrets`, `tokens`, `skill-doctor`) + `tools/omnia-consolidated-audit/audit.py` | **UPGRADABLE** | `verify_pack.py` ports 4 of the 6 subcommands + adds `skill-doctor`, **missing `cp-stress`** (compiled `gen` vs `brute` vs `sol` stress harness for competitive/algorithm verification) and `bakers` (optional). |
| **Omnia as an External Stdio MCP Server** (`omni_mcp_server.py` `L3877..4003`) | `omnia-agent/src/mcp_client.rs` (Omnia acts as MCP *client*); `routes_studio_v5.rs` exposes HTTP `/api/mcp/*`; `omnia-cli/src/main.rs` has **no `--mcp` stdio server mode** | **MISSING** | Adding `omnia --mcp` stdio JSON-RPC server (exposing `omni_search_skills`, bounded `omni_load_skill` `<15.5k` chars, `graphify_query`, `rag_search`, `deep_think`) lets Codex CLI, OpenCode, Claude Code, and `agy` invoke Omnia's Rust engines natively! |
| **Tier-2 Playbook Deepening (`expand_skills_batch.py`, `L1379..1590`)** | Cold vault entries in `omni-deep-1000-catalog.json` remain concise `focus_en`/`description_vi` metadata; Tier-2 watermarked deep enrichment not yet materialized for top technical skills | **UPGRADABLE** | Keep JSON compact, **or** optionally pre-compute rich Tier-2 checklists/verifiers into external `D:\OmniaData\research\omnia-tier2-playbooks.jsonl` for Categories `01..29`, `63..64`, `89..100` while maintaining zero in-repo stub bloat. |
| **Self-Evolving Gap Radar Telemetry (`deep-omni-gap-radar-evolver` `L4245`)** | `skill_registry.rs:785` has `codify_skill` with semantic overlap check, **but** no automatic telemetry log of low-score `<threshold` routing misses triggering `SkillGapProposal` | **MISSING** | Log low-confidence routing queries (`score < min_threshold` or repeated misses) into `ops_store` -> surface "Suggested Learned Skill" card in `KnowledgeExtensionsView` (`codify_skill`). |
| **7-Group / 43 Governance Files (`L51..91`)** | `docs/workspace/` (`STATUS.md`, `GOAL.md`, `DOD.md`, `CHECKPOINT.md`, `STEER_QUEUE.md`, `TRANSFER_CONTRACT.md`, `SESSION_ADMISSION.json`, etc. + `MEMORY`/`LESSONS` in `docs/handoff/` & `.agents/`) | **ALREADY_IN_OMNIA** (Core subset) / **UPGRADABLE** | Omnia intentionally consolidated redundant taxonomy entries (avoiding parallel status sprawl per `AGENTS.md`). Selected high-ROI missing pieces worth keeping structured in `ops_store` or `docs/workspace/`: formal `RISK_REGISTER.md` / `FAILURE_MODES.md` cross-index & explicit `BUDGETS.md` SLA sheet for headless CLI/Studio RSS & latency. |

---

## 5. `agy` & `agy-fast` Integration Candidates

Based strictly on observed structures in `C:\Users\khang\.gemini\antigravity\builtin\skills\` (`16` built-in skills + `references/{cli,app,ide}.md`) and `C:\Users\khang\.gemini\antigravity\scratch\agy-fast\` (`v0.23.0` native Rust plugin: `native/src/`, `skills-taxonomy.json`, `guard-config.json`, `mcp_config.json`, `hooks.json`) + `C:\Users\khang\.gemini\config\plugins\agy-fast\omni-vault\`:

### 5.1 Candidates Already Present in `agy-fast` (Baseline Verified)
- `C:\Users\khang\.gemini\config\plugins\agy-fast\omni-vault\` ALREADY stores all **`1,001` physical `SKILL.md` skill directories across `100` categories** + `SKILL_INDEX.json` + `SKILL_LOCK.json` + `OMNI_PIPELINES.json` (`<5.1`k-line `omni_skills.rs` + `semantic_router.rs` Model2Vec + BM25).
- `agy-fast` already implements: 11 eager MCP tools (`batch_search`, `apply_edits`, `read_slices`, `quick_outline`, `run_checks`, `memory_sync`, `workspace_health`, `research_vault`, `omni_skills`, `super_engine`, `canvas_studio`), 6 lifecycle hooks (`SessionStart` -> `Stop`), CLI `worktree` subcommand (`gitflow.rs:393`), `net_lab.rs` (Tailscale detection + bufferbloat/DNS), `audit.rs` (`redact_proxy_string` + ToS env checks), and `skills-taxonomy.json` Tier-1 (`383` skills) vs Tier-2 (`618` skills) split.

### 5.2 High-ROI Missing / Upgradable Candidates for `agy` (Antigravity 2.0 / CLI / IDE)
1. **Inline PR-Style Diff Line Comments (`IDE` & `Antigravity 2.0`)**: Antigravity IDE/App currently renders visual diff overlays (`references/ide.md:65-67`), **but** adding Claude-Desktop-style per-line clickable diff comments that batch into the next chat turn avoids copy-pasting line ranges.
2. **Smooth Windows WSL Distro Switcher (`agy` CLI & IDE Terminal Sandbox)**: Inspired by T3 Code (`File 1 L76-82`) — clean distro picker (`Ubuntu`, etc.) with automatic Windows<->WSL path mapping inside `Antigravity 2.0` project settings (`references/app.md:66-79`).
3. **Mid-Thread Engine / ACP Handoff & Thin Desktop Shell Option**: Adopting T3 Code / Zed ACP interoperability and keeping a low-RAM WebView2/Rust frame option alongside Electron (`Antigravity 2.0`, `references/app.md:3`) eliminates Electron's heavy multi-hundred-MB baseline per window.
4. **Native Cold-Vault `SKILL_INDEX.json` Discovery (`~/.gemini/config`)**: Instead of linear startup scanning of large skill sets, natively support indexed cold-vault lookup (`<=1,000` tok active startup budget + on-demand `omni_load_skill` bounded `<4,500` tok).
5. **Composer Offline Voice Input (Whisper Fallback)**: Add local speech-to-text capture alongside drag-and-drop media uploads in Chat Canvas (`references/app.md:31-33`).

### 5.3 High-ROI Missing / Upgradable Candidates for `agy-fast` (`scratch/agy-fast`)
1. **Tier-2 Deep Playbook Enrichment (`expand_skills_batch.py`) in `omni-vault`**: Sampling `C:\Users\khang\.gemini\config\plugins\agy-fast\omni-vault\skills\deep-ab-experimentation\SKILL.md` shows it is currently only `42` lines of uniform Tier-1 category template. Running watermark-resumable Tier-2 enrichment (equations, parameter tables, anti-pattern traps, 1-command verifiers) across `skills-taxonomy.json`'s **`383` Tier-1 Core skills** (`Cat 01..23, 25..29, 31, 46, 63, 64, 89, 96, 97, 100`) will turn boilerplate entries into genuine specialist guides.
2. **Native Rust Phase-3 Verifier Suite in `run_checks` / `audit.rs`**: Port `omni_verifiers.py`'s `preservation` (mixed CRLF/LF + disallowed ASCII control bytes + SHA-256), `contrast` (WCAG 2.1 ratio checker), `tokens` (5k truncation risk estimator), `secrets` scan, and `cp-stress` (compiled generator vs brute vs optimal C++/Rust checker) directly into `agy-fast` `run_checks` actions with `<=8,400` B MCP caps (`mcp.rs` / `omni_skills.rs:8`).
3. **16-Case Bilingual Golden Routing CI Gate & Merkle Check in `workspace_health`**: Verify `omni_skills` + `semantic_router` hits **`>=95%` Top-5 Recall** across all 16 Vietnamese/English benchmark cases (`L4764..4781`) AND cross-check `SKILL_LOCK.json` Merkle SHA-256 root on `workspace_health` / `scripts/test.mjs` so drift is caught immediately.
4. **Sync Updated `VN_EN_SYNONYMS` & Modern `24` Pipelines from Omnia**: `Omnia`'s `skill_registry.rs` (`37` `VN_EN_SYNONYMS` pairs) + `skill_router.py` (`24` Omnia v5 pipelines such as `omnia-deep-research`, `omnia-deep-think`, `peer-mesh-swarm-delivery`, `network-observatory-qa`, `ai-router-lab-audit`) should be merged into `agy-fast`'s `omni_skills.rs` and `omni-vault/OMNI_PIPELINES.json` alongside its existing domain pipelines.
5. **Expose `gitflow.rs` Worktrees + Commit/Push/PR + Inline Diff Comments in `native/web/` & `tui.rs`**: `gitflow.rs:393` already implements CLI `worktree` (`add/list/prune`), while `native/web/` (`app.js`, `index.html`) lacks interactive worktree isolation cards, 1-click commit/PR triggers, and inline diff line comment batching.
6. **Self-Evolving Skill Gap Telemetry (`deep-omni-gap-radar-evolver`)**: Record low-confidence `omni_skills(route)` queries (`top1_score < threshold`) into `.agents/memory/` so `/learn` and `super_engine` automatically propose crisp non-overlapping skill updates (checked against `external_dedup_blocklist` in `skills-taxonomy.json`).
7. **Policy Alignment Guard on Concurrency Caps**: Note `agy-fast/guard-config.json:227` currently enforces `maxSubagentsPerSession: 12` and `maxStopHookContinuations: 3`. While Stop-loop blocking (`blockZeroProgressStopLoop: true`) is essential against `0`-progress spam, ensure subagent coordination for `agy-fast`'s `super_engine` aligns transparently with explicit user swarm tasks rather than silently stalling legitimate multi-shard peer-mesh runs.

---

## 6. Open Gaps / Next Safe Actions
- **Wave 1 Read-Only Constraint Respected**: Zero files in `D:\Omnia` or `C:\Users\khang\.gemini` were modified.
- **Suggested Wave 2 Prioritization (for `@coordinator` & Peer Mesh)**:
  1. *(Omnia)* Add `omnia --mcp` stdio server exposing Omnia's `1,001`-skill router, `GraphifyIndex`, and `ProactiveRag` (`<15.5 KB` bounded responses) so external CLIs (`codex`, `opencode`, `agy`) plug directly into Omnia.
  2. *(Omnia)* Wire `ops_routines` Tokio cron execution loop + `MissionLifecycleView` UI, per-thread `WorktreeManager` UI/header badge + 1-click Git Commit/Push/PR, PR-style inline diff comments in `DiffCard.tsx`, and `Composer.tsx` offline Whisper fallback.
  3. *(`agy` / `agy-fast`)* Enrich `383` Tier-1 `omni-vault` playbooks via `expand_skills_batch`-style pipeline, embed deterministic `preservation`/`contrast`/`tokens`/`cp-stress` checks in `run_checks`, sync Omnia's `37+` bilingual synonyms + `24` v5 pipelines, and add the `16`-case Golden Eval + `SKILL_LOCK.json` CI gate.
