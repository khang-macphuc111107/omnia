# Omnia Studio UI — Rebuild Specification (v1)

- **Document ID:** `OMNIA-STUDIO-UI-REBUILD-20261113` (supersedes `OMNIA-FLAGSHIP-STUDIO-UI-20261112`)
- **Owning surface:** `ui/` served by `omnia-studio.exe` on `127.0.0.1:<port>`
- **Design source:** design canvas "Omnia Studio — UI Rebuild" (7 artboards: Hội thoại, Tác tử, Định tuyến, Tri thức, Cài đặt, Trạng thái & hộp thoại, Hệ thiết kế). The canvas stylesheet `omnia-ui.css` was split into `ui/styles/{tokens,base,components,layout}.css`; keep both in sync.
- **Status:** platform layer implemented; feature views assigned (§6).

## 1. Scope and decisions

| Decision | Value |
|---|---|
| Scope | Rebuild the web Studio `ui/` only. **No backend change** (`cpp/`, `native/` untouched). |
| Feature set | The features the previous UI exposed, made real and honest. Static marketing content (the old "C++20 architecture" page) and demo buttons (simulated paste, `.7z` sample, QA quick-steers) are removed. |
| Honesty | No fixture/fallback data. Every panel shows real server data or an explicit loading / empty / error / offline state. |
| Chat | The server has **no chat/message API**. Messages are stored locally per session (browser storage) and each send runs a router decision to show which provider *would* be used. Never fabricate an assistant reply. |
| Router side effect | `POST /api/router/decide` is explicit control-plane work. Simulation is side-effect free; live execution and trip/reset reserve quota/concurrency until their lifecycle is reconciled. Call it only on an explicit user action and state the effect in the UI. |
| Language | Vietnamese default, English switch (Settings, palette). All UI strings go through `t()`. |
| Themes | Dark (default), Light, System; density Comfortable/Compact; reduced motion (OS or Omnia setting). |
| Tech | Zero-build ES2022 modules, no dependencies, no CDN, CSP `script-src 'self'`, hash routing. |

## 2. Architecture

```
ui/
  index.html                  shell markup, CSP, stylesheet links, <script type="module" src="./app/main.js">
  styles/tokens.css           design tokens (dark, light, compact, reduced motion)      [platform]
  styles/base.css             base elements, utilities, icon primitive                  [platform]
  styles/components.css       shared components (see §5)                                [platform]
  styles/layout.css           app frame, sidebar modes, panels                          [platform]
  styles/views/<view>.css     view-specific rules only (prefix classes with the view)   [view owner]
  app/main.js                 entry: strings → prefs → views → shell → router → monitors [platform]
  app/api.js                  HTTP client for the 16 routes, ApiError, connection, poll [platform]
  app/core/                   dom, store, i18n, prefs, icons, router, overlay, palette, sessions, shell, strings [platform]
  app/lib/                    markdown, latex, highlight, sha256 (pure)                 [Workspace owner]
  app/views/index.js          imports every view                                         [platform]
  app/views/<view>/index.js   registerView(...) + view modules + strings.js             [view owner]
  tests/*.test.js             node --test unit tests (pure functions)
```

Rules:
1. A view never edits platform files. Needed platform changes are requested in the hand-off report.
2. Rendering: build markup with `html\`…\`` (auto-escaped) and apply it with `morph(el, markup)`; handle events with `on(root, type, selector, fn)` and `data-action` attributes. Never assign `innerHTML` with unescaped data.
3. Imperatively managed DOM (canvas) carries `data-morph-skip`. Textareas are uncontrolled unless `data-controlled`.
4. A view's `mount(host, route)` renders its own `.topbar` and body into `host` and returns `{ update(route), unmount() }`. `update` is also called after a language change. `unmount` must stop polling, timers, observers and window listeners.
5. Polling uses `poll(fn, { every })` from `api.js` (pauses while the page is hidden) and stops on unmount.
6. Async results announce through `announce()`; errors use `describeError(err)`; transient feedback uses `toast()`; destructive actions use `confirmDialog({ danger: true })`.
7. Strings: `registerStrings('<view>', { vi: {…}, en: {…} })` in `views/<view>/strings.js`; both languages complete.
8. Icons only through `icon(name)` (`core/icons.js` lists the names). No emoji.
9. Keyboard: every action reachable by keyboard; tabs and segmented controls use `rovingFocus`; Esc closes popovers/overlays and returns focus.

## 3. Platform API (import paths are relative to `ui/app/views/<view>/`)

| Module | Exports |
|---|---|
| `../../core/dom.js` | `html`, `raw` (trusted markup only), `escapeHtml`, `join`, `cx`, `morph`, `render`, `$`, `$$`, `on`, `batched`, `debounce`, `uid`, `prefersReducedMotion`, `withTransition` |
| `../../core/store.js` | `createStore(initial)` → `{ get, set, subscribe }`; `storage.get/set/remove/keys` (never throws) |
| `../../core/i18n.js` | `registerStrings`, `t(key, params)`, `getLang`, `onLangChange`, `fmtNumber`, `fmtPercent`, `fmtBytes`, `fmtTime(v, withSeconds)`, `fmtDateTime`, `fmtRelative`, `fold` (accent-insensitive) |
| `../../core/prefs.js` | `prefs` store `{ theme, density, lang, reduceMotion, sidebar, inspectorOpen }`, `resolvedTheme()`, `cycleTheme()` |
| `../../core/icons.js` | `icon(name, { size: 'sm'|'md'|'lg'|'xl', label, className })`, `ICON_NAMES` |
| `../../core/router.js` | `registerView`, `navigate(hash, { replace })`, `buildHash(view, ...params)`, `currentRoute`, `onRoute` |
| `../../core/overlay.js` | `openDialog`, `confirmDialog`, `openOverlay`, `toast`, `announce`, `copyText`, `trapFocus`, `rovingFocus`, `focusables` |
| `../../core/palette.js` | `registerCommands(() => [{ id, group, title, keywords, shortcut, icon, run, when }])`, `openPalette` |
| `../../core/sessions.js` | `sessions` store `{ items, status, error, activeId, lease }`, `loadSessions`, `createSession`, `setActiveSession`, `findSession`, `activeSession` |
| `../../core/shell.js` | `openNewSessionDialog`, `toggleSidebar` |
| `../../api.js` | `api.*` (§4), `ApiError`, `describeError`, `connection` store, `retryConnection`, `poll`, constants `EFFORTS`, `TASK_CLASSES`, `PRIVACY_TIERS`, `STEER_MODES`, `TRAVERSE_DIRECTIONS`, `TEMPLATE_CATEGORIES`, validators `validateMemoryNamespace`, `validateMemoryKey` |

Global events: the shell dispatches `window` event `omnia:toggle-inspector` on Ctrl+. ; views with a side panel listen to it.

## 4. Server contract (`cpp/src/studio/studio_server.cpp`)

All bodies are JSON objects with `ok`; timestamps are epoch ms unless noted; POST bodies must be JSON objects. Non-2xx responses carry `{ ok:false, error, message }` and surface as `ApiError(code=error)`.

| Client call | Route | Response (fields the UI uses) |
|---|---|---|
| `api.health()` | GET `/api/health` | `engine, compiler, cplusplus, rustFiles, pid, workingSetBytes, binaryBytes, skillCount, peerCount` |
| `api.sessions.list()` | GET `/api/sessions` | `sessions[{id,title,modelId,effort,updatedAt,revision}]` (≤50, newest first), `activeLease{ownerId,pid,leaseEpoch,expiresAt}|null` |
| `api.sessions.create({title,modelId,effort})` | POST `/api/sessions/create` | list payload + `session`. `effort` ∈ `none|minimal|low|medium|high|xhigh|max`; 400 `invalid_session_params` |
| `api.steer.list()` | GET `/api/steer` | `tokenBudget:null`, `items[{id,seq,text,mode,status,createdAt}]`; mode `ADDITIVE_INTAKE|BOUNDARY_CORRECTION|EXPLICIT_STOP_OR_REPLACE`; status `queued|in_progress|completed` |
| `api.steer.enqueue({text,mode})` | POST `/api/steer/enqueue` | `item, items`; 400 `empty_steer_text` |
| `api.composer.templates()` | GET `/api/composer/templates` | `templates[{id,category:'Mathematics'|'Physics'|'Chemistry',title,symbol,latex,description,placeholders}]` (15) |
| `api.graph.get()` | GET `/api/graph` | `nodes[{id,label,role,state:'ACTIVE'|'INACTIVE',epoch,maxHops,disjointPaths,excludedPaths,incomingCount,outgoingCount,duplexPeers,lastSeq}]`, `links[{from,to,mode:'Duplex'|'Directed',label,provenance}]`, `messages[{seq,conversationId,from,to,recipients,text,epoch,hop,maxHops,provenance,timestamp:'HH:MM:SS',timestampMs}]`, `graphifyNodes[{id,kind,label,path,summary}]`, `graphifyEdges[{from,to,relation,provenance,confidenceBps,note}]` |
| `api.graph.send({from,to,text,broadcast})` | POST `/api/graph/send` | `message, messages`; 400 `empty_message`, `graph_send_rejected` (message explains) |
| `api.graph.traverse({entity,direction,maxDepth})` | GET `/api/graph/traverse` | `visited, visitedEntities[{id,kind,label,path}], edges[{from,to,relation,provenance,depth,note}], quarantinedAmbiguous[...]`; unknown entity → empty arrays; depth clamped 1–8 |
| `api.router.state()` | GET `/api/router/state` | `candidates[{id,providerId,modelId,capabilities,capabilitiesFlags,privacyTier,region,circuit:'Closed'|'Open'|'HalfOpen',quotaState:'Known'|'Unknown'|'Stale'|'Contradictory',remainingTokens|null,reserveTokens,ewmaMs,p95Ms,errorRate}]`, `recentReceipts[{receiptId,policyClass,policyHash,selectedRoute,reservationId,reservedTokens,decidedAt}]` (≤10) |
| `api.router.decide(policy)` | POST `/api/router/decide` | `ok`, `selectedCandidateId|null`, `status:'ROUTED_DETERMINISTIC'|'SIMULATED_DETERMINISTIC'|'FENCED_OPERATOR_RECOVERY_REQUIRED'|'FENCED_NO_ELIGIBLE_ROUTE'`, `candidates`, `receipt{receiptId,sequenceId,simulated,schemaVersion,redactionPolicy,policyClass,policyHash,selectedRoute,reservationId,reservedTokens,promptRedacted,secretsExposed,estimatedCostMicrounits,scores[{candidateId,eligible,totalScore,totalScoreBps,capabilityScore,privacyScore,quotaScore,latencyScore,reliabilityScore,preferenceScore,priorityScore,rejectedReason}]}`. Simulation has no reservation side effect; live decisions reserve tokens. |
| `api.memory.list()` | GET `/api/memory` | `entries[{id:'<ns>/<key>',namespace,key,content,tier:'Working'|'Durable',contentSha256,updatedAt,links}]`, `erasures[{receiptId,erasedId,namespace,previousDigestSha256,erasedAt,verifiedPlaintextFree}]` |
| `api.memory.upsert({namespace,key,content,tier})` | POST `/api/memory/upsert` | `entry, entries`; 400 `invalid_memory_namespace_or_key` (ASCII `[A-Za-z0-9._-]` segments only, ≤8 levels) |
| `api.memory.erase({id})` | POST `/api/memory/erase` | `receipt`; 404 `memory_entry_not_found` |
| `api.rag.plan({query})` | POST `/api/rag/plan` | `query, language:'en'|'vi'|'bilingual', uncertaintyScore (0–1), shouldRetrieve, triggers[], subQueries[{angle,query}], citedSources[{id,title,locator,snippet,provenance,score}], unusedSources[{id,title,locator,reason}]` |
| `api.skills.search(q)` | GET `/api/skills?q=` | `query, total, skills[{name,description,path,category,score}]` |

Server facts that shape the UI: no push channel (poll); no SPA fallback (hash routes); everything except sessions resets when the server restarts; only `127.0.0.1` is bound; `Cache-Control: no-store`.

## 5. Design system

Use the shared classes before writing view CSS (all scoped under `.omnia`):

- Frame: `.sidebar .nav .nav-item .session-item .main .topbar .topbar__title .view .view__body .pane .panel .panel__header .panel__section .panel--overlay .disclosure .page .page-header .page-title .page-sub`
- Controls: `.btn` (`--primary --ghost --danger --danger-solid --icon --sm --lg --block --start`), `.kbd`, `.field .field__label .field__hint .field__error`, `.input .select .textarea .input--mono .input-group`, `.check`, `.switch`, `.range`, `.seg .seg__item`, `.tabs .tab`
- Display: `.chip` (`--mono --accent`), `.status` (`--ok --warn --danger --info --accent`) always with icon + text, `.dot`, `.count`, `.card` (`--pad --interactive`) `.card__header .card__title .card__body`, `.kv`, `.table-wrap .table`, `.meter .meter__fill` (`--warn --danger --info --accent`) `.meter--unknown`, `.stackbar` with `.s1…s5`, `.legend .legend__item .swatch`, `.banner` (`--info --warn --danger`), `.empty .empty__icon .empty__title .empty__text`, `.skeleton`, `.toast`, `.dialog`, `.popover .popover__header .menu .menu-item`, `.palette`
- Content: `.thread .msg .msg__head .msg__author .msg__time .msg__bubble .avatar .event .event__note .prose .code-block .code-block__bar .tok-kw|type|str|num|cmt|fn|pre .math .math-display .mfrac .mfrac__num .mfrac__den .mop .mop__sym .mop__lim .msqrt .msqrt__rad .mvec .mmatrix .att .tray .tray-item .composer .composer__toolbar .composer__input .composer__preview .composer__tray .composer__footer .tpl-grid .tpl-card .tpl-card__title .tpl-card__math .graph-stage .gnode`
- Utilities: `.row .col .wrap .between .grow .fill .scroll .gap-1…6 .mono .num .muted .subtle .strong .text-xs .text-sm .text-lg .truncate .sr-only .divider .vr .hide-md .hide-sm`

Token rules: colours only via `var(--…)`; one accent (`--accent`) for primary action, selection and focus; status colours only for status; data series use `--viz-1…5` (a warm amber ramp plus neutrals, never a rainbow); monospace only for code, IDs, hashes and numbers; type scale 12/13/14/15/18/22/28; spacing on the 4px grid; radii 4/6/10/14; no blur, decorative pills or emoji; gradients only as transient light (button sheen, loading shimmer), never as static surfaces; text contrast ≥ 4.5:1 in both themes.

Motion and interaction (user direction 2026-11-13: modern, restrained, luxurious, smooth, tech-feel controls) — provided by `components.css` §20 and `layout.css` §21, so views only opt in:
- Tokens: `--ease-out` (soft deceleration), `--ease-spring` (toggles), `--dur-1…4` = 140/220/340/460 ms; all collapse to 0 under OS or Omnia reduced motion.
- Automatic: button lift + press, primary-button amber glow and one light sweep on hover, icon springs, field focus glow, focus ring settling in, switch spring, segmented/tab underline transitions, nav marker, interactive-card lift, composer focus glow, dialog/palette/popover/toast entrances and exits, drawer and overlay-panel slides, route changes animating only the main column (View Transitions), skeleton shimmer, stackbar/meter width easing, connection ping/breath.
- Opt-in: `.enter` (with `style="--i: n"` for a stagger) on items created by user actions or first load; `aria-busy="true"` or `.is-loading` on a `.btn` while its action runs.
- Never: idle animation loops, motion that is not a response to the user or to new data.

## 6. Views and ownership

| Owner | Paths (exclusive) | Routes |
|---|---|---|
| Platform (lead) | `ui/index.html`, `ui/app/main.js`, `ui/app/api.js`, `ui/app/core/**`, `ui/app/views/index.js`, `ui/styles/{tokens,base,components,layout}.css`, `ui/tests/core.test.js`, this document | — |
| Workspace agent | `ui/app/views/chat/**`, `ui/app/lib/**`, `ui/styles/views/chat.css`, `ui/tests/{lib,chat}.test.js` | `#/chat`, `#/chat/<sessionId>` |
| Insight agent | `ui/app/views/{agents,routing}/**`, `ui/styles/views/{agents,routing}.css`, `ui/tests/{agents,routing}.test.js` | `#/agents`, `#/agents/code`, `#/routing` |
| Knowledge agent | `ui/app/views/{knowledge,settings}/**`, `ui/styles/views/{knowledge,settings}.css`, `ui/tests/{knowledge,settings}.test.js` | `#/knowledge/memory|skills|rag`, `#/settings` |

View ids, order and shortcuts are fixed: `chat` 1 `chat` icon, `agents` 2 `agents`, `routing` 3 `route`, `knowledge` 4 `book`, `settings` 5 `sliders` (placement `footer`).

### 6.1 Workspace — `#/chat[/<sessionId>]`
- **Layout** (artboard 1): topbar (h1 session title, chips model · effort · `rev N`, "Lệnh Ctrl K" button, inspector toggle `aria-pressed`) + body: conversation pane (local-mode banner, thread max 780px, composer) and inspector panel (340px; `panel--overlay` below 1280px).
- **Session**: route param selects the session; without one, use `sessions.activeId` and `navigate(..., { replace: true })`. No sessions → empty state with "Phiên mới" (`openNewSessionDialog`). Unknown id → "Không tìm thấy phiên" with a link back.
- **Local storage schema** (shared with Settings): key `omnia.ui.chat.<sessionId>` → `{ v: 1, messages: [{ id, role: 'user', markdown, attachments: [{ id, name, size, mime, sha256, placement: 'inline'|'tray'|'both' }], createdAt, route: { state: 'pending'|'routed'|'fenced'|'error', selectedCandidateId, receipt, status, errorCode, policy } }], draft: { text, rev, attachments } }`. Keep the newest 200 messages; storage failures → toast.
- **Send** (Ctrl+Enter or button; never while `isComposing`): append the message, clear the draft, then `api.router.decide({ taskClass, estimatedTokens, privacyTier: 'enterprise_zdr', requireStreaming: true })` where `taskClass` is `math_derivation` when the text contains LaTeX, else `code_generation`, and `estimatedTokens = max(512, ceil(chars / 3) + 1024)` (shown as an estimate). Render a route event under the message: pending → routed (provider, receipt id, reserved tokens, privacy chip, "Xem receipt") → fenced (warn + rejected reasons) → error (danger + "Thử lại"). Always add the note "Không gửi tới provider — chưa có runtime hội thoại."
- **Composer**: toolbar heading, bold, italic, underline, inline code | bullet, numbered, checklist, table, quote | formula templates | attach | preview toggle. Ctrl+B/I/U format inside the composer (root has `data-editor`). Formula popover: templates from the server, category segments (Tất cả/Toán/Vật lý/Hoá học mapped from `Mathematics/Physics/Chemistry`), accent-insensitive search, cards render LaTeX via `lib/latex.js` (never raw TeX), insert `$latex$` at the caret, arrow-key grid, Esc closes. Live preview toggle (remembered) renders the draft with `lib/markdown.js` (debounced).
- **Attachments**: picker (multiple), paste of files, drag & drop (drop on the input → inline at the drop caret, elsewhere in the pane → tray). SHA-256 from the file bytes (`crypto.subtle`, pure-JS fallback); dedupe by digest; inline token `[[att:<first 8 hex>]]`; paste/drop opens the placement dialog (artboard 6) with "Chèn tại con trỏ" focused; Esc/Huỷ leaves text, caret and rev unchanged. Files > 25 MB are rejected with a message. No claims about encryption or conversion.
- **Draft**: autosave (300 ms debounce) of text and attachment metadata; footer "Bản nháp đã lưu · rev N".
- **Rendering**: markdown (headings, emphasis, underline `__x__`, inline code, fenced code with highlight + copy, bullet/numbered/task lists, tables, quotes, links as text with URL, `$…$` and `$$…$$` math, attachment chips). Output must be safe: escape first, then build markup.
- **Inspector** (`details` sections): latest route receipt for the session (kv, score stackbar, rejected candidates, link to `#/routing`); steer queue (`api.steer.list` polled 10 s while visible, enqueue form with mode Bổ sung/Sửa ranh giới/Dừng hoặc thay thế, status chips queued/in_progress/completed); attachments of the draft (name, size, MIME, full SHA-256 + copy, placement). Listen to `omnia:toggle-inspector`; state in `prefs.inspectorOpen`.
- **Commands**: insert template (one per template), toggle preview, toggle inspector, attach file, focus composer.

### 6.2 Agents — `#/agents` (peer mesh) and `#/agents/code` (Graphify)
- **Topbar**: h1, tabs as links (`#/agents`, `#/agents/code`, arrow keys), "Tự cập nhật mỗi 10 giây", refresh button. `api.graph.get()` polled every 10 s while visible; show the last update time.
- **Mesh**: segmented "Đồ thị | Danh sách". Graph on `<canvas data-morph-skip>`: deterministic layout (coordinator-role node centred, others on an ellipse, ordered by id), links as lines (Directed with arrowheads), edges of the selected node in accent, node ring for selection, DPR-aware, redraw on data/selection/resize (ResizeObserver)/theme change only — **no idle animation loop**; when a new message arrives, animate one pulse along its edge (≤ 600 ms, skipped with reduced motion). Hit-testing for click/hover; keyboard alternative: a node button strip under the canvas and the "Danh sách" table (id, label, role, state, in/out, duplex peers, last seq).
- **Inspector** (360px): selected peer (label, id, state chip, role, epoch · maxHops, in/out, lastSeq, duplexPeers, disjointPaths, excludedPaths).
- **Send form**: from/to selects from the nodes (+ `@all`), text, "Gửi tới tất cả"; `api.graph.send`; inline error with `describeError` (e.g. `graph_send_rejected`); success toast + pulse.
- **Message log**: newest first (render ≤ 50), `#seq`, from → to/recipients, time, provenance chip (EXTRACTED ok, INFERRED info, AMBIGUOUS warn), hop/maxHops.
- **Code graph**: entity list grouped by kind with counts and filter; traverse form (root select, direction segments Cả hai/Xuôi/Ngược, depth 1–8, "Duyệt"); results summary, edges table (from, to, relation, provenance chip, depth, note), visited entity chips (click → new root), quarantined AMBIGUOUS banner with notes, entity detail card (kind, path, summary). Empty/loading/error states.

### 6.3 Routing — `#/routing`
- `api.router.state()` on mount, every 15 s while visible, on refresh and after each decision.
- **Summary tiles**: providers, Hoạt động (Closed), Thử lại (HalfOpen), Đang ngắt (Open).
- **Providers table**: id + provider/model, privacy chip (`strict_local_zero_retention` Cục bộ, `enterprise_zdr` ZDR, `private_vpc` VPC riêng, `standard_cloud` Công khai), circuit status (Closed ok "Hoạt động", HalfOpen warn "Thử lại", Open danger "Đang ngắt") + raw value, quota (Known: remaining · reserve + meter scaled to the largest Known remaining; Stale: warn "Đã cũ · quá TTL" + unverified value; Unknown: warn "Không rõ" + "không bao giờ coi là 0" + dashed meter; Contradictory: danger "Mâu thuẫn"), EWMA · p95, error rate, action "Ngắt"/"Khôi phục" behind a confirm dialog that states the reservation side effect, then `decide({ ...policy, tripCandidate|resetCandidate })`. Rows selectable (button in the first cell) → detail (capabilities, flags, region, last scores).
- **Scores**: from the most recent decision made in this UI session; stackbar per candidate (capability, privacy, quota, latency, reliability; preference/priority as text when non-zero), total / 100 or "Bị loại" + `rejectedReason`.
- **Receipts log**: `recentReceipts` (id, time, route, policy class, reserved, hash short + copy).
- **Simulation panel** (360px): task class (5, labelled in VI/EN), estimated tokens (number + range 64–120000), privacy segments (4 tiers), require streaming switch, warning banner that previews do not reserve resources, "Chạy mô phỏng" → result card (status chip, selected route, receipt kv incl. sequenceId, simulated, reservationId, policyClass, policyHash, reservedTokens, promptRedacted, secretsExposed, estimatedCostMicrounits or "—", JSON in `details` with copy). Policy remembered in `omnia.ui.routing.policy`.
- **Commands**: run simulation, refresh router state.

### 6.4 Knowledge — `#/knowledge/memory|skills|rag` (default memory)
- **Topbar** tabs (links) with counts.
- **Memory**: namespace tree from the entries (counts, "Tất cả"), text filter, entry cards (namespace/key, tier chip Durable info "Lâu dài" / Working warn "Làm việc", content, link chips that filter, SHA-256 short + updated time, Sửa → loads the form, Xoá → `confirmDialog({ danger: true })` → `api.memory.erase({ id })` → toast + refresh). Erasure receipts card from `erasures` (+ new ones): receipt id, erased id, namespace, previous digest + copy, time, plaintext-free chip. Form panel: namespace, key (validated live with `validateMemoryNamespace`/`validateMemoryKey`, messages per error code — explain that diacritics are not accepted), tier segments, content (hint `[[namespace/key]]`), Lưu (disabled until valid) → `api.memory.upsert` → toast, refresh, highlight the entry; server 400 → inline error; "Xoá biểu mẫu".
- **Skills**: search (debounce 200 ms) → `api.skills.search`; quick chips; result cards (name, category, description, path, score); total; empty and error states.
- **RAG planner**: query textarea (Ctrl+Enter), three VI/EN samples, "Phân tích" → `api.rag.plan`; result: retrieve decision chip, language chip (vi/en/bilingual), uncertainty meter + value, triggers, sub-queries, cited sources (title, locator, snippet, provenance, score), unused sources with reasons (dashed cards). Keep the previous result visible while loading (`aria-busy`).

### 6.5 Settings — `#/settings`
- Appearance: theme radio cards (Tối/Sáng/Theo hệ thống with swatches) → `prefs.set({ theme })`; density segments; reduce-motion switch.
- Language: VI/EN segments → `prefs.set({ lang })` (shell repaints, views receive `update`).
- Shortcuts table (Ctrl K, Ctrl B, Ctrl ., Alt 1…5, Ctrl Enter, Alt T, Esc).
- Diagnostics from the `connection` store: status chip, host, engine, compiler, C++ standard, PID, working set, binary size, skills · peers, Rust files; "Kiểm tra lại" → `retryConnection()`; last check time; offline → `describeError(lastError)`.
- Local data: counts from keys `omnia.ui.chat.*` (sessions, messages, approximate bytes); "Xuất JSON" (download via object URL, file `omnia-local-chat-YYYYMMDD.json`); "Xoá dữ liệu cục bộ" behind a danger confirm.

## 7. Contracts that must keep working

- `cpp/tests/test_studio_http.cpp`: `GET /` contains "Omnia Studio"; `GET /styles/tokens.css` and `GET /app/api.js` return 200 with a body; `ui/index.html` exists.
- `tools/maintained-scripts/stage-public-release.mjs` requires `ui/index.html`.
- File names: no `..`, `\` or `+`; only `.html .css .js .mjs .json .svg .png .ico .woff2` get a proper MIME type.
- CSP meta in `index.html`; no inline scripts or event-handler attributes.

## 8. Acceptance checks

1. `node --check` on every file under `ui/app` (recursive) and `node --test "ui/tests/*.test.js"` pass.
2. Against a live `omnia-studio.exe`: every view loads real data; stopping the server shows offline/error states (no invented data) and recovers on restart.
3. Viewports 1024×768, 1220×820, 1440×900, 1920×1080 in dark and light: no horizontal page overflow, no clipped primary action, sidebar usable (rail/drawer below 1100px), inspector usable (overlay below 1280px).
4. Keyboard only: reach and operate every control; visible focus; Esc closes overlays and restores focus; Vietnamese IME composition never sends or loses text.
5. No console errors or unhandled rejections during a full walkthrough; no idle `requestAnimationFrame` loop.
6. `GET /api/router/decide` side effect only on explicit user actions (none on page load).
7. `ctest` for `cpp/` still passes (`test_studio_http`).
