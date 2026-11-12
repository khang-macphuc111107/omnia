# UI Direction Decision & Preview Contract

- **Document ID:** `OMNIA-UI-DIRECTION-20261112`
- **Task / DoD Bindings:** `PRODUCT-WORKSPACE`, `PRODUCT-COMPOSER`, `PRODUCT-ATTACHMENTS`, `PRODUCT-CHAT`, `DOD-12`, `DOD-14`
- **Related Specifications:** [GOAL.md](../workspace/GOAL.md) · [DOD.md](../workspace/DOD.md) · [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md) · [DYNAMIC_ROUTING_REQUIREMENTS.md](../workspace/DYNAMIC_ROUTING_REQUIREMENTS.md)
- **External Preview Root:** `D:\OmniaData\qa\ui-direction-20261112\`
- **Decision State:** `PROVISIONAL_RECOMMENDATION` (`Candidate A: Precision Studio` with `Candidate C` Win32 resource/UIA invariants; `Candidate B` retained as opt-in Study/Knowledge mode)
- **User Review Gate:** `PENDING_USER_REVIEW` *(Internal critique is recorded below; internal agent review is NOT user approval.)*
- **Runtime / QA Gate:** `SEPARATE_OPEN_GATE` *(HTML/CSS/JS slices are interactive design-direction specifications, not proof of native Win32 parity, provider delivery, or packaged runtime performance.)*

---

## 1. Problem Framing

- **Surface / platform / snapshot:** Omnia unified desktop workspace (`Chat`, `IDE`, `Browser`, `Session & Subagent Explorer`, `Word-Grade Rich Composer`, `Attachment Tray & Provenance Inspector`, and `Dynamic Provider/Quota Router Telemetry`) targeting Windows 11 native Rust (`native/` Win32 shell + shared `src-tauri/crates/` services) on repository baseline `D:\Omnia` (`2026-11-12`).
- **User and primary task:** Technical builders, researchers, and bilingual Vietnamese/English students who compose structured prompts (rich headings, indentation, tables, checklists, live rendered LaTeX math/physics/chemistry equations, and mixed inline-at-caret + tray attachments), supervise multi-agent runs, and audit deterministic provider/model routing without losing context or burning duplicate quota reservations.
- **Constraints and budgets:**
  - **Native-first execution:** Pure-Rust Win32 (`native/`) remains the primary desktop shell target ([GOAL.md](../workspace/GOAL.md)); zero ornamental GPU blur layers or continuous animations that inflate idle CPU/GPU/RAM.
  - **Known `QUALITY-01` defects to eliminate by design:** (1) zero bottom status-panel text clipping at the `1220 × 820` baseline and across `1024px–2560px` resizes; (2) explicit Windows UI Automation `ControlType.Edit` (`role="textbox"` in HTML slice) composer discovery.
  - **Accessibility floor:** WCAG 2.2 AA minimum (`>= 4.5:1` normal text, `>= 3.0:1` active focus perimeter of `>= 2px`), targeting WCAG AAA (`>= 7.0:1`) for primary reading/editing text; desktop interactive hit targets `>= 32 × 32 px`; Vietnamese IME (`compositionstart` / `compositionend`) fencing.
  - **Offline determinism & privacy:** Preview slices use zero external CDNs, fonts, scripts, or network calls; router receipts and UI surfaces expose zero credentials, raw secrets, or prompt bodies in telemetry logs.
- **Experience principles (non-negotiable):**
  1. **Authoritative State Honesty:** Never silently coerce `quota_stale` or `usage_unknown` to `0`, and never claim encrypted or unsupported attachments (`ENCRYPTED_UNRESOLVED`) were read.
  2. **Zero-Mutation Escape & Payload Deduplication:** Pasting an attachment offers explicit keyboard-accessible placement (`Inline at Caret` vs `Attachment Tray`), where `Esc` / `Cancel` leaves draft bytes, caret offset, and revision history untouched, and shared inline/tray references bind a single content-addressed digest (`sha256`) without duplicate uploads.
  3. **Visual Recognition Before Recall in Scientific Input:** Mathematics, physics, and chemistry palettes render human-readable notation (`∑`, `∫`, `∇`, `ħ`, `⇌`, `ΔG°`, matrices) inside the picker before insertion, paired with live side-by-side Markdown/LaTeX preview.
  4. **Luminance & Hairline Hierarchy Over Decoration:** Establish visual order via measurable surface luminance steps, `1px` structural borders, and `tabular-nums` alignment—never via decorative gradients, backdrop-blur glass, or arbitrary pill badges.
- **Anti-goals:**
  - Generic SaaS hero banners, symmetrical 3-card marketing grids, or purple-to-pink "AI magic" gradients.
  - Translucent `backdrop-filter: blur(...)` glassmorphism soup that degrades Win32 GDI/DirectComposition legibility and GPU budgets.
  - Decorative rainbow subagent icons or `border-radius: 9999px` pills that do not encode deterministic state (`RUN`, `PASS`, `BLOCKED`).
  - Treating a static or interactive HTML direction slice as proof that native Rust behavior passes `DOD-13` or `DOD-14`.

---

## 2. Source-Backed Reference Ledger

Research combines the workspace's bounded public UI/style acquisition (`10` GitHub search queries, `68` unique repository identities, `8` official documentation fetches, and `11` selected README retrievals recorded on `2026-11-11T16:09:36Z–16:12:53Z`), local requirement intakes, and user-supplied workflow screenshots. Unread or JS-gated pages are explicitly marked below.

| Source | Retrieved / Revision | Inspected Range | License / Reuse | Observation | Decision |
|---|---|---|---|---|---|
| [W3C WCAG 2.2 SC 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | `2026-11-11T16:09:36Z` · HTTP 200 (`80,501 B`, `sha256:80ECBE54...`) | Extracted `32,275` chars (`281` term hits): normative `4.5:1` normal text, `3:1` large text, luminance formula | W3C Document License (guidance only; zero copied prose) | Color-vision and low-luminance legibility depend on relative luminance delta rather than hue saturation | **Adopt** (`>= 5.74:1` achieved across all body/muted text; `>= 15.0:1` primary text) |
| [W3C WCAG 2.2 SC 2.4.13 Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) | `2026-11-11T16:09:36Z` · HTTP 200 (`101,529 B`, `sha256:B5C04AC4...`) | Extracted `45,519` chars (`535` term hits): `>= 2px` perimeter area and `>= 3:1` focused/unfocused contrast | W3C Document License (guidance only) | Thin `1px` low-contrast browser outlines disappear in dense dark or tabular UIs | **Adopt** (`2px solid` focus rings with `>= 6.27:1` contrast across all 3 candidates) |
| [Microsoft Fluent 2 Design System](https://fluent2.microsoft.design/) & [`microsoft/fluentui`](https://github.com/microsoft/fluentui) | `2026-11-11T16:09:36Z` · HTTP 200 (`142,922 B`) + README (`10,623 B`) | Landing extract (`1,101` chars: Focus Order, Contrast Checker, Icon Scaling) + `master` README headings | MIT (`fluentui`); site terms unverified (zero assets copied) | Windows desktop surfaces feel native when tab/focus order, optical icon sizing, and restrained neutral surfaces align with OS conventions | **Adapt** (adopt keyboard focus zoning & neutral layering; reject Mica/Acrylic blur effects) |
| [GitHub Primer Product UI](https://primer.style/product/) & [`primer/react`](https://github.com/primer/react) | `2026-11-11T16:09:36Z` · HTTP 200 (`514,179 B`) + README (`2,327 B`) | Extracted `3,165` chars: semantic token naming, `SplitPageLayout`, `TreeView`, `ActionBar`, `useFocusTrap`, degraded/empty states | MIT (`primer/react`); zero code vendored | Explicit degraded-experience patterns and semantic role tokens (`canvas`, `surface`, `muted`, `danger`) scale cleanly across dense developer views | **Adapt** (informed Candidate A token hierarchy and degraded router telemetry states) |
| [IBM Carbon Design System](https://carbondesignsystem.com/) & [`carbon-design-system/carbon`](https://github.com/carbon-design-system/carbon) | `2026-11-11T16:09:36Z` · HTTP 200 (`208,419 B`) + README (`9,081 B`) | Extracted `3,469` chars: `2x` spacing grid, data table density, inline status indicators, AI label transparency | Apache-2.0 (`carbon`); zero code vendored | Strict `4px/8px` spacing multiples and explicit AI/provenance labels prevent ambiguous status chrome in data-dense enterprise tools | **Adapt** (informed Candidate B provenance badges and Candidate C `1px` tabular receipt log) |
| [GOV.UK Service Manual — Design](https://www.gov.uk/service-manual/design) | `2026-11-11T16:09:36Z` · HTTP 200 (`59,871 B`, `sha256:9995DFBA...`) | Extracted `4,294` chars: plain-language form/error clarity, inclusive prototyping | OGL v3.0 (principles only) | High-contrast daylight typography and unambiguous action labels outperform ornamental chrome on complex decision dialogs | **Adapt** (informed paste-chooser wording and explicit `ENCRYPTED_UNRESOLVED` copy) |
| [`radix-ui/primitives`](https://github.com/radix-ui/primitives) & [`chakra-ui/zag`](https://github.com/chakra-ui/zag) | `2026-11-11T16:09:36Z` · `pushedAt: 2026-10-14` / `2026-11-11` | Metadata + `radix` README (`1,704 B`); state-machine dialog/popover focus patterns | MIT (zero dependencies vendored) | Modal/popover controls require deterministic keyboard state transitions (`Esc` cancel returning focus to exact trigger/caret) | **Adapt** (implemented pure-JS zero-mutation `Esc` cancel in paste choosers) |
| [`palantir/blueprint`](https://github.com/palantir/blueprint) | `2026-11-11T16:09:36Z` · `pushedAt: 2026-11-11T15:53:27Z` (`22,200` stars) | Bounded GitHub search metadata only (full source not read) | Apache-2.0 | High-density desktop-oriented control sizing (`28px–32px`) for analytical workflows | **Adapt** (concept only; density calibrated locally via `deep-ui-quantitative`) |
| [`DioxusLabs/dioxus`](https://github.com/DioxusLabs/dioxus), [`slint-ui/slint`](https://github.com/slint-ui/slint), [`elixir-crab/gpui`](https://github.com/elixir-crab/gpui), [`rust-windowing/winit`](https://github.com/rust-windowing/winit) | `2026-11-11T16:09:36Z` · `winit` README (`3,264 B`) + search metadata | `winit` README headings + repository metadata (`Apache-2.0` / `MIT` / `NOASSERTION`) | Mixed (`slint` `NOASSERTION` — excluded from code reuse) | Pure-Rust windowing/UI ecosystems separate layout tokens from OS accessibility bridges; custom rendering requires explicit UIA wiring | **Defer** external UI crates (retain Omnia's existing pure-Rust Win32 shell + shared crates) |
| [`Verstige/anti-slop-ui-design`](https://github.com/Verstige/anti-slop-ui-design), [`jshmllr/tokyn`](https://github.com/jshmllr/tokyn), [`1-Pankaj/slopless-ui`](https://github.com/1-Pankaj/slopless-ui) | `2026-11-11T16:09:36Z` · bounded GitHub query `"anti ai slop interface design"` | Discovery metadata/descriptions only (repository source bodies not opened) | `MIT` / `NOASSERTION` (zero code/text copied) | Convergent critique across independent authors: enforce deterministic typography, single functional accent, real degraded/error states, and zero gratuitous gradients | **Adapt** as adversarial checklist items only (discovery-level credit only) |
| [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) & [Material Design 3](https://m3.material.io/) | `2026-11-11T16:09:36Z` · HTTP 200 (`17,978 B` / `62,386 B`) | **JS-shell truncated** (`277` chars / `49` chars extracted without headless browser execution) | Site terms unverified | Automated non-JS fetch returned shell notices rather than full guidelines | **Reject as evidence** (explicitly recorded as uninspected body; zero claims derived) |
| [`shadcn-ui/ui`](https://github.com/shadcn-ui/ui) & [`saadeghi/daisyui`](https://github.com/saadeghi/daisyui) | `2026-11-11T16:12:53Z` · README extracts (`467 B` / `2,762 B`) | Counterexample evaluation for default AI-generated web templates | MIT | Unmodified default card/pill/zinc web templates are the #1 source of homogeneous "AI-generated SaaS" visual fatigue | **Reject** default visual styling (used as counterexample in anti-template audit) |
| User-supplied workflow screenshots (`15` local captures, `2026-11-11`) & `native-preview-r8-window.png` (`1220 × 820`) | `2026-11-11` / `2026-11-10` · Direct visual inspection | Left rail + session folders, subagent drawer (`Active`/`Done`), `+` attachment/plugin menu, Vietnamese rich-composer prompt, and Win32 r8 shell | Internal project intake (not published) | Revealed user's exact workflow needs (Word-grade toolbar, live rendered math/chem list, inline vs tray paste, persistent goal strip) AND two anti-patterns to fix: rainbow decorative subagent icons and r8 bottom status-bar clipping | **Adopt requirements / Fix anti-patterns** |

---

## 3. Style Exploration: Three Materially Distinct Candidates

To avoid defaulting to a single familiar template, three offline-interactive vertical slices were built from the same product contracts ([COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md) and [DYNAMIC_ROUTING_REQUIREMENTS.md](../workspace/DYNAMIC_ROUTING_REQUIREMENTS.md)), varying **four orthogonal structural axes**:

| Structural Axis | Candidate A: `Precision Studio` | Candidate B: `Academic Workbench` | Candidate C: `Minimal Systems` |
|---|---|---|---|
| **1. Spatial Topology & Navigation** | `44px` icon rail + collapsible `252px` session/subagent tree + split multi-surface stage (`Chat` / `IDE Diff` / `Browser DOM` / `Split`) + docked bottom ribbon composer | `236px` hierarchical memory namespace rail + document-centric **Two-Column Margin-Citation Sheet** (`66ch` prose + `248px` margin notes) + `296px` provenance rail + bottom RAG drawer | **Zero persistent sidebars**; full-width `1px` tabular grid + top `Ctrl+K` command bar + native-mapped `Edit` composer + collapsible bottom receipt/tray drawer |
| **2. Chromatic Polarity & Surface Model** | High-contrast Deep Obsidian Dark (`#0B0E14` / `#10151E` / `#161D29`, `#ECF2F8` ink = `17.13:1` AAA); single cobalt signal `#58A6FF` | Warm Archival Vellum Daylight (`#FAF7F0` / `#FFFFFF` / `#F2EDE2`, `#181715` ink = `17.91:1` AAA); mineral ultramarine `#1B4DDB` (`6.71:1`) | Dual System Polarity: Crisp Zinc System Light (`#FFFFFF`, `17.74:1` AAA) + `Alt+T` System Dark (`#181B20`, `15.69:1` AAA); `0px` shadows |
| **3. Typography Voice & Rhythm** | `Segoe UI Variable Text` + `Cascadia Mono` (`13.5px / 20px` compact studio rhythm, `4px` spacing grid) | Editorial/Math Serif `Cambria` / `Georgia` (`16px / 26px`, `66ch` reading measure) + UI Grotesque metadata + `Cascadia Mono` digests | Tabular Monospace dominance (`Cascadia Mono` / `Consolas` `tabular-nums` across headers, quotas, timestamps, receipts) + `Segoe UI` (`13px / 19px`) |
| **4. Composer & Telemetry Disclosure** | Persistent top Goal + Router Telemetry Strip; docked Word-grade ribbon + split live Markdown/LaTeX preview + modal paste chooser | Inline Notebook Cell Composer with visual Equation Preset Drawer + Margin Citation anchors `[1]` + Proactive Multi-Query RAG Unused-Source Ledger | Keyboard command bar (`/route`, `/bounds 1220x820`, `/paste`) + non-modal inline paste bar + append-only tabular Router Decision/Outcome Receipt Log |

### 3.1 Candidate A — `candidate-a-precision-studio` (Technical Dark Multi-Surface Studio)
- **Reference lineage:** GitHub Primer dark role hierarchy + Zed/Linear-style compact pane choreography + WCAG 2.2 focus/contrast rules.
- **Product-specific transformation:** Replaces decorative subagent badges with deterministic text-and-border tags (`RUN`, `PASS`); integrates a persistent top Dynamic Router strip (`closed`, `half_open` / `quota_stale`, `open` / `usage_unknown`), a Word-grade formatting ribbon (`Title/H1/H2`, `Bold`, `Italic`, `Underline`, font family/size/contrast-verified ink color, indent/outdent, lists, checklists, tables), a rendered Math/Physics/Chemistry palette (`∑`, `∫`, `∇`, `ħ`, `⇌`, `ΔG°`, matrices), split live preview, and a focus-trapped Inline-vs-Tray paste chooser whose `Esc` cancel is verified by a live `Draft Rev` + `FNV-1a` checksum readout.
- **Risks:** High simultaneous control count on `1024px` viewports if both sidebar and split preview remain open (mitigated via responsive single-column composer fallback below `1100px` and `Ctrl+B` tree collapse).

### 3.2 Candidate B — `candidate-b-academic-workbench` (Warm-Paper Daylight Margin-Citation & RAG Workbench)
- **Reference lineage:** Typst / GNU TeXmacs / Wolfram Mathematica notebook cells + Tufte synchronized margin citations + Carbon explicit provenance tagging.
- **Product-specific transformation:** Elevates `PRODUCT-MEMORY`, `PRODUCT-GRAPH`, and `PRODUCT-KNOWLEDGE` into first-class visual structures: hierarchical namespaces (`study/physics/stat-mech`), typed graph edges (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`), a Proactive Multi-Query RAG drawer separating **Cited Sources** from **Explicit Unused/Excluded Sources**, and a right-rail Attachment Provenance Inspector contrasting verified OCR conversions (`lecture_thermodynamics_scan.pdf` → `.md`) against an honest `ENCRYPTED_UNRESOLVED` archive (`exam_solutions_locked.7z`).
- **Risks:** Two-column margin-citation prose (`66ch` + `248px` margin) prioritizes deep reading and scientific study over side-by-side code diffing (`IDE` mode).

### 3.3 Candidate C — `candidate-c-minimal-systems` (Restrained Win32 / Fluent-Industrial Command Surface)
- **Reference lineage:** Pure Win32 GDI/DirectWrite control grids + Fluent 2 keyboard focus order + GOV.UK plain operational labeling.
- **Product-specific transformation:** Eliminates all sidebars, shadows, and rounded containers (`0px` grid cells, `2px` buttons) to minimize native Win32 redraw and memory overhead; exposes an explicit `UIA ControlType.Edit` (`id="omniaUiaEdit"`, `aria-label="Edit"`) composer, a non-modal keyboard paste bar, a `/`-command bar, and a built-in `1220 × 820` viewport harness proving `0px` bottom status-bar clipping.
- **Risks:** Stark `1px` industrial aesthetic feels austere during multi-hour study/tutoring or rich document authoring compared with Candidates A and B.

---

## 4. Weighted Decision Matrix

Weights reflect Omnia's native-first engineering priorities ([GOAL.md](../workspace/GOAL.md)) and sum to **100**:

| Criterion | Weight | Candidate A (`Precision Studio`) | Candidate B (`Academic Workbench`) | Candidate C (`Minimal Systems`) | Evidence Basis |
|---|---:|---:|---:|---:|---|
| **Task Clarity** (Composer + Router + Multi-mode) | 20 | **9.2** (`18.40`) | 8.4 (`16.80`) | 8.6 (`17.20`) | Cand A unifies `Chat`, `IDE`, `Browser`, ribbon composer, and router telemetry in one predictable scan path |
| **Visual Hierarchy & Scan Order** | 15 | **9.0** (`13.50`) | **9.2** (`13.80`) | 8.5 (`12.75`) | Cand B excels on long derivations (`17.91:1` serif + margin citations); Cand A leads across mixed code + chat |
| **Information Density & Viewport Fit** | 15 | **9.1** (`13.65`) | 7.8 (`11.70`) | **9.4** (`14.10`) | Cand C and Cand A preserve full controls at `1220 × 820` without clipping; Cand B's 3-column + margin layout needs `>= 1180px` |
| **Accessibility & UIA Parity** | 15 | **9.0** (`13.50`) | 8.9 (`13.35`) | **9.3** (`13.95`) | All 3 pass WCAG AA/AAA (`>= 5.74:1` muted, `>= 15.0:1` primary), `>= 32px` targets, `2px` focus rings, and `Esc` no-mutation paste |
| **Native-Platform Fit (Rust / Win32)** | 15 | 8.6 (`12.90`) | 7.6 (`11.40`) | **9.6** (`14.40`) | Cand C maps `1:1` to Win32 GDI/DirectWrite controls; Cand A maps cleanly with custom-drawn ribbon/tabs |
| **Performance & Resource Cost** | 10 | 8.8 (`8.80`) | 8.5 (`8.50`) | **9.8** (`9.80`) | Zero blur/gradients/animations in all 3; Cand C has lowest layout/compositor complexity |
| **Distinctiveness & Anti-Slop Identity** | 5 | **9.0** (`4.50`) | **9.4** (`4.70`) | 8.4 (`4.20`) | Cand B (Tufte archival workbench) and Cand A (instrumented studio) avoid every generic AI chat template cliché |
| **Implementation Risk (Low Risk = High Score)** | 5 | 8.2 (`4.10`) | 7.4 (`3.70`) | **9.4** (`4.70`) | Cand C requires minimal custom layout logic; Cand B's synchronized margin anchoring requires custom native text measurement |
| **Weighted Total (`/ 100`)** | **100** | **`89.35` ( Provisional #1 — Studio Target )** | **`83.95` ( Retained Mode — Study/RAG )** | **`91.10` ( Win32 Baseline / Low-Overhead Floor )** | *Note: Scores are provisional design-slice evaluations until user review and live native QA.* |

### Provisional Synthesis & Recorded Rejections
1. **Why `Candidate C` (`91.10`) and `Candidate A` (`89.35`) are paired rather than discarding either:**
   - **Immediate Native Win32 Shell (`PRODUCT-NATIVE` / `QUALITY-01`):** Adopt **Candidate C's structural invariants** (strict `1px` unclipped grid geometry at `1220 × 820`, zero GPU blur/shadow cost, explicit `UIA ControlType.Edit` exposure, and deterministic receipt table) as the immediate low-risk foundation in `native/src/`.
   - **Full Unified Omnia Workspace (`PRODUCT-WORKSPACE` / `PRODUCT-COMPOSER`):** Recommend **Candidate A (`Precision Studio`)** as the primary multi-pane studio direction once rich formatting spans, symbol palette popovers, and split `Chat + IDE/Browser` panes are active, because Candidate C alone is too austere for rich Word-like authoring and multi-pane supervision.
2. **Why `Candidate B` (`83.95`) is NOT selected as the sole default shell (Rejection / Scoping Rationale):**
   - Candidate B's `66ch` serif sheet + `248px` margin-citation lane consumes horizontal width needed by split `IDE Diff` and `Browser DOM` panels at `1220 × 820`. Rather than forcing code diffs into an academic paper layout, Candidate B's **Warm-Paper Daylight palette** and **Margin-Citation + Proactive RAG Source Ledger** should be preserved as an opt-in **Study / Research Notebook Mode** (`PRODUCT-KNOWLEDGE`, `PRODUCT-MEMORY`), while porting its honest `EXTRACTED`/`INFERRED`/`AMBIGUOUS` and `ENCRYPTED_UNRESOLVED` badges directly into Candidate A/C.
3. **Visible Open Questions for User Review:**
   - **OQ-01 (Default Theme Polarity):** Should Omnia start in Candidate A's Deep Obsidian Dark (`#0B0E14`) or Candidate B/C's High-Contrast Daylight (`#FAF7F0` / `#FFFFFF`), with `Alt+T` instant switching?
   - **OQ-02 (Paste Placement Default Focus):** When `Ctrl+V` opens the Inline-vs-Tray chooser, should initial `Enter` focus default to `1. Insert Inline at Caret` (current preview behavior) or `2. Add to Attachment Tray`?

---

## 5. Concrete Direction Brief

- **Hierarchy & Scan Order:**
  1. Top status strip (`34px–42px`): active persistent goal + Dynamic Router health (`circuit`, `EWMA/p95`, explicit `quota` + `reserve`).
  2. Center primary work stage: conversation/derivation stream (`66ch–76ch` max measure) paired on demand with `IDE`, `Browser`, or `Router Receipt` inspector.
  3. Bottom anchored composer: formatting/equation strip → split input + live Markdown/LaTeX preview → deduplicated attachment tray → single primary `Send / Dispatch` CTA.
  4. Bottom `26px` unclipped status bar: `UIA Edit` binding, draft revision/checksum, and containment status.
- **Density & Rhythm:** `4px` base unit (`4, 8, 12, 16, 24, 32 px`); desktop interactive controls `>= 32 × 32 px`; compact `12px–13.5px` studio controls (`16px` prose in Academic mode).
- **Typography:** Maximum 3 font roles per candidate: UI Sans (`Segoe UI Variable Text` / `Segoe UI`), Technical Monospace (`Cascadia Mono` / `Consolas` with `font-variant-numeric: tabular-nums` on all quotas, latencies, byte counts, and hashes), and Mathematical Serif (`Cambria Math` / `Cambria`).
- **Color & Surfaces:** Solid luminance steps only (`0` gradients, `0px` backdrop blur). Every semantic status pairs color (`>= 5.78:1` text contrast) with an explicit text label and geometric symbol (`◆ closed`, `▲ half_open`, `■ open`).
- **Interaction & Motion:** `0ms–120ms` state transitions (`cubic-bezier(0.2, 0, 0, 1)`), collapsing automatically to `0ms` under `prefers-reduced-motion: reduce`. Zero idle/looping decorative animations.
- **State Coverage:**
  - *Router states:* `closed` (healthy reservation + emergency reserve), `half_open` (`quota_stale` with explicit age > TTL, probe route), `open` (`usage_unknown` + fenced dispatch preventing duplicate reservation spend).
  - *Composer & attachment states:* IME composing vs committed, inline-at-caret node `[[att:id]]` vs tray reference sharing one `sha256` payload, text-only provider labeled fallback serialization, verified conversion (`PDF → Markdown`) with original retained, and `ENCRYPTED_UNRESOLVED` opaque attachment state.

---

## 6. Adversarial Template & Anti-Slop Audit

| Anti-Slop Check | Audit Method | Result Across Candidates A, B, C | Rationale / Enforcement |
|---|---|---|---|
| **Gratuitous purple/pink/cyan gradients** | Regex scan (`linear-gradient`, `radial-gradient`) across all `.css`/`.html`/`.js` | **PASS (`0` occurrences)** | Hierarchy relies strictly on measured surface luminance and `1px` borders |
| **Glassmorphism blur soup** | Regex scan (`backdrop-filter`) + shadow audit | **PASS (`0` occurrences)** | Preserves crisp Win32 ClearType subpixel legibility and zero GPU blur cost |
| **Arbitrary `9999px` decorative pills** | Token & CSS radius inspection | **PASS (`0px–6px` max)** | Badges use `2px` technical chamfers; controls use `2px–4px` |
| **Decorative rainbow subagent icons** | Inspection against user screenshot `651445bf` | **FIXED** | Replaced arbitrary flower/pinwheel icons with deterministic `RUN` / `PASS` state tags |
| **Dead static mock controls** | Interactive event handler & `node --check` verification | **PASS** | Ribbon buttons, math/phys/chem palettes, live preview, router state switcher, slash commands, and paste modals execute real state transitions |
| **Silent zeroing of unknown/stale quota** | Inspection against `DYNAMIC_ROUTING_REQUIREMENTS.md` | **PASS** | `quota_stale` and `usage_unknown` render as explicit states and fence unsafe retries |
| **Fabricated reading of encrypted files** | Inspection against `COMPOSER_REQUIREMENTS.md` | **PASS** | `exam_solutions_locked.7z` / `protected_dump.7z` explicitly display `ENCRYPTED_UNRESOLVED (0 bytes claimed read)` |
| **External CDN / private path leakage** | Automated scan for `http(s)://` in runtime code & local usernames | **PASS (`0` runtime URLs, `0` PII)** | 100% offline-deterministic rendering |

---

## 7. Preview Checkpoints & Artifact Hashes

All preview slices are stored outside the repository in `D:\OmniaData\qa\ui-direction-20261112\` per `DOD-06` and `PRODUCT-WORKSPACE`.

| Candidate / Surface | External Artifact Locator | Size (Bytes) | SHA-256 Digest | User Review | Status |
|---|---|---:|---|---|---|
| **Cand A** · HTML Entrypoint | `D:\OmniaData\qa\ui-direction-20261112\candidate-a-precision-studio\index.html` | `19,697` | `9AAAE2D417EDEFE8DC7AED1B64CA952449ED3EA36ECB3640D77B4A1351554D6C` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand A** · Studio Styles | `D:\OmniaData\qa\ui-direction-20261112\candidate-a-precision-studio\styles.css` | `18,245` | `CD25B17F8926E25ECF54FD20041937936ED7DC44FE24F7037328BAD25BAF80E7` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand A** · Interactive Engine | `D:\OmniaData\qa\ui-direction-20261112\candidate-a-precision-studio\app.js` | `40,263` | `63C660941B04B34DF4B64CD494400ECECBFAEDF011C04EF6078769DDBE412A35` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand A** · Token Seed (DTCG) | `D:\OmniaData\qa\ui-direction-20261112\candidate-a-precision-studio\tokens.seed.json` | `6,139` | `30B27AD8A59EB08C63B5668A3F5532F7CB4874AA5587D1FDA53C20D2ED32DC58` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand B** · HTML Entrypoint | `D:\OmniaData\qa\ui-direction-20261112\candidate-b-academic-workbench\index.html` | `12,259` | `75EA1DDB04121A20566E4E06AB74C2C2C31103A20B9A1F2705871F032F48B9BD` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand B** · Daylight Styles | `D:\OmniaData\qa\ui-direction-20261112\candidate-b-academic-workbench\styles.css` | `11,425` | `3F2A1BAF0E9F96F3689982638AC19C7D7A378B13F804EE6388CC04A7755A7A0D` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand B** · Notebook & RAG JS | `D:\OmniaData\qa\ui-direction-20261112\candidate-b-academic-workbench\app.js` | `26,532` | `1188FBE83426C9F0C9B6756B7A0FE19456E5B2C38C4C8E00A5C9A241CDEFD062` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand B** · Token Seed (DTCG) | `D:\OmniaData\qa\ui-direction-20261112\candidate-b-academic-workbench\tokens.seed.json` | `6,110` | `06A1AA4018EA21E855D3F707B539BC5D5E2F454C286BCA71866AD419FD8AEC00` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand C** · HTML Entrypoint | `D:\OmniaData\qa\ui-direction-20261112\candidate-c-minimal-systems\index.html` | `7,647` | `83E41B59FCC96E4313952CDB0F7F3E2EFDB0CDDB27129CA3848D90F676315E1A` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand C** · Grid Styles | `D:\OmniaData\qa\ui-direction-20261112\candidate-c-minimal-systems\styles.css` | `6,995` | `F94731E22EE506A59C87BB1C4126A17B63C932113EEC60210F41AE966253F651` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand C** · Command & Receipt JS | `D:\OmniaData\qa\ui-direction-20261112\candidate-c-minimal-systems\app.js` | `19,313` | `9FA7043053C2B99B23C485321A7A0492CA713C387A14D4EB534AE1483E596805` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |
| **Cand C** · Token Seed (DTCG) | `D:\OmniaData\qa\ui-direction-20261112\candidate-c-minimal-systems\tokens.seed.json` | `5,041` | `DBBC8E7B03E51F0A10E8A4448625D57E621673CB39F1087E9B0D72FD66BBE311` | `PENDING_USER_REVIEW` | `PREVIEW_READY` |

---

## 8. Independent Critique Ledger

Two structured critique passes were executed against the initial candidate tokens and layouts prior to finalizing the preview artifacts:

| ID | Pass | Finding | Evidence | Severity | Decision & Resolution | Owner | Recheck |
|---|---|---|---|---|---|---|---|
| `CRIT-01` | Pass 1 (Quantitative Contrast) | Initial mental-math WCAG contrast approximations in `tokens.seed.json` differed by `0.2–1.1` points from IEEE 754 sRGB gamma-linearized relative luminance (`((v+0.055)/1.055)^2.4`). | Python WCAG 2.2 luminance audit across all foreground/background pairs | Medium | Recomputed and updated every `wcagContrast` field in all three `tokens.seed.json` files to exact 2-decimal WCAG 2.2 luminance ratios (`>= 5.74:1` all body/muted pairs). | `ui-direction` | **RESOLVED** (verified exact) |
| `CRIT-02` | Pass 1 (Win32 `QUALITY-01` Parity) | r8 native session capture (`1220 × 820`) suffered bottom status-panel text clipping and `Missing UIA control: Edit`. | [DOD.md](../workspace/DOD.md) lines 152–154; `native-preview-r8-window.png` | High | Anchored explicit `26px` non-clipping bottom grid row across all 3 candidates, exposed `role="textbox"` / `aria-label="Edit"`, and added a live `1220×820` viewport harness in Candidate C. | `ui-direction` → `product-architect` | Re-verify in native `qa-smoke.ps1` & `qa-session.ps1` |
| `CRIT-03` | Pass 2 (Adversarial Anti-Slop) | Reference screenshot `651445bf` used decorative multi-colored floral/geometric icons per subagent row with no semantic mapping to task state. | Visual audit of supplied subagent drawer screenshot | Medium | Rejected decorative icons; replaced with monospace semantic badges (`RUN`, `PASS`, `FENCED`) paired with high-contrast borders. | `ui-direction` | **RESOLVED** in Candidate A |
| `CRIT-04` | Pass 2 (Composer Contract) | Split live Markdown/LaTeX preview side-by-side with editor can crowd narrow (`< 1100px`) windows. | Responsive breakpoint inspection on Candidate A `composer-work-grid` | Low | Added `@media (max-width: 1100px)` single-column collapse plus an explicit `Split Live Preview: ON/OFF` toolbar toggle. | `ui-direction` | Re-observe under `deep-ui-qa` DPI/zoom sweep |
| `CRIT-05` | Pass 2 (Honest Provenance) | Academic RAG interfaces frequently hide discarded search hits or silently skip password-locked archives. | [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md) line 15; [DOD.md](../workspace/DOD.md) line 91 | High | Added dedicated **Explicit Unused / Excluded Sources** column and `ENCRYPTED_UNRESOLVED` artifact card in Candidate B & C. | `ui-direction` | **RESOLVED** in preview slices |

---

## 9. User Review Gate (`PENDING_USER_REVIEW`)

> **Gate Rule:** Neither internal critique nor automated QA verification substitutes for explicit user selection. Status remains **`PENDING_USER_REVIEW`** until the user inspects the previews and confirms or redirects the choice.

### How to Inspect Offline (Zero Server Required)
Open each candidate directly in any local browser (`file:///...` — zero network/CDN needed):
1. **Candidate A (`Precision Studio` — Dark Multi-Surface Workbench):**
   `D:\OmniaData\qa\ui-direction-20261112\candidate-a-precision-studio\index.html`
   - *Try:* Click **∑ ∫ ⇌ Math / Phys / Chem** to insert rendered equations; switch **Sim State** (`closed` → `half_open / quota_stale` → `open / usage_unknown`); click **Simulate Paste Image/File (Ctrl+V)** and press `Esc` to verify `Draft Rev` and `Checksum` in the bottom bar do **not** mutate; switch **Target Capability** to `Text-Only Fallback` and click **Dispatch via Router**.
2. **Candidate B (`Academic Workbench` — Warm-Paper Margin-Citation & RAG):**
   `D:\OmniaData\qa\ui-direction-20261112\candidate-b-academic-workbench\index.html`
   - *Try:* Switch left-rail namespaces (`study/physics/stat-mech`, `study/chem/electrochem`, `projects/omnia/routing`); click inline citation `[1]` to highlight its synchronized right-margin note; inspect `exam_solutions_locked.7z` (`ENCRYPTED_UNRESOLVED`) in the right rail and the **Explicit Unused Sources** box in the bottom RAG ledger.
3. **Candidate C (`Minimal Systems` — Restrained Win32 Command Grid):**
   `D:\OmniaData\qa\ui-direction-20261112\candidate-c-minimal-systems\index.html`
   - *Try:* Click **1220×820** in the top-right QA Viewport bar to verify unclipped bottom status text; press `Alt+T` (or type `/theme` in `Ctrl+K` command bar) to flip between System Light and System Dark; type `/route open` and press `Ctrl+Enter` in the composer to observe fenced dispatch in the bottom receipt log.

---

## 10. Acceptance Checklist (`deep-ui-direction`)

- [x] Direction problem framing, experience principles, and anti-goals are concrete, and 3 materially distinct alternatives across 4 structural axes are recorded.
- [x] Measurable DTCG token seeds (`tokens.seed.json`) with exact WCAG 2.2 contrast ratios, hit targets, typography scales, spacing grids, and radii are handed off for `modern-tech-ui-design` and `deep-ui-quantitative`.
- [x] Major surfaces and required states (`closed`/`half_open`/`open` router, `quota_stale`/`usage_unknown`, rich composer, rendered math/phys/chem palette, inline-vs-tray paste with `Esc` zero-mutation cancel, deduplicated payload store, `EXTRACTED`/`INFERRED`/`AMBIGUOUS` graph memory, and `ENCRYPTED_UNRESOLVED` attachments) have offline interactive previews.
- [x] Independent critique passes and adversarial anti-slop audit are recorded with concrete resolutions.
- [x] User review status is explicitly marked `PENDING_USER_REVIEW` (never conflated with internal review).
- [x] Native Rust implementation (`PRODUCT-01`) and live UI/UIA/DPI runtime verification (`QUALITY-01`, `DOD-13`, `DOD-14`) remain explicitly separate gates.
