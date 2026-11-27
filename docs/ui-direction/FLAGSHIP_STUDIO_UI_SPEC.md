# Flagship Studio UI Specification — "Obsidian Kinetic Atelier"

- **Document ID:** `OMNIA-FLAGSHIP-STUDIO-UI-20261112`
- **Owning Surface:** `ui/` (`index.html`, `styles/{tokens,themes,layout,components}.css`, `app/{api,composer,peer-graph,router-lab,ide-explorer,memory-vault,command-palette,main}.js`)
- **Runtime Host:** Full Native Rust `omnia-studio.exe` (`rust/omnia-studio/`, migrating the archived Wave 4 C++20 host backed up in `D:\OmniaData\backups\pre-full-rust-20261115\`, `127.0.0.1:<port>` loopback JSON-RPC + OS Edge/WebView2 `--app` surface, `0` Electron/Node runtime overhead, plus standalone offline fallback checks)
- **Related Governance & Specs:** [DIRECTION_DECISION.md](./DIRECTION_DECISION.md) · [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md) · [DYNAMIC_ROUTING_REQUIREMENTS.md](../workspace/DYNAMIC_ROUTING_REQUIREMENTS.md) · [BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
- **Skill Compliance:** `deep-ui-taste` · `modern-tech-ui-design`

---

## 1. Visual Thesis & Anti-Slop Craftsmanship (`deep-ui-taste`)

### 1.1 Product-Specific Aesthetic Thesis: *Obsidian Kinetic Atelier*
Omnia Studio serves systems engineers, researchers, and bilingual Vietnamese/English builders orchestrating 2-way all-to-all Rust agent swarms, auditing deterministic multi-provider routing, and authoring scientific derivations. **Obsidian Kinetic Atelier** derives its visual identity directly from precision optical instrumentation and architectural drafting tables rather than generic SaaS chat templates:

1. **Calibrated Luminance Layering Over Blur/Gradients:** Spatial hierarchy is established strictly through 5 solid luminance steps (`--bg-canvas` → `--bg-rail` → `--bg-panel` → `--bg-elevated` → `--bg-interactive`), crisp `1px` hairline structural borders, and a `1px` top specular bevel (`inset 0 1px 0 var(--border-specular)`).
2. **Tabular Telemetry Discipline:** Every latency, token quota, byte count, SHA-256/FNV-1a digest, epoch, and score waterfall uses `Cascadia Mono` / `Consolas` with `font-variant-numeric: tabular-nums` so live updates never induce horizontal jitter.
3. **Zero-CDN Publication-Grade Math & Code Rendering:** Scientific expressions (`\sum`, `\int`, `\oint`, `\frac`, `\sqrt`, `\nabla \times \mathbf{E}`, `i\hbar\frac{\partial \Psi}{\partial t}`, `\rightleftharpoons`, `\begin{pmatrix}...\end{pmatrix}`) and Rust/system source blocks render into semantic HTML/CSS math stacks and syntax-highlighted tokens with **zero** external network or CDN requests.
4. **Dual-Origin Determinism:** Every module registers cleanly on `window.OmniaStudio` without ES-module `file://` CORS breakage and includes a pure-JS RFC-6234 SHA-256 implementation so content-addressed attachment deduplication and cryptographic `ErasureReceipt` generation work identically over `127.0.0.1` loopback HTTP and standalone offline inspection.

### 1.2 Adversarial Anti-Slop Audit Ledger

| Pattern Audited | Inspection Method | Result | Architectural Rationale |
|---|---|---|---|
| **Purple/pink/cyan decorative gradients** | Regex scan (`linear-gradient`, `radial-gradient`) across `ui/styles/*.css` | **PASS (`0` matches)** | Tonal hierarchy comes from measured solid surface steps and `1px` borders |
| **Glassmorphism blur layers** | Regex scan (`backdrop-filter`) across `ui/styles/*.css` | **PASS (`0` matches)** | Preserves subpixel ClearType crispness and `0` idle GPU blur cost |
| **Arbitrary candy pills** | Radius audit across `tokens.css` & `components.css` | **PASS (`2px–8px` chamfers)** | Badges use `2px` chamfers paired with geometric state symbols (`◆`, `▲`, `■`) |
| **External CDN / third-party URLs** | Full-tree scan across `ui/**` | **PASS (`0` URLs)** | Satisfies strict `default-src 'self'` CSP and air-gapped offline execution |
| **Dead decorative mock buttons** | Interactive DOM + CDP verification across all 5 views | **PASS (`0` dead buttons)** | Every toolbar button, circuit toggle, BFS control, and modal executes live state transitions |
| **Silent coercion of `Unknown`/`Stale` quota** | Router Lab & `api.js` inspection | **PASS** | `QuotaState::Unknown` and `QuotaState::Stale` render explicit warning badges and fence unsafe routes |
| **Fabricated reading of locked archives** | Attachment tray `.7z` sample verification | **PASS** | `exam_solutions_locked.7z` renders explicit `ENCRYPTED_UNRESOLVED (0 B read)` |

---

## 2. Token Architecture & Verified WCAG 2.2 Contrast Matrix (`modern-tech-ui-design`)

All foreground/background pairs across all **3 instant studio themes** (`Obsidian Atelier`, `Alabaster Editorial`, `Midnight Blueprint`) were verified using exact IEEE-754 sRGB relative luminance ($L = 0.2126 R_{lin} + 0.7152 G_{lin} + 0.0722 B_{lin}$), exceeding the `>= 4.8:1` floor across **every** surface (`canvas`, `rail`, `panel`, `elevated`):

### 2.1 Theme 1 — **Obsidian Atelier** (`[data-theme="obsidian"]`, Default Dark Flagship)
- **Surfaces:** `--bg-canvas: #080A0F` · `--bg-rail: #0C0F16` · `--bg-panel: #111621` · `--bg-elevated: #171E2C`
- **Borders:** `--border-subtle: rgba(255,255,255,0.075)` · `--border-specular: rgba(255,255,255,0.12)`

| Semantic Token | Hex | vs `canvas` (`#080A0F`) | vs `rail` (`#0C0F16`) | vs `panel` (`#111621`) | vs `elevated` (`#171E2C`) | Min Ratio / Grade |
|---|---|---:|---:|---:|---:|---|
| `--ink-primary` | `#F2F5FA` | `18.12:1` | `17.54:1` | `16.56:1` | `15.27:1` | **`15.27:1` (AAA)** |
| `--ink-secondary` | `#C3CDDE` | `12.36:1` | `11.96:1` | `11.29:1` | `10.42:1` | **`10.42:1` (AAA)** |
| `--ink-muted` | `#8E9BB2` | `7.05:1` | `6.83:1` | `6.45:1` | `5.94:1` | **`5.94:1` (AA+)** |
| `--accent-amber` | `#F0B44C` | `10.69:1` | `10.35:1` | `9.77:1` | `9.01:1` | **`9.01:1` (AAA)** |
| `--accent-cyan` | `#38BDF8` | `9.24:1` | `8.95:1` | `8.45:1` | `7.79:1` | **`7.79:1` (AAA)** |
| `--status-emerald` | `#34D399` | `10.30:1` | `9.97:1` | `9.41:1` | `8.68:1` | **`8.68:1` (AAA)** |
| `--status-coral` | `#FB7185` | `7.36:1` | `7.12:1` | `6.72:1` | `6.20:1` | **`6.20:1` (AA+)** |

### 2.2 Theme 2 — **Alabaster Editorial** (`[data-theme="alabaster"]`, Warm Museum-Paper Daylight)
- **Surfaces:** `--bg-canvas: #F6F5F0` · `--bg-rail: #EEECE4` · `--bg-panel: #FFFFFF` · `--bg-elevated: #F9F8F4`

| Semantic Token | Hex | vs `canvas` (`#F6F5F0`) | vs `rail` (`#EEECE4`) | vs `panel` (`#FFFFFF`) | vs `elevated` (`#F9F8F4`) | Min Ratio / Grade |
|---|---|---:|---:|---:|---:|---|
| `--ink-primary` | `#11141C` | `16.87:1` | `15.56:1` | `18.41:1` | `17.32:1` | **`15.56:1` (AAA)** |
| `--ink-secondary` | `#2E3646` | `11.11:1` | `10.25:1` | `12.12:1` | `11.41:1` | **`10.25:1` (AAA)** |
| `--ink-muted` | `#4E586E` | `6.53:1` | `6.03:1` | `7.13:1` | `6.71:1` | **`6.03:1` (AA+)** |
| `--accent-amber` | `#945200` | `5.55:1` | `5.12:1` | `6.06:1` | `5.70:1` | **`5.12:1` (AA+)** |
| `--accent-cyan` | `#0B5CAB` | `6.14:1` | `5.67:1` | `6.70:1` | `6.31:1` | **`5.67:1` (AA+)** |
| `--status-emerald` | `#0B6B49` | `5.99:1` | `5.52:1` | `6.53:1` | `6.15:1` | **`5.52:1` (AA+)** |
| `--status-coral` | `#B81D3A` | `5.87:1` | `5.42:1` | `6.41:1` | `6.03:1` | **`5.42:1` (AA+)** |

### 2.3 Theme 3 — **Midnight Blueprint** (`[data-theme="blueprint"]`, Aerospace CAD Deep-Navy)
- **Surfaces:** `--bg-canvas: #070E1B` · `--bg-rail: #0A1324` · `--bg-panel: #0E1A30` · `--bg-elevated: #13223D`

| Semantic Token | Hex | vs `canvas` (`#070E1B`) | vs `rail` (`#0A1324`) | vs `panel` (`#0E1A30`) | vs `elevated` (`#13223D`) | Min Ratio / Grade |
|---|---|---:|---:|---:|---:|---|
| `--ink-primary` | `#EDF5FF` | `17.57:1` | `16.88:1` | `15.80:1` | `14.43:1` | **`14.43:1` (AAA)** |
| `--ink-secondary` | `#BFD2EC` | `12.55:1` | `12.06:1` | `11.29:1` | `10.31:1` | **`10.31:1` (AAA)** |
| `--ink-muted` | `#8BA3C7` | `7.50:1` | `7.21:1` | `6.75:1` | `6.16:1` | **`6.16:1` (AA+)** |
| `--accent-amber` | `#F4BE58` | `11.36:1` | `10.92:1` | `10.22:1` | `9.33:1` | **`9.33:1` (AAA)** |
| `--accent-cyan` | `#4CC9FF` | `10.21:1` | `9.81:1` | `9.19:1` | `8.39:1` | **`8.39:1` (AAA)** |
| `--status-emerald` | `#3CE0A6` | `11.41:1` | `10.96:1` | `10.26:1` | `9.37:1` | **`9.37:1` (AAA)** |
| `--status-coral` | `#FF7D90` | `7.90:1` | `7.59:1` | `7.10:1` | `6.49:1` | **`6.49:1` (AA+)** |

---

## 3. Five Flagship Workbenches & Loopback `/api/*` Bindings

| Workbench View | Module | Key Interactive Capabilities | Bound `omnia-studio.exe` Endpoints |
|---|---|---|---|
| **1. Studio Chat & Scientific Rich Composer** | `app/composer.js` | Multi-turn provenance cards (`EXTRACTED`, `INFERRED`), collapsible reasoning trace, syntax-highlighted Rust copy receipt, live `ADDITIVE_INTAKE` Steer Queue (`token_budget: NULL`), 15-template LaTeX math/physics/chemistry palette, SHA-256 deduplicated inline + tray attachments, `Esc` zero-mutation paste chooser | `GET /api/composer/templates`, `GET /api/steer`, `POST /api/steer/enqueue`, `POST /api/router/decide` |
| **2. 2-Way `PeerMeshGraph` & `Graphify` Canvas** | `app/peer-graph.js` | High-DPI `devicePixelRatio` `<canvas>` + accessible node selector strip, curved bidirectional `A <-> B` `Duplex` arcs with directional particles, `disjoint_paths` & `epoch`/`max_hops` inspector, live 2-way pulse dispatch, `Forward`/`Reverse`/`Both` Graphify BFS with quarantined `AMBIGUOUS` edges | `GET /api/graph`, `POST /api/graph/send`, `GET /api/graph/traverse` |
| **3. Dynamic Provider Router Lab** | `app/router-lab.js` | Task class, token slider, privacy boundary, SSE toggle, per-provider **Trip / Reset Circuit Breaker** controls, visual 5-segment score waterfalls, explicit `Known`/`Stale`/`Unknown` quota meters, secret-redacted `RouteDecisionReceipt` JSON | `GET /api/router/state`, `POST /api/router/decide` |
| **4. Native Rust Architecture & Proactive RAG** | `app/ide-explorer.js` | Interactive 17-crate Rust workspace explorer (`omnia-winsqlite` .. `omnia-notebook` / `omnia-agent`) with Windows 11 SDK link badges & Graphify jump + bilingual EN/VN `ProactiveRag` uncertainty analyzer without `"search"` keyword (`citedSources` vs quarantined `unusedSources`) | `POST /api/rag/plan` |
| **5. `MemoryGraph` & Curated Skill Vault** | `app/memory-vault.js` | Hierarchical namespace filter (`workspace/*`, `architecture/*`, `lessons/*`), `..`/`\` containment-guarded memory upsert, cryptographic erasure generating SHA-256 `ErasureReceipt` (`verifiedPlaintextFree: true`), instant EN/VN BM25 skill search | `GET /api/memory`, `POST /api/memory/upsert`, `POST /api/memory/erase`, `GET /api/skills?q=` |
| **Global Shell & `Ctrl+K` Command Palette** | `app/main.js`, `app/command-palette.js` | Live `/api/health` (`LIVE_RUST`) telemetry header pill, instant 3-theme persistence, SQLite WAL cooperative session switcher, fuzzy `Ctrl+K` modal across views/themes/LaTeX/simulations | `GET /api/health`, `GET /api/sessions`, `POST /api/sessions/create` |

---

The command palette ranks contiguous matches in a command title, group, or keywords above subsequence matches, even at the end of a long keyword list. Enter runs the highlighted result.

Chat is the initial view. Completing asynchronous startup requests must not switch away from a workbench the user has already selected.

## 4. Quantitative Viewport & Non-Clipping Geometry Contract

- **Master 3-Row `100dvh` Frame (`styles/layout.css`):** `grid-template-rows: 48px minmax(0, 1fr) 28px` guarantees the bottom `28px` UIA & draft-checksum status bar is **never** clipped across any desktop viewport height.
- **Responsive Breakpoints & Zero Horizontal Overflow:**
  - `1440 × 900`: Full `224px` navigation/session rail + dual-pane studio workbenches (`0 px` horizontal overflow).
  - `1220 × 820`: Compact `192px` rail + calibrated inspector widths (`0 px` horizontal overflow, `0 px` bottom status clipping).
  - `1024 × 768`: Automatic `56px` icon-rail collapse (expandable anytime via `Ctrl+B`) + single-column composer preview adaptation (`0 px` horizontal overflow).

---

## 5. Steer #15..#17 `ui-v5` OMP + Trae + VS Code Studio Shell & 10-Dimension Observatory (Verified `0b8be95`)

- **Stack & Out-of-Source Bundle (`ui-v5/`):** SolidJS + Tailwind CSS + Vite + CodeMirror + `@xterm/xterm` + `katex` + `@pierre/diffs` + `mermaid` (`ui-v5/vite.config.ts` resolves workspace packages from `D:\OmniaData\build\ui-deps` and caches under `D:\OmniaData\build\ui-vite-cache`), building cleanly out-of-source into `D:\OmniaData\build\ui-dist` (`543` files, `17.58 MiB`; `tsc --noEmit` `rc=0`, `0` CDNs, `0` `backdrop-filter`, `0` purple-pink gradients).
- **Asset Precedence in `omnia-studio.exe` (`rust/omnia-studio/src/embedded_ui.rs`):** When launched without an explicit custom `--ui-root`, `omnia-studio` resolves `D:\OmniaData\build\ui-dist` -> `<ws>/ui-v5/dist` -> compile-time `rust-embed` (`--features embed-ui`) BEFORE falling back to legacy `ui/` (`embedUiPrecedenceOk: true`; Vite `ui-dist` build always precedes `omnia-studio --features embed-ui`).
- **Steer #17 Observatory & Shell Depth (`552438a` + `0b8be95`):** Adds 6 modular `obs/*` panels (`AiTelemetryPanel.tsx` percentiles/sparklines/waterfall/cache-bust/alerts, `RouterLabPanel.tsx` 5-segment score waterfalls/SQLite Trip+Reset/runway/redacted receipts, `NetworkSpeedtestPanel.tsx` dual-stack IP/NIC/VPN/DNS/Proxy/TLS + live cancellable WS Speedtest & Bufferbloat `A+..F`, `SystemHardwarePanel.tsx` CPU/RAM/VRAM/Disks/RSS/WAL/Ports, `BenchmarkScoreboardPanel.tsx` live `/api/benchmarks/scoreboard` v5 workbench, `VaultDiffExportPanel.tsx` CredMan/4-way Diff/4 One-Click Exports), Global Privacy Mask (`P` hotkey + `MASK:ON` status badge), expanded `Ctrl+K` Command Palette, `SteerQueueDrawer` (`ADDITIVE_INTAKE`, `token_budget: NULL`), `RewindPreviewModal`, and deepened zero-dead-button Chat/IDE/Browser/Swarm/Atelier/OmniDrive/Knowledge workbenches (`123/123` Studio route parity).
- **4×4 4x-CPU Playwright Oracle & Mica Host (`D:\OmniaData\qa\v5-verify\steer17-playwright-0b8be95.json`, `0b8be95`):** Verified `PW_RC=0` & `MICA_RC=0` under `cpuThrottleRate: 4` across **16/16 (`4` themes × `4` viewports)** (`obsidian`, `titanium`, `alabaster`, `blueprint` WCAG `>= 5.94:1`; `1440×900`, `1280×720`, `1220×820`, `1024×768`; `overflowX: 0`, `statusClipped: false`), live Hardware/WAL (`8` cores, `10.39/15.84 GiB` RAM, `4096 MiB` VRAM, `C:`/`D:`, `omnia-*` RSS, WAL rows, listening ports), Router Lab 5-segment score waterfalls, Global Privacy Mask `P`, `consoleErrors: []`, `pageErrors: []`, `server5xx: []`, `client4xx: []`, and `externalRequests: []`.

---

## 6. Steer #18..#21 Flagship `ui-v5` Expansion & Collaborator PR #1 Modular Fallback `ui/` Reconciliation (Verified `2d4087f` & `f76b4a5`)

- **Primary Flagship `ui-v5/` (`Steer #18..#21`, `c35c77c` + `2d4087f`, `embed-ui` priority):** Extends §5 (`D:\OmniaData\build\ui-dist` `543` files / `17,766.49 KiB`, `UI_DIST_CDN_HITS=0`, embedded in `omnia-studio.exe` SHA-256 `4AC5449E...6BEC`) with Universal Markdown/LaTeX (`$PATH`-safe inline-code protection, `\ce{}`/`\pu{}`, Copy TeX, GitHub Callout Alerts, Footnotes, clickable inline `[S###]`/`[G###]` citation chips, IDE Code Cards w/ sandboxed SVG/HTML/Mermaid preview), `SourcePreviewModal` (PDF/Image/Audio-Video/CSV-XLSX/`.ipynb`/`.zip`/`.tex`/Binary Hex+SHA-256), Default-ON `Deep Research: Auto` + `Deep Think: Auto` + `RAG: Local+Global` controls & `ResearchSourceDrawer` ("Sources (Searched, Viewed & Extracted)" ledger), `MissionLifecycleView` (12 cross-linked artifacts + 6-state receipts + `.agents/super/state.json` + non-clipping `minmax(0,1fr)`/`min-w-0` bidirectional link & Deep Think grids), `KnowledgeExtensionsView` (Hot/Cold 1,001-Skill Vault + `<1,000` tok budget gauge + 4-stage DAG Composer + Local/Global RAG browser), 4-Tab `OmniDriveView` Protocol Studio (`MANUAL_VISIBLE_BROWSER_ONLY`, `autoSolvePermitted: false`), and live `BenchmarkScoreboardPanel.tsx` `pass_at_1_pct`/`by_effort` descending sort (`#1 omnia 90.8% (69/76)`).
- **Phase 4 Playwright & Visual Verification (`D:\OmniaData\qa\v5-verify\wave4-playwright-oracle.json` at `2d4087f`):** Verified `PW_RC=0`, `MICA_RC=0`, `passed: true` across **`16/16`** 4×4 theme×viewport cells (WCAG `>= 5.94:1`, `0px` overflow, `layoutContinuityOk: true`), `hasRealV5Scoreboard: true`, **`lifecycleLinkOk: true`** (`linkBtnVisible: true`, `linkBtnClipped: false`, `btnRight: 1409 <= cardRight: 1424`), `0` console/page/4xx/5xx/external errors, Mica capture SHA-256 `E5E78B8E...`, and pixel-inspected visual screenshots.
- **Modular Zero-Bundler Fallback `ui/` (`Steer #21` — PR #1 `origin/pr-1` = `04899e6` Semantic Merge, `f76b4a5`):** Reconciles collaborator `thtt0120` (HTMusTC)'s zero-bundler `ui/` rebuild (`OMNIA-STUDIO-UI-REBUILD-20261113`) directly onto Full Native Rust `omnia-studio.exe` fallback paths (`0` stale C++20 labels, `0` fabricated fixture fallbacks):
  - **Modular Structure & Verified Tests:** `ui/index.html`, `ui/favicon.svg`, `ui/styles/{tokens,base,components,layout}.css` + `ui/styles/views/**`, `ui/app/{api,core/*,lib/*,views/*}.js` (`59/59` `node --check` PASS), and **`11` automated Node JS unit test suites (`119/119` `node --test` PASS in `post_01e226b_audit.json`)** covering transport/abort deadlines (`AUD-06/22`), session revision races (`AUD-20/32`), overlay focus/close guards (`AUD-23`), local data erasure receipts (`AUD-21`), and command palette contiguous-match ranking.
  - **Information Architecture & Honesty Contract:** 5 views (`#/chat` Hội thoại, `#/agents` Tác tử, `#/routing` Định tuyến using side-effect-free `SIMULATED_DETERMINISTIC` previews per `AUD-09`, `#/knowledge` Tri thức, `#/settings` Cài đặt), Vietnamese-first + English toggle, dark/light/system themes, explicit offline/empty/error states (never inventing server replies), zero external CDNs, zero inline scripts/event handlers, and `0` idle `requestAnimationFrame` loops.
