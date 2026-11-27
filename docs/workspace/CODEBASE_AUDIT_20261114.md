<!-- Reconciled from collaborator PR #1 (origin/pr-1 @ 04899e6, thtt0120:master) under Steer #21 (2026-11-28) -->

> [!NOTE]
> **Steer #21 Full Native Rust Reconciliation (`2026-11-28`, branch `omnia-sota-harness`)**:
> This audit ledger was authored against the historical Wave 4 C++20 snapshot (preserved externally in `D:\OmniaData\backups\pre-full-rust-20261115\`). Under **Steer #14..#21**, Omnia runs as a **17-crate Full Native Rust** workspace (`0` `.cpp`/`.hpp`/`CMake*` in active tree) with Flagship `ui-v5/` (`embed-ui`) and HTMusTC's semantically merged modular fallback `ui/` (`11` `node --test` suites). Every applicable `AUD-01..AUD-32` security, JSON, SQLite/WAL, pagination, routing (`AUD-09`/`AUD-14`), graph (`AUD-26..28`), HTTP (`AUD-07`/`AUD-29`), UI (`AUD-06`/`20..23`/`32`), and history-sync (`AUD-30`/`AUD-31`, `7/7` tests PASS) finding is tracked and ported into the active Rust/UI/tools surfaces without reintroducing retired `cpp/**` files or junk paths (`Microsoft/Windows/PowerShell/ModuleAnalysisCache`, `nul*`). See [`../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md`](../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md) and [`STEER_QUEUE.md`](STEER_QUEUE.md).

# Omnia codebase audit — 2026-11-14

## Scope and evidence boundary

This is a bounded audit of snapshot d5536ec plus the pre-existing UI rebuild changes in the working tree. It covers cpp/, native/, ui/, tools/, workspace contracts, and isolated runtime probes. It does not claim that every historical file, ignored artifact, provider integration, browser state, or Windows accessibility matrix was semantically reviewed.

The initial audit changed no product source. The repair continuation below now verifies working-tree changes in C++ core/graph/HTTP, history sync and UI. Existing UI rebuild changes remain preserved. Builds, probes and repair receipts use external system-temp directories. One earlier ignored `router-probe.obj` remains in the checkout; it is a hygiene exception, not an external-output pass. The temporary Studio process used for the original HTTP probes was stopped and its port was verified closed.

The earlier documentation continuation rechecked all 135 source hashes against its probe baseline with zero mismatches. That equality predates the repairs and does not describe the current tree. AUD-01..32 include source risks and product/design gaps, and AUD-06/AUD-22 share a root cause. They are not a count of 32 independent, reproduced bugs. Finding descriptions and source line numbers below retain the original audit baseline; the repair table owns current dispositions.

## Repair verification — 2026-11-15

## Repair verification refresh — 2026-11-21

The simulation/lifecycle repair was rechecked on the current dirty snapshot.
`DynamicProviderRouter` now keeps simulation out of quota, concurrency, circuit
probe, idempotency and durable decision receipt state; its receipt is marked
`simulated`, has sequence `0`, no reservation ID and zero reserved tokens.
Fallback admission carries the parent deadline and dispatch rejects an expired
continuation. The Studio HTTP response exposes
`SIMULATED_DETERMINISTIC` and the UI renders that state as successful without a
misleading “reserved 0” message.
Simulation requests cannot mutate circuit controls, and fallback allowlists
reject disjoint constrained intersections instead of treating an empty result
as unrestricted.

Fresh evidence from the external build directory
`%TEMP%/omnia-audit-current-56cc8c93cf594fe69976a982882e1da1`:

- Release incremental MSVC/Ninja build completed after the router, server and
  test changes.
- Unified CTest: **35/35 passed**; the updated routing and Studio HTTP tests
  include fallback deadline fencing and three repeated simulation requests with
  unchanged candidates and recent receipts.
- UI syntax: **48/48** `node --check` files passed; UI unit tests: **118/118**.
- History sync: **7/7** Python tests passed.
- `git diff --check` passed and tracked files report `0` CRLF lines.

This is scoped regression evidence on an uncommitted working tree. It does not
close provider execution, persistence/lease history, retention, cancellation,
browser/CDP, PowerShell 7, native QA, or the required independent clean-audit
streak.

HEAD remains `d5536ecd1381e45f16146406d70f13584fdf0d4f`; repairs are uncommitted. `REPAIRED_SCOPED` means the named regression passes on this working tree, without claiming browser/native accessibility qualification, independent audit closure or whole-product completion.

| Findings | Current disposition and implementation | Regression evidence |
|---|---|---|
| AUD-26/27 | REPAIRED_SCOPED: normalize logical workspace-relative ownership paths; reject unsupported aliases/escape; reuse overlap validation before reactivation | `cpp/tests/test_graph.cpp`: alias rejection, carve-outs, valid siblings, failed activation retains inactive state |
| AUD-28 | REPAIRED_SCOPED: require original recipient/expected responder and current sender epoch; old replies cannot replace a newer conversation tracker | `cpp/tests/test_graph.cpp`: nonrecipient rejection without append/tracker mutation, intended/broadcast replies, stale-epoch rejection |
| AUD-29 | REPAIRED_SCOPED: finite/integral/range-checked `try_int64()`; `estimatedTokens` must be 64..1,000,000 before route/circuit mutation | `cpp/tests/test_core.cpp`, `cpp/tests/test_studio_http.cpp`: integer boundaries and malformed budgets rejected without state changes; AUD-14 remains open |
| AUD-30/31 | REPAIRED_SCOPED: exclusion check at FTS extraction/mutation; digest-based transactional refresh with failure receipts | `tools/agy-history-sync/test_agy_history_sync.py`: explicit/descendant/RUNNING/WAL exclusions, two-to-four-step growth in both directions, idempotence, extraction and insertion failure preservation |
| AUD-20/32 | REPAIRED_SCOPED: bounded session pages plus detail lookup; UI load versions, abort and revision merge preserve newer creates and older selections | HTTP fixture enumerates 56 IDs exactly once across timestamp ties and rejects invalid cursor/limit/ID; six `ui/tests/sessions.test.js` cases cover deferred-response races and detail recovery |
| AUD-06/22 | REPAIRED_SCOPED: deadline and caller abort remain attached through body consumption; body failures become `ApiError` | `ui/tests/transport.test.js`: real loopback HTTP slow body, caller abort, truncated body, HTTP/JSON error classification |
| AUD-21 | REPAIRED_SCOPED: erase reports verified removal/remaining counts and unreadable storage separately | Four `ui/tests/local-data.test.js` cases: success, throwing/no-op removal, unreadable storage |
| AUD-23 | REPAIRED_SCOPED: pending/closed guards, native disabled state, prior-state restoration, no late focus callback on a closed dialog | Four `ui/tests/overlay.test.js` cases invoke real `openDialog` handlers through a minimal DOM adapter. Original overlay fails 3/4; repaired overlay passes 4/4. This is not a browser keyboard/IME pass. |
| AUD-07 | REPAIRED_SCOPED: detached request threads replaced by an owned bounded worker queue; shutdown closes the listener and active client sockets, wakes workers, and joins every worker before returning | `cpp/tests/test_studio_http.cpp`: slow partial request is closed during `StudioServer::stop()`, stop completes under 2 seconds; unified Release CTest 35/35 pass |
| AUD-17 | REPAIRED_SCOPED: strict request-line/header parser, exact Host/Origin presence policy, checked `from_chars` Content-Length, 16 KiB headers, 1 MiB body, timeout and incomplete-body rejection before routing | `cpp/tests/test_studio_http.cpp::verify_http_framing`; authority/framing receipts in `%TEMP%/omnia-server-repair-20261115-w6yua3fq/`; unified Release CTest 35/35 pass |

Fresh checks: unified incremental Release build (`ninja: no work to do`) and CTest **35/35**, UI syntax **48/48**, UI tests **118/118**, history sync **7/7**. Six pre-existing UI files were normalized from CRLF to LF; before-bytes and byte-only conversion hashes are retained. No Git index/commit/remote mutation was performed.

Current evidence owner: `%TEMP%/omnia-repair-dialog-20261115-3gstssqi/`. `before.json` records 222 pre-edit files; `dialog-original-red.json`, `dialog-red.json`, `dialog-green.json`, `ui-final.json`, `ui-syntax.json`, `history-current.json`, the retained CTest log and `verification.json` bind commands, exits, hashes and limitations. Earlier red/green core/history/session/transport receipts remain in `%TEMP%/omnia-repair-20261115-j7u9/` and `%TEMP%/omnia-repair-resume-20261115-fxq6bgmq/`. The earlier file named `sessions-green.json` actually records exit 1 (a timestamp-tie ordering assertion); the current six-case suite supersedes it. File names are not pass evidence.

Still open: AUD-01..05, AUD-08..16, AUD-18/19 and AUD-24/25, with their original evidence levels and overlaps. AUD-02 and AUD-07/17 are now scoped repairs; lease lifecycle (AUD-08) remains open. Next repair seam: unique Studio lease identity/heartbeat/release, followed by native provider/SSE/history/secret delivery. Router authorization/lifecycle and retention gaps remain release blockers. Logical path normalization is not filesystem/reparse authorization; graph synchronization remains AUD-19.

## Original audit verification run (before repairs)

| Check | Result | Evidence / limitation |
|---|---:|---|
| Unified Release MSVC/CMake/Ninja build | PASS | External system-temp build; 46 build steps |
| Unified CTest | PASS | 35/35; Testing/Temporary/LastTest.log |
| UI JavaScript syntax | PASS | 48/48 node --check files |
| UI unit tests | PASS | 99/99 node --test ui/tests/*.test.js |
| History-sync Python tests | PASS | 5/5 |
| Exporter tests | UNVERIFIED | 10 failures were sandbox/fixture EPERM errors; not promoted to product defects |
| Native PowerShell QA workflows | UNVERIFIED | pwsh unavailable; Windows PowerShell 5 lacks required workflow APIs |
| Browser/Edge QA | UNVERIFIED | CDP walkthrough unavailable; final Edge headless probe exited 2147483651 with zero DOM bytes |
| Skill structural validation | PASS, scoped | 13/13 in `skill-doctor.json`; this is not runtime skill invocation |
| Secret scan | PASS, scoped | Five area receipts cover 180 files with zero pattern findings; not a whole-machine/private-history scan |
| EOL / workspace hygiene | OPEN | Six untracked UI files have CRLF; generated artifacts remain in the checkout |

The retained skill, secret, UI preservation, history-test and diff receipts are under `%TEMP%/omnia-audit-20261115-kl34dggm/`. The five secret-scan denominators are cpp 35, native 30, tools 5, docs 44 and ui 66 (180 total); this corrects the earlier unsupported 217-file scan total. `git diff --check` passed. A UI preservation scan reported CRLF in six newly added UI files (`ui/app/lib/markdown.js`, `ui/app/views/chat/controller.js`, `ui/app/views/chat/inspector.js`, `ui/app/views/chat/local-store.js`, `ui/app/views/chat/strings.js`, `ui/app/views/chat/thread.js`). Normalize those files before delivery; this is a working-tree hygiene issue, not a runtime defect.

The documentation continuation re-ran the five secret scans (180 files, zero findings), skill doctor (13/13), diff/cached-diff checks, and preservation checks for all three edited documents (valid UTF-8, pure LF, no control characters or broken local links). Receipts are under `%TEMP%/omnia-audit-docs-20261115-qjbf4ffp/`. Build, CTest and UI/history suites above are retained prior results; they were not re-run for a documentation-only change. Existing product and artifact hashes were preserved.

## Confirmed defects

### AUD-01 — Persistent Studio database cannot be reopened (P0/P1)

StudioServer::seed_flagship_state unconditionally inserts the same three session IDs at cpp/src/studio/studio_server.cpp:399-426. SessionStore::create_session uses a plain insert at cpp/src/storage/session_store.cpp:342-353. A first start with a scratch SQLite database succeeds; a second start against that same file exits with code 1 and Failed inserting session row.

Impact: a configured persistent Studio database is not restart-safe.

Fix: make demo/bootstrap data an explicit first-run migration, or use idempotent inserts guarded by a schema/bootstrap marker. Do not seed synthetic sessions in the production constructor. Add a two-launch regression that verifies rows reopen without duplicates.

### AUD-02 — Loopback Origin/Host checks accept unrelated local ports (P1)

The allowlists at cpp/src/studio/studio_server.cpp:319-363 accept any numeric port after 127.0.0.1, localhost, or [::1]. Live disposable probes returned Host evil.example → 403, Host 127.0.0.1.evil:18787 → 403, Host 127.0.0.1:9999 → 200, and Origin http://127.0.0.1:9999 → 200.

Impact: another local web origin can issue mutation requests to the Studio API. Loopback address validation is not same-origin validation.

Fix: derive one canonical configured origin from the bound listener and compare scheme, host, and port exactly. Treat a missing Origin as a separate local client policy; do not use prefix-plus-digits checks. Add tests for default port, random bound port, alternate local port, IPv6, and malformed authorities.

### AUD-03 — Native HTTP execution reports truncated/empty streams as completed (P1)

native/src/store.cpp:1667-1672 initializes final_status to completed. When recv returns zero or an error, the loop simply breaks at native/src/store.cpp:1691-1694; no valid headers, successful HTTP status, terminal SSE marker, or complete body is required. An external C++ probe linked against the fresh native library produced empty_eof → status completed and truncated → status completed.

Impact: provider disconnects and partial responses can be persisted or shown as successful runs.

Fix: track header, HTTP status, framing, and terminal DONE independently. Return failed for EOF/error before a valid terminal marker, preserve partial assistant text as an interrupted/failed turn, and bound body/frame sizes. Add fixtures for empty close, reset, timeout, partial JSON, HTTP 4xx/5xx, and missing DONE.

### AUD-04 — Native SSE parser does not handle valid CRLF frames (P1)

The parser searches only for the LF blank-line delimiter at native/src/store.cpp:1712-1716. The same external probe returned no delta for a CRLF stream while the LF stream returned answer.

Fix: use a line/frame scanner accepting CRLF and LF, preserve partial frames between recv calls, support multi-line data fields, and require a valid terminal event before success.

### AUD-05 — Native provider request drops conversation history and attachments (P1)

Although execute_prepared_http_run receives history and user_content, the outbound JSON is built from one message containing only prompt_text at native/src/store.cpp:1636-1645. The probe passed prior turns and an image; the captured body contained only a single user message with new prompt, model empty, and stream true.

Impact: multi-turn context is lost and multimodal attachments never reach the provider even when the composer reports them as sendable.

Fix: serialize admitted history in provider-specific format, append current user content, preserve image/media blocks for multimodal adapters, and define explicit text fallback behavior for non-multimodal providers. Add request-capture tests for prior turns, text plus image, and adapter differences.

### AUD-06 — UI request timeout stops at response headers (P1)

ui/app/api.js:106-118 clears the abort timer as soon as fetch returns. response.text is awaited afterward at lines 120-128. A controlled local server sent headers immediately and delayed the body by 300 ms; an 80 ms request completed successfully after about 318 ms.

Fix: keep the deadline active through body consumption, or wrap fetch plus body read in one deadline. Preserve caller abort semantics and add a slow-body regression test.

## High-confidence lifecycle and design risks

### AUD-07 — Detached Studio workers capture this past shutdown (P1, source finding)

cpp/src/studio/studio_server.cpp:968-971 detaches a worker capturing the server object. StudioServer::stop joins only accept_thread at lines 938-949. A request still inside handle_client can access a destroyed server during teardown.

Fix: use an owned worker collection or bounded executor, close active sockets on stop, join all workers, and add a slow-client shutdown race test.

### AUD-08 — Studio lease is not an effective process fence (P1, source finding)

seed_flagship_state ignores acquire_lease and always uses owner string omnia-studio-host at studio_server.cpp:399-405. No production heartbeat or release call is wired. SessionStore compares the owner string when deciding whether an existing lease is the same owner at session_store.cpp:220-239, so another process using the same constant can be treated as the current owner. This is separate from native HarnessStore kernel LockFileEx ownership.

Fix: use a per-process owner nonce plus PID/start-time identity, surface acquisition failure, heartbeat periodically, release on clean shutdown, and fence mutations by lease epoch.

### AUD-09 — Router simulation consumes reservations with no completion/release (P1)

The Studio router decide route calls router_.decide_and_reserve at cpp/src/studio/studio_server.cpp:1386. The UI contract documents that no release endpoint exists. Repeated simulations therefore consume quota and concurrency until valid work is rejected.

Fix: make simulation side-effect-free, or issue an expiring reservation token with complete/fail/cancel/release endpoints. Add a repeated-simulation test.

### AUD-10 — Studio telemetry and Graphify data are unconditional demo state (P2)

seed_flagship_state populates agents, messages, provider quota/latency, memory, steer items, a synthetic routing outcome, and a manually authored Graphify map at studio_server.cpp:399-610. The UI removed fallback fixtures, but the backend still reports synthetic state as live state.

Fix: separate demo mode from production state, expose provenance and freshness for telemetry, and build Graphify from the current source index or label the map explicitly as a sample.

### AUD-11 — Retention is unbounded on message/decision/event surfaces (P2, source finding)

Graph GET/send serializes all retained messages. Router decisions/outcomes and idempotency entries have no visible bounded retention policy. Event and memory surfaces also need an explicit size/age policy.

Fix: paginate messages, cap payload sizes, add age/count limits and compaction, and test behavior at configured limits.

## Continuation findings (2026-11-14)

### AUD-12 — Native provider URL validation is not loopback-safe and HTTPS is a dead configuration (P1)

`parse_loopback_http_url` at `native/src/store.cpp:1555-1572` checks only the `http://` prefix, a colon, and an IPv4-shaped port. It does not require the parsed host to be loopback. `build_provider` accepts both `http://` and `https://` at `native/src/store.cpp:1345-1364`, while execution calls the HTTP-only parser and rejects HTTPS at `native/src/store.cpp:1607-1609`. A configured provider can therefore pass admission but either connect to a non-loopback IPv4 address or fail only when the run starts.

Impact: a provider profile can reach a LAN or metadata endpoint if the caller is allowed to configure it, and HTTPS configuration gives a misleading healthy-looking profile that cannot execute.

Fix: parse an authority with a strict URL routine, require an explicit loopback address (or an explicitly approved local-network grant with a separate policy), reject credentials and unsupported URL forms, and make transport capability match admission. Add negative tests for private/LAN, public, malformed, IPv6, HTTPS and alternate-port URLs.

### AUD-13 — Provider adapter and authentication metadata never reach the wire (P1)

`SecretBroker::with_secret` returns the literal `synthetic-resolved-secret` and `put` returns a reference without persisting the supplied secret (`native/src/store.cpp:1285-1304`). `provider_selection` distinguishes OpenAI Chat, OpenAI Responses and Anthropic families, but `execute_prepared_http_run` always sends `POST /v1/chat/completions` with no provider-specific path or authentication headers (`native/src/store.cpp:1580-1652`).

Impact: real provider calls cannot authenticate or use the selected adapter; a successful local fixture can conceal that production delivery is disconnected.

Fix: define an adapter interface for URL/path, headers, request body, SSE/event decoding and status mapping. Connect it to a real secret store boundary; never serialize the secret into receipts or logs. Add request-capture tests for bearer, API-key, OpenAI Responses and Anthropic Messages.

### AUD-14 — Router stores deadlines but does not enforce them; token and cost arithmetic can wrap (P1)

`RouteRequestPolicy::estimated_total_tokens()` adds two `uint64_t` values without overflow detection (`cpp/include/omnia/routing/dynamic_router.hpp:239-243`), and `RouteCandidate::estimate_cost_microunits()` multiplies token counts by rates without checked arithmetic (`cpp/src/routing/dynamic_router.cpp:120-143`). `decide_internal()` records `deadline_ms` in the receipt but has no admission or dispatch-time deadline check (`cpp/src/routing/dynamic_router.cpp:352-668`). An external router probe against the current library admitted a request whose deadline was already expired and admitted `UINT64_MAX + 1` as a one-token reservation.

Impact: expired work can consume quota, and overflow can under-reserve tokens or understate cost.

Fix: reject non-positive or expired deadlines at admission and fence dispatch/reconciliation against the reservation deadline. Use checked add/multiply helpers with explicit `overflow` rejection and bounded policy inputs. Add boundary tests at `UINT64_MAX`, rate overflow, zero/negative deadlines and clock skew.

### AUD-15 — Outcome reconciliation is accepted before dispatch and with an empty attempt ID (P1)

`reconcile_outcome()` only rejects terminal reservations or a non-empty mismatched active attempt (`cpp/src/routing/dynamic_router.cpp:715-770`). A `ReservedNotDispatched` grant has no active attempt and can be charged by an arbitrary outcome; an `InFlight` grant accepts an empty `attempt_id`. A current-library probe produced `reconciled_charged` with `fenced_late_outcome=false` for an outcome submitted before `mark_dispatched`.

Impact: late, forged or mis-correlated provider results can charge a reservation that was never dispatched, weakening exactly-once and cancellation fencing.

Fix: require `InFlight` status, a non-empty attempt ID, and exact attempt equality. Treat all other states as fenced or operator-recovery outcomes. Persist an attempt nonce at dispatch and include the reservation epoch in the reconciliation key.

### AUD-16 — Fallback admission can change the original authorization boundary (P1)

`decide_fallback()` takes a fresh `RouteRequestPolicy` from its caller and carries forward only the prior privacy tier when the new policy is weaker (`cpp/src/routing/dynamic_router.cpp:297-344`). It does not preserve the original auth boundary, region allowlist, capability requirements, retention limit or model/provider restrictions. A caller that supplies a weaker fallback policy can therefore select a route outside the original admission boundary.

Fix: persist the full normalized admission policy on the reservation, intersect fallback policy with it, and reject any attempt to widen authorization, region, capability, retention or provider/model scope. Record every fallback narrowing in the receipt.

### AUD-17 — Studio HTTP framing accepts missing Host and malformed or oversized Content-Length (P2)

`is_allowed_loopback_host()` returns true for an empty host (`cpp/src/studio/studio_server.cpp:348-351`). The request reader parses `Content-Length` with `std::strtoull` without checking conversion errors, overflow, duplicate headers or a body-size limit (`cpp/src/studio/studio_server.cpp:1001-1041`). The one-megabyte receive loop can therefore treat malformed framing as a zero-length request or reserve a size beyond the configured safety bound.

Fix: require exactly one syntactically valid Host authority, parse `Content-Length` with checked `from_chars`, reject duplicates/overflow/negative values, enforce separate header/body limits and return `400`/`413` before routing.

### AUD-18 — Partial assistant output is discarded on interruption or provider failure (P1)

`execute_prepared_http_run()` appends streamed text to `assistant_accum` but persists it only when `final_status == "completed"` (`native/src/store.cpp:1748-1755`). Timeout, disconnect, cancellation, HTTP error and malformed stream paths therefore retain the user turn but lose the partial assistant text already shown to the caller.

Fix: persist an assistant turn with an explicit interrupted/failed state whenever any text was emitted, or persist append-only stream chunks and finalize them into a terminal message. Add cancellation, reset, timeout, HTTP 4xx/5xx and missing-DONE fixtures.

### AUD-19 — Unbounded graph/memory retention and duplicate Graphify edges; graph synchronization contract missing (P2, source finding)

`PeerMeshGraph` retains messages and conversation/cursor state in process memory; `GraphifyIndex::add_edge()` appends edges without deterministic deduplication (`cpp/src/graph/graphify_index.cpp:23-53`). Neither class declares an internal mutex or an explicit caller synchronization contract. Concurrent use is a source-level risk, not a reproduced race in this audit; the host's own serialization must be considered separately.

`MemoryGraph` does have `mutable std::mutex mutex_` (`cpp/include/omnia/harness/memory_graph.hpp:91`) and locks its public state operations (`cpp/src/harness/memory_graph.cpp:150,189,239-272`). Its open issue here is unbounded entry/edge/erasure-receipt retention, including `erasures_.push_back()` at line 234. This finding does not establish a MemoryGraph data race.

Fix: add bounded retention and pagination, compaction/expiry and deterministic edge identity. Define locking or immutable snapshots for PeerMesh/Graphify, including the lifetime of returned pointers. Retain MemoryGraph's existing locking and test its resource limits separately. AUD-11 overlaps the retention part of this finding.

## Additional candidate requiring follow-up

native/src/composer.cpp:1344-1363 writes a sibling draft temp file then calls filesystem rename. A probe saved twice on this Windows machine successfully, so the suspected replacement failure is not confirmed. Keep a regression for replacement semantics on the supported filesystem rather than treating it as a current defect.

The history synchronizer intentionally uses monotonic step counts at tools/agy-history-sync/agy_history_sync.py:920-1022. Equal-length divergent trajectories are not reconciled; this is a data-integrity risk only if the contract requires content-level merge. Add content hashes or an explicit conflict receipt before changing behavior.

## UI continuation findings (2026-11-15)

### AUD-20 — Session list requests can overwrite a newer create result (P1/P2)

`loadSessions()` in `ui/app/core/sessions.js` has no request sequence or abort fence. A stale `GET /api/sessions` response can complete after `createSession()` and call `applyListPayload()`, replacing the newly created session and active selection with the older list. A module-level probe with a deferred list response reproduced `create -> [new, old]` followed by the stale response changing state to `[old]` and active `old`.

Impact: the user can create a session successfully and then lose it from the sidebar until the next refresh; the active route and local chat key can point at metadata that the sidebar no longer displays.

Fix: give session loads a monotonically increasing request ID and an `AbortController`; ignore stale responses and abort the previous list request when create/reload starts. Merge a successful create into the newest list by revision rather than accepting an older whole-list snapshot. Add a deferred-response regression covering load/create/reload ordering.

### AUD-21 — Local-data erase reports success when browser storage deletion fails (P2)

`storage.remove()` in `ui/app/core/store.js` catches every exception and returns no result. `clearChatRecords()` counts keys before deletion and returns that count, so Settings reports `cleared N` even when `removeItem` throws or the key remains. A module probe forced `removeItem` to throw and observed `claimedRemoved: 1` with `stillPresent: true`.

Impact: a user receives a false privacy/data-management confirmation and cannot distinguish successful erasure from blocked or quota-restricted storage.

Fix: make removal return `{removed, failed}` or a boolean per key, re-read the prefix after deletion, and show a partial-failure alert with the remaining count. Keep export/erase receipts honest when storage is unavailable. Add a blocked-storage test.

### AUD-22 — Caller abort is detached after response headers (P1)

`api.request()` removes the caller's abort listener and clears its timeout immediately after `fetch()` resolves, before `response.text()` completes. A probe returned a delayed body successfully after the caller signal had been aborted (`signalAborted: true`, elapsed 184 ms against a 70 ms abort). This is the same framing boundary as AUD-06, but it also breaks explicit cancellation from views.

Impact: navigation, unmount and user cancellation cannot stop a slow body read; stale work continues and may update shared stores or consume a reservation after the UI has moved on.

Fix: keep one deadline/abort scope around fetch plus body consumption, remove the listener only in a final cleanup block, and classify caller abort separately from timeout/network. Add slow-header, slow-body, caller-abort and unmount tests.

### AUD-23 — Async dialog actions are only aria-disabled, so keyboard activation can race (P2)

The original `openDialog()` set `aria-disabled="true"` while awaiting `onAction`, but did not set the native `disabled` property and the click handler only checked `button.disabled`. CSS blocked pointer clicks, yet a focused button or Enter in a single-line dialog input could activate the action again while the first action was pending. The new-session dialog uses this async path and could issue duplicate create requests. The repair continuation reproduced duplicate handler activation with a DOM adapter; actual browser keyboard reproduction remains open. The simple erase confirmation has no async `onAction`, so this finding does not establish duplicate erase operations.

Fix: set `button.disabled = true` for the duration of the action, guard the handler with an in-flight flag, and restore focus only after the final close. Add an async-action double-Enter regression.

### AUD-24 — Chat decision cancellation is a product gap (OPEN, not a reproduced defect)

`runDecide()` in `ui/app/views/chat/controller.js` calls `api.router.decide()` without a caller signal. The source explicitly intends requests to outlive view unmount and persist their result. Navigation alone is therefore not a cancellation defect. A real provider chat runtime will still need explicit cancellation, an interrupted state, and reservation reconciliation; the current routing demonstrator has no such end-to-end capability. Page teardown is not proven to allow the request to complete.

Upgrade: create one run controller per message and an explicit cancel command, persist run state independently of view lifetime, and reconcile or release reservations after acknowledged cancellation. Preserve navigation continuity. This depends on the backend lifecycle fixes in AUD-09, AUD-14 and AUD-15.

### AUD-25 — UI health and capability state are not separated (design gap)

The health monitor marks the connection `online` for non-network `ApiError`, including HTTP errors from `/api/health`. This is valid as transport reachability, but is insufficient to establish service health. Diagnostics expose engine facts and lack separate service/capability states for provider streaming, durable chat, browser/IDE and native accessibility. Treat this as a proposed model improvement, not a proved failure of the current reachability contract.

Fix: model transport reachability, service health and product capability as separate states. Render the timestamp, source, confidence and remediation for every unavailable capability. Add HTTP 5xx/invalid-health and server-restart recovery tests.

These UI findings are source/runtime-probe evidence for the current working tree, not claims that the UI is production-ready. Browser walkthrough, IME, screen-reader and viewport matrices remain OPEN because the CDP page session still fails at `Runtime.enable` in this environment.

## Core, history and session continuation findings (2026-11-15)

### AUD-26 — PeerMesh ownership accepts aliases of an already owned Windows path (P1)

`normalize_path_pattern()` only changes separators, whitespace, leading `./` and trailing glob syntax (`cpp/src/graph/peer_mesh.cpp:18-48`). `prefix_covers()` compares the remaining strings case-sensitively (lines 51-65), and `register_agent()` relies on this result (lines 197-217). With an active owner of `cpp/**`, the core probe rejected `cpp/src/**` but admitted both `CPP/src/**` and `ui/../cpp/src/**` for another active agent.

Impact: the disjoint-writer guard accepts overlapping ownership on a normal case-insensitive Windows checkout. This demonstrates an in-process ownership invariant failure; it does not demonstrate unauthorized filesystem writes or remote access.

Fix: define one workspace-relative path identity policy, normalize or reject dot segments before overlap checks, apply the target filesystem's case policy, and reject workspace escape/unsupported glob forms. Resolve existing paths and reparse aliases at the filesystem boundary. Test equivalent aliases, exclusions and valid sibling ownership.

Evidence: `core-probe-receipt.json` in the receipt map below; `same_case_overlap_admitted=false`, `case_alias_admitted=true`, `dot_alias_admitted=true`.

### AUD-27 — Reactivating a peer bypasses the disjoint ownership check (P1)

`register_agent()` checks ownership only for active nodes (`cpp/src/graph/peer_mesh.cpp:204-217`), while `set_agent_active()` assigns `active` without checking conflicts (lines 256-265). The core probe registered active A and inactive B with the same `cpp/**` ownership, activated B, and observed both active.

Impact: pausing and resuming an agent can violate single-writer ownership even with identical canonical path strings. Fixing AUD-26 alone leaves this path open.

Fix: share the ownership validator between registration, ownership updates and inactive-to-active transitions. Validate before mutation under the graph's synchronization boundary; on conflict retain the prior inactive state and return the conflicting owner/path. Add activation, failed-activation rollback and release/reactivation tests.

Evidence: `core-probe-receipt.json`, `conflicting_agents_active=true`.

### AUD-28 — A linked nonrecipient can reply to another peer's message (P1)

`PeerMeshGraph::reply()` verifies that `from` and the original sender are active and linked, but never checks `orig.recipients` or `orig.expect_reply_from` (`cpp/src/graph/peer_mesh.cpp:506-554`). In an all-to-all graph, the probe sent A -> B with B expected to reply, then successfully submitted C's reply to the same sequence. That reply also replaces the conversation tracker.

Impact: a graph caller can insert an unrelated peer's response into a directed exchange and change its waiting state. Link membership is insufficient authorization for that response. This is a library contract failure; an unauthenticated public reply endpoint was not established.

Fix: require membership in the original recipient set and, when present, equality with the expected responder. Define broadcast reply semantics explicitly and fence conversation state by message/agent epoch before changing the tracker. Keep valid intended-recipient replies working.

Evidence: `core-probe-receipt.json`, `nonrecipient_reply_accepted=true`. The same probe also accepted a reply to a message predating an original-sender epoch bump; that is a follow-up epoch-contract observation, not a separately counted defect.

### AUD-29 — JSON numeric coercion admits invalid token budgets (P1)

`JsonValue::as_int64()` directly casts a stored double to `int64_t` without checking range or finiteness (`cpp/include/omnia/core/json.hpp:82-89`). The MSVC probe observed `INT64_MIN` for parsed `1e100` and `9223372036854775808`, and 64 for 64.9. Out-of-range floating-to-integer conversion is undefined C++ behavior; the observed value is not portable or a safe fallback.

The Studio route then clamps `prop_int64("estimatedTokens")` to at least 64 before reserving (`cpp/src/studio/studio_server.cpp:1359-1363`). HTTP probes with `1e100`, `-1e100`, `9223372036854775808` and `64.9` each returned 200 and a 64-token reservation.

Impact: malformed budgets become accepted work with an understated or unintended reservation. This is an input-validation defect separate from the arithmetic/deadline defects in AUD-14.

Fix: provide checked numeric conversion and validate type, integral value, sign and application bounds before any route/circuit/reservation mutation. Return a field-specific 4xx error rather than silently truncating or clamping invalid input. Avoid using a rounded `double(INT64_MAX)` as an inclusive upper bound. Test integer limits, adjacent representable doubles, fractions, negative and huge exponents, and unchanged quota/reservation counts after rejection.

Evidence: `core-probe-receipt.json` and `studio-api-probes.json`.

### AUD-30 — CLI FTS backfill reintroduces excluded active conversations (P1)

`plan_and_run_sync()` excludes active IDs from its planned actions (`tools/agy-history-sync/agy_history_sync.py:899-909`), but later unions every CLI `conversations/*.db` into `_upsert_summaries_and_fts()` without subtracting those IDs (lines 1094-1099). The helper itself has no exclusion parameter (lines 748-754). A disposable fixture's conversation was present in `excluded_active` yet gained two CLI FTS rows.

Impact: an apply run reads/indexes an explicitly excluded active conversation, violating the documented exclusion boundary and making its body searchable in the CLI surface. The evidence concerns local `conversation_summaries.db` FTS, not publication or the separate unified index, which receives exclusions explicitly.

Fix: propagate the exclusion set through every backfill/refresh entry point and filter candidates immediately before extraction or mutation. Preserve existing excluded rows unless an explicit policy authorizes their erasure. Add explicit-ID, descendant, RUNNING and recent-WAL fixtures asserting no new rows, body extraction or conversation-file mutation for excluded IDs.

Evidence: `history-probes.json`, `excludedInPlan=true`, `excludedFtsRows=2`.

### AUD-31 — Existing FTS rows stay stale after a trajectory grows (P2)

`_upsert_summaries_and_fts()` indexes only IDs absent from `conversations_fts` (`tools/agy-history-sync/agy_history_sync.py:795-812`). It never invalidates an existing conversation's chunks after a newer trajectory replaces its database. In the fixture, both destination trajectory and summary advanced from two to four steps, but the new term had zero hits and the sync indexed zero conversations; integrity checks still passed.

Impact: newly synced messages cannot be found through the surface's built-in search despite successful metadata and SQLite integrity results. This is distinct from the unconfirmed equal-length divergence candidate above.

Fix: track the indexed trajectory revision/content digest, rebuild changed eligible conversations transactionally, and make replay idempotent. Preserve the old index on rebuild failure and expose failed/pending refresh in the sync receipt. Test growth, new-term search, repeated sync without duplicate chunks, failure rollback and both directions; retain AUD-30's exclusion fence.

Evidence: `history-probes.json`, `trajectorySteps=4`, `summarySteps=4`, `newTermHits=0`, `indexedRows=0`, `integrityFailures=[]`.

### AUD-32 — Studio exposes only the first 50 sessions, with no older-session lookup (P2)

`StudioServer::build_sessions_json()` always calls `list_sessions_page(50)` and discards `next_cursor`/`total_count` (`cpp/src/studio/studio_server.cpp:1971-1999`). The two session routes expose listing and creation, with no session-by-ID route (lines 1656-1685). The storage layer already provides both keyset pagination and `get_session()` (`cpp/include/omnia/storage/session_store.hpp:113-118`).

The live fixture reached 56 sessions; GET returned 50, the old ID was absent, pagination query parameters still returned 50 without a cursor, and direct lookup returned 404.

Impact: older session metadata becomes undiscoverable through Studio's API/sidebar once it leaves the first page. This does not establish deletion of stored rows or browser-local transcripts.

Fix: expose bounded keyset pages with an opaque validated cursor and a session detail route; let the UI merge pages and resolve a route's selected ID independently of the first page. Retain the stale-response protection from AUD-20. Test more than 50 sessions, equal timestamps, stable ordering, invalid cursors, page boundaries and reopening the oldest ID after refresh.

Evidence: `studio-api-probes.json`, `sessionCap` object.

## Receipt map and regression handoff

The new probes belong to `%TEMP%/omnia-audit-final-20261115-8IjY2A/` on the audit host (`C:/Users/trung/AppData/Local/Temp/`). `baseline.json` binds HEAD `d5536ecd1381e45f16146406d70f13584fdf0d4f` and 135 source files; hash equality is identity evidence, not a claim of line-by-line coverage. The original command/output receipts are retained outside Git.

| Receipt | UTC | SHA-256 | Scope |
|---|---|---|---|
| `core-probe-receipt.json` | 2026-11-15T10:59:04Z | `9e992b59cfa41e8e7612d7dea93735e6e79b9d1dab524066937199767c8f6a3e` | AUD-26..29; compile/run exit 0, expected defect observations |
| `history-probes.json` | 2026-11-15T11:25:22Z | `2ea2e4dd9cef575441a332628e187e4abffc4c6cc73618f8435aba57e6f4c5c5` | AUD-30..31; disposable history roots |
| `studio-api-probes.json` | 2026-11-15T11:26:08Z | `40c9cf2acda88b8794b246be550844ec86f06f732735fbead0627e3659182e15` | AUD-29/32; process stopped and port closed |
| `browser-receipt.json` | 2026-11-15T11:36:43Z | `8d8f5b4c41409570c5d0857e8334fbaa38e4a30132bc0fda7c48cc86126ffe0a` | Environment failure: exit 2147483651, zero DOM bytes; no UI pass/fail inference |

The repair continuation promoted these probes into the regression owners below; their acceptance oracles remain useful for subsequent changes:

| Findings | Existing test owner | Required oracle |
|---|---|---|
| AUD-26/27 | `cpp/tests/test_graph.cpp` | Alias conflicts rejected; failed reactivation preserves inactive state; valid disjoint peers still activate |
| AUD-28 | `cpp/tests/test_graph.cpp` | Nonrecipient cannot append or replace tracker state; intended responder succeeds |
| AUD-29 | `cpp/tests/test_core.cpp`, `cpp/tests/test_studio_http.cpp` | Checked conversion; invalid HTTP budgets rejected before side effects |
| AUD-30/31 | `tools/agy-history-sync/test_agy_history_sync.py` | Exclusions hold across FTS; growth becomes searchable; repeat sync is idempotent |
| AUD-32 | `cpp/tests/test_studio_http.cpp`, `ui/tests/` | Fetch all >50 IDs exactly once and reopen an older selection |

No production code or committed tests were edited for this documentation batch. Before-bytes, source comparisons and documentation checks are retained under `%TEMP%/omnia-audit-docs-20261115-qjbf4ffp/`. Existing `Microsoft/Windows/PowerShell/ModuleAnalysisCache` (8,246 bytes), the literal filename ``nul`r`ncl`` (551 bytes), and ignored `router-probe.obj` (279,954 bytes) remain preserved pending ownership/cleanup disposition; none is a new finding about product behavior.

## Upgrade roadmap

The owning implementation sequence and exit tests are in [CODEBASE_ROADMAP_20261114.md](CODEBASE_ROADMAP_20261114.md). Numeric/graph, history/session, UI transport/erase/dialog repairs now have scoped regression evidence. Continue with persistence, origin and worker-lifetime safety, then provider and router blockers. Browser/PowerShell/IME/Narrator qualification and a repaired frozen-snapshot audit remain open.

## Current status

The repository remains buildable; the repair table distinguishes regression-verified repairs from open findings. This dirty snapshot is not ready for a zero-defect or production-provider claim.
