<!-- Reconciled from collaborator PR #1 (origin/pr-1 @ 04899e6, thtt0120:master) under Steer #21 (2026-11-28) -->

> [!NOTE]
> **Steer #21 Full Native Rust Reconciliation (`2026-11-28`, branch `omnia-sota-harness`)**:
> This roadmap accompanied [`CODEBASE_AUDIT_20261114.md`](CODEBASE_AUDIT_20261114.md) against the historical Wave 4 C++20 snapshot (archived externally in `D:\OmniaData\backups\pre-full-rust-20261115\`). Active Omnia development runs on the **17-crate Full Native Rust** workspace + Flagship `ui-v5/` (`embed-ui`) + semantically merged modular fallback `ui/` (`11` `node --test` suites); see [`PLAN.md`](PLAN.md), [`../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md`](../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md), and [`STEER_QUEUE.md`](STEER_QUEUE.md).

# Omnia codebase deep roadmap — 2026-11-14

## Scope

This document extends CODEBASE_AUDIT_20261114.md. It describes working snapshot d5536ec plus the existing UI rebuild. It is a planning artifact, not proof that proposed work is implemented.

Evidence labels: VERIFIED means observed by a passing command or controlled runtime probe. INSPECTED means source and contract were read but behavior was not exercised. PARTIAL means some paths are verified while important boundaries remain open. OPEN means evidence is missing or a known implementation gap exists.

No product implementation was changed while writing this roadmap. Updated 2026-11-15 for AUD-26..32. The audit ledger owns findings and evidence; this document owns repair order and acceptance criteria.

## Maturity map

| Area | Current state | Maturity | Completion condition |
|---|---|---:|---|
| Native C++ core | JSON, UTF-8, SHA-256, redaction, graph, routing, memory, skills | PARTIAL | Contract tests for malformed input, limits, concurrency and migrations |
| Studio host | Winsock2 HTTP server, static UI, 16 JSON routes, SQLite or memory state | PARTIAL | Restart-safe state, exact origin binding, owned workers, leases and request limits |
| Native shell | Direct2D/DWM shell, SQLite store, composer, UIA provider | PARTIAL | Compatible PowerShell QA plus UIA, IME, Narrator and provider runtime |
| Browser Studio UI | Zero-build modules, hash router, five top-level views, local chat | PARTIAL | Live walkthrough across routes, viewports, keyboard, offline and recovery |
| Chat | Local transcript and explicit routing dry run; no provider chat API | OPEN | Authenticated run API, streaming events, durable transcript and cancellation |
| Router | Candidate scoring, reservations, circuits and receipts | PARTIAL | Side-effect-free simulation is scoped complete; execution reservation lifecycle remains |
| Sessions | Storage CRUD and keyset pagination; Studio exposes only the first 50 rows | PARTIAL | API cursor/detail lookup, stale-response fencing, idempotent bootstrap and leases |
| Attachments | Browser metadata and SHA-256; native payload model | PARTIAL | Blob boundary, provider blocks, conversion workers and progress |
| Peer mesh / Graphify | In-memory duplex graph and manually seeded map | PARTIAL | Canonical ownership, reactivation/reply authorization, explicit synchronization, live indexing |
| Memory / RAG | In-memory working/durable graph and planner endpoint | PARTIAL | Persistent corpus, compaction, retrieval benchmark and source lifecycle |
| History sync | Three-surface SQLite sync using monotonic step count | PARTIAL | Exclusion-safe FTS refresh, searchable growth, conflict receipts and restore verification |
| Governance | Strong contracts and external build rules | PARTIAL | EOL normalization, unavailable gates and current-tree reconciliation |

## Upgrade sequence

All phases remain OPEN implementation work. The sequence below is an execution order, not a relaxation of release gates: existing persistence, origin and worker-lifetime blockers still prevent release. Promote the external defect probes into failing regression tests before repair; the audit's regression handoff names the existing test owners.

### Phase 0: freeze and hygiene

1. Preserve current UI changes and audit docs as separate reviewable work.
2. Normalize the six UI files reported with CRLF while preserving UTF-8 content.
3. Classify the untracked PowerShell ModuleAnalysisCache, literal filename ``nul`r`ncl`` and ignored `router-probe.obj` before any cleanup. Preserve them until ownership and recovery are established.
4. Freeze commit, status, hashes, compiler, build directory, test commands and known gaps in one source manifest.
5. Turn every confirmed audit finding into a regression oracle before repair.

Exit: diff check, pure-LF scan, skill doctor, secret scan and source manifest agree on one snapshot.

### Phase 1: numeric inputs and graph authorization

1. Add checked JSON integer conversion and a field-specific HTTP validator. Reject out-of-range, non-integral and negative token budgets before any side effects (AUD-29); keep router overflow checks as a separate obligation (AUD-14).
2. Normalize or reject path aliases under the target workspace's case and containment policy. Share overlap validation between registration and inactive-to-active transitions; failed activation must retain the inactive state (AUD-26/27).
3. Authorize replies against original recipients and the expected responder before appending messages or replacing conversation state. Define broadcast and epoch semantics explicitly (AUD-28).

Exit: regressions in `cpp/tests/test_core.cpp`, `cpp/tests/test_graph.cpp` and `cpp/tests/test_studio_http.cpp` reject invalid inputs without state changes and retain valid input/peer behavior. The probe's epoch observation needs a defined contract; it is not a separately confirmed finding.

### Phase 2: history search and session access

1. Pass `excluded_active` through every FTS backfill/refresh path and filter before body extraction. Test explicit IDs, descendants, RUNNING and recent-WAL exclusions (AUD-30).
2. Track indexed trajectory revision/digest and transactionally rebuild changed eligible conversations. Preserve the prior index on failure and avoid duplicate chunks on repeated sync (AUD-31).
3. Expose storage keyset pagination through bounded API pages and validated opaque cursors, plus session detail lookup backed by `get_session()`. Let the UI resolve an older selected ID independently of the first page (AUD-32).
4. Fence stale list responses across load/create/reload and merge pages by ID/revision (AUD-20).

Exit: history fixtures remain excluded, a two-to-four-step trajectory becomes searchable, and repeated sync is idempotent. A 56-session HTTP/UI fixture can enumerate all records once and reopen its oldest ID after refresh; equal timestamps and invalid cursors are covered.

### Phase 3: persistence and server safety

1. Replace unconditional demo seeding with a first-run migration or explicit demo-data mode. Existing IDs must be idempotent only in demo mode.
2. Give every Studio process a unique lease owner. Persist PID and process start identity, check acquisition, heartbeat before TTL expiry, release cleanly, and fence writes by lease epoch.
3. Parse Host and Origin as authorities. Compare scheme, loopback address and bound port exactly. Document the policy for a missing Origin.
4. **Scoped repair complete (AUD-07):** detached request threads are replaced by an owned bounded worker queue. Shutdown closes the listener and active client sockets, wakes workers and joins all workers. Keep the slow-client regression in the release suite.
5. **Scoped repair complete (AUD-17):** strict request-line/header parsing, exact authority checks, checked Content-Length, 16 KiB header and 1 MiB body limits, and incomplete-request deadlines are enforced before routing. Keep the framing negatives in the release suite.

Exit: two launches reuse one database; competing processes and stale leases are deterministic; slow-client shutdown has no lifetime race; alternate-port mutations are rejected. The worker/framing sub-gates are green on the current dirty snapshot; persistence lease lifecycle remains open.

### Phase 4: real provider execution

1. Define a provider adapter interface for request encoding, authentication, endpoint selection, status mapping, SSE decoding and usage extraction.
2. Serialize all admitted history and current user content. Preserve image blocks for multimodal adapters and show an explicit text fallback otherwise.
3. Add one incremental SSE decoder accepting LF and CRLF, comments, multi-line data fields, partial chunks, terminal DONE and provider errors.
4. Model run state as admitted, connecting, headers, streaming, completed, interrupted, failed and persisted. EOF before DONE is never completed.
5. Keep UI timeout active through body consumption and preserve caller abort.
6. Add HTTPS and provider-specific paths only with explicit certificate and secret handling. Receipts remain secret-free.
7. Reconcile reservation, usage, billing estimate and outcome idempotently.

Exit: fixtures cover success, LF, CRLF, partial frames, reset, timeout, cancellation, usage and persistence failure. Real provider qualification remains a separate runtime gate.

### Phase 5: router and control plane

1. **Scoped repair complete (AUD-09):** `/api/router/decide` accepts an explicit
   simulation flag; previews return `SIMULATED_DETERMINISTIC` with no quota,
   concurrency, circuit, idempotency or durable-receipt mutation. Keep the
   repeated HTTP regression in the release suite. Reject simulation combined
   with circuit mutation and reject disjoint constrained fallback allowlists.
2. Keep execution decisions separate and return reservation token, expiry, owner, epoch and estimated usage.
3. Add complete, fail, cancel and expire operations.
4. Bound idempotency cache, receipts and reservations by age and count; expose a cursor for recent receipts.
5. Persist active runs, cancellation and goal/plan/task state behind one control plane module.
6. Enforce reservation deadlines at admission/dispatch/reconciliation and use checked token/cost arithmetic (AUD-14).
7. Accept outcomes only for the correct in-flight attempt and intersect fallback policies with the original admission boundary (AUD-15/16).

Exit: repeated simulation has no resource drift and every execution has one terminal outcome, including crash recovery.

### Phase 6: attachments, memory and graph

1. Define a content-addressed blob interface with size cap, MIME sniffing, ownership, retention, deletion receipt and optional encryption adapter.
2. Converge browser and native attachment models on one manifest.
3. Add bounded conversion workers with pending, complete, failed, unsupported and cancelled states.
4. Persist memory namespaces and links, bound entries/edges/erasure receipts, add compaction and retrieval metrics, and expose source provenance and freshness. Preserve MemoryGraph's existing mutex; AUD-19 does not establish a MemoryGraph race.
5. Replace the manually seeded Graphify map with a deterministic source indexer and idempotent edge identity. Define PeerMesh/Graphify synchronization and returned-pointer lifetime explicitly; keep ambiguous edges quarantined and show index revision in the UI.
6. Add process peer transport only after ownership and lease semantics exist.

Exit: attachment send, memory restart, RAG retrieval and graph re-index each have a durable round-trip test and bounded resource policy.

### Phase 7: native shell and delivery quality

1. Run all seven native PowerShell workflows in a compatible PowerShell 7 environment with external fixtures.
2. Verify UIA patterns, background modal invocation, focus recovery, DPI, resizing, Vietnamese IME, Narrator and screen-reader announcements.
3. Add packaged startup, idle CPU, memory, crash recovery and migration tests.
4. Reconcile current UI additions and deletions with the source disposition ledger.
5. Repeat independent read-only audits on a frozen repaired snapshot.
6. Make browser erase report actual removal/remaining failures, and guard asynchronous dialogs against repeat keyboard activation (AUD-21/23). Keep capability modeling (AUD-25) distinct from confirmed defects; explicit run cancellation (AUD-24) belongs with the provider/control-plane implementation.

Exit: every PRODUCT leaf has a scoped runtime receipt and no release claim depends on an unavailable environment. The current Edge headless failure (exit 2147483651, zero DOM bytes) does not establish a UI result. Re-run browser/CDP and the seven PowerShell workflows when compatible runtimes are available.

## UI status and design review

### Platform layer

The UI has good deep-module seams. dom.js owns escaping and delegated events; router.js owns hash routing and view lifecycle; sessions.js owns server metadata and active selection; api.js owns transport, connection state and polling; overlay.js owns dialogs, focus and announcements; i18n.js owns language and formatting. This gives views a small interface and keeps policy local.

Open platform risks:

- api.request() clears its timeout after response headers, before body parsing.
- Each view manages asynchronous safety separately; there is no shared stale-result cancellation contract.
- Health and session loading start independently, so initial connecting, empty and offline states can temporarily disagree.
- A render crash uses hard-coded bilingual text rather than the string registry.
- Polling is not deduplicated across sidebar, view and inspector consumers.

### Chat view

Strengths: local transcript schema, explicit no-fake-reply banner, Markdown and LaTeX preview, formula palette, attachment placement dialog, autosave, route receipt rendering, steer inspector and retry states.

Boundary: this is a routing demonstrator, not a chat runtime. Send persists a browser message and calls router decide; it does not send prompt bytes, attachments or history to a provider. The wording is honest, but PRODUCT-CHAT is incomplete.

Completion design: keep local-first UX and add a run state machine: draft, admitted, connecting, streaming, completed, failed, cancelled. Render provider events incrementally, replay durable events after refresh, and make retry create a new attempt instead of mutating the old receipt.

### Agents and Graphify

The view has the right dual representation: canvas plus keyboard list, selected node inspector, send form, newest-first message log, Graphify traversal and ambiguous-edge quarantine. ResizeObserver and bounded pulse animation are good choices.

Main gap: Studio manually seeds graph entities and messages. The UI can look live while showing sample state. Add index revision, source freshness and provenance labels, then replace the seed data with a deterministic index.

### Routing

The view exposes candidate scores, quotas, circuits, receipts, trip/reset and a reservation warning. This is useful diagnostic UI.

Simulation is now side-effect free and the UI states that preview explicitly. The remaining gap is the execution lifecycle: complete/fail/cancel/expire endpoints, bounded reservations and persisted run ownership.

### Knowledge

Memory has namespace validation, tier display, erasure receipts, filters and editing. Skills has debounced search and empty/error states. RAG has language, uncertainty, retrieval decision, cited and unused sources.

Main gaps: state is mostly in memory, source freshness is not a first-class visual field, and retrieval quality lacks latency, hit count and relevance metrics. Add persisted corpus state and an evidence inspector rather than more card text.

### Settings

Settings covers theme, density, reduced motion, language, shortcuts, diagnostics and browser-local data export/erase.

Main gaps: diagnostics mix host health with product readiness, and the screen cannot explain which runtime capabilities are unavailable. Add a capability matrix with source, last checked time, confidence and remediation.

## UI acceptance matrix

| View | Implemented surface | Required next proof |
|---|---|---|
| Chat | Local messages, composer, preview, attachments, route receipt | Browser keyboard/IME run; offline recovery; real streaming after backend |
| Agents | Mesh canvas/list, Graphify traversal, send form | Browser graph interactions; live index freshness; canvas resize/DPR |
| Routing | Provider table, score bars, simulation, receipts | Repeated simulation without resource drift; keyboard table; bounded receipts |
| Knowledge | Memory, skills and RAG panels | Persistence/reopen; retrieval metrics; erase/recovery behavior |
| Settings | Theme, density, language, diagnostics, local-data controls | Capability matrix; screen-reader and focus audit; export/erase round trip |

## Definition of done for this roadmap

Do not mark the work complete because build and unit tests pass. Each phase needs implementation, behavior, boundary/security checks, and a receipt bound to the same frozen source snapshot. An owner and next action preserve an unresolved item; they do not satisfy its gate. Whole-goal completion still requires all 16 DoD gates, the PRODUCT leaves, and three consecutive independent zero-finding audits on the repaired frozen snapshot under DOD.md.
