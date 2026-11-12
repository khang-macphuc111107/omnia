# Flagship Studio UI Specification — "Obsidian Kinetic Atelier"

- **Document ID:** `OMNIA-FLAGSHIP-STUDIO-UI-20261112`
- **Owning Surface:** `ui/` (`index.html`, `styles/{tokens,themes,layout,components}.css`, `app/{api,composer,peer-graph,router-lab,ide-explorer,memory-vault,command-palette,main}.js`)
- **Runtime Host:** Native C++20 `omnia-studio.exe` (`127.0.0.1:<port>` loopback JSON-RPC + OS Edge/WebView2 `--app` surface, `0` Electron/Node runtime overhead, plus `100%` standalone offline fallback parity)
- **Related Governance & Specs:** [DIRECTION_DECISION.md](./DIRECTION_DECISION.md) · [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md) · [DYNAMIC_ROUTING_REQUIREMENTS.md](../workspace/DYNAMIC_ROUTING_REQUIREMENTS.md) · [BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
- **Skill Compliance:** `deep-ui-taste` · `modern-tech-ui-design`

---

## 1. Visual Thesis & Anti-Slop Craftsmanship (`deep-ui-taste`)

### 1.1 Product-Specific Aesthetic Thesis: *Obsidian Kinetic Atelier*
Omnia Studio serves systems engineers, researchers, and bilingual Vietnamese/English builders orchestrating 2-way all-to-all C++20 agent swarms, auditing deterministic multi-provider routing, and authoring scientific derivations. **Obsidian Kinetic Atelier** derives its visual identity directly from precision optical instrumentation and architectural drafting tables rather than generic SaaS chat templates:

1. **Calibrated Luminance Layering Over Blur/Gradients:** Spatial hierarchy is established strictly through 5 solid luminance steps (`--bg-canvas` → `--bg-rail` → `--bg-panel` → `--bg-elevated` → `--bg-interactive`), crisp `1px` hairline structural borders, and a `1px` top specular bevel (`inset 0 1px 0 var(--border-specular)`).
2. **Tabular Telemetry Discipline:** Every latency, token quota, byte count, SHA-256/FNV-1a digest, epoch, and score waterfall uses `Cascadia Mono` / `Consolas` with `font-variant-numeric: tabular-nums` so live updates never induce horizontal jitter.
3. **Zero-CDN Publication-Grade Math & Code Rendering:** Scientific expressions (`\sum`, `\int`, `\oint`, `\frac`, `\sqrt`, `\nabla \times \mathbf{E}`, `i\hbar\frac{\partial \Psi}{\partial t}`, `\rightleftharpoons`, `\begin{pmatrix}...\end{pmatrix}`) and C++20 source blocks render into semantic HTML/CSS math stacks and syntax-highlighted tokens with **zero** external network or CDN requests.
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
| **1. Studio Chat & Scientific Rich Composer** | `app/composer.js` | Multi-turn provenance cards (`EXTRACTED`, `INFERRED`), collapsible reasoning trace, syntax-highlighted C++20 copy receipt, live `ADDITIVE_INTAKE` Steer Queue (`token_budget: NULL`), 15-template LaTeX math/physics/chemistry palette, SHA-256 deduplicated inline + tray attachments, `Esc` zero-mutation paste chooser | `GET /api/composer/templates`, `GET /api/steer`, `POST /api/steer/enqueue`, `POST /api/router/decide` |
| **2. 2-Way `PeerMeshGraph` & `Graphify` Canvas** | `app/peer-graph.js` | High-DPI `devicePixelRatio` `<canvas>` + accessible node selector strip, curved bidirectional `A <-> B` `Duplex` arcs with directional particles, `disjoint_paths` & `epoch`/`max_hops` inspector, live 2-way pulse dispatch, `Forward`/`Reverse`/`Both` Graphify BFS with quarantined `AMBIGUOUS` edges | `GET /api/graph`, `POST /api/graph/send`, `GET /api/graph/traverse` |
| **3. Dynamic Provider Router Lab** | `app/router-lab.js` | Task class, token slider, privacy boundary, SSE toggle, per-provider **Trip / Reset Circuit Breaker** controls, visual 5-segment score waterfalls, explicit `Known`/`Stale`/`Unknown` quota meters, secret-redacted `RouteDecisionReceipt` JSON | `GET /api/router/state`, `POST /api/router/decide` |
| **4. Native C++20 Architecture & Proactive RAG** | `app/ide-explorer.js` | Interactive 7-target C++20 module explorer (`omnia_core` .. `omnia-studio`) with Windows 11 SDK link badges & Graphify jump + bilingual EN/VN `ProactiveRag` uncertainty analyzer without `"search"` keyword (`citedSources` vs quarantined `unusedSources`) | `POST /api/rag/plan` |
| **5. `MemoryGraph` & Curated Skill Vault** | `app/memory-vault.js` | Hierarchical namespace filter (`workspace/*`, `architecture/*`, `lessons/*`), `..`/`\` containment-guarded memory upsert, cryptographic erasure generating SHA-256 `ErasureReceipt` (`verifiedPlaintextFree: true`), instant EN/VN BM25 skill search | `GET /api/memory`, `POST /api/memory/upsert`, `POST /api/memory/erase`, `GET /api/skills?q=` |
| **Global Shell & `Ctrl+K` Command Palette** | `app/main.js`, `app/command-palette.js` | Live `/api/health` C++20 telemetry header pill, instant 3-theme persistence, SQLite WAL cooperative session switcher, fuzzy `Ctrl+K` modal across views/themes/LaTeX/simulations | `GET /api/health`, `GET /api/sessions`, `POST /api/sessions/create` |

---

## 4. Quantitative Viewport & Non-Clipping Geometry Contract

- **Master 3-Row `100dvh` Frame (`styles/layout.css`):** `grid-template-rows: 48px minmax(0, 1fr) 28px` guarantees the bottom `28px` UIA & draft-checksum status bar is **never** clipped across any desktop viewport height.
- **Responsive Breakpoints & Zero Horizontal Overflow:**
  - `1440 × 900`: Full `224px` navigation/session rail + dual-pane studio workbenches (`0 px` horizontal overflow).
  - `1220 × 820`: Compact `192px` rail + calibrated inspector widths (`0 px` horizontal overflow, `0 px` bottom status clipping).
  - `1024 × 768`: Automatic `56px` icon-rail collapse (expandable anytime via `Ctrl+B`) + single-column composer preview adaptation (`0 px` horizontal overflow).
