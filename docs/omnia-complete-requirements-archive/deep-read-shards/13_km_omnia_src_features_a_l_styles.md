# Shard 13 — Exhaustive Deep-Read: `khangmacphuc-omnia` `src/features/workspace/[A-L]*` & `src/styles/**`

- **Swarm Agent**: `@qa-parallel-runner` (Wave 1 Read-Only Deep-Read Shard 13)
- **Generated (UTC)**: `2026-11-28T10:01:39Z`
- **Source Root**: `D:/OmniaData/research/khangmacphuc-omnia/src/`
- **Partition Boundary**:
  - `src/features/workspace/**` (including `src/features/workspace/activities/**`) where filename starts with `[a-lA-L]` (`271` files = `73,982` lines; `km-features-b` owns `[m-zM-Z]` = `437` files; combined = `708/708` feature files).
  - `src/styles/**` — all `138` stylesheets (`54,677` lines).
- **Zero-Skip Coverage Totals**: **`409` files / `128,659` lines / `0` skipped** (`139` prod feature modules = `56,368` lines + `132` test suites = `17,614` lines / `919` detected tests + `138` CSS stylesheets = `54,677` lines).
- **Honest Verification Provenance**:
  - **`74` flagship files (`55` prod `.ts/.tsx` + `19` core `.css`) directly read via `read_file`** across complete symbol/layout/interaction spans (~40,000+ lines manually audited line-by-line).
  - **All `409/409` files (`128,659/128,659` lines)** exhaustively parsed line-by-line via deterministic `python -B` AST/regex/CSS analyzers (`features_a_l_index.json`, `styles_index.json`, `css_deep_summary.json`) and reviewed via complete catalog digests (`prod_catalog_139.md`, `css_catalog_138.md`, `test_catalog_132.md`).
- **Workspace Mutation Check**: Strictly READ-ONLY on `D:/Omnia`, `D:/OmniaData/research/khangmacphuc-omnia`, and `C:/Users/khang/.gemini`.

---

## 1. Executive Summary & Architectural Synthesis

`khangmacphuc-omnia`'s `src/features/workspace/[A-L]*` + `src/styles/**` layer is an extraordinarily thorough **desktop-grade AI studio & engineering workbench UI** engineered around four recurring principles that directly address the highest-impact UX, accessibility, and truthfulness gaps in both **Omnia `ui-v5` (`D:/Omnia/ui-v5/src/`)** and **`agy-fast` WebUI / SEP-1865 Canvas Studio (`C:/Users/khang/.gemini/antigravity/scratch/agy-fast/native/src/{webui.rs,canvas_ui.rs}`)**:

1. **Single-Source Navigation, Power-User Keyboard Ergonomics & Fail-Closed Input Contracts**:
   - `activity-registry.tsx` unifies rail buttons, `Alt+1..Alt+8` IME-safe shortcuts, lazy screens, sidebar modes, and Command Palette descriptors in one canonical registry.
   - `command-palette.tsx` (`1,266` L) implements an **11-scope Command Center** with **10 single-character power prefixes** (`>`, `@`, `#`, `?`, `~`, `%`, `&`, `!`, `:`, `^`), `Alt+Left/Right` scope cycling, breadcrumbs, and an in-palette multi-step destination mover with diff preview.
   - `keyboard-shortcuts-dialog.tsx` (`558` L) + `keyboard-shortcut-session.ts` (`97` L) provide live key-chord capture, 4 role presets (`Default`, `Coder`, `Research`, `Focus-first`), reserved browser/OS chord blocking, conflict resolution, 20-step Undo/Redo, and a **fail-closed runtime resolver (`matched.length === 1`)**.
2. **Pure-Markdown WYSIWYM Rich Composer & Zero-Pollution `/btw` Side-Chat**:
   - `composer.tsx` (`2,491` L) + `composer-editor.ts` (`686` L) + `composer-rich-preview.tsx` (`1,113` L) + `composer-block-insert-studio.tsx` (`362` L) + `composer-slash-commands.ts` (`798` L) + `ai-panel-composer.tsx` (`664` L) deliver selection-remapped Markdown/LaTeX editing, smart list/fence `Enter` continuation (multi-letter alphabetic `Z.` -> `AA.`), a 6-mode live preview (`Rendered | WYSIWYM | Outline | Blocks | Format | Source`), a 10-template editable Block Insert Studio, cross-agent `ArrowUp/ArrowDown` prompt history, 1-click **Enhance + Undo**, and 18 slash commands (`/btw`, `/spawn`, `/peer`, `/verify`, `/enhance`, `/schedule`, `/compare`, `/branch`, `/clone`).
   - `conversation-view.tsx` (`1,259` L) + `collapsible-ai-steps.tsx` (`249` L) + `conversation-navigation-model.ts` (`700` L) combine auto-folding streaming tool steps with language-colored file icons and numbered inline diff viewers, an isolated `/btw` Side-Chat Drawer (`retainPrimarySelection`, zero KV-cache prefix pollution), 9-facet transcript navigation (`Alt+Arrow/Home/End`), and fail-closed `omnia://` deep-link resolution.
3. **Epistemic Truthfulness, Evidence Receipts & Deterministic Built-in Workbenches**:
   - `inspector.tsx` (`1,028` L), `context-harness.ts` (`988` L), and `cache-context-routing-contract.ts` (`480` L) enforce strict separation between **local reuse** and **provider-reported cache evidence**, 5-tier usage observation ranking (`user-correction > provider-invoice > provider-final > provider-incremental > local-estimate`), prompt-injection-hardened `<source_excerpt metadata=...>content_json: ...</source_excerpt>` compilation, and SHA-256 `ProviderAttemptLineageReceipt` transparency.
   - `builtin-calculator-workbench.tsx` (`2,228` L) embeds a zero-`eval()` 7-tab Math/CAS/Graphing/Matrix/Quant-Finance/32-Bit-IEEE754-SAT/DevTools + **LLM Stream `<calc>/<cas>/<matrix>` Interceptor & PRM Anti-Hallucination Live Verifier**.
   - Full domain studios cover **LTST Hierarchical Knowledge Tree + HippoRAG 2 PPR + 9 Harness Configurators + Hardware-Aware Local Model Advisor** (`knowledge-tree-explorer.tsx`, `1,579` L), **Anchored-Note Document Studio** (`artifact-document-studio-preview.tsx`, `1,473` L), **Peer-Mesh + Kahn DAG + Conflict Reconciliation + Supervisor Policy Drafts** (`agent-dag-*`, `agent-mesh-*`), **4-Lane `Queue | Steer | Btw | Discuss` Goal Orchestration** (`goal-orchestration-rail.tsx`, `goal-task-studio.tsx`), **Computer-Use 1 GB Video Ring + `Esc+1..9` Kill Switch** (`computer-use-video-overlay.tsx`), **5-Tab Extensions & MCP Control Room** (`extensions-mcp-hub.tsx`), **Capability Matrix** (`capability-matrix-workbench.tsx` — directly closing Omnia's Issue #9 / `AUD-25`!), **Academic Citation Ledger + Graph + RunTimeline** (`academic-citation-ledger-preview.tsx`, `citation-graph-preview.tsx`, `citation-timeline.tsx`), **Data Lineage + Learning Loop + Redacted Diagnostics** (`data-lineage-studio.tsx`, `learning-loop-lab.tsx`, `diagnostics-session-workbench.tsx`), and **9-Algorithm Interactive Lab** (`algorithm-lab-preview.tsx`).
4. **Hardened 138-File CSS Design System (`54,677` L) with Critical Chromium & Accessibility Invariants**:
   - `149` generated semantic CSS tokens (`tokens.generated.css` + `tokens.css`), `5` harmonized developer palettes (`vscode-dark`, `linear-carbon`, `claude-obsidian`, `tokyo-night`, `daylight-tech`), `128/138` (`92.8%`) `color-mix(in srgb, ...)` derivation, `90/138` (`65.2%`) `:focus-visible`, **`74/138` (`53.6%`) Windows High Contrast `@media (forced-colors: active)`**, dual reduced-motion kill-switch (`@media (prefers-reduced-motion: reduce)` + `:root[data-motion="reduced"]`), `overflow: clip` viewport framing (fixing Chromium's `scrollIntoView()` layout-shift bug present in Omnia `ui-v5/src/styles/tokens.css:209`!), and `:has(...)` upward popup clipping escapes.
   - **Mandatory Omnia Hygiene Guardrails Flagged**:
     - `3/138` CSS files contain `backdrop-filter` (`shell.css:148-149`, `overlays.css:9-10`, `responsive.css:162-163` + `1080-1081`) — **MUST strip** and replace with opaque/alpha surface scrims when porting into Omnia `ui-v5` (`tokens.css:10` strictly forbids blur/gradients).
     - `index.css` contains a duplicate import (`local-model-readiness-preview.css` at L75 & L79) and `5` stylesheets (`review-chat-shell.css`, `review-composer.css`, `review-message-content.css`, `sovereign-ide-workbench.css`, `theme-preset-studio.css`) are imported outside `index.css`.
     - **Steer #22 YOLO Preservation Rule**: Several `khangmacphuc-omnia` preview contracts (`approval-request-preview-contract.ts`, `extensions-mcp-hub.tsx` `Deny all` preset) default to `ask`/`deny` for preview governance demos. When porting their UI surfaces into Omnia, **keep Omnia's `ApprovalMode::Yolo` / `PermissionsEngine::default_rules()` zero-nerf default intact** and expose strict/deny presets strictly as opt-in overlays.

---

## 2. Exhaustive Domain-by-Domain Feature & Interaction Analysis (`src/features/workspace/[A-L]*`)

### 2.1 Shell, Activity Rail, Command Palette, Global Search & Keyboard Rebinding
- **Single-Source Activity Registry (`activity-registry.tsx` 259L, `activity-rail.tsx` 60L, `activities/library-activity-screen.tsx` 226L)**:
  - Registers 8 primary activities (`home`, `chats`, `projects`, `work`, `library`, `memory`, `skills`, `settings`), binding `Alt+1`..`Alt+8` with `event.isComposing` IME protection (critical for Vietnamese VNI/Telex!), lazy component loaders, sidebar mode (`conversations | projects | context`), and command palette actions in one declaration so rail, palette, and hotkeys never drift.
  - `library-activity-screen.tsx` consolidates **19 lazy workbenches behind a single categorized `<optgroup>` dropdown** (preventing activity-rail bloat) while handling cross-surface custom events (`omnia:open-sovereign-workbench`, `omnia:enqueue-download`) with an inline `"Stream captured for Ultra IDM+"` confirmation banner.
- **11-Scope Universal Command Palette (`command-palette.tsx` 1,266L, `command-palette.css` 525L)**:
  - Scopes: `All | Commands | Chats | Messages | Projects | Files | Memory | Skills | Library | Providers | Models`.
  - **10 single-character power prefixes**: `>` commands, `@` chats, `#` projects, `?` messages, `~` files, `%` memory, `&` skills, `!` library, `:` providers, `^` models.
  - Navigation ergonomics: `Alt+ArrowLeft` / `Alt+ArrowRight` cycle scopes, `PageUp`/`PageDown` jump `+/-5` rows, `Home`/`End` jump ends, breadcrumb context (`Location: Activity / Project / Chat`), tab-local recent command memory, and an **in-palette multi-step `"Move active Chat"` destination picker** showing explicit `Changes` vs `Unchanged` project-scope diffs before confirming.
- **Unified Global Object Search (`global-object-search-preview.tsx` 961L)**:
  - Supports structured query operators (`type:`, `kind:`, `status:`, `@kind`) reconciled cleanly via `stripGlobalSearchOperators()` whenever UI filter chips/selects mutate.
  - Full **Saved Search Views CRUD** (up to 24 views), relevance/recent/title sorting with pinned and needs-attention score boosts, and URI-encoded DOM element IDs preventing `a/b` vs `a-b` ARIA `aria-activedescendant` collisions.
- **Live Keyboard Shortcut Rebinding Studio (`keyboard-shortcuts-dialog.tsx` 558L, `keyboard-shortcut-session.ts` 97L)**:
  - 4 curated presets (`Default`, `Coder`, `Research`, `Focus-first`), live key-chord capture modal, conflict detection respecting context-scoped `allowSharedBinding`, **reserved browser/OS chord blocking** (`Ctrl+W`, `Ctrl+R`, `Alt+F4`, `Alt+Tab`), 20-step Undo/Redo history, strict schema-validated 16 KB JSON bundle import/export, and a **fail-closed runtime matcher (`matched.length === 1`)** so ambiguous collisions never trigger accidental actions.

### 2.2 Flagship Rich Composer, WYSIWYM Markdown Editor, Slash Commands & Block Studio
- **Pure-Markdown WYSIWYM Editor Engine (`composer-editor.ts` 686L)**:
  - Selection-remapped (`mapPosition`) inline toggles for `**bold**`, `*italic*` (explicitly distinguishing `**`), `~~strike~~`, and `` `code` `` — cleanly unwrapping both outer-adjacent and inner-selected delimiters.
  - Structural transforms: `H1`–`H6`, bullet lists, numbered lists, **multi-letter alphabetic lists (`Z.` -> `AA.`)**, task checklists, and blockquote toggling.
  - Smart `Enter` handler: auto-continues lists/checklists, exits empty list items while preserving outer `>` blockquote prefixes, and auto-indents inside fenced code blocks (```` ``` ```` / `~~~`) so pressing `Enter` inside a code fence never prematurely submits the prompt.
  - `Tab`/`Shift+Tab` multi-line indent/outdent, `insertMarkdownLink` pre-selecting `https://`, and `readComposerSelection` caching last selection across toolbar clicks so clicking a toolbar button never loses caret range.
- **6-Mode Live Rich Preview (`composer-rich-preview.tsx` 1,113L)**:
  - Horizontal roving `tablist`: `Rendered | WYSIWYM | Outline | Blocks | Format | Source`.
  - Dependency-free `formatLatexPreview` + `splitInlineMath` (active even inside `MarkdownLoadingState` during React Suspense fallback so math never flashes raw).
  - Bounded `analyzeComposerFormatting` 12-metric syntax audit that masks inline code spans before flagging unmatched `**`/`*`/`` ` ``/`$` delimiters.
  - Split-pane `BlockEditorPreview` with per-block dirty draft state, occurrence-disambiguated `"Jump to source"` caret sync, and `"Apply to draft"`.
- **Block Insert Studio (`composer-block-insert-studio.tsx` 362L)**:
  - Searchable, 5-category (`Structure | Code | Data | Math | Layout`) 10-template popover (`> [!NOTE]` callout, Mermaid diagram, LaTeX block, GFM table, checklist, JSON config, diff patch, etc.) with an inline editable snippet scratchpad before insertion, preserving main textarea focus via `onMouseDown={e => e.preventDefault()}`.
- **Shared `AiPanelComposer`, Prompt Assist & Language-Colored File Icons (`ai-panel-composer.tsx` 664L)**:
  - Reusable compact composer shared across Main Chat, IDE Sidebar, and `/btw` Side-Chat with 1-click **Enhance + Undo** (`enhanceDraftPromptText`), live `Tab`-to-accept inline prompt suggestions, crisp custom colored mini SVG file-type badges (`.ts`, `.js`, `.md`, `.rs`, `.json`, `.css`, `.py`, `.go`), line-range aware attachment chips (`file.ts:10-42`), and `omnia:close-floating-menus` global popover coordination.
- **Main Composer & 18 Slash Commands (`composer.tsx` 2,491L, `composer-slash-commands.ts` 798L)**:
  - **Cross-agent `ArrowUp`/`ArrowDown` prompt history** recalling prior prompts across Main Chat, `/btw` subchats, IDE sidebar, and subagents.
  - `9` core + `9` extended slash commands (`/btw`, `/spawn`, `/peer {A, B}, C`, `/verify`, `/enhance`, `/schedule`, `/compare`, `/branch`, `/clone`) plus `25` slash triggers indexed across the A–L workspace (`/calc`, `/math`, `/code`, `/table`, `/checklist`, `/numbered`, `/quote`, `/prompt`, `/remote`, `/report`, `/research`, `/architecture`, `/bug-postmortems`, `/learned-skills`, `/session-provenance`, `/user-preferences`).
  - Voice dictation session counter (`voiceSessionRef`) preventing duplicate interim/final transcript commits; deterministic plain-text paste interception with char/token/byte/line budget assessment before auto-converting giant pastes into attachment cards.

### 2.3 Conversation Transcript, Collapsible AI Steps, `/btw` Side-Chat, Navigation & Branching
- **Auto-Folding Tool Steps & Inline Diff Line Viewer (`collapsible-ai-steps.tsx` 249L, `review-message-content.css` 427L)**:
  - Automatically collapses completed thinking/tool steps and opens **only the active running step** while streaming.
  - Parses `Read/Edited/Created <path> (+add -del) / (lines A-B)` headers into colored language file icons, green `#4ade80` / red `#f87171` diff stat badges, and a 3-column numbered inline diff line viewer (`.ai-step__line-viewer`: `28px` line-num, `14px` `+/-`, `1fr` code).
  - `INTERNAL_STEP_COPY` regex in `conversation-view.tsx` / `ide-agent-sidebar.tsx` filters noisy internal transport/telemetry lines while carefully preserving legitimate filenames (`cache.ts`, `dfs.ts`, `harness.ts`).
- **Zero-Pollution `/btw` Side-Chat (`conversation-view.tsx` 1,259L)**:
  - `SideChatDrawer` spawns an isolated child thread citing `omnia://sessions/${parentId}` with `retainPrimarySelection` so the parent chat's active selection and KV-cache prefix remain completely untouched; triggered via `/btw` or `omnia:open-btw-side-chat`.
- **9-Facet Navigation, Fail-Closed Deep-Links & Branch Safety (`conversation-navigation-model.ts` 700L, `branch-revision-workbench.tsx` 781L, `chat-first-canvas.tsx` 171L, `chat-signal-strip.tsx` 426L)**:
  - 9 transcript facets + 6 `Alt+Arrow/Home/End` jump shortcuts + viewport-center scroll-spy (`data-message-id`) + one-shot `requestAnimationFrame` message scroll from Command Palette.
  - Strict fail-closed `omnia://chat/<id>` & `omnia://project/<pid>/chat/<cid>` URI parser/resolver supporting `branch`, `message`, `messageRevision`, `selection`, `run`, `attempt`, `cursor`, `revision`, `fingerprint`, and `quoteHash` with `nearestAncestor` recovery.
  - `NativeBranchSelector` safety lock prevents destructive branch switches while unsent drafts/attachments exist or a run is actively streaming; `BranchRevisionWorkbench` renders cycle-safe, orphan-aware `role="tree"` lineage with 7 typed revision effects.
  - `ChatFirstCanvas` binds `Alt+Enter` to focus the composer and automatically collapses the starter rail once messages exist.

### 2.4 Inspector, Context Compiler, Cache Routing & Epistemic Truthfulness
- **3-Tab Context Inspector & Focus-Restoring Citation Takeover (`inspector.tsx` 1,028L)**:
  - Roving `tablist` (`Context | Run | Controls`). Clicking any inline citation opens `SourcesInspector`, preserving both `returnTab` **and the exact trigger button DOM focus** when returning.
  - **5-tier usage observation precedence**: `user-correction > provider-invoice > provider-final > provider-incremental > local-estimate`, explicitly retaining counter-bearing observations over cost-only invoices so token breakdowns are never erased.
  - `ProviderAttemptLineageReceipt` displays SHA-256 hashes of request definition, endpoint, and normalized params alongside requested vs effective reasoning effort; `ParameterInspector` gates controls by model capability, tucks expert knobs behind disclosure, and warns on `temperature` + `top_p` conflict.
- **Prompt-Injection-Hardened Context Compiler (`context-harness.ts` 988L)**:
  - Enforces strict authority tiers, content-hash deduplication + per-source caps + frontier caps (ensuring a source-capped chunk never poisons dedup for other sources), untrusted-data framing via `<source_excerpt metadata=...>content_json: ...</source_excerpt>`, paired `user`/`assistant` turn dependencies, invariant placement of the active user prompt last, and dual UTF-8 byte + lexical conservative token estimation.
- **Cache vs Provider Evidence Contract (`cache-context-routing-contract.ts` 480L)**:
  - Cleanly partitions **local reuse** (11 cache object kinds, encryption status, TTL, eviction, data-class filtering, user-managed inventory) from **provider-reported cache evidence** via fail-closed `normalizeProviderEvidence()` (non-authoritative telemetry cannot fabricate cache hits; incomplete segment estimates return `null` rather than misleading partial sums).

### 2.5 Built-in Zero-Eval Math, CAS, DevTools & PRM Anti-Hallucination Studio
- **`builtin-calculator-workbench.tsx` (2,228L)**:
  - Compact DevTools shell (`34px` topbar + `24px` monospace statusbar) unifying 7 specialized tabs with **zero `eval()` / `new Function()`**:
    1. **Scientific / Programmer Calculator** + persistent paper tape + 1-click `"Insert into Active Chat"`.
    2. **Symbolic CAS**: `d/dx`, definite/symbolic `∫`, Taylor expansion, numeric roots, RK4 ODE solver, Complex/Polar arithmetic.
    3. **Interactive SVG Function Grapher**: plots `f(x)`, dashed derivative `f'(x)`, and detected local extrema.
    4. **N×N Linear Algebra**: RREF, matrix inverse, determinant, and eigenvalues.
    5. **Quant Finance & Statistics**: Black-Scholes + Greeks, NPV/IRR/CAGR, OLS regression, Bayes posterior, Shannon entropy.
    6. **Bitwise & Logic Lab**: interactive 32-bit toggle grid (`.sw-bit-grid`), IEEE-754 Float64 sign/exponent/mantissa/ULP inspector, and Boolean SAT truth-table solver (DNF/CNF).
    7. **OmniDev Swiss-Army Knife + LLM Stream Verifier**: JSON Schema validator, Regex tester, SHA-256/CRC32/JWT decoder, Cron humanizer, 5-language bracket balancer, **LLM `<calc>/<cas>/<matrix>` stream auto-interceptor** + 14 MCP tool schemas, and a **PRM Anti-Hallucination Live Verifier** (`"Load & Verify Active Chat Turn"` + 1-click `"Apply Auto-Corrected Draft"`).

### 2.6 Knowledge Tree, Document Studio, Library CRUD & Capability Matrix
- **LTST Hierarchical Knowledge Tree (`knowledge-tree-explorer.tsx` 1,579L)**:
  - Replaces flat `MEMORY.md` lists with 5 canonical folders, confidence bars, provenance URIs, 4 typed semantic edges (`supports | contradicts | derived-from | supersedes`), a **HippoRAG 2 Multi-Hop PPR Search Bar**, a **9-Harness Official Adapter Configurator**, and a **Hardware-Aware Local Model Advisor** generating 4 copyable deployment blueprints (`PowerShell`, `Ollama Modelfile`, `llama-server CLI`, `Provider JSON`).
- **Document Studio & Library (`artifact-document-studio-preview.tsx` 1,473L, `library-screen.tsx` 1,267L, `library-conversation-crud-preview.tsx` 857L)**:
  - Split/Editor/Rendered modes, 50-step Undo/Redo, 12 named checkpoints, **24 Anchored Review Notes with live edit-drift detection (`anchorChanged`)**, filterable Structure Block inspector, Find/Replace, interactive rendered task checkboxes, hidden-selection filter awareness (never leaves a stale detail pane beside an empty filtered gallery), smart collections, bulk triage, and portable JSON/Markdown I/O.
- **Capability Matrix Workbench (`capability-matrix-workbench.tsx` 378L — Direct Closure for Omnia Issue #9 / `AUD-25`!)**:
  - Live filterable/searchable provider & model capability matrix with toggleable capability facets, explicit summary metrics, and mobile single-column responsive rules (`responsive.css:978-984`).

### 2.7 Multi-Agent Peer-Mesh, Kahn DAG, Conflict Reconciliation, Supervisor & 4-Lane Goals
- **`agent-dag-orchestration-preview.tsx` (447L)**: Kahn's algorithm topological layering, critical-path highlighting, and explicit cycle / self-loop / unknown-ref / duplicate dependency diagnostics.
- **`agent-mesh-preview.tsx` (618L)**: 4-tab control room (`Mesh | Kanban Board | Bulk-Triage Mailbox | Leases`) with delivery/sensitivity mailbox filters and cooperative fencing-epoch lease timeline.
- **`agent-mesh-reconciliation-preview.tsx` (568L)**: 4 explicit conflict classes (`write-claim`, `stale-snapshot`, `output-route`, `lease-epoch`), competing contender path diffs, 4 resolution strategies (`sequence | merge | hold | manual`), and bulk triage.
- **`agent-mesh-supervisor-preview.tsx` (508L)**: Task queue + live-diffed editable **Supervisor Policy Draft** (child authority, write conflict, output route, stale snapshot, lease recovery, max parallel tasks 1–16) with 30-step Undo/Redo and JSON/Markdown import/export.
- **4-Lane `Queue | Steer | Btw | Discuss` Goal Orchestration (`goal-orchestration-rail.tsx` 111L, `goal-task-studio.tsx` 496L)**:
  - Concrete UI realization of Omnia's `ADDITIVE_INTAKE` contract: `Steer` explicitly returns the displaced active item to the front of `Queue` (never dropping it!), while `Btw` and `Discuss` stay isolated in collapsible Side Notes until explicitly promoted. `goal-task-studio.tsx` adds cross-goal queues (`ready | active | blocked`), overdue badges, List/Board view toggle, and `sessionStorage` draft recovery.

### 2.8 Embedded VS Code, IDE Agent Sidebar & Computer-Use Video Overlay
- **`embedded-vscode-stage.tsx` (179L) & `ide-agent-sidebar.tsx` (413L)**:
  - Runs an endpoint health-check before attaching iframe/native stage (`90s` overall deadline, `10s` per-probe timeout), keeps the iframe alive via `hidden` + `inert` when local utility drawers open (preventing editor reload loss!), tracks `connectionEpoch` reconnects, exposes `@workspace:multi-root` / `@active-file` / `@terminal` / `@git-diff` context pills, `extractLatestAgentCode`, and 4 utility drawers.
- **`computer-use-video-overlay.tsx` (502L)**:
  - 1 GB FIFO Video Ring Buffer, **Emergency `Esc` / `Esc+1..9` Kill Switch** (supporting both simultaneous hold `Esc+digit` AND a `2.5s` armed chord window), Parallel Virtual Mice & Keyboards status strip with animated typing indicators, `[M1 -> M2]` keyframe segment extraction, and Final Video Audit + Delete workflow.

### 2.9 Automation, Approvals, Extensions/MCP, Citations, Lineage, Learning, Diagnostics, Local Models, Appearance & Algorithm Lab
- **Automation & Workflow Canvas (`automation-studio-preview.tsx` 785L, `automation-workflow-canvas-preview.tsx` 366L)**: 14 trigger types, missed-run/concurrency/retry/budget/connector policies, plus zoomable (`70%–135%`) SVG Bezier DAG canvas (`Dependency Lanes` vs `Linear Flow`, `Focus Selected Path`).
- **Typed Approval Contract & 5-Tab Extensions/MCP Hub (`approval-request-preview-contract.ts` 243L, `extensions-mcp-hub.tsx` 769L)**: Typed exact-approval matrix (7 ops, 6 scopes, 6 expiries, 6 sandbox tiers, 3 network policies, 3 secret modes, 4 presets); 5-tab Control Room (`Catalog | MCP inspector | Capability grants | Permission review | Lifecycle`) with live JSON tool-call rehearsal, 3 grant presets, and a 6-gate activation pipeline (`Discover -> Install -> Trust -> Grant -> Enable -> Execute`).
- **Academic Citations, Timeline & Graph (`academic-citation-ledger-preview.tsx` 791L, `citation-timeline.tsx` 727L, `citation-graph-preview.tsx` 554L)**: Claim-to-source ledger with fail-closed triage priority (`blocked > claim-review > source-review > review-ready`), merge conflict policies (`keep-local | use-imported`), `RunTimeline` journal integrity audit + event inspector, and BFS shortest-path / connected-cluster Citation Graph.
- **Data Lineage, Learning Loop & Redacted Diagnostics (`data-lineage-studio.tsx` 677L, `learning-loop-lab.tsx` 725L, `diagnostics-session-workbench.tsx` 577L)**: Source->Transform->Artifact->Evaluation lineage with sensitivity/edge-evidence ledgers; deterministic train/validation/held-out split preview & 6-year local review cadence calculator; **redacted diagnostics timeline** (redacting even search queries inside activity history!) with 3-column pre-export contract review (`Included | Excluded | Validation checks`) and JSON/JSONL export.
- **Appearance, Local Models, Routing, Git/CI, Harness Synthesis & Algorithm Lab (`appearance-preview-deck.tsx` 795L, `local-model-catalog-preview.tsx` 392L, `local-model-readiness-preview.tsx` 250L, `adaptive-auto-routing-learning-preview.tsx` 315L, `git-ci-workbench-preview.tsx` 543L, `harness-capability-synthesis.tsx` 353L, `algorithm-lab-preview.tsx` 686L)**: 12 multi-hue palettes + 12 monochrome geometric SVG marks + live dark-theme app trial + CSS/JSON/MD export; hardware-aware local model catalog & readiness probes; adaptive routing scorecards; Git/CI workbench; 9 interactive algorithms with step traces, formal proofs, edge cases, and Pseudocode/Python/C++/Rust tabs.

---

## 3. Complete 138-File CSS Design System & Craft Analysis (`src/styles/**`)

### 3.1 Token Architecture & Quantitative Audit (`54,677` Lines)
| Metric | Value | Key Evidence / Files |
|---|---|---|
| Total CSS stylesheets | **138** (`54,677` lines) | `src/styles/index.css` imports `132` (+ `1` duplicate); `5` imported directly by features |
| Unique CSS custom properties defined | **149** | `tokens.generated.css` (152L, generated by `scripts/generate-design-tokens.mjs`) + `tokens.css` (93L) |
| Harmonized developer palettes | **5** + base dark/light | `vscode-dark`, `linear-carbon`, `claude-obsidian`, `tokyo-night`, `daylight-tech` (`sovereign-super-suite.css:7-115`) |
| `color-mix(in srgb, ...)` adoption | **128 / 138** (`92.8%`) | Dynamic border/tint/glow derivation without hand-maintaining dozens of rgba constants |
| `:focus-visible` keyboard focus rules | **90 / 138** (`65.2%`) | Consistent `2px solid var(--focus)` keyboard ring separate from mouse clicks |
| Windows High Contrast (`forced-colors`) | **74 / 138** (`53.6%`) | `@media (forced-colors: active)` + `CanvasText`/`Highlight` outlines (`responsive.css:1094-1106`) |
| Reduced motion support | **12 / 138** + global kill-switch | Dual gate: `@media (prefers-reduced-motion: reduce)` AND `:root[data-motion="reduced"]` (`responsive.css:1055-1073`) |
| Reduced transparency override | **1 / 138** | `@media (prefers-reduced-transparency: reduce)` (`responsive.css:1075-1092`) |
| `@keyframes` defined | **10** across `6` files | `boot-progress`, `message-thinking-pulse`, `native-project-goals-spin`, `omnia-spin`, `scrim-in`, `dialog-in`, `sidebar-slide-in`, `inspector-slide-in`, `activity-load-progress`, `settings-surface-loading-pulse` |
| `backdrop-filter` occurrences (**HYGIENE FLAG**) | **3 / 138** (`8` lines) | `shell.css:148-149`, `overlays.css:9-10`, `responsive.css:162-163` (+ `none` override `1080-1081`) |
| Duplicate import bug in `index.css` | **1** | `local-model-readiness-preview.css` imported at both `index.css:75` and `index.css:79` |
| Unimported in `index.css` (direct feature imports) | **5** | `review-chat-shell.css`, `review-composer.css`, `review-message-content.css`, `sovereign-ide-workbench.css`, `theme-preset-studio.css` |

### 3.2 High-Value CSS Craft Patterns Worth Porting Directly
1. **Chromium `overflow: clip` Viewport Frame Fix (`shell.css:12-18`)**:
   `overflow: hidden` still creates a programmatic scroll container in Chromium/Edge/WebView2 — any `scrollIntoView()` on a control below the composer shifts `.app-shell` and pushes the top bar offscreen (`y < 0`). Switching `.app-shell` to `overflow: clip` eliminates this entire class of desktop WebView2 layout bugs! (**Directly applicable to `D:/Omnia/ui-v5/src/styles/tokens.css:209` `.omnia-shell`!**)
2. **`:has(...)` Dynamic Popover Clipping Escape (`shell.css:558-561`, `review-composer.css:31`)**:
   `.activity-rail:has(.profile-menu) { z-index: 80; overflow: visible; }` and `.composer-region--review:has(.composer-slash-menu, .review-composer-attach-menu, .review-composer-attachment-preview[open]) { overflow: visible; z-index: 100; }` keep normal scroll clipping intact and dynamically lift clipping ONLY while an upward popover is open.
3. **Flex-Column Chat Pane + Unshrinkable Composer Guard (`delivery-polish.css:48-80`, `review-composer.css:2-11`)**:
   Replacing fixed `grid-template-rows` on the conversation pane with `display: flex; flex-direction: column; min-height: 0;` + `flex: 0 0 auto; max-height: min(50vh, 480px);` on `.composer-region` guarantees conditionally mounted banners/drawers never displace or clip the composer Send button.
4. **Zero-JS Hover-Only Tooltips With Auto-Downward Flip (`sovereign-super-suite.css:118-148`)**:
   `[data-tooltip]:hover::after` renders strictly on `:hover` (so clicked buttons never leave stuck tooltips) and flips `top: calc(100% + 6px)` inside top chrome bars (`.title-bar`, `.sw-topbar`).
5. **Ergonomic Density & Hit-Target Tokens (`tokens.generated.css:47-51`, `tokens.css:83-93`, `base.css`)**:
   Separates visual button size from touch/click targets (`--target-inline: 32px`, `--target-comfortable: 40px`, `--target-touch: 44px`, `.hit-target-control`) and supports runtime `:root[data-density="compact" | "touch"]`.
6. **WCAG Active-Card Contrast Promotion (`overlays.css:713-720`)**:
   Explicitly promotes `--text-tertiary` to `--text-secondary` inside `.dialog-choice--active small` so supporting copy on tinted dark cards never drops below WCAG AA 4.5:1.
7. **Full-Window Surface Replacement (`shell.css:46-98`)**:
   When entering IDE or Browser mode, `.app-shell--full-window-surface` completely replaces the grid (`grid-template-areas: none`) without leaving dead rail columns, while keeping global overlay hosts (Command Palette, Dialogs) as siblings so shortcuts keep working seamlessly.
8. **5-Breakpoint Responsive Cascade (`responsive.css:1-1246`)**:
   Gracefully transitions desktop 4-column shell -> drawer sidebars (`<=920px`) -> 52px bottom activity bar (`<799px`) -> single-column dense workbenches (`<=620px`) -> phone status-badge wrap guard (`<=390px` in `chat-first-canvas.css:382-396`).

---

## 4. Test Architecture & High-Value Behavioral Contracts (`132` Test Files, `17,614` Lines, `919` Tests)

All `132` A–L test files (`17,614` lines, `919` detected `describe`/`it`/`test` blocks) were indexed line-by-line into `test_catalog_132.md`. Recurring test contracts worth replicating in Omnia (`ui-v5` & `ui/tests/`) and `agy-fast`:
- **Fail-Closed Bundle & Import Tests** (`academic-citation-bundle.test.ts`, `academic-citation-ledger-preview.test.tsx`, `keyboard-shortcuts-dialog.test.tsx`, `artifact-document-studio-preview.test.tsx`): assert malformed JSON, dangling reference IDs, invalid enums, and oversized payloads are rejected **before** mutating state and remain undoable.
- **Boundary Honesty Tests** (`cache-context-routing-contract.test.ts`, `inspector.test.tsx`, `diagnostics-session-workbench.test.tsx`): assert non-authoritative telemetry never fabricates provider cache hits, cost-only invoices never wipe token counts, and search queries are redacted from exported diagnostic timelines.
- **IME, Focus Restoration & Selection Remapping Tests** (`activity-registry.test.tsx`, `composer-editor.test.ts`, `composer.test.tsx`, `inspector.test.tsx`, `global-object-search-preview.test.tsx`): assert `isComposing` blocks `Alt+1..8`, closing Citation Inspector restores exact button DOM focus, `a/b` vs `a-b` ARIA IDs never collide, and `Enter` inside fenced code blocks never submits.
- **Branch Safety & Cycle-Free Graph Tests** (`branch-revision-workbench.test.tsx`, `agent-dag-orchestration-preview.test.tsx`, `citation-graph-preview.test.tsx`, `conversation-navigation-model.test.ts`): assert unsent drafts lock destructive branch swaps, cyclic/orphan nodes degrade cleanly without infinite recursion, and invalid `omnia://` deep-links fail closed.

---

## 5. Prioritized Omnia (`D:/Omnia/ui-v5` & Fallback `D:/Omnia/ui`) Integration Matrix

All targets below map directly to real verified files in `D:/Omnia/ui-v5/src/**` and `D:/Omnia/ui/**`, strictly enforcing **Omnia's non-negotiable rules**:
- **Zero `backdrop-filter` / zero candy gradients** (`ui-v5/src/styles/tokens.css:10` — strip blur from `shell.css:148`, `overlays.css:9`, `responsive.css:162`).
- **Zero external CDNs** (keep `@fontsource/*`, `katex`, `@xterm/xterm` strictly bundled offline via `D:/OmniaData/build/ui-deps`).
- **Steer #22 Zero-Nerf YOLO Default**: preserve `ApprovalMode::Yolo` / empty `PermissionsEngine::default_rules()`; any strict/ask permission matrix ported from `extensions-mcp-hub.tsx` or `approval-request-preview-contract.ts` must be strictly opt-in!
- **Pure UTF-8 LF** and out-of-source Vite output (`D:/OmniaData/build/ui-dist`).

| Priority | Feature / Pattern from `khangmacphuc-omnia` | Exact Omnia Target File(s) | Why It Matters & Adaptation Rules |
|---|---|---|---|
| **P0** | **Capability Matrix Workbench** (`capability-matrix-workbench.tsx` 378L + CSS) | `ui-v5/src/components/workbenches/obs/RouterLabPanel.tsx` or new `CapabilityMatrixPanel.tsx` + `ui/app/views/routing/table.js` | **Directly closes Omnia Issue #9 / `AUD-25`!** Port searchable/filterable provider+model capability grid, facet toggles, and mobile collapse rules. |
| **P0** | **Chromium `overflow: clip` + `forced-colors` High Contrast + Density/Motion Tokens** (`shell.css:12-18`, `responsive.css:1055-1106`, `tokens.css:83-93`) | `ui-v5/src/styles/tokens.css` (`L186, L209`), `ui/styles/base.css`, `ui/styles/layout.css` | Eliminates Chromium `scrollIntoView()` topbar-clip bug in `.omnia-shell`, closes `0` -> full Windows High Contrast `@media (forced-colors: active)` gap across all 4 themes (`obsidian`, `titanium`, `alabaster`, `blueprint`), and adds `:root[data-density="compact"\|"touch"]` + `:root[data-motion="reduced"]` + `:has(...)` upward popup escape (`zero backdrop-filter`). |
| **P0** | **11-Scope Command Palette w/ 10 Single-Char Prefixes + Move-Chat Flow** (`command-palette.tsx` 1,266L) | `ui-v5/src/components/shell/CommandPalette.tsx`, `ui/app/core/palette.js` | Upgrades current palette with `> @ # ? ~ % & ! : ^` prefixes, `Alt+Left/Right` scope cycling, `PgUp/PgDn` +/-5 jumps, breadcrumbs, and in-palette session move diff preview. |
| **P0** | **Pure-Markdown WYSIWYM Composer Engine + 6-Mode Preview + Block Insert Studio + Cross-Agent History** (`composer-editor.ts`, `composer-rich-preview.tsx`, `composer-block-insert-studio.tsx`, `ai-panel-composer.tsx`) | `ui-v5/src/components/chat/Composer.tsx`, `ui/app/views/chat/composer.js`, `ui/app/views/chat/format.js`, `ui/app/views/chat/templates.js` | Brings selection-remapped formatting, fenced-code-aware `Enter` (no accidental submit!), multi-letter `Z.`->`AA.` lists, 12-metric format linter, editable 10-template Block Insert popover, `Enhance + Undo`, language-colored file chips, and cross-surface `ArrowUp/Down` prompt recall. |
| **P0** | **Auto-Folding `CollapsibleAiSteps` w/ Numbered Inline Diff Viewer & Telemetry Filter** (`collapsible-ai-steps.tsx`, `review-message-content.css:113-257`) | `ui-v5/src/components/chat/Transcript.tsx`, `ui-v5/src/components/chat/DiffCard.tsx`, `ui/app/views/chat/thread.js` | Auto-folds finished tool calls during streaming, opens only the active step, parses `Read/Edited/Created (+add -del)` with inline `#4ade80`/`#f87171` 3-col diff viewer, and strips internal telemetry noise without hiding filenames. |
| **P0** | **Live Keyboard Shortcut Rebinding Studio + Fail-Closed Resolver** (`keyboard-shortcuts-dialog.tsx`, `keyboard-shortcut-session.ts`) | New `ui-v5/src/components/shell/KeyboardShortcutsModal.tsx` wired from `TopBar.tsx` / `CommandPalette.tsx` | Adds 4 presets (`Default`, `Coder`, `Research`, `Focus-first`), live chord capture, OS/browser chord blocklist, `isComposing` Vietnamese IME safety, 20-step Undo/Redo, JSON I/O, and fail-closed `matched.length === 1` dispatch. |
| **P1** | **4-Lane `Queue \| Steer \| Btw \| Discuss` Goal Rail + Isolated `/btw` Side-Chat Retention** (`goal-orchestration-rail.tsx`, `goal-task-studio.tsx`, `conversation-view.tsx`) | `ui-v5/src/components/shell/SteerQueueDrawer.tsx`, `ui-v5/src/components/chat/QuoteBtwDrawer.tsx`, `ui-v5/src/components/workbenches/MissionLifecycleView.tsx` | Makes Omnia's `ADDITIVE_INTAKE` contract visually unmistakable (`Steer` returns prior active work to queue head; `Btw`/`Discuss` stay isolated off-prefix until promoted) and adds `sessionStorage` draft recovery. |
| **P1** | **Peer-Mesh Conflict Reconciliation + Kahn DAG Critical Path + Supervisor Policy Draft** (`agent-dag-orchestration-preview.tsx`, `agent-mesh-reconciliation-preview.tsx`, `agent-mesh-supervisor-preview.tsx`) | `ui-v5/src/components/workbenches/SwarmView.tsx`, `ui/app/views/agents/mesh.js`, `ui/app/views/agents/graph-canvas.js` | Upgrades `SwarmView` with topological Kahn layers, cycle/orphan diagnostics, 4 conflict-class contender diffs (`write-claim`, `stale-snapshot`, `output-route`, `lease-epoch`), fencing-epoch leases, and undoable Supervisor Policy Drafts (keeping YOLO default!). |
| **P1** | **Epistemic Usage Precedence, Provider Attempt Lineage & Cache Separation** (`inspector.tsx`, `context-harness.ts`, `cache-context-routing-contract.ts`) | `ui-v5/src/components/workbenches/obs/AiTelemetryPanel.tsx`, `ui-v5/src/components/workbenches/ObservabilityView.tsx`, `ui/app/views/chat/inspector.js` | Adds 5-tier usage observation ranking, SHA-256 request/param attempt lineage receipts, fail-closed provider vs local cache evidence separation, and `<source_excerpt>` untrusted-data framing. |
| **P1** | **Anchored Review Notes (Drift-Detecting) + Academic Citation Ledger & Graph** (`artifact-document-studio-preview.tsx`, `academic-citation-ledger-preview.tsx`, `citation-graph-preview.tsx`) | `ui-v5/src/components/chat/ArtifactCanvasDrawer.tsx`, `ui-v5/src/components/workbenches/AtelierView.tsx`, `ui-v5/src/components/shell/ResearchSourceDrawer.tsx` | Adds 24 edit-drift-aware review notes (`anchorChanged`), 50-step Undo/Redo + 12 checkpoints to Canvas Drawer, and claim-to-source triage (`blocked > claim-review > source-review > review-ready`) + BFS citation graph to Atelier. |
| **P1** | **LTST Knowledge Tree + HippoRAG 2 PPR Bar + Hardware Local Model Advisor** (`knowledge-tree-explorer.tsx`, `local-model-catalog-preview.tsx`, `local-model-readiness-preview.tsx`) | `ui-v5/src/components/workbenches/KnowledgeExtensionsView.tsx`, `ui-v5/src/components/workbenches/obs/SystemHardwarePanel.tsx`, `ui/app/views/knowledge/memory.js` | Adds typed memory links (`supports/contradicts/derived-from/supersedes`), multi-hop search UX, 5-tab MCP tool rehearsal (`extensions-mcp-hub.tsx` — keeping YOLO default!), and 4-format local model launch blueprints (`PowerShell`, `Modelfile`, `llama-server`, `JSON`). |
| **P1** | **Embedded VS Code Keep-Alive (`hidden`+`inert`) + Context Pills + Computer-Use `Esc+1..9` Kill Switch** (`embedded-vscode-stage.tsx`, `ide-agent-sidebar.tsx`, `computer-use-video-overlay.tsx`) | `ui-v5/src/components/ide/IdeWorkbench.tsx`, `ui-v5/src/components/browser/BrowserWorkbench.tsx` | Prevents embedded IDE reloads on drawer toggle, adds `@active-file`/`@terminal`/`@git-diff` chips, and brings `Esc` / `Esc+1..9` armed emergency kill-switch + `[M1->M2]` segment audit to Browser/Computer-Use. |
| **P2** | **Zero-Eval Built-in Math/CAS/Graph/Bitwise/DevTools + PRM Anti-Hallucination Verifier** (`builtin-calculator-workbench.tsx` 2,228L) | New lazy workbench in `ui-v5/src/components/workbenches/` (reachable via Command Palette / `/calc` / `/verify`) | Gives Omnia deterministic offline CAS, SVG plotting, IEEE-754/32-bit/SAT tools, and 1-click chat-turn numeric verification without inflating initial bundle size. |
| **P2** | **Redacted Diagnostics Export + Data Lineage + Global Saved Search Views + 5 Extra Theme Palettes** (`diagnostics-session-workbench.tsx`, `data-lineage-studio.tsx`, `global-object-search-preview.tsx`, `sovereign-super-suite.css:7-115`) | `ui-v5/src/components/workbenches/obs/VaultDiffExportPanel.tsx`, `ui-v5/src/styles/tokens.css`, `ui-v5/src/components/shell/SessionSidebar.tsx` | Adds 3-column pre-export privacy audit (`Included \| Excluded \| Validation checks`), query-redacted timelines, 24 saved search views, and optional `vscode-dark`/`linear-carbon`/`claude-obsidian`/`tokyo-night` palette tokens. |

---

## 6. Prioritized `agy` & `agy-fast` WebUI / SEP-1865 Canvas Studio Integration Matrix

Mapped directly to real verified paths in `C:/Users/khang/.gemini/antigravity/scratch/agy-fast/`:
- **`native/src/webui.rs` (`3,614` L)** & **`native/web/{index.html,styles.css,app.js,charts.js}`** (local HTTP/WS dashboard & operator console)
- **`native/src/canvas_ui.rs` (`3,888` L)** & **`skills/intelligent-canvas-ui/references/ui-ux-design-system.md`** (SEP-1865 `canvas_studio` interactive MCP app widgets & strict CSP templates)
- **`native/src/tui.rs` (`7,061` L)** (terminal workbench keyboard/palette ergonomics)

| Priority | Feature / Pattern from `khangmacphuc-omnia` | Exact `agy-fast` Target File(s) | Concrete Integration Value |
|---|---|---|---|
| **P0** | **Token System (`tokens.generated.css`) + `forced-colors` High Contrast + `overflow: clip` + Pure-CSS `[data-tooltip]`** | `native/web/styles.css`, `native/src/canvas_ui.rs`, `skills/intelligent-canvas-ui/references/ui-ux-design-system.md` | Directly elevates `agy-fast` WebUI and SEP-1865 `canvas_studio` MCP widgets with zero-JS hover tooltips (CSP-friendly!), Chromium `overflow: clip` scroll-shift immunity, `:focus-visible`, and `forced-colors: active` accessibility without bundle bloat. |
| **P0** | **Auto-Folding `CollapsibleAiSteps` w/ Numbered 3-Col Inline Diff Viewer** (`collapsible-ai-steps.tsx`, `review-message-content.css`) | `native/web/app.js`, `native/web/styles.css`, `native/src/canvas_ui.rs` | Renders agent tool runs cleanly inside `agy-fast` WebUI and Canvas Studio using pure semantic HTML `<details>`/`<summary>` + 3-col CSS grid (`28px 14px 1fr`) — works with minimal JS under strict SEP-1865 CSP. |
| **P0** | **11-Scope Prefix Command Palette & Fail-Closed Shortcut Resolver (`matched.length === 1`)** (`command-palette.tsx`, `keyboard-shortcut-session.ts`) | `native/web/app.js`, `native/web/index.html`, `native/src/tui.rs` | Unifies `> @ # ? ~ % & ! : ^` prefix lookup and IME-safe (`isComposing`) fail-closed shortcut matching across `agy-fast` WebUI and TUI. |
| **P1** | **Zero-Eval Math / SVG Grapher / 32-Bit IEEE-754 / Matrix / PRM Verifier Widget Templates** (`builtin-calculator-workbench.tsx`) | `native/src/canvas_ui.rs`, `native/web/charts.js` | Zero-`eval()` architecture passes strict SEP-1865 `canvas_studio` CSP (`script-src` without `'unsafe-eval'`) out-of-the-box — turning `canvas_studio` into an instant interactive math/graphing/bitwise/verifier surface. |
| **P1** | **5-Tier Usage Precedence + Provider Attempt Lineage + Cache Evidence Separation** (`inspector.tsx`, `cache-context-routing-contract.ts`) | `native/src/webui.rs`, `native/web/app.js`, `native/src/observatory.rs`, `native/src/telemetry.rs` | Prevents cost-only telemetry rows from wiping token counters and cleanly separates local `agy-fast` cache hits from authoritative provider prompt-cache hits. |
| **P1** | **Academic Citation Ledger + BFS Citation Graph + Anchored Drift-Aware Notes** (`academic-citation-ledger-preview.tsx`, `citation-graph-preview.tsx`, `artifact-document-studio-preview.tsx`) | `native/src/canvas_ui.rs`, `native/web/charts.js`, `native/src/research_vault.rs` | Pairs seamlessly with `agy-fast`'s `research_vault.rs` W3C `TextQuoteSelector` fuzzy quote verification: renders claim-level `Supported/Disputed/Unverified` triage, BFS citation clusters, and `anchorChanged` drift badges inside `canvas_studio`. |
| **P1** | **Kahn DAG Layering, Peer-Mesh Conflict Diffs & 4-Lane `Queue \| Steer \| Btw \| Discuss` Rail** (`agent-dag-orchestration-preview.tsx`, `agent-mesh-reconciliation-preview.tsx`, `goal-orchestration-rail.tsx`) | `native/web/app.js`, `native/web/charts.js`, `native/src/canvas_ui.rs` | Visualizes `agy-fast` multi-agent runs, critical paths, write-claim conflicts, and non-destructive `Steer` vs `Btw` side-notes. |
| **P2** | **Redacted Diagnostics 3-Column Export Gate + 9-Algorithm Interactive Trace Cards** (`diagnostics-session-workbench.tsx`, `algorithm-lab-preview.tsx`) | `native/src/webui.rs`, `native/web/app.js`, `native/src/canvas_ui.rs` | Enforces query-redacted diagnostic bundle review before export (`Included \| Excluded \| Validation checks`) and provides reusable interactive trace widgets for `canvas_studio`. |


---

## 7. Complete 409-File Coverage Ledger (`128,659` Lines, `0` Skipped)

Verification Totals:
- **Part A — Production Feature Modules (`[A-L]*`)**: `139` files, `56,368` lines (`55` directly `read_file`d + `139/139` full-line script-indexed).
- **Part B — Test Suites (`[A-L]*`)**: `132` files, `17,614` lines, `919` detected tests (`132/132` full-line script-indexed & reviewed via `test_catalog_132.md`).
- **Part C — Stylesheets (`src/styles/**`)**: `138` files, `54,677` lines (`19` directly `read_file`d + `138/138` full-line script-indexed).
- **Grand Total**: **`409` files / `128,659` lines / `0` skipped**.

### Part A — Production Feature Modules (`src/features/workspace/[A-L]*`, `139` files, `56,368` lines)

| # | Relative Path (`src/...`) | Lines | SHA-256 (12) | Read Mode | Primary Exports / Surface Summary |
|---:|---|---:|---|---|---|
| 1 | `features/workspace/academic-citation-bundle.ts` | 190 | `ac90220e21fd` | full-line-index | `const ACADEMIC_CITATION_BUNDLE_SCOPE`, `const ACADEMIC_CITATION_BUNDLE_VERSION`, `const ACADEMIC_CITATION_BUNDLE_MAX_BYTES`, `const ACADEMIC_CITATION_BUNDLE_MAX_CITATIONS` (+11 more) |
| 2 | `features/workspace/academic-citation-ledger-preview.tsx` | 791 | `88177eb5f006` | direct-read (L1-759/791) + full-line-index | `interface CitationLedgerSource`, `interface CitationLedgerClaim`, `type CitationQualitySignal`, `type CitationQualitySort` (+6 more) |
| 3 | `features/workspace/academic-studio-preview.tsx` | 421 | `2910294c00b4` | full-line-index | `function AcademicStudioPreview` [keys:4] |
| 4 | `features/workspace/accessibility-command-surface-preview.tsx` | 205 | `f531463c790e` | full-line-index | `function AccessibilityCommandSurfacePreview` [keys:8] |
| 5 | `features/workspace/activities/background-work-screen.tsx` | 166 | `07a4a41efdc6` | full-line-index | `function BackgroundWorkScreen` |
| 6 | `features/workspace/activities/home-screen.tsx` | 20 | `26f259449e88` | full-line-index | `function HomeScreen` |
| 7 | `features/workspace/activities/library-activity-screen.tsx` | 226 | `e412aaaea9d3` | direct-read (full) | `type LibraryWorkbenchId`, `function LibraryActivityScreen` |
| 8 | `features/workspace/activity-rail.tsx` | 60 | `5fcbf8f83459` | direct-read (full) | `function ActivityRail` |
| 9 | `features/workspace/activity-registry.tsx` | 259 | `cb8c830dec70` | direct-read (full) | `const ACTIVITY_IDS`, `type ActivityId`, `type NonChatActivityId`, `type ActivityPlacement` (+14 more) [keys:8] |
| 10 | `features/workspace/activity-screen-host.tsx` | 117 | `d766b456e091` | full-line-index | `type ActivityModuleLoader`, `function ActivityScreenHost` |
| 11 | `features/workspace/adaptive-auto-routing-learning-preview.tsx` | 315 | `c3c659d7fe35` | direct-read (full) | `function AdaptiveAutoRoutingLearningPreview` |
| 12 | `features/workspace/agent-dag-orchestration-preview.tsx` | 447 | `b620312edf5a` | direct-read (full) | `type AgentDagNodeState`, `type AgentDagNode`, `type AgentDagLayer`, `type AgentDagModel` (+4 more) |
| 13 | `features/workspace/agent-mesh-export.ts` | 248 | `e08906ea2840` | full-line-index | `type AgentMeshExportFormat`, `type AgentMeshExportScope`, `const AGENT_MESH_EXPORT_FORMAT`, `const AGENT_MESH_EXPORT_VERSION` (+4 more) |
| 14 | `features/workspace/agent-mesh-inbox-preview.tsx` | 482 | `94a26e12e7bd` | full-line-index | `type AgentMeshInboxPriority`, `type AgentMeshInboxStatus`, `type AgentMeshInboxKind`, `type AgentMeshInboxSensitivity` (+7 more) |
| 15 | `features/workspace/agent-mesh-preview.tsx` | 618 | `189ae7e74384` | direct-read (full) | `type AgentMeshView`, `type AgentMeshFilter`, `type AgentMeshMailboxDeliveryFilter`, `type AgentMeshMailboxSensitivityFilter` (+9 more) [keys:3] |
| 16 | `features/workspace/agent-mesh-reconciliation-preview.tsx` | 568 | `0a3254151623` | direct-read (full) | `type ReconciliationConflictKind`, `type ReconciliationConflictSeverity`, `type ReconciliationConflictState`, `type ReconciliationStrategy` (+9 more) [keys:3] |
| 17 | `features/workspace/agent-mesh-supervisor-flow.tsx` | 205 | `ff5e2aff7b51` | full-line-index | `type SupervisorFlowTaskState`, `interface SupervisorFlowTask`, `interface SupervisorFlowLayer`, `interface SupervisorFlowStats` (+4 more) |
| 18 | `features/workspace/agent-mesh-supervisor-policy.ts` | 118 | `dd2187d85612` | full-line-index | `type SupervisorChildAuthority`, `type SupervisorWriteConflict`, `type SupervisorOutputRoute`, `type SupervisorStaleSnapshot` (+14 more) |
| 19 | `features/workspace/agent-mesh-supervisor-preview.tsx` | 508 | `8e9dd1f2d77b` | direct-read (full) | `type AgentMeshSupervisorView`, `type AgentMeshSupervisorTaskMode`, `type AgentMeshSupervisorTaskState`, `interface AgentMeshSupervisorTask` (+2 more) [keys:3] |
| 20 | `features/workspace/agent-orchestration-prompt-preview.tsx` | 210 | `9c6d0cfade0c` | full-line-index | `type OrchestrationStrategy`, `type OrchestrationContextMode`, `type OrchestrationEffort`, `type OrchestrationRolePlan` (+4 more) |
| 21 | `features/workspace/ai-panel-composer.tsx` | 664 | `3332fb7beacc` | direct-read (full) | `interface AiPanelComposerAttachment`, `interface ComposerChoice`, `const DEFAULT_COMPOSER_PROVIDERS`, `const DEFAULT_COMPOSER_EFFORTS` (+10 more) [keys:5] |
| 22 | `features/workspace/algorithm-lab-preview.tsx` | 686 | `b94b421f72d5` | direct-read (L1-600/686) + full-line-index | `function AlgorithmLabPreview` [keys:3] |
| 23 | `features/workspace/appearance-preview-deck.tsx` | 795 | `60f891e79deb` | direct-read (full) | `function AppearancePreviewDeck` |
| 24 | `features/workspace/appearance-token-lab-contract.ts` | 73 | `4716a2908aa1` | full-line-index | `type AppearanceTokenLabCategory`, `type AppearanceTokenLabToken`, `type AppearanceTokenLabInput`, `function buildAppearanceTokenRows` (+2 more) |
| 25 | `features/workspace/appearance-token-lab.tsx` | 103 | `8db9033942c5` | full-line-index | `function AppearanceTokenLab` |
| 26 | `features/workspace/approval-request-preview-contract.ts` | 243 | `2470f492c04d` | direct-read (full) | `type ApprovalOperation`, `type ApprovalScope`, `type ApprovalExpiry`, `type ApprovalSandbox` (+23 more) |
| 27 | `features/workspace/approval-request-preview.tsx` | 247 | `e067a232edb8` | full-line-index | `function ApprovalRequestPreview` |
| 28 | `features/workspace/artifact-atomic-handoff-preview-contract.ts` | 259 | `a2dcac7326b6` | full-line-index | `const ARTIFACT_ATOMIC_HANDOFF_SCHEMA`, `const ARTIFACT_ATOMIC_HANDOFF_TYPE`, `type ArtifactAtomicTargetKind`, `type ArtifactAtomicCheckState` (+12 more) |
| 29 | `features/workspace/artifact-atomic-handoff-preview.tsx` | 167 | `7bfc10e31ba4` | full-line-index | `interface ArtifactAtomicHandoffPreviewProps`, `function ArtifactAtomicHandoffPreview` |
| 30 | `features/workspace/artifact-document-io.ts` | 140 | `704f0716a45b` | full-line-index | `const ARTIFACT_DOCUMENT_BUNDLE_SCOPE`, `const ARTIFACT_DOCUMENT_BUNDLE_VERSION`, `const ARTIFACT_DOCUMENT_MAX_BYTES`, `const ARTIFACT_DOCUMENT_MAX_CONTENT_LENGTH` (+7 more) |
| 31 | `features/workspace/artifact-document-studio-preview.tsx` | 1473 | `706719aed978` | direct-read (full) | `interface ArtifactDocumentStudioPreviewProps`, `function ArtifactDocumentStudioPreview` [keys:5] |
| 32 | `features/workspace/attachment-binary-preview.ts` | 102 | `504f18caa73d` | full-line-index | `const ATTACHMENT_BINARY_PREVIEW_MAX_BYTES`, `const ATTACHMENT_BINARY_PREVIEW_DEFAULT_BYTES`, `interface AttachmentBinaryPreview`, `function createAttachmentBinaryPreview` |
| 33 | `features/workspace/attachment-catalog.ts` | 298 | `a99cc8d3a7b3` | full-line-index | `interface NativeAttachmentRecord`, `function attachmentKind`, `function attachmentState`, `function formatAttachmentSize` (+8 more) |
| 34 | `features/workspace/automation-condition-set-preview.tsx` | 149 | `5f2c590abe3b` | full-line-index | `type AutomationConditionSetOperator`, `type AutomationConditionSetJoin`, `type AutomationConditionSetRule`, `type AutomationConditionSetSnapshot` (+5 more) |
| 35 | `features/workspace/automation-studio-preview.tsx` | 785 | `0a8b9383d2a1` | direct-read (L1-773/785) + full-line-index | `function AutomationStudioPreview` [keys:3] |
| 36 | `features/workspace/automation-workflow-builder-preview.tsx` | 305 | `8166eb3eed92` | full-line-index | `type AutomationBuilderTemplateId`, `type AutomationBuilderStepDraft`, `type AutomationWorkflowBuilderPreviewProps`, `function serializeAutomationWorkflowBuilder` (+1 more) |
| 37 | `features/workspace/automation-workflow-canvas-preview.tsx` | 366 | `d02436ee4a0b` | direct-read (full) | `type AutomationWorkflowCanvasLayout`, `type AutomationWorkflowCanvasNode`, `type AutomationWorkflowCanvasEdge`, `type AutomationWorkflowCanvasModel` (+4 more) |
| 38 | `features/workspace/automation-workflow-plan-preview.tsx` | 629 | `f22258f92401` | full-line-index | `type AutomationPlanStepKind`, `type AutomationConditionOperator`, `type AutomationApprovalRoute`, `type AutomationPlanExportFormat` (+10 more) |
| 39 | `features/workspace/background-task-inspector-preview.tsx` | 217 | `dffa3befdf33` | full-line-index | `type BackgroundTaskInspectorKind`, `type BackgroundTaskInspectorState`, `type BackgroundTaskInspectorFilter`, `type BackgroundTaskInspectorExportFormat` (+4 more) |
| 40 | `features/workspace/background-work-board-preview.tsx` | 238 | `4ed66f49683c` | full-line-index | `type BackgroundWorkBoardView`, `type BackgroundWorkBoardLane`, `interface BackgroundWorkBoardPreviewProps`, `function BackgroundWorkBoardPreview` [keys:3] |
| 41 | `features/workspace/background-work-export.ts` | 167 | `c5dda01e1fde` | full-line-index | `type BackgroundWorkExportFormat`, `const BACKGROUND_WORK_EXPORT_FORMAT`, `const BACKGROUND_WORK_EXPORT_SCOPE`, `const BACKGROUND_WORK_EXPORT_VERSION` (+3 more) |
| 42 | `features/workspace/background-work-inspector.tsx` | 639 | `990ba3552d4f` | direct-read (full) | `type BackgroundWorkKind`, `type BackgroundWorkRole`, `type BackgroundWorkState`, `interface BackgroundWorkRow` (+13 more) [keys:6] |
| 43 | `features/workspace/background-work-optional-workbench.tsx` | 258 | `468d9320de46` | full-line-index | `function BackgroundWorkOptionalWorkbench` |
| 44 | `features/workspace/background-work-projection.ts` | 315 | `99b00011a9d2` | full-line-index | `type BackgroundWorkKind`, `type BackgroundWorkState`, `type BackgroundWorkDurability`, `type BackgroundWorkAction` (+6 more) |
| 45 | `features/workspace/branch-revision-workbench.tsx` | 781 | `fc3c9a4ee5eb` | direct-read (full) | `type BranchWorkbenchTab`, `interface BranchWorkbenchBranch`, `interface BranchWorkbenchRevision`, `interface BranchRevisionProjection` (+8 more) |
| 46 | `features/workspace/builtin-calculator-workbench.tsx` | 2228 | `12728d920e64` | direct-read (full) | `const CALC_HISTORY_STORAGE_KEY`, `type BuiltinWorkbenchTabId`, `type WorkbenchThemePreset`, `type CasSubTabId` (+3 more) |
| 47 | `features/workspace/cache-context-routing-contract.ts` | 480 | `a4f13755b098` | direct-read (full) | `const CACHE_CONTEXT_ROUTE_SCHEMA`, `type LocalCacheReuseMode`, `type LocalCacheEncryption`, `type LocalCacheEviction` (+20 more) |
| 48 | `features/workspace/cache-context-routing-preview.tsx` | 340 | `20ef89dacbb8` | full-line-index | `const DEFAULT_USER_MANAGED_CACHE_OBJECTS`, `interface CacheContextRoutingPreviewProps`, `function CacheContextRoutingPreview` |
| 49 | `features/workspace/capability-matrix-workbench.tsx` | 378 | `1d6c317a8394` | direct-read (full) | `type CapabilityMatrixStatus`, `type CapabilityMatrixView`, `type CapabilityMatrixScope`, `type CapabilityMatrixStatusFilter` (+2 more) |
| 50 | `features/workspace/chat-entry-banner.tsx` | 62 | `76cad4ffa853` | full-line-index | `interface ChatEntryBannerProps`, `function ChatEntryBanner` |
| 51 | `features/workspace/chat-first-canvas.tsx` | 171 | `bd436b4d4b1b` | direct-read (full) | `function ChatFirstCanvas` [keys:1] |
| 52 | `features/workspace/chat-signal-strip.tsx` | 426 | `1f4a91c09138` | direct-read (full) | `type ChatSignalFilter`, `interface ChatSignalProjectionInput`, `function buildChatSignalProjection`, `interface ChatSignalStripProps` (+1 more) [keys:3] |
| 53 | `features/workspace/chat-workbench-strip.tsx` | 188 | `e1f12265199f` | full-line-index | `function ChatWorkbenchStrip` [keys:3] |
| 54 | `features/workspace/citation-graph-preview.tsx` | 554 | `3ea2aa70c517` | direct-read (full) | `function CitationGraphPreview` |
| 55 | `features/workspace/citation-selection-store.ts` | 37 | `4245f6935005` | full-line-index | `const useCitationSelectionStore`, `function focusCitationReturnTarget` |
| 56 | `features/workspace/citation-timeline.tsx` | 727 | `0d15126e4e69` | direct-read (full) | `interface CitationMarkerProps`, `function CitationMarker`, `function CitationStrip`, `interface SourcesInspectorProps` (+3 more) |
| 57 | `features/workspace/collapsible-ai-steps.tsx` | 249 | `d5a3c3083dca` | direct-read (full) | `interface AiStep`, `interface CollapsibleAiStepsProps`, `function CollapsibleAiSteps` |
| 58 | `features/workspace/command-history-session.ts` | 52 | `edc87e668929` | full-line-index | `type CommandHistoryGroup`, `interface CommandHistoryEntry`, `function getCommandHistory`, `function recordCommandInvocation` (+1 more) |
| 59 | `features/workspace/command-palette-host.tsx` | 43 | `25bf1b6d6acd` | full-line-index | `function CommandPaletteHost` |
| 60 | `features/workspace/command-palette.tsx` | 1266 | `640197543182` | direct-read (full) | `function CommandPalette` [keys:16] |
| 61 | `features/workspace/command-registry-adapter.ts` | 97 | `8ea73795f1f4` | full-line-index | `type WorkspacePaletteCommand`, `type WorkspacePaletteCommandOptions`, `function createWorkspacePaletteCommands`, `function invokeWorkspacePaletteCommand` |
| 62 | `features/workspace/composer-attachment-admission-review-contract.ts` | 177 | `61912f1c6459` | full-line-index | `type AttachmentAdmissionGateId`, `type AttachmentAdmissionGateStatus`, `type AttachmentAdmissionDecision`, `interface AttachmentAdmissionGate` (+5 more) |
| 63 | `features/workspace/composer-attachment-admission-review.tsx` | 126 | `f5dff33b4c54` | full-line-index | `function ComposerAttachmentAdmissionReview` |
| 64 | `features/workspace/composer-attachment-compatibility-contract.ts` | 254 | `0637d8f43640` | full-line-index | `type ComposerAttachmentCompatibilityStatus`, `type ComposerAttachmentCompatibilityKind`, `interface ComposerAttachmentCompatibilityRow`, `interface ComposerAttachmentCompatibilitySummary` (+5 more) |
| 65 | `features/workspace/composer-attachment-compatibility.tsx` | 75 | `9cae2bbcfdb8` | full-line-index | `function ComposerAttachmentCompatibility` |
| 66 | `features/workspace/composer-attachments.tsx` | 281 | `59eb5faad7b7` | full-line-index | `type ComposerAttachmentKind`, `type ComposerAttachmentState`, `interface ComposerAttachmentItem`, `interface ComposerAttachmentSummary` (+4 more) |
| 67 | `features/workspace/composer-block-insert-studio.tsx` | 362 | `cc0da3ad8b37` | direct-read (full) | `type ComposerBlockCategory`, `interface ComposerBlockTemplate`, `const COMPOSER_BLOCK_TEMPLATES`, `interface ComposerBlockInsertStudioProps` (+1 more) |
| 68 | `features/workspace/composer-draft-contract.ts` | 226 | `2da7045f6f0d` | full-line-index | `const COMPOSER_DRAFT_BUNDLE_SCOPE`, `const COMPOSER_DRAFT_BUNDLE_VERSION`, `type ComposerDraftMode`, `type ComposerDraftPortableFormat` (+9 more) |
| 69 | `features/workspace/composer-draft-history.ts` | 111 | `754e0ec9c94b` | full-line-index | `type DraftChangeKind`, `interface ComposerDraftHistoryController`, `function useComposerDraftHistory` |
| 70 | `features/workspace/composer-draft-studio.tsx` | 499 | `2d09ad7e1c60` | full-line-index | `interface ComposerDraftStudioProps`, `function ComposerDraftStudio` |
| 71 | `features/workspace/composer-draft-versions.ts` | 126 | `0c8a23c93a75` | full-line-index | `interface ComposerDraftLinePreview`, `interface ComposerDraftVersionStats`, `interface ComposerDraftVersionComparison`, `function summarizeComposerDraftVersion` (+1 more) |
| 72 | `features/workspace/composer-editor-workbench.tsx` | 215 | `49c77f937539` | full-line-index | `type ComposerEditorWrapMode`, `type ComposerEditorPreferences`, `const DEFAULT_COMPOSER_EDITOR_PREFERENCES`, `type ComposerEditorDraftSummary` (+3 more) |
| 73 | `features/workspace/composer-editor.ts` | 686 | `8cfdc7dd4b44` | direct-read (full) | `type ComposerEditorDirection`, `type ComposerEditorChange`, `type ComposerInlineMarker`, `type ComposerListStyle` (+12 more) |
| 74 | `features/workspace/composer-input-policy.ts` | 168 | `025a920bd8f8` | full-line-index | `const DEFAULT_COMPOSER_INPUT_THRESHOLDS`, `type ComposerInputThresholdKey`, `type ComposerInputPolicyMode`, `interface ComposerInputThresholds` (+6 more) |
| 75 | `features/workspace/composer-media-preview.tsx` | 160 | `a1e0a4e8719e` | full-line-index | `type ComposerMediaKind`, `function ComposerMediaPreview` |
| 76 | `features/workspace/composer-mode-controls-preview.tsx` | 399 | `01b04e8680f2` | full-line-index | `interface ComposerModeControlsPreviewProps`, `function ComposerModeControlsPreview` |
| 77 | `features/workspace/composer-paste-preview.tsx` | 107 | `4e1f4a67e6b9` | full-line-index | `interface ComposerPastePreviewProps`, `function ComposerPastePreview` |
| 78 | `features/workspace/composer-paste.ts` | 185 | `ef233b6b0b5f` | full-line-index | `interface ComposerPasteAssessment`, `interface ComposerPasteFileProjection`, `function assessComposerPaste`, `function projectComposerPasteFile` (+6 more) |
| 79 | `features/workspace/composer-rich-preview.tsx` | 1113 | `4b3def488ac4` | direct-read (full) | `type ComposerPreviewMode`, `type ComposerPreviewBlockKind`, `type ComposerPreviewBlock`, `type ComposerPreviewAnalysis` (+11 more) [keys:6] |
| 80 | `features/workspace/composer-slash-commands.ts` | 798 | `4b2bd0a5ea12` | direct-read (full) | `type ComposerSlashCommandId`, `type ComposerSlashCommandCategory`, `type ComposerSlashCommandStatus`, `type ComposerSlashCommandInsertMode` (+24 more) [slash:/branch,/btw,/checklist,/clone] |
| 81 | `features/workspace/composer.tsx` | 2491 | `bc9300270dba` | direct-read (full) | `function ChatComposer` [keys:15] |
| 82 | `features/workspace/computer-use-video-overlay.tsx` | 502 | `938a36c764e9` | direct-read (full) | `interface ComputerUseVideoOverlayPanelProps`, `function ComputerUseVideoOverlayPanel` [keys:3] |
| 83 | `features/workspace/context-answer-receipt.tsx` | 179 | `2ed8b8a706ea` | full-line-index | `type AnswerReceiptRowState`, `interface AnswerReceiptRow`, `interface AnswerReceiptModel`, `function buildAnswerReceiptModel` (+1 more) |
| 84 | `features/workspace/context-compiler-preview.tsx` | 598 | `ed0919eb81a9` | full-line-index | `interface ContextCompilerFolderCandidate`, `interface ContextCompilerMemoryCandidate`, `interface ContextCompilerSkillCandidate`, `type ContextCompilerView` (+9 more) [keys:3] |
| 85 | `features/workspace/context-estimate.ts` | 69 | `4e3135969b1b` | full-line-index | `type ContextEstimateStatus`, `interface ContextEstimateView`, `interface ContextEstimateInput`, `function buildContextEstimate` (+2 more) |
| 86 | `features/workspace/context-harness.ts` | 988 | `ae598e95beba` | direct-read (full) | `type HarnessMessageRole`, `type RetrievalSourceKind`, `interface HarnessInstructionInput`, `interface HarnessConversationTurn` (+14 more) |
| 87 | `features/workspace/context-inspector-host.tsx` | 34 | `9d2bf3b7fee3` | full-line-index | `function ContextInspectorHost` |
| 88 | `features/workspace/context-manifest-preview.tsx` | 70 | `7e1405c78095` | full-line-index | `function ContextManifestPreview` |
| 89 | `features/workspace/context-memory-skill-receipt.tsx` | 379 | `778b6b3e03df` | full-line-index | `type ContextReceiptComponentKind`, `type ContextReceiptComponentState`, `type ContextReceiptProvenanceState`, `interface ContextReceiptProvenance` (+8 more) |
| 90 | `features/workspace/context-preflight-preview.tsx` | 413 | `a35895e90b97` | full-line-index | `type ContextPreflightSourceStatus`, `interface ContextPreflightSource`, `function ContextPreflightPreview` |
| 91 | `features/workspace/context-run-evidence.tsx` | 297 | `a240475f0fd1` | full-line-index | `type ContextRunEvidenceSurface`, `type ContextRunEvidenceState`, `interface ContextRunEvidenceRow`, `interface ContextRunEvidenceModel` (+2 more) |
| 92 | `features/workspace/conversation-actions-dialog.tsx` | 408 | `0251633b574f` | full-line-index | `interface ConversationActionsDialogProps`, `function ConversationActionsDialog` [keys:4] |
| 93 | `features/workspace/conversation-catalog.ts` | 142 | `c4eab30018fe` | full-line-index | `function activeMessageIds`, `function conversationFromNativeSnapshot`, `function conversationsFromNativeSnapshots` |
| 94 | `features/workspace/conversation-message-actions-preview.tsx` | 371 | `ad692cfb49ce` | full-line-index | `type ConversationMessagePreviewAction`, `function ConversationMessageActionPreview` |
| 95 | `features/workspace/conversation-navigation-model.ts` | 700 | `c57ff69efa66` | direct-read (full) | `type NavigationMarkerKind`, `type NavigationFacet`, `interface NavigationFilter`, `interface NavigationMarker` (+24 more) |
| 96 | `features/workspace/conversation-navigation.tsx` | 460 | `e6b3becc39e8` | full-line-index | `interface ConversationNavigationProps`, `function ConversationNavigation` [keys:7] |
| 97 | `features/workspace/conversation-project-bridge.tsx` | 210 | `9d95aab2d97b` | full-line-index | `function ConversationProjectBridge` |
| 98 | `features/workspace/conversation-scope-header.tsx` | 253 | `14a58174a60a` | full-line-index | `function ConversationScopeHeader` [keys:7] |
| 99 | `features/workspace/conversation-start-dialog.tsx` | 349 | `ab6ff7532a73` | full-line-index | `function ConversationStartDialog` |
| 100 | `features/workspace/conversation-view.tsx` | 1259 | `ec3099dc8d0a` | direct-read (full) | `function conversationMessageSteps`, `function NativeBranchSelector`, `function ConversationView` [keys:5] |
| 101 | `features/workspace/data-intake-learning-review.tsx` | 537 | `f5398c386924` | full-line-index | `type IntakeSource`, `type IntakeSensitivity`, `type IntakeConsent`, `type IntakeRetention` (+13 more) |
| 102 | `features/workspace/data-lineage-studio.tsx` | 677 | `12e59561768b` | direct-read (L1-670/677) + full-line-index | `type LineageNodeKind`, `type LineageNodeStatus`, `type LineageEdgeKind`, `type LineageEdgeStatus` (+18 more) |
| 103 | `features/workspace/delivery-evidence-status-preview.tsx` | 317 | `9536d1014c15` | full-line-index | `type DeliveryEvidenceStatus`, `type DeliveryEvidenceGroup`, `interface DeliveryEvidenceItem`, `const DELIVERY_EVIDENCE_ITEMS` (+1 more) |
| 104 | `features/workspace/diagnostics-session-contract.ts` | 250 | `94f591ae554f` | full-line-index | `type DiagnosticPreviewLevel`, `type DiagnosticPreviewCategory`, `interface DiagnosticPreviewEvent`, `type DiagnosticPreviewFormat` (+12 more) |
| 105 | `features/workspace/diagnostics-session-workbench.tsx` | 577 | `1c07d3d79d80` | direct-read (full) | `type DiagnosticsHistoryAction`, `type DiagnosticsHistoryEntry`, `const DIAGNOSTICS_HISTORY_ACTION_LABELS`, `function filterDiagnosticsHistory` (+2 more) |
| 106 | `features/workspace/dialogs.tsx` | 595 | `e9b45ed179c6` | full-line-index | `const providerTemplates`, `function ProjectDialog`, `function ProviderDialog`, `function GlobalDialogs` |
| 107 | `features/workspace/embedded-vscode-stage.css` | 67 | `81355f63b651` | full-line-index | internal / default component |
| 108 | `features/workspace/embedded-vscode-stage.tsx` | 179 | `2ad82c99550a` | direct-read (full) | `function EmbeddedVscodeStage` |
| 109 | `features/workspace/evaluation-rubric-workbench.tsx` | 211 | `e8ad211ec435` | full-line-index | `type EvaluationRubricTone`, `type EvaluationRubricDimension`, `type RubricPresetId`, `type RubricAdjudication` (+6 more) |
| 110 | `features/workspace/evidence-types.ts` | 170 | `e24ebb591a03` | full-line-index | `type CitationSourceType`, `type CitationVerificationState`, `interface CitationView`, `type RunTimelineStage` (+8 more) |
| 111 | `features/workspace/extensions-mcp-hub.tsx` | 769 | `9a003f9ac410` | direct-read (full) | `interface ExtensionRecord`, `const EXTENSION_SEED`, `function serializeExtensionManifest`, `function parseExtensionManifest` (+1 more) [keys:3] |
| 112 | `features/workspace/extensions-mcp-permission-review-contract.ts` | 140 | `db879a1e2964` | full-line-index | `type ExtensionPermissionGrantMode`, `type ExtensionPermissionRisk`, `type ExtensionPermissionScope`, `type ExtensionPermissionExpiry` (+16 more) |
| 113 | `features/workspace/finance-workspace-preview.tsx` | 215 | `efaa5f75f649` | full-line-index | `function FinanceWorkspacePreview` |
| 114 | `features/workspace/git-ci-workbench-preview.tsx` | 543 | `867158fa12d2` | direct-read (L1-531/543) + full-line-index | `function GitCiWorkbenchPreview` [keys:6] |
| 115 | `features/workspace/global-dialogs-host.tsx` | 43 | `66ac03ec5713` | full-line-index | `function GlobalDialogsHost` |
| 116 | `features/workspace/global-object-search-preview.tsx` | 961 | `fa9ecefa48b9` | direct-read (full) | `type GlobalSearchKind`, `type GlobalSearchStatus`, `type GlobalSearchSort`, `interface GlobalObjectSearchResult` (+7 more) [keys:7] |
| 117 | `features/workspace/goal-orchestration-rail.tsx` | 111 | `612c333429c3` | direct-read (full) | `function GoalOrchestrationRail` |
| 118 | `features/workspace/goal-task-studio.tsx` | 496 | `b285b7199ad9` | direct-read (full) | `function parseGoalTaskPreview`, `function GoalTaskStudio` [keys:1] |
| 119 | `features/workspace/harness-capability-synthesis.tsx` | 353 | `6ff8f3ca2762` | direct-read (full) | `type HarnessSynthesisSource`, `type HarnessSynthesisRecommendation`, `type HarnessSynthesisDomain`, `type HarnessSynthesisFormat` (+6 more) |
| 120 | `features/workspace/harness-contract-panel.tsx` | 236 | `5a84c7108277` | full-line-index | `function HarnessContractPanel` |
| 121 | `features/workspace/harness-evidence-register.ts` | 70 | `df203ad15350` | full-line-index | `type HarnessEvidenceStrength`, `type HarnessSourceEvidence`, `const HARNESS_EVIDENCE_REFRESH`, `const HARNESS_SOURCE_EVIDENCE` (+1 more) |
| 122 | `features/workspace/home-import-preview.tsx` | 297 | `a8825b3df122` | full-line-index | `interface HomeImportPreviewProps`, `function HomeImportPreview` |
| 123 | `features/workspace/home-lazy-surface.tsx` | 50 | `7a3ae551a5b4` | full-line-index | `function HomeLazySurface` |
| 124 | `features/workspace/home-mission-control.tsx` | 200 | `dbc03eae7a3e` | full-line-index | `interface HomeMissionControlProps`, `function HomeMissionControl` |
| 125 | `features/workspace/home-operations-deck.tsx` | 282 | `ba9f27d3f7a2` | full-line-index | `interface HomeOperationsDeckProps`, `function HomeOperationsDeck` |
| 126 | `features/workspace/home-quick-access-contract.ts` | 91 | `f3bdb255cfac` | full-line-index | `const HOME_QUICK_ACCESS_SCHEMA`, `const HOME_QUICK_ACCESS_IMPORT_LIMIT`, `const HOME_QUICK_ACCESS_ACTIONS`, `type HomeQuickAccessActionId` (+5 more) |
| 127 | `features/workspace/home-quick-access.tsx` | 251 | `7827575222b2` | full-line-index | `interface HomeQuickAccessProps`, `function HomeQuickAccess` |
| 128 | `features/workspace/ide-agent-sidebar.tsx` | 413 | `8676a310bf9b` | direct-read (full) | `interface IdeProjectFolder`, `const DEFAULT_IDE_PROJECT_FOLDERS`, `function extractLatestAgentCode`, `function ideAssistantSteps` (+1 more) [slash:/btw,/calc,/remote,/spawn; keys:1] |
| 129 | `features/workspace/ide-editor-transport.ts` | 111 | `c04d3daa4442` | full-line-index | `interface EditorServerStatus`, `interface EditorWorkspaceFolder`, `interface EditorWorkspace`, `function usesNativeEditorTransport` (+6 more) |
| 130 | `features/workspace/inspector-preview.tsx` | 592 | `7e84a44381e3` | full-line-index | `type InspectorPreviewView`, `function InspectorPreview` [keys:3] |
| 131 | `features/workspace/inspector.tsx` | 1028 | `6aed5acf4472` | direct-read (full) | `function ContextInspectorPanel` [keys:3] |
| 132 | `features/workspace/keyboard-shortcut-session.ts` | 97 | `d7362def1e88` | direct-read (full) | `type RendererCommandShortcut`, `type RendererShortcutAction`, `type ShortcutOverrides`, `function isActiveRendererShortcut` (+4 more) |
| 133 | `features/workspace/keyboard-shortcuts-dialog.tsx` | 558 | `7fb12850d57e` | direct-read (full) | `function KeyboardShortcutsDialog` [keys:3] |
| 134 | `features/workspace/knowledge-tree-explorer.tsx` | 1579 | `d5d48f88feb3` | direct-read (full) | `type KnowledgeStudioTabId`, `type SovereignArtifactTabId`, `const LTST_KNOWLEDGE_STORAGE_KEY`, `const HARNESS_CONFIG_STORAGE_KEY` (+12 more) [slash:/architecture,/bug-postmortems,/learned-skills,/session-provenance] |
| 135 | `features/workspace/learning-loop-lab.tsx` | 725 | `bc27cecb97de` | direct-read (L1-694/725) + full-line-index | `type LearningReviewCadence`, `type LearningReviewDecision`, `type LearningReviewSchedule`, `type LearningEvent` (+6 more) |
| 136 | `features/workspace/library-conversation-crud-preview.tsx` | 857 | `992142136d4b` | direct-read (L1-800/857) + full-line-index | `type ConversationSearchMode`, `type ConversationSearchScope`, `type ConversationSearchSort`, `function conversationMatchesLibrarySearch` (+2 more) [keys:8] |
| 137 | `features/workspace/library-screen.tsx` | 1267 | `20f5aeb58152` | direct-read (full) | `interface LibraryScreenProps`, `function LibraryScreen` |
| 138 | `features/workspace/local-model-catalog-preview.tsx` | 392 | `ff42f97e2ee1` | direct-read (full) | `function LocalModelCatalogPreview` |
| 139 | `features/workspace/local-model-readiness-preview.tsx` | 250 | `588b224119b8` | direct-read (full) | `function LocalModelReadinessPreview` |

### Part B — Test Suites (`src/features/workspace/[A-L]*.test.*`, `132` files, `17,614` lines, `919` tests)

| # | Relative Path (`src/...`) | Lines | SHA-256 (12) | Tests | Read Mode | Key Tested Contracts (Sample) |
|---:|---|---:|---|---:|---|---|
| 1 | `features/workspace/academic-citation-bundle.test.ts` | 60 | `c09e91b15098` | 5 | full-line-index | academic citation bundle; round-trips the strict JSON bundle and preserves citation metadata; round-trips portable Markdown without ... |
| 2 | `features/workspace/academic-citation-ledger-preview.test.tsx` | 225 | `b789ea24edd8` | 13 | full-line-index | AcademicCitationLedgerPreview; keeps the evidence boundary visible and summarizes the preview ledger; filters claims and updates the... |
| 3 | `features/workspace/academic-studio-preview.test.tsx` | 108 | `180a4a99325e` | 10 | full-line-index | AcademicStudioPreview; lets a user add an outline section and switch the drafting language; keeps the citation and export boundaries... |
| 4 | `features/workspace/accessibility-command-surface-preview.test.tsx` | 57 | `9dfe3bdd1863` | 5 | full-line-index | AccessibilityCommandSurfacePreview; renders independent comfort controls and a command finder with a clear preview boundary; applies... |
| 5 | `features/workspace/accessibility.test.tsx` | 77 | `1693f90278cc` | 5 | full-line-index | workspace accessibility contracts; connects the command input to its listbox and active option; gives a dialog a unique accessible t... |
| 6 | `features/workspace/activities/background-work-screen.test.tsx` | 103 | `6a3a92b560dd` | 5 | full-line-index | BackgroundWorkScreen; mounts the renderer-only background-work activity from workspace state; opens a source thread without mutating... |
| 7 | `features/workspace/activities/legacy-screens.test.tsx` | 29 | `b4c33e2fd45c` | 3 | full-line-index | legacy Home and Settings activity screens; points Home to the single Home hub entry point; points Settings to the rail Settings dial... |
| 8 | `features/workspace/activities/library-activity-screen.test.tsx` | 50 | `44c5dced2867` | 4 | full-line-index | LibraryActivityScreen; opens one workbench at a time and keeps the optional surfaces lazy; keeps renderer-local boundary copy with t... |
| 9 | `features/workspace/activity-rail.test.tsx` | 40 | `b8cac0749fa4` | 3 | full-line-index | ActivityRail; routes every primary and secondary rail button to its renderer activity; keeps the approved rail icon-only with crisp ... |
| 10 | `features/workspace/activity-registry.test.ts` | 87 | `125ddc14ee38` | 6 | full-line-index | workspace activity registry; contains each canonical activity exactly once; keeps chats eager and gives every non-chat activity one ... |
| 11 | `features/workspace/activity-screen-host.test.tsx` | 85 | `b424ad006f50` | 4 | full-line-index | lazy activity screen host; renders an accessible loading state and then the loaded activity; contains loader failures and retries wi... |
| 12 | `features/workspace/adaptive-auto-routing-learning-preview.test.tsx` | 57 | `6f61a1fe2e9a` | 5 | full-line-index | AdaptiveAutoRoutingLearningPreview; exposes adaptive strategy, role, signal, and learning-source controls; recalculates the recommen... |
| 13 | `features/workspace/agent-dag-orchestration-preview.test.tsx` | 88 | `618f8f588dc3` | 7 | full-line-index | AgentDagOrchestrationPreview; derives layers, ready gates, leaves, and critical path from visible nodes; diagnoses malformed referen... |
| 14 | `features/workspace/agent-mesh-export.test.ts` | 104 | `c7c68dca4264` | 4 | full-line-index | agent mesh export; serializes a bounded JSON envelope with explicit renderer scope; keeps Markdown export readable for selected records |
| 15 | `features/workspace/agent-mesh-inbox-preview.test.tsx` | 62 | `f143400dc992` | 6 | full-line-index | AgentMeshInboxPreview; renders a triage queue with truthful preview wording; filters decision messages and supports bulk renderer-se... |
| 16 | `features/workspace/agent-mesh-preview.test.tsx` | 187 | `38871458d011` | 12 | full-line-index | AgentMeshPreview; renders a bounded graph with truthful renderer-only wording; filters attention agents and exposes selected-agent r... |
| 17 | `features/workspace/agent-mesh-reconciliation-preview.test.tsx` | 115 | `d7e42f4aafe8` | 9 | full-line-index | AgentMeshReconciliationPreview; renders bounded conflict inventory and selected contender detail; keeps strategy and state changes i... |
| 18 | `features/workspace/agent-mesh-supervisor-flow.test.tsx` | 52 | `e1b3334271b4` | 4 | full-line-index | AgentMeshSupervisorFlow; derives stable layers and ignores missing dependency ids; renders dependency layers and a selected node detail |
| 19 | `features/workspace/agent-mesh-supervisor-policy.test.ts` | 48 | `14d18fa367f5` | 4 | full-line-index | Agent Mesh supervisor policy preview contract; normalizes unknown values and clamps the parallel task bound; round-trips a bounded p... |
| 20 | `features/workspace/agent-mesh-supervisor-preview.test.tsx` | 74 | `a9a7a2216666` | 6 | full-line-index | AgentMeshSupervisorPreview; renders queue projections with explicit renderer-only boundaries; shows bounded task detail and keeps re... |
| 21 | `features/workspace/agent-orchestration-prompt-preview.test.tsx` | 72 | `4284ced0f3d3` | 5 | full-line-index | AgentOrchestrationPromptPreview; derives bounded roles from prompt signals without claiming execution; supports prompt analysis, rol... |
| 22 | `features/workspace/ai-panel-composer.test.tsx` | 120 | `601f19e367c8` | 7 | full-line-index | shared review AI composer; uses the exact quiet placeholder and footer with real controls only; does not invent a model or reasoning... |
| 23 | `features/workspace/algorithm-lab-preview.test.tsx` | 125 | `da2649696335` | 11 | full-line-index | AlgorithmLabPreview; offers editable algorithm presets and deterministic binary-search output; rehearses merge sort with editable in... |
| 24 | `features/workspace/appearance-preview-deck.test.tsx` | 156 | `d949c9bbd0b4` | 8 | full-line-index | Appearance Preview Deck; offers multiple palette directions and keeps changes reversible in the renderer; supports a custom accent a... |
| 25 | `features/workspace/appearance-token-lab.test.ts` | 38 | `b362b91b2d0f` | 4 | full-line-index | appearance token lab contract; builds colorful semantic signals on neutral surface layers; filters families without changing the sou... |
| 26 | `features/workspace/appearance-token-lab.test.tsx` | 31 | `df7f4bf36432` | 3 | full-line-index | AppearanceTokenLab; shows the semantic map and supports family filtering; reports clipboard boundaries without changing tokens |
| 27 | `features/workspace/approval-request-preview-contract.test.ts` | 41 | `4367f8e4836e` | 4 | full-line-index | approval request preview contract; provides safe presets with exact targets and bounded network/secret defaults; uses a conservative... |
| 28 | `features/workspace/approval-request-preview.test.tsx` | 91 | `84276fc9c5ae` | 7 | full-line-index | Approval Request Preview; shows exact-request inputs, presets, and an explicit renderer-only boundary; loads a high-risk command rev... |
| 29 | `features/workspace/artifact-atomic-handoff-preview-contract.test.ts` | 80 | `02a3c5e37b6c` | 5 | full-line-index | artifact atomic handoff preview contract; freezes one source revision and stable retry identity; changes the key when source revisio... |
| 30 | `features/workspace/artifact-atomic-handoff-preview.test.tsx` | 49 | `16c5169ab264` | 4 | full-line-index | ArtifactAtomicHandoffPreview; shows the exact source and supports a renderer-local staging action; switches destinations and blocks ... |
| 31 | `features/workspace/artifact-document-io.test.ts` | 65 | `4657340e2165` | 4 | full-line-index | artifact document portable I/O; round-trips a strict JSON bundle; round-trips portable Markdown and accepts plain Markdown with neut... |
| 32 | `features/workspace/artifact-document-studio-preview.test.tsx` | 330 | `e5952d39bb24` | 15 | full-line-index | artifact document studio preview; renders an editable outline and deterministic rendered preview; supports layout changes, local res... |
| 33 | `features/workspace/attachment-binary-preview.test.ts` | 51 | `eeadd35545d3` | 4 | full-line-index | native attachment binary preview; validates authenticated bytes and keeps non-media bytes inert; creates a data URL only for the exp... |
| 34 | `features/workspace/attachment-catalog.test.ts` | 290 | `f3d25a0104c2` | 10 | full-line-index | native attachment catalog; maps the renderer-safe desktop record and preserves open-draft ownership; deduplicates desktop rows and r... |
| 35 | `features/workspace/automation-condition-set-preview.test.tsx` | 54 | `c6f31a6d49fe` | 4 | full-line-index | Automation condition set preview; validates ALL and ANY rule expressions in the renderer; adds, edits, removes and previews a multi-... |
| 36 | `features/workspace/automation-studio-preview.test.tsx` | 224 | `919ed91d95c0` | 15 | full-line-index | Automation Studio preview; shows trigger-aware workflows and an explicit renderer boundary; adds a renderer-local draft automation t... |
| 37 | `features/workspace/automation-workflow-builder-preview.test.tsx` | 97 | `366edafd4bab` | 6 | full-line-index | Automation workflow builder preview; shows reusable templates and a bounded renderer boundary; filters templates and stages resolved... |
| 38 | `features/workspace/automation-workflow-plan-preview.test.tsx` | 115 | `36dcba050135` | 8 | full-line-index | Automation workflow plan preview; builds a typed plan and exports JSON/Markdown with a preview boundary; edits, reorders, toggles, a... |
| 39 | `features/workspace/background-task-inspector-preview.test.tsx` | 89 | `308a71b766a8` | 5 | full-line-index | Background Task Inspector Preview; renders the work graph and keeps authority boundaries visible; filters records, reviews a selecte... |
| 40 | `features/workspace/background-work-board-preview.test.tsx` | 112 | `77d2ceb74bfe` | 5 | full-line-index | BackgroundWorkBoardPreview; renders visible work across stage lanes and exposes truthful preview copy; switches to a flow map, filte... |
| 41 | `features/workspace/background-work-export.test.ts` | 103 | `29a75dbee9c4` | 4 | full-line-index | background-work export preview; serializes canonical counts and redacts sensitive-looking item text; renders a readable Markdown sum... |
| 42 | `features/workspace/background-work-inspector.test.tsx` | 259 | `999d65b3a810` | 10 | full-line-index | background work inspector; projects active conversations and completed timeline runs once each; adapts the canonical projection with... |
| 43 | `features/workspace/background-work-optional-workbench.test.tsx` | 105 | `19f169a4c138` | 5 | full-line-index | BackgroundWorkOptionalWorkbench; keeps the optional stage closed until requested and exposes one keyboard entry point; reopens the d... |
| 44 | `features/workspace/background-work-projection.test.ts` | 274 | `e7d856d94e96` | 7 | full-line-index | background-work projection; projects visible queued, running, and failed Chat states with attention counts; prefers the latest repla... |
| 45 | `features/workspace/branch-revision-workbench.test.tsx` | 249 | `495c63a2c9ea` | 8 | full-line-index | BranchRevisionWorkbench; keeps renderer-estimated branch slots distinct from hydrated native lineage; maps native ConversationView b... |
| 46 | `features/workspace/builtin-calculator-workbench.test.tsx` | 252 | `1a9f1a5ef37d` | 10 | full-line-index | BuiltinCalculatorWorkbench; exports both named BuiltinCalculatorWorkbench and default export; evaluates scientific expressions, memo... |
| 47 | `features/workspace/cache-context-routing-contract.test.ts` | 214 | `babb5234a91b` | 15 | full-line-index | cache/context route preview contract; plans stable selected segments without calling them provider hits; keeps local reuse separate ... |
| 48 | `features/workspace/cache-context-routing-preview.test.tsx` | 93 | `e5ba5b2028cc` | 7 | full-line-index | CacheContextRoutingPreview; exposes reversible local/provider controls and a prefix plan; can collapse and reopen the prefix plan |
| 49 | `features/workspace/capability-matrix-workbench.test.tsx` | 58 | `d2e2cfc2b2d1` | 4 | full-line-index | CapabilityMatrixWorkbench; compares provider-reported capabilities and keeps future endpoints planned; filters local models and lets... |
| 50 | `features/workspace/chat-first-canvas.test.tsx` | 81 | `c24688124acf` | 4 | full-line-index | ChatFirstCanvas; makes the advertised Alt+Enter shortcut focus the message composer; keeps starter prompts out of the default Chat r... |
| 51 | `features/workspace/chat-signal-strip.test.tsx` | 253 | `d4891121998b` | 9 | full-line-index | ChatSignalStrip; projects selected-chat attention and active state without a durable event journal; keeps run timeline signals scope... |
| 52 | `features/workspace/chat-workbench-strip.test.tsx` | 181 | `55ff96849279` | 7 | full-line-index | ChatWorkbenchStrip; exposes overview metrics and truthful workbench tabs; opens the inspector target from route and run panels witho... |
| 53 | `features/workspace/citation-graph-preview.test.tsx` | 107 | `310af91f2536` | 8 | full-line-index | citation graph preview; renders the evidence map with explicit preview boundaries; filters nodes and lets the user inspect a connect... |
| 54 | `features/workspace/citation-rendering.test.tsx` | 180 | `8429d45079ad` | 4 | full-line-index | persisted citation presentation; opens exact persisted evidence without exposing unsafe source URI schemes; scopes Answer evidence t... |
| 55 | `features/workspace/collapsible-ai-steps.test.tsx` | 58 | `e0437ef87966` | 5 | full-line-index | CollapsibleAiSteps; puts completed thinking and command steps on separate collapsed disclosures; auto-collapses previous work and op... |
| 56 | `features/workspace/command-history-session.test.ts` | 37 | `1e6a43922952` | 3 | full-line-index | renderer-session command history; keeps the newest invocation first and de-duplicates repeated commands; keeps a bounded tab-local h... |
| 57 | `features/workspace/command-palette.command-center.test.tsx` | 314 | `482fa987fc03` | 8 | full-line-index | command center object scopes; searches renderer-visible memory and library records from Ctrl+K; surfaces provider and model scopes w... |
| 58 | `features/workspace/command-palette.phase2.test.tsx` | 313 | `121927bb9ecc` | 9 | full-line-index | Phase 2 command palette; supports prefix-scoped search for commands, chats, and projects; opens the selected inspector tab and close... |
| 59 | `features/workspace/composer-attachment-admission-review-contract.test.ts` | 95 | `2dc02a0ed82a` | 6 | full-line-index | composer attachment admission review contract; keeps a ready vision item planned until frozen native dispatch evidence exists; block... |
| 60 | `features/workspace/composer-attachment-admission-review.test.tsx` | 81 | `2da12f8194de` | 4 | full-line-index | ComposerAttachmentAdmissionReview; shows gate detail and a clear preview boundary; switches the selected record and changes report f... |
| 61 | `features/workspace/composer-attachment-boundary.test.tsx` | 204 | `8e5544f475ec` | 5 | full-line-index | composer attachment dispatch boundary; fails closed instead of silently sending a text-only provider request; hydrates native picker... |
| 62 | `features/workspace/composer-attachment-compatibility.test.ts` | 111 | `2032aadff975` | 6 | full-line-index | composer attachment compatibility contract; maps MIME and preview hints to the right modality; shows a catalog-compatible image whil... |
| 63 | `features/workspace/composer-attachment-compatibility.test.tsx` | 86 | `b6be5e0a9e77` | 4 | full-line-index | composer attachment compatibility preview; shows selected route and catalog-compatible image signals; keeps browser previews visibly... |
| 64 | `features/workspace/composer-attachments.test.tsx` | 175 | `92fca0822e46` | 8 | full-line-index | composer attachment presentation; maps durable attachment extraction evidence into honest composer states; blocks submission wheneve... |
| 65 | `features/workspace/composer-block-insert-studio.test.tsx` | 60 | `260a72166f88` | 4 | full-line-index | ComposerBlockInsertStudio; offers a broad block catalog with honest renderer-only boundary; filters categories, previews a template,... |
| 66 | `features/workspace/composer-context-preflight.component.test.tsx` | 243 | `4477524c292c` | 9 | full-line-index | ChatComposer context preflight entry; surfaces selected native attachments as a planned, renderer-only context source; keeps a stand... |
| 67 | `features/workspace/composer-draft-studio.test.tsx` | 168 | `0d9575c08a05` | 8 | full-line-index | Composer Draft Studio renderer preview; supports undo and redo for explicit draft changes; saves, restores, and removes named snapsh... |
| 68 | `features/workspace/composer-draft-versions.test.ts` | 31 | `130880c4c038` | 4 | full-line-index | composer draft version comparison; aligns inserted lines and reports a bounded renderer-local diff; bounds preview output and avoids... |
| 69 | `features/workspace/composer-editor.component.test.tsx` | 446 | `81ac89100244` | 23 | full-line-index | ChatComposer smart Markdown editor; uses real model and reasoning selectors without reopening a Chat inspector; keeps the default co... |
| 70 | `features/workspace/composer-editor.test.ts` | 208 | `4aaace711412` | 21 | full-line-index | composer smart editor; continues unordered lists; increments ordered lists and preserves the delimiter |
| 71 | `features/workspace/composer-input-policy.test.ts` | 91 | `fe78a2f86a6e` | 9 | full-line-index | composer input measurements; measures UTF-8 bytes and Unicode characters without confusing surrogate pairs; counts CRLF as one line ... |
| 72 | `features/workspace/composer-media-preview.test.tsx` | 63 | `bc08ddf036c3` | 5 | full-line-index | composer media preview; exposes image, video, and audio affordances without pretending to ingest files; shows removable queued chips... |
| 73 | `features/workspace/composer-mode-controls-preview.test.tsx` | 63 | `8e4ba4e89f08` | 5 | full-line-index | ComposerModeControlsPreview; renders Ask controls with a renderer-only boundary; keeps independent values for each mode and resets t... |
| 74 | `features/workspace/composer-mode-selector.test.tsx` | 116 | `fb057457f5f0` | 7 | full-line-index | composer mode selector; exposes Ask, Create, Research, and Discuss as explicit mode options; keeps Discuss preview-only and exposes ... |
| 75 | `features/workspace/composer-paste.component.test.tsx` | 131 | `543f2af097c7` | 5 | full-line-index | ChatComposer paste handling; prevents browser interpretation and restores the cursor after selection replacement; keeps a large past... |
| 76 | `features/workspace/composer-paste.test.ts` | 82 | `1b00b970e40f` | 7 | full-line-index | composer paste assessment; keeps a small plain-text paste inline without a conversion notice; reports every crossed threshold and pr... |
| 77 | `features/workspace/composer-rich-preview.test.tsx` | 165 | `b3506337dc37` | 13 | full-line-index | ComposerRichPreview; summarizes Markdown structure without treating fenced code as an equation; keeps raw LaTeX visible while provid... |
| 78 | `features/workspace/composer-slash-command-registry.test.ts` | 69 | `30543d30b4f3` | 4 | full-line-index | composer slash command registry; exposes searchable metadata for built-in commands; builds an honest renderer-session registry snapshot |
| 79 | `features/workspace/composer-slash-commands.test.ts` | 36 | `87ead1150767` | 5 | full-line-index | composer slash commands; opens only for a slash token at the current line start; filters commands by command, label, description, an... |
| 80 | `features/workspace/context-answer-receipt.test.tsx` | 66 | `7f35513e849e` | 4 | full-line-index | ContextAnswerReceipt; scopes rows to the current answer and run; downgrades invalid verified evidence and keeps the boundary explicit |
| 81 | `features/workspace/context-compiler-preview.test.tsx` | 143 | `4ee1e29b9036` | 9 | full-line-index | ContextCompilerPreview; builds a deterministic reference decision ledger with a final current request; withholds aggregate compiler ... |
| 82 | `features/workspace/context-estimate.test.ts` | 44 | `cbc145c56935` | 5 | full-line-index | context estimate evidence contract; labels numeric renderer calculations as heuristic; withholds the aggregate estimate when access ... |
| 83 | `features/workspace/context-harness.test.ts` | 465 | `3457abce49c9` | 16 | full-line-index | context token estimation; is deterministic and charges for multilingual/code-like content; retrieval frontier |
| 84 | `features/workspace/context-manifest-preview.test.tsx` | 30 | `fc11e4a7b4b7` | 4 | full-line-index | ContextManifestPreview; updates the estimate when source toggles change; renders a truthful export contract |
| 85 | `features/workspace/context-memory-skill-receipt.test.tsx` | 210 | `c98def6ebfca` | 6 | full-line-index | ContextMemorySkillReceipt; projects active scoped memories and enabled non-manual skills; keeps standalone scope from claiming proje... |
| 86 | `features/workspace/context-preflight-preview.test.tsx` | 192 | `4194cd528f3a` | 10 | full-line-index | ContextPreflightPreview; surfaces source, budget, and native-freeze gates; evaluates a blocked budget and exposes a renderer-local d... |
| 87 | `features/workspace/context-run-evidence.test.tsx` | 174 | `0436435a9942` | 5 | full-line-index | ContextRunEvidenceCard; builds an honest run-linked evidence model without inventing a context revision; renders blocked access and ... |
| 88 | `features/workspace/conversation-actions-dialog.test.tsx` | 171 | `f84348b08538` | 5 | full-line-index | conversation action surface; renames, pins, and resets the active Chat draft from the manage view; opens a truthful renderer-local t... |
| 89 | `features/workspace/conversation-branch-activation.test.ts` | 92 | `756fa8f2e404` | 3 | full-line-index | native Chat branch selection; sends expected active branch to native and hydrates only its returned snapshot; rejects a branch switc... |
| 90 | `features/workspace/conversation-catalog.test.ts` | 197 | `1be9f426e96b` | 4 | full-line-index | native conversation catalog; hydrates stable message and run provenance; resolves an inherited branch prefix without flattening sibl... |
| 91 | `features/workspace/conversation-message-actions-preview.test.tsx` | 110 | `a83f212f3e7c` | 5 | full-line-index | conversation message action preview; rehearses editing without mutating the transcript and can load the draft; shows branch and retr... |
| 92 | `features/workspace/conversation-navigation.test.tsx` | 407 | `2e3d42c65296` | 22 | full-line-index | conversation navigation projection; preserves message order and classifies prompts, outputs and issues; retains branch metadata and ... |
| 93 | `features/workspace/conversation-project-bridge.test.tsx` | 90 | `b55ec8fa72bd` | 3 | full-line-index | ConversationProjectBridge; makes a Project-scoped Chat continuity and its renderer-only actions inspectable; gives a standalone Chat... |
| 94 | `features/workspace/conversation-scope-header.test.tsx` | 128 | `fb2b544d12f9` | 6 | full-line-index | ConversationScopeHeader; shows one Folder / chat-title breadcrumb without URI, counters, or diagnostic metadata; switches visible Ch... |
| 95 | `features/workspace/conversation-start-dialog.test.tsx` | 206 | `ac954be12e7e` | 10 | full-line-index | ConversationStartDialog; opens a configured renderer conversation with title, mode, and starter draft; keeps a selected temporary re... |
| 96 | `features/workspace/conversation-view.integration.test.tsx` | 504 | `59e9a30f7569` | 18 | full-line-index | ConversationView integration wiring; renders the populated conversation shell with its transcript and composer but no inspector or d... |
| 97 | `features/workspace/data-intake-learning-review.test.tsx` | 71 | `f25fb12ce5ee` | 7 | full-line-index | DataIntakeLearningReview; renders provenance, policy metrics, and truthful renderer boundary; updates policy and record review actio... |
| 98 | `features/workspace/data-lineage-studio.test.tsx` | 165 | `7d1517c45da4` | 13 | full-line-index | DataLineageStudio; renders a truthful source-to-evaluation lineage surface; filters nodes and exposes selected-record edge details |
| 99 | `features/workspace/delivery-evidence-status-preview.test.tsx` | 64 | `5d93bfbf9fd8` | 5 | full-line-index | DeliveryEvidenceStatusPreview; shows honest status counts and a selected evidence detail; filters to attention checks and updates th... |
| 100 | `features/workspace/diagnostics-session-contract.test.ts` | 143 | `e65390420358` | 5 | full-line-index | diagnostics session preview redaction; removes sensitive credentials, signed URL fields, identities, paths, and unsafe controls; use... |
| 101 | `features/workspace/diagnostics-session-workbench.test.tsx` | 191 | `99ebf4248f64` | 8 | full-line-index | Diagnostics Session Log Workbench; filters the renderer-only event timeline without claiming native evidence; supports renderer chec... |
| 102 | `features/workspace/dialogs.test.tsx` | 83 | `10c73376b7b2` | 6 | full-line-index | provider dialog truthfulness; describes the OpenAI adapter that is actually wired; offers DeepSeek as a fixed OpenAI-compatible conn... |
| 103 | `features/workspace/embedded-vscode-stage.test.tsx` | 245 | `8008cf2a8be5` | 11 | full-line-index | EmbeddedVscodeStage; checks real server status before mounting the editor; reports an unavailable runtime without showing a broken f... |
| 104 | `features/workspace/evaluation-rubric-workbench.test.tsx` | 78 | `a797672ab333` | 5 | full-line-index | Evaluation Rubric Workbench preview; normalizes weighted criteria deterministically; switches presets and exposes editable score pol... |
| 105 | `features/workspace/extensions-mcp-hub.test.tsx` | 187 | `987086516607` | 10 | full-line-index | Extensions & MCP Hub preview; renders catalog, filters integrations, and keeps lifecycle changes renderer-local; exposes grants, lif... |
| 106 | `features/workspace/finance-workspace-preview.test.tsx` | 49 | `27da944a2245` | 5 | full-line-index | FinanceWorkspacePreview; renders a bounded budget posture and local-only boundary; updates the ledger and posture when a local actua... |
| 107 | `features/workspace/git-ci-workbench-preview.test.tsx` | 95 | `6288345440a2` | 5 | full-line-index | Git and CI/CD workbench preview; shows delivery tabs and keeps Git/CI actions preview-only; supports staging, branch, pipeline, rele... |
| 108 | `features/workspace/global-object-search-preview.test.tsx` | 418 | `c2ed6afa05e4` | 13 | full-line-index | GlobalObjectSearchPreview; builds searchable results across all visible object families; exposes command-center commands and power-u... |
| 109 | `features/workspace/goal-orchestration-rail.test.tsx` | 66 | `405d83ee511d` | 5 | full-line-index | GoalOrchestrationRail; moves a selected queue item to a distinct active preview slot and can return it; keeps prior active work at t... |
| 110 | `features/workspace/goal-task-studio.test.tsx` | 221 | `a29ea866b8cf` | 17 | full-line-index | GoalTaskStudio; advances a visible task through the preview lifecycle; adds a task and filters the projection |
| 111 | `features/workspace/harness-capability-synthesis.test.tsx` | 73 | `3207a88156f3` | 6 | full-line-index | harness capability synthesis; keeps the cross-harness source signals explicit and bounded; filters decisions and renders source evid... |
| 112 | `features/workspace/harness-contract-panel.test.tsx` | 46 | `6e1373e10472` | 4 | full-line-index | HarnessContractPanel; renders contract slices with explicit preview boundaries; filters the catalog and exposes a selected contract |
| 113 | `features/workspace/home-import-preview.test.tsx` | 54 | `a981016ca91a` | 5 | full-line-index | home import preview; summarizes a conversation JSON bundle without mutating workspace state; supports Markdown preview and resets th... |
| 114 | `features/workspace/home-lazy-surface.test.tsx` | 67 | `9c2bb93b3cb2` | 4 | full-line-index | HomeLazySurface; keeps optional Home workbenches renderer-local while loading; retries a failed optional Home chunk without losing t... |
| 115 | `features/workspace/home-operations-deck.test.tsx` | 100 | `eaa88f1b481b` | 5 | full-line-index | HomeOperationsDeck; renders the core operations and keeps renderer boundaries visible; routes each operation to its renderer-local a... |
| 116 | `features/workspace/home-quick-access-contract.test.ts` | 28 | `65b432a70694` | 4 | full-line-index | home quick access contract; round-trips the complete renderer-local layout; fails closed for missing, duplicate, and unknown actions |
| 117 | `features/workspace/home-quick-access.test.tsx` | 46 | `6f9cd9c21abc` | 4 | full-line-index | home quick access; activates shortcuts and filters visible actions; supports session-only customization, reorder, and undo |
| 118 | `features/workspace/ide-agent-sidebar.test.tsx` | 161 | `e768e2f91646` | 12 | full-line-index | IDE review Image 23; shows one compact header, no metadata or debug tabs, and code-block-only apply/copy actions; shows real run ste... |
| 119 | `features/workspace/ide-code-navigation.test.tsx` | 52 | `c7722a998d56` | 4 | full-line-index | Image 19 Open in IDE integration; navigates to an existing file without applying the suggested code; survives lazy mounting and show... |
| 120 | `features/workspace/ide-editor-transport.test.ts` | 86 | `631f61312b9a` | 7 | full-line-index | editor transport; uses the protected preview route for the browser and the local fast desktop preview; uses session-guarded native c... |
| 121 | `features/workspace/inspector-preview.accessibility.test.tsx` | 99 | `fdf31014c58a` | 3 | full-line-index | Inspector Preview accessibility; keeps nested evidence tabs roving and labels the active panel; labels browser runs as renderer prev... |
| 122 | `features/workspace/inspector.provider-lineage.test.tsx` | 102 | `f7e1ba35da2f` | 3 | full-line-index | Run inspector provider-attempt lineage; reads the exact native attempt and shows only redacted historical provenance; keeps unavaila... |
| 123 | `features/workspace/inspector.telemetry.test.tsx` | 253 | `bdd68095003c` | 4 | full-line-index | Run inspector native telemetry projection; shows real partial provider usage while keeping missing timing and cost explicit; keeps a... |
| 124 | `features/workspace/keyboard-shortcut-session.test.ts` | 38 | `6f116546ffcd` | 4 | full-line-index | renderer-session shortcut resolution; uses defaults, then rebinds one action without leaving its previous chord active; fails closed... |
| 125 | `features/workspace/keyboard-shortcuts-dialog.test.tsx` | 143 | `9ee8e2e72122` | 10 | full-line-index | keyboard shortcuts dialog; shows the current renderer shortcuts and closes from the footer; supports renderer-local shortcut customi... |
| 126 | `features/workspace/knowledge-tree-explorer.test.tsx` | 290 | `367fb01b9601` | 8 | full-line-index | KnowledgeTreeExplorer; exports both named KnowledgeTreeExplorer and default export; renders the 5 canonical LTST folders (/architect... |
| 127 | `features/workspace/lazy-overlay-hosts.test.tsx` | 52 | `8633207f1a35` | 3 | full-line-index | lazy overlay hosts; loads the command palette into exactly one modal scrim; loads a global dialog into exactly one modal scrim |
| 128 | `features/workspace/learning-loop-lab.test.tsx` | 158 | `e0464d36e2eb` | 12 | full-line-index | Learning Loop Lab preview; calculates the next review occurrence without creating a scheduler; renders an editable review cadence re... |
| 129 | `features/workspace/library-conversation-crud-preview.test.tsx` | 275 | `6d67b81c4b06` | 9 | full-line-index | conversation library CRUD preview; renames, pins, archives, moves, and restores a renderer-local conversation; supports delete-previ... |
| 130 | `features/workspace/library-screen.phase3.test.tsx` | 297 | `c6a35d094240` | 6 | full-line-index | artifact workbench preview; opens a versioned artifact into preview, diff, and metadata tabs; filters provenance, sorts visible reco... |
| 131 | `features/workspace/local-model-catalog-preview.test.tsx` | 50 | `fde336eb2d40` | 5 | full-line-index | LocalModelCatalogPreview; shows a hardware-aware seeded catalog with an explicit renderer boundary; filters by task and source, then... |
| 132 | `features/workspace/local-model-readiness-preview.test.tsx` | 46 | `d4fa2e973d37` | 4 | full-line-index | LocalModelReadinessPreview; shows the audited host posture without claiming a native probe; keeps planning controls local and update... |

### Part C — Stylesheets (`src/styles/**`, `138` files, `54,677` lines)

| # | Relative Path (`src/...`) | Lines | SHA-256 (12) | Read Mode | Tokens / Flags / Media & Hygiene Notes |
|---:|---|---:|---|---|---|
| 1 | `styles/academic-citation-ledger.css` | 567 | `774e200248c8` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 2 | `styles/academic-studio.css` | 79 | `c132df0d48cb` | full-line-index | forced-colors, color-mix; 2 @media |
| 3 | `styles/accessibility-command-surface-preview.css` | 81 | `163c78e802d3` | full-line-index | focus-visible, color-mix, reduced-motion, vars:2; 3 @media |
| 4 | `styles/adaptive-auto-routing-learning-preview.css` | 72 | `71790ba882ff` | full-line-index | forced-colors, color-mix; 3 @media |
| 5 | `styles/agent-dag-orchestration.css` | 68 | `a9fa13b344c4` | full-line-index | focus-visible, color-mix; 2 @media |
| 6 | `styles/agent-orchestration-prompt.css` | 46 | `f84372f461d5` | full-line-index | color-mix; 2 @media |
| 7 | `styles/algorithm-lab.css` | 80 | `ac327bcc3285` | full-line-index | forced-colors, color-mix, clamp; 4 @media |
| 8 | `styles/approval-request-preview.css` | 87 | `9b58fb91eb1e` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 9 | `styles/artifact-document-studio.css` | 960 | `efdffacf6621` | full-line-index | focus-visible, color-mix; 3 @media |
| 10 | `styles/automation-studio.css` | 233 | `312c68fa0722` | full-line-index | forced-colors, focus-visible, color-mix; 7 @media |
| 11 | `styles/background-task-inspector-preview.css` | 120 | `788d5e2f4f10` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 12 | `styles/background-work.css` | 2651 | `9752721bca40` | full-line-index | forced-colors, focus-visible, color-mix; 5 @media |
| 13 | `styles/base.css` | 336 | `394978dc83d3` | direct-read (full) | focus-visible, color-mix, vars:3 |
| 14 | `styles/boot.css` | 213 | `8909b39465d7` | direct-read (full) | forced-colors, color-mix, reduced-motion, kf:boot-progress; 3 @media |
| 15 | `styles/cache-context-routing-preview.css` | 106 | `93d4544b42bd` | full-line-index | forced-colors, color-mix; 3 @media |
| 16 | `styles/chat-first-canvas.css` | 396 | `7404617a523c` | direct-read (full) | focus-visible, color-mix; 3 @media |
| 17 | `styles/chat-header-actions-polish.css` | 104 | `3e8f539d60cd` | full-line-index | focus-visible, color-mix, reduced-motion, vars:1; 3 @media |
| 18 | `styles/chat-header-responsive.css` | 381 | `3ae4ad1f0499` | full-line-index | focus-visible, color-mix, reduced-motion, clamp, vars:2; 5 @media |
| 19 | `styles/chat-layout-polish.css` | 715 | `72af3bb04ea9` | full-line-index | clamp, vars:1; 8 @media |
| 20 | `styles/chat-message-actions.css` | 808 | `461b24f7517e` | direct-read (L1-800/808) + full-line-index | forced-colors, focus-visible, color-mix, reduced-motion, kf:message-thinking-pulse; 4 @media |
| 21 | `styles/chat-modern-surface.css` | 235 | `8b89cf3af735` | direct-read (full) | focus-visible, color-mix, reduced-motion; 3 @media |
| 22 | `styles/chat.css` | 2532 | `a7cee3471494` | direct-read (L1-800/2532) + full-line-index | focus-visible, color-mix; 5 @media |
| 23 | `styles/citation-graph-preview.css` | 786 | `d9f09f516a4a` | full-line-index | focus-visible, color-mix; 3 @media |
| 24 | `styles/command-palette.css` | 525 | `2c3b1a26613a` | direct-read (full) | focus-visible, color-mix; 1 @media |
| 25 | `styles/context-answer-receipt.css` | 182 | `65a352630792` | full-line-index | color-mix; 1 @media |
| 26 | `styles/context-compiler-preview.css` | 87 | `734f68c9eab5` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 27 | `styles/context-manifest-preview.css` | 1 | `29b7155d0bfa` | full-line-index | color-mix |
| 28 | `styles/context-memory-skill-receipt.css` | 289 | `7822eec06b11` | full-line-index | color-mix; 1 @media |
| 29 | `styles/context-preflight-preview.css` | 85 | `1000855d9997` | full-line-index | forced-colors, color-mix, container-query; 3 @media |
| 30 | `styles/conversation-start-dialog.css` | 659 | `4f008ffa186e` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 31 | `styles/data-intake-learning-review.css` | 103 | `309e7b930b71` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 32 | `styles/data-lineage-studio.css` | 190 | `8a6535648afa` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 33 | `styles/delivery-evidence-status.css` | 48 | `950a39a0e1c8` | full-line-index | focus-visible, color-mix; 2 @media |
| 34 | `styles/delivery-polish.css` | 295 | `b717abd2c8f2` | direct-read (full) | focus-visible; 2 @media |
| 35 | `styles/extensions-mcp-hub.css` | 295 | `8b9c2e7b1823` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 36 | `styles/finance-workspace.css` | 53 | `c8ce8a5f3785` | full-line-index | forced-colors, color-mix, clamp; 3 @media |
| 37 | `styles/git-ci-workbench-preview.css` | 188 | `2dd3768ec750` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 38 | `styles/global-object-search.css` | 128 | `a18f8c1d077a` | full-line-index | focus-visible, color-mix; 1 @media |
| 39 | `styles/goal-orchestration-rail.css` | 10 | `1b95bb62ffa2` | full-line-index | focus-visible, color-mix; 1 @media |
| 40 | `styles/goal-task-studio.css` | 152 | `b68f011a913c` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 41 | `styles/home-quick-access.css` | 380 | `0cfd13352d79` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 42 | `styles/index.css` | 133 | `3c7fa7cfd939` | direct-read (full) | standard rules |
| 43 | `styles/inspector-layout-fix.css` | 86 | `406e1d8c2194` | full-line-index | standard rules; 4 @media |
| 44 | `styles/keyboard-shortcuts.css` | 384 | `9c737712cb16` | direct-read (full) | color-mix; 1 @media |
| 45 | `styles/local-model-catalog-preview.css` | 90 | `9524bec8967f` | full-line-index | forced-colors, color-mix; 3 @media |
| 46 | `styles/local-model-readiness-preview.css` | 122 | `57186c8b1b70` | full-line-index | forced-colors, color-mix; DUP-IMPORT in index.css(L75,L79); 3 @media |
| 47 | `styles/media-endpoint-console-preview.css` | 111 | `2853692b13ba` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 48 | `styles/media-generation.css` | 2912 | `7bac4cc5ac3a` | full-line-index | forced-colors, focus-visible, color-mix, vars:4; 7 @media |
| 49 | `styles/memory-draft-studio.css` | 75 | `457fbbe0f753` | full-line-index | focus-visible, color-mix; 2 @media |
| 50 | `styles/memory-lifecycle-studio.css` | 30 | `e8260b334c1c` | full-line-index | color-mix; 1 @media |
| 51 | `styles/memory-proposal-inbox.css` | 95 | `f6795a2263bb` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 52 | `styles/memory-provenance-revision-inspector.css` | 91 | `a71c9dcd49ff` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 53 | `styles/memory-review-workbench.css` | 103 | `ff9749ada0a4` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 54 | `styles/memory-scope-mode-preview.css` | 95 | `4d30c39ff985` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 55 | `styles/mission-control-signal-center.css` | 377 | `35fda02ffb5c` | full-line-index | focus-visible, color-mix; 2 @media |
| 56 | `styles/model-endpoint-workbench.css` | 811 | `5426dc468f1d` | full-line-index | forced-colors, color-mix; 4 @media |
| 57 | `styles/model-evaluation-studio.css` | 349 | `abd0667b9591` | full-line-index | forced-colors, color-mix; 3 @media |
| 58 | `styles/model-route-fit-lab.css` | 75 | `a68d60501d24` | full-line-index | forced-colors, color-mix; 3 @media |
| 59 | `styles/model-route-presets-preview.css` | 87 | `608eee5a0a0d` | full-line-index | forced-colors, color-mix; 3 @media |
| 60 | `styles/native-project-goals.css` | 57 | `d102e78faa2e` | full-line-index | focus-visible, color-mix, reduced-motion, kf:native-project-goals-spin; 3 @media |
| 61 | `styles/notification-center-preview.css` | 191 | `5ba153bad669` | full-line-index | focus-visible, color-mix; 2 @media |
| 62 | `styles/observability-evidence-dashboard.css` | 76 | `6610466bae31` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 63 | `styles/observability-preview.css` | 77 | `0297c28f700a` | full-line-index | color-mix; 2 @media |
| 64 | `styles/omnia-labs-showcase.css` | 23 | `f58b8f1197bc` | full-line-index | focus-visible, color-mix; 2 @media |
| 65 | `styles/overlays.css` | 1425 | `f5d8262c06d5` | direct-read (L1-800/1425) + full-line-index | forced-colors, focus-visible, color-mix, BACKDROP-FILTER!, kf:omnia-spin,scrim-in,dialog-in, vars:1; 1 @media |
| 66 | `styles/performance-signal-strip.css` | 287 | `400213b77030` | full-line-index | focus-visible, color-mix; 1 @media |
| 67 | `styles/permission-control-center.css` | 211 | `4db6282d2cc2` | full-line-index | focus-visible, color-mix, vars:1; 3 @media |
| 68 | `styles/permission-matrix-studio.css` | 78 | `f061f5a71806` | full-line-index | focus-visible, color-mix; 2 @media |
| 69 | `styles/permission-preset-lab.css` | 113 | `70649059ec3a` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 70 | `styles/phase-cockpit-preview.css` | 65 | `3f103cd5fee8` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 71 | `styles/plugin-catalog-preview.css` | 80 | `e3dcd9b9ac56` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 72 | `styles/project-activity-timeline.css` | 149 | `544539740687` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 73 | `styles/project-advanced-settings.css` | 116 | `96c5a5afa1d5` | full-line-index | forced-colors, color-mix; 3 @media |
| 74 | `styles/project-control-deck.css` | 1060 | `a481de6c678b` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 75 | `styles/project-handoff-workbench.css` | 239 | `28a018138f62` | full-line-index | color-mix; 2 @media |
| 76 | `styles/project-ide-preview.css` | 162 | `237a39a347b1` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 77 | `styles/project-metadata-provenance-preview.css` | 221 | `f3e10d79272b` | full-line-index | forced-colors, color-mix; 4 @media |
| 78 | `styles/project-metadata-receipt-preview.css` | 315 | `1f19d32db1d9` | full-line-index | forced-colors, color-mix; 3 @media |
| 79 | `styles/project-mission-overview.css` | 266 | `bf0ec57c54c2` | full-line-index | forced-colors, color-mix; 3 @media |
| 80 | `styles/project-next-actions-preview.css` | 57 | `4cadbe8a297e` | full-line-index | color-mix; 1 @media |
| 81 | `styles/project-overview-action-center.css` | 50 | `2f3f7f949f4e` | full-line-index | focus-visible, color-mix; 1 @media |
| 82 | `styles/project-overview-refresh.css` | 171 | `14c6e93753da` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 83 | `styles/project-planning-preview.css` | 235 | `e83d21e1f07b` | full-line-index | focus-visible, color-mix; 2 @media |
| 84 | `styles/project-runtime-posture.css` | 178 | `842818977e32` | full-line-index | focus-visible, color-mix; 2 @media |
| 85 | `styles/project-scope-inheritance.css` | 197 | `292c4365295c` | full-line-index | forced-colors, color-mix; 3 @media |
| 86 | `styles/project-twin-edge-preview.css` | 27 | `225f494d0b16` | full-line-index | focus-visible, color-mix; 2 @media |
| 87 | `styles/prompt-experiment-studio.css` | 169 | `c51b16fe0b56` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 88 | `styles/prompt-library-preview.css` | 830 | `84e9ca096b20` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 89 | `styles/prompt-template-lab-preview.css` | 92 | `2d35963eb605` | full-line-index | focus-visible, color-mix; 1 @media |
| 90 | `styles/provider-connection-profile-preview.css` | 597 | `4ed6c05dae83` | full-line-index | forced-colors, color-mix; 3 @media |
| 91 | `styles/provider-endpoint-health-preview.css` | 130 | `b520e61e055e` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 92 | `styles/provider-model-compatibility.css` | 59 | `4ad091b433e7` | full-line-index | forced-colors, color-mix; 2 @media |
| 93 | `styles/provider-model-lab-preview.css` | 60 | `c40a1faa974a` | full-line-index | forced-colors, color-mix; 2 @media |
| 94 | `styles/provider-route-compare-preview.css` | 620 | `e191520496ca` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 95 | `styles/provider-settings-disclosure.css` | 123 | `550a783c9649` | full-line-index | forced-colors, focus-visible, color-mix, reduced-motion; 3 @media |
| 96 | `styles/release-evidence-dashboard.css` | 84 | `4d5a6848f77a` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 97 | `styles/research-notebook.css` | 563 | `78676147d11e` | full-line-index | focus-visible, color-mix, clamp; 2 @media |
| 98 | `styles/responsive.css` | 1246 | `05c48ecf1098` | direct-read (full) | forced-colors, color-mix, reduced-motion, BACKDROP-FILTER!, kf:sidebar-slide-in,inspector-slide-in, vars:8; 11 @media |
| 99 | `styles/review-chat-shell.css` | 420 | `4ce4f05f3589` | direct-read (full) | focus-visible, vars:7; direct-import(not in index.css); 2 @media |
| 100 | `styles/review-composer.css` | 240 | `c96be4aeff2b` | direct-read (full) | focus-visible, vars:1; direct-import(not in index.css); 1 @media |
| 101 | `styles/review-message-content.css` | 427 | `418dc97997e8` | direct-read (full) | focus-visible, reduced-motion; direct-import(not in index.css); 1 @media |
| 102 | `styles/role-routing-preview.css` | 66 | `820afaa380f8` | full-line-index | color-mix; 2 @media |
| 103 | `styles/run-action-preview.css` | 108 | `7357ea982251` | full-line-index | focus-visible, color-mix; 1 @media |
| 104 | `styles/science-notebook-lab.css` | 139 | `4ed46b6de425` | full-line-index | focus-visible, color-mix; 3 @media |
| 105 | `styles/screens.css` | 8495 | `2cdce07171ea` | full-line-index | forced-colors, focus-visible, color-mix, reduced-motion, clamp, kf:activity-load-progress,settings-surface-loading-pulse, vars:2; 13 @media |
| 106 | `styles/security-policy-preview.css` | 107 | `e495c1e6025a` | full-line-index | forced-colors, focus-visible, color-mix; 4 @media |
| 107 | `styles/settings-control-center.css` | 484 | `9281a53a9a24` | full-line-index | forced-colors, focus-visible, color-mix, vars:27; 4 @media |
| 108 | `styles/settings-layout-polish.css` | 577 | `372f881f695e` | full-line-index | focus-visible, color-mix; 3 @media |
| 109 | `styles/shell.css` | 2041 | `5301a409d895` | direct-read (L1-800/2041) + full-line-index | focus-visible, color-mix, BACKDROP-FILTER!, vars:23; 3 @media |
| 110 | `styles/signal-preferences-preview.css` | 112 | `f67f7f0f80ea` | full-line-index | focus-visible, color-mix; 2 @media |
| 111 | `styles/skill-activation-matrix.css` | 125 | `c2bfce6d7435` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 112 | `styles/skill-authoring-preview.css` | 514 | `936f82980cca` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 113 | `styles/skill-domain-catalog.css` | 222 | `e375faa92f45` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 114 | `styles/skill-package-review-preview.css` | 181 | `daefdc3b7d16` | full-line-index | forced-colors, color-mix; 3 @media |
| 115 | `styles/skill-registry-preview.css` | 188 | `054cb9292951` | full-line-index | forced-colors, color-mix; 3 @media |
| 116 | `styles/sovereign-ide-workbench.css` | 284 | `aa57f15cfbdc` | full-line-index | focus-visible, reduced-motion, clamp, container-query, vars:11; direct-import(not in index.css); 2 @media |
| 117 | `styles/sovereign-super-suite.css` | 1862 | `8e432c20ddbd` | direct-read (L1-1600/1862) + full-line-index | focus-visible, color-mix, vars:128; 2 @media |
| 118 | `styles/state-base-cursor.css` | 218 | `87015c731461` | full-line-index | focus-visible, color-mix; 2 @media |
| 119 | `styles/storage-health-preview.css` | 108 | `8dc2d2d508a1` | full-line-index | forced-colors, focus-visible, color-mix, vars:1; 3 @media |
| 120 | `styles/structured-io-workbench.css` | 153 | `c5cf9cd5e88f` | full-line-index | focus-visible, color-mix; 1 @media |
| 121 | `styles/technical-lab.css` | 63 | `b764e9d5cbae` | full-line-index | color-mix, clamp; 1 @media |
| 122 | `styles/telemetry-inspector-preview.css` | 65 | `61107e024838` | full-line-index | focus-visible, color-mix; 2 @media |
| 123 | `styles/terminal-compiler-preview.css` | 150 | `d6da988dd409` | full-line-index | forced-colors, focus-visible, color-mix; 2 @media |
| 124 | `styles/theme-preset-studio.css` | 69 | `2f43b02e1c07` | full-line-index | focus-visible, color-mix; direct-import(not in index.css); 3 @media |
| 125 | `styles/tokens.css` | 93 | `a96b806c686e` | direct-read (full) | vars:43 |
| 126 | `styles/tokens.generated.css` | 152 | `d265e4150928` | direct-read (full) | vars:131 |
| 127 | `styles/toolchain-environment-planner.css` | 94 | `78706b69f865` | full-line-index | forced-colors, color-mix; 4 @media |
| 128 | `styles/training-control-center.css` | 254 | `6acf0aca9abb` | full-line-index | color-mix; 3 @media |
| 129 | `styles/training-dataset-pipeline.css` | 113 | `e391d333b854` | full-line-index | forced-colors, color-mix; 3 @media |
| 130 | `styles/workflow-dry-run-history.css` | 401 | `8515dc7f1d0b` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 131 | `styles/workflow-run-diff-preview.css` | 287 | `38a4f28338f6` | full-line-index | forced-colors, color-mix; 3 @media |
| 132 | `styles/workspace-export-center.css` | 742 | `5062068007ab` | full-line-index | forced-colors, color-mix; 3 @media |
| 133 | `styles/workspace-export-schedule-preview.css` | 214 | `8cc9bee06a02` | full-line-index | color-mix; 2 @media |
| 134 | `styles/workspace-file-browser.css` | 652 | `b68b9925ac7c` | full-line-index | color-mix, clamp; 1 @media |
| 135 | `styles/workspace-file-roots-preview.css` | 713 | `701a1a460769` | full-line-index | color-mix; 2 @media |
| 136 | `styles/workspace-preset-lab.css` | 718 | `e07602cd0b87` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
| 137 | `styles/workspace-snapshot-preview.css` | 393 | `bf434f5ddf69` | full-line-index | focus-visible, color-mix; 2 @media |
| 138 | `styles/workspace-transfer-hub.css` | 382 | `d9311d9de265` | full-line-index | forced-colors, focus-visible, color-mix; 3 @media |
