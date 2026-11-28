# Omnia execution plan and wave architecture

**Index role:** Concise navigable execution plan routing to authoritative contracts in [`GOAL.md`](GOAL.md), [`DOD.md`](DOD.md), and [`CHECKPOINT.md`](CHECKPOINT.md). Do not duplicate mutable counters here.

## Orchestration topology

Omnia executes multi-lane engineering work through a **bidirectional 2-way peer-mesh graph** (`A <-> B` duplex links, `sibling <-> sibling`, `author <-> verifier`, `child <-> parent`) rather than a rigid one-way tree:

- **Specification & handoff doc:** [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
- **Full Native Rust implementation (`Steer #14`):** [`../../rust/omnia-graph/src/peer_mesh.rs`](../../rust/omnia-graph/src/peer_mesh.rs) & [`../../rust/omnia-graph/src/graphify_index.rs`](../../rust/omnia-graph/src/graphify_index.rs) (`PeerMeshGraph` + `GraphifyIndex`, exposed live via Rust `omnia-studio.exe` `/api/graph/*`; archived Wave 4 C++20 files backed up in `D:\OmniaData\backups\pre-full-rust-20261115\`)
- **Concurrency & safety invariants:**
  1. Strict `disjoint_paths` single-writer ownership per active peer (`D:\OmniaData\coordination\master-bridge-01a1d643\DISJOINT_OWNERSHIP.json`).
  2. Strictly out-of-source Cargo builds (`CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace`) with zero in-tree build outputs (`target/`, `build/`, `*.exe`, `__pycache__/`).
  3. Bounded cyclic feedback loops (`max_hops`, `epoch` fencing, convergence criteria, cursor-based `read_since(seq)` wakeup).
  4. Graph-first code/knowledge traversal (`GraphifyIndex` `Forward` / `Reverse` / `Both` with `EXTRACTED` / `INFERRED` / `AMBIGUOUS` edge provenance) before broad text grep.
  5. Additive steer intake (`ADDITIVE_INTAKE` with `token_budget IS NULL`) governed by [`STEER_QUEUE.md`](STEER_QUEUE.md).

## Multi-wave execution phases

| Wave | Scope | Key deliverables & owning locators | Verification gate |
|---|---|---|---|
| **Wave 1** | Root cleanup, source reconciliation, multi-host history, URL qualification, core subsystem specs | `138/138` focus rows reconciled ([`SOURCES.md`](SOURCES.md)), `12` clutter dirs externalized + `4` worktrees repaired + `+10.125 GiB` initial `D:\` cache cleanup ([`CLEANUP_STATUS_20261112.md`](CLEANUP_STATUS_20261112.md)), `1,767`-file history watermark ([`SESSIONS.md`](SESSIONS.md)), `103`-URL qualification ([`REFS.md`](REFS.md)), 3 UI direction candidates ([`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)) | Independent lane audits under `D:\OmniaData\qa\audits-20261112\` |
| **Wave 2 (`2026-11-12`)** | Queued additive steers (`Steer #1..#7`) & initial native/domain verification | Google Doc `100`-category / `1,001`-skill catalog extraction, curated repo skills incl. `deep-proposal` + Windows drive-absolute Antigravity `skills.json` mount, Antigravity 3-surface sync tool ([`../../tools/agy-history-sync/README.md`](../../tools/agy-history-sync/README.md)), `8` REA URLs + `github/spec-kit`, `#32770` `WH_CBT` modal UIA invoke | `7/7` Win32 QA workflows (`90/90` cases `rc=0`) -> `PASS_ALL_SCOPED_LANES_ZERO_OPEN_DEFECTS` |
| **Wave 3** | Pre-C++20 baseline publication, clean-clone check & `3/3` independent zero-defect audit streak (`Steer #8`) | Navigable workspace indexes, Commits #1–#3 pushed to `https://github.com/khang-macphuc111107/omnia`, `3/3` consecutive zero-finding audits (`c3033728abe6f0a4906a796bf7652c84408356d7`, archived as tag `archive/pre-cpp-rust-snapshot-20261112`) | `errors=0, warnings=0` across rounds 1–3 (`round-{1,2,3}-v2-receipt.json`) |
| **Wave 4 (Historical C++20)** | Historical C++20 snapshot (now backed up under `D:\OmniaData\backups\pre-full-rust-20261115\`), Flagship Studio UI, `13` skills, exhaustive `D:\` + `C:\` deep clean (`+944.29 GiB` physical) (`Steer #9..#12`) | [`../../ui/`](../../ui/) & [`../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](DEEP_CLEAN_AUDIT_D_DRIVE.md) (`+778.15 GiB`), [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](DEEP_CLEAN_AUDIT_C_DRIVE.md) (`+166.14 GiB`) | Historical `35/35` CTests, `90/90` Win32 QA, `45/45` Edge CDP states (`FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json`) |
| **Wave 5 (`Steer #13..#23`, Final Cleanroom)** | **Full Native Rust** 17-crate Cargo workspace (`0` `.cpp`/`.hpp`/`CMake*`) + **Omnia v5 Harness, OMP+Trae Studio, All-51 Models/5-Effort Benchmarks (`FINAL_SCOREBOARD_V5`), Network/Speedtest Observatory, Default-ON Deep Research/Deep Think & 12-Artifact Lifecycle OS (`Steer #18`), Authorized `.gemini`/`ChatGPT` Integration (`Steer #19`), Deep Audit v2 / Cold-Vault (`Steer #20`), Collaborator PR #1 Semantic Merge (`Steer #21`, `3/3` cleanroom at `6a82180`), Full-Freedom YOLO Default (`Steer #22`) & AI Studio Arena / Canvas / NotebookLM++ / Gems (`Steer #23`: `05eafbb`, `2f61380`, `a41c4d6`)**, `22/22` 3-way skill parity, `.gitattributes` LF, `audit.py --strict --strict-scope full` | [`../../Cargo.toml`](../../Cargo.toml), [`../../rust/`](../../rust/) (`17` crates), [`../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md`](../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md), [`CODEBASE_AUDIT_20261114.md`](CODEBASE_AUDIT_20261114.md), [`../../native/`](../../native/), [`../../platform/`](../../platform/), [`../../tools/`](../../tools/) | `a41c4d6` (`3/3` `clippy -D warnings`, **`575/575`** Rust tests, `5/5` staged binaries `omnia.exe` `12.389 MiB`/`8.29–10.40 ms` `5EFB97E4...`, `omnia-studio.exe` `6A771FFA...`), Steer #22+#23 Phase 4 `100%` PASS (`wave4-{steer22-23-fullstack,final-systems,steer17-fullstack,steer18-20-fullstack,playwright-oracle}.json`, `native-qa-final` `90/90` IME-resilient, `cli_v5_steer22_23.json` `16/16`, `post_05eafbb_audit.json` `13/13`, PR #1 `29/32` `VERIFIED_PASS`), `f76b4a5` (`119/119` UI), `1a1e423` (`14/14`, `TRK-06` closed), `wave3-final-audit.json` (`793` trials, `0` findings), `22/22` skills (`16/16` golden eval); fresh 3 cleanroom rounds next |

## Additive context and capability integration lane — 2026-11-14

This section extends the existing waves and does not rewrite their historical
claims or mutable counters. It converts the current request to an evidence
bound integration backlog. A source is admitted to Omnia only after its bytes,
ownership, provenance, compatibility and runtime contract have been inspected.
An index, filename count, pointer, hash, fixture, mock, preview or plan entry
does not prove that a transcript body was acquired, that a capability works, or
that a product integration is complete.

### Evidence vocabulary

Use these labels in task ledgers and receipts:

- `verified`: the named behavior ran against the current source snapshot and
  has a reproducible receipt.
- `partial`: a bounded slice is implemented and verified, while required
  sibling paths or failure cases remain open.
- `historical`: evidence belongs to an older revision or clean clone and must
  be re-run before it supports a current-tree claim.
- `unresolved`: the source or behavior is known, but ownership, semantics,
  compatibility or required evidence is still undecided.
- `blocked`: a named technical prerequisite or authoritative capability is
  unavailable; preserve the blocker and next executable action.
- `uninspected`: the item is in scope but no bounded content inspection has
  been completed.
- `next`: the smallest executable action that can move the item to a stronger
  evidence state.

Metadata indexes prove only metadata. Codex and Antigravity session indexes,
directory manifests and generated pointers must never be described as complete
transcript acquisition. Raw chat bodies, private records and access-bearing
data stay outside the repository. The repository may contain only redacted
manifests, requirement summaries, hashes, interface contracts, provenance and
verification receipts.

### Source inventory and disposition

Create one immutable, redaction-safe manifest for each configured source root
below. Each manifest must record the source owner, exact revision or content
hash, timestamp, license/provenance, duplicate comparison, admission decision,
destination module, retrieval state and next action. Use bounded enumeration
and content inspection; do not infer that every file or every conversation was
read from a directory listing.

| Source root | Required disposition | Candidate Omnia destination | Current state |
|---|---|---|---|
| `D:\opencode` | Inventory source and history adapters, compare overlapping contracts, admit only source-backed pieces with compatible licenses and current tests | `rust/omnia-connector-gateway/`, `rust/omnia-harness/`, `ui/app/`, or `tools/` | `partial` (`opencode_compat.rs` + `tools/omnia-connector-intake/`) |
| `D:\htmustc-proxy` | Inspect transport, namespace restoration, retry/stream behavior and secret handling; record exact interface and runtime evidence | `rust/omnia-connector-gateway/`, `rust/omnia-routing/`, `rust/omnia-runtime/`, Studio bridge | `partial` (`proxy_router.rs`, RFC 9110 multi-Cookie, `30_000 ms` proxy budget; live billing/streaming open) |
| `D:\CodexBetaPatched` | Compare Codex runtime and MCP dispatch changes against Omnia contracts; retain provenance and avoid copying private runtime state | `rust/omnia-connector-gateway/`, `tools/`, `.agents/skills/` | `partial` (`codex_patched.rs` + `codex-mcp-namespace-diagnostics` skill) |
| `C:\Users\khang\Documents\ChatGPT\Gemini Notebook` | Import only Omnia-relevant, redacted requirements and validated connector behavior; keep raw exports external | `tools/` ingestion receipts and `docs/workspace/` requirement traces | `historical` notes exist; current admission requires a bounded manifest |
| `C:\Users\khang\Documents\ChatGPT\Google Drive Downloader` | Inspect reusable capture, resume, origin/host and security contracts; compare against Omnia media/storage boundaries before admission | `rust/omnia-media-capture/`, `rust/omnia-storage/`, or a separately owned tool | `historical` notes exist; current source admission is `unresolved` |

For every manifest row, the disposition must be one of `admit`, `adapt`,
`defer`, `reject`, or `blocked`, with a technical reason and an executable next
action. Never delete or overwrite a source to force convergence. Preserve
unresolved and blocked rows until their owner, revision and recovery path are
recorded.

### Codex and Antigravity history integration

1. Snapshot the Codex and Antigravity source indexes before parsing. Record
   source surface, index revision/hash, timestamp, workspace and missing or
   truncated ranges.
2. Normalize each accessible record to a redacted envelope containing
   `source_surface`, `source_id`, `workspace`, `timestamp`, `content_hash`,
   `retrieval_state`, `transcript_available`, `redaction_state`,
   `requirement_refs`, and `provenance`.
3. Keep raw bodies and private exports outside `D:\Omnia`. The importer may
   emit only redacted summaries, requirement links, stable hashes and
   source-backed contracts.
4. Map admitted records to existing Omnia goal/task IDs and product leaves.
   Preserve conflicting or ambiguous requirements as explicit unresolved
   entries; do not silently merge contradictory prompts.
5. Import admitted summaries into the Studio history model and expose truthful
   availability states through the existing history endpoints. A missing body
   must yield an unavailable or partial response with its reason, never a
   fabricated message.
6. Verify importer tests, C++ pointer/generation tests, zero-secret scans,
   current out-of-source CTest, and live `/api/history` plus
   `/api/history/messages` round trips. Save the same-snapshot receipt under
   `D:\OmniaData\qa\`.

The current history receipt is bounded: it proves receipt-path compatibility,
pointer-generation HTTP checks and importer tests only. It does not prove
complete Codex or Antigravity acquisition, transcript completeness, or
product completion.

### Runtime capability priority

Implement and verify capabilities in this order. Each capability needs a real
adapter, truthful unavailable/error states, negative cases and a receipt before
the next dependent capability is marked verified.

1. **Provider transport.** Complete the Rust runtime only where its async
   HTTPS/SSE transport is technically useful. Define a stable C++/Studio bridge
   with request IDs, cancellation, timeout, backpressure, bounded response
   buffers, environment-only credentials and provider receipts. Do not emit
   synthetic provider replies. The current `rust/omnia-runtime/` tree is an
   incomplete untracked prototype and has no runtime completion receipt.
2. **Workspace and IDE.** Implement filesystem read/write, editor save, diff,
   terminal and LSP contracts with canonical path containment, reparse-point
   checks, bounded command output, cancellation and rollback receipts.
3. **Browser, capture and OBS.** Add explicit service adapters and capability
   states. Every unavailable service, permission error, stale handle and
   reconnect path must be observable; a UI control cannot imply success.
4. **Paired media and input.** Define authentication and pairing records,
   reconnect and cross-network transport, screen-share/capture frames, and
   mouse/keyboard/touch messages with authorization, sequence, replay and audit
   receipts.
5. **Packaging.** Add web, Windows native, Android/APK and other targets only
   after each target has an actual build, install, launch, capability and
   recovery contract. Keep platform-specific code behind explicit interfaces.
6. **Selective Rust conversion.** Migrate C++ components only when an
   ownership, safety, portability or performance measurement supports it.
   Preserve C++/WebView/Node pieces where they remain technically appropriate.
   Do not claim a full Rust migration from an untracked prototype. Studio
   health must also stop hard-coding `rustFiles = 0`; it needs a source-root
   readback and a fresh test for the current checkout.
7. **UI truthfulness audit.** Review every remaining health, session, router,
   graph, memory, skills, composer and IDE fallback. Replace static or
   synthetic success content with endpoint-backed data or explicit unavailable
   states and add endpoint-level receipts.

### Atomic integration task table

Each row has one owner and one disjoint path set. A worker may edit only its
owned paths, must preserve unrelated dirty work, and must return the command,
source revision, exit status, receipt path and exact unresolved gap. Shared
builds and Git mutations are serialized by the coordinator.

| ID | Exact requirement | Owner and disjoint paths | Input / contract | Implementation files | Dependencies | Acceptance command | Receipt | Status | Next action | Stop condition |
|---|---|---|---|---|---|---|---|---|---|---|
| `INT-01` | Freeze current source and history indexes | `history-freezer`; `D:\OmniaData\qa\history-index-*` | Source roots, index schemas, redaction rules | External manifest and receipt only; read `tools/omnia-history-import/` and `tools/agy-history-sync/` without editing | None | `python -B -m unittest discover -s tools/omnia-history-import -p "test_*.py"` and `python -B -m unittest discover -s tools/agy-history-sync -p "test_*.py"` | `D:\OmniaData\qa\history-index-<timestamp>\receipt.json` | `partial` | Add bounded manifests and missing-range records | Stop if an index cannot be read reproducibly or would copy raw bodies |
| `INT-02` | Normalize and admit relevant Codex/AGY records | `history-normalizer`; `tools/omnia-history-import/`, `tools/agy-history-sync/` | The redacted envelope and disposition vocabulary above | `tools/omnia-history-import/import_history.py`, `tools/agy-history-sync/agy_history_sync.py`, importer tests and README | `INT-01` | Import fixture plus malformed, duplicate, unavailable and redaction cases | `D:\OmniaData\qa\history-import-<timestamp>\receipt.json` | `partial` | Add source/workspace/revision fields and explicit gaps | Stop on missing provenance, secret-scan failure or fabricated body |
| `INT-03` | Serve truthful history summaries and messages | `studio-history`; `rust/omnia-studio/src/history.rs`, `http.rs` | `/api/history` and `/api/history/messages` schemas, pagination and generation rules | `rust/omnia-studio/src/{history,http}.rs`, `rust/omnia-storage/src/session_store.rs` | `INT-02` | External `cargo test -p omnia-studio -p omnia-storage --offline --locked` + live endpoint receipt | `D:\OmniaData\qa\history-receipt-<timestamp>\receipt.json` | `partial` | Verify against compiled Rust `omnia-studio.exe` | Stop if pointer generation, pagination or redaction invariants fail |
| `INT-04` | Replace health and UI synthetic states with source-backed states | `ui-truth`; `ui/app/{api,main,history,router-lab,ide-explorer,memory-vault,peer-graph,composer}.js`, `ui-v5/` | Endpoint schemas, explicit unavailable/error states | Listed `ui/app/*.js` & `ui-v5/` modules (`embed-ui` priority) | `INT-03` | `node --check ui/app/*.js` plus isolated Playwright 4x-CPU & live `omnia-studio.exe` CDP checks | `D:\OmniaData\qa\v5-verify\wave2-playwright-oracle.json` & `wave2-816626d-systems.json` | `partial` | Verify `/api/benchmarks/scoreboard` UI integration & final Wave 4 live Studio round-trip | Stop when a UI control can report success without a server receipt |
| `INT-05` | Prove a real provider request, stream, cancel and timeout path | `provider-transport`; `rust/omnia-routing/`, `rust/omnia-connector-gateway/`, `rust/omnia-runtime/` | Request ID, SSE framing, cancellation, timeout, backpressure and env-only credential contract | Listed Rust routing/gateway/runtime crates | `INT-04` | `cargo test -p omnia-routing -p omnia-connector-gateway -p omnia-runtime --offline --locked` + configured endpoint smoke test | `D:\OmniaData\qa\provider-transport-<timestamp>\receipt.json` | `partial` | Complete live streaming & credential-manager boundary checks | Stop on absent live transport, unknown external effect or secret exposure |
| `INT-06` | Add workspace and IDE operations with containment and rollback | `workspace-ops`; `rust/omnia-workspace-ops/src/` | Canonical path, reparse guard, bounded output, cancellation and rollback contract | `rust/omnia-workspace-ops/src/{lib,path_guard,fs_ops,process_ops}.rs` | `INT-03` | `cargo test -p omnia-workspace-ops --offline --locked` | `D:\OmniaData\qa\workspace-ops-<timestamp>\receipt.json` | `partial` | Bind each operation to live Studio/native UI actions | Stop on path escape, unbounded output or rollback ambiguity |
| `INT-07` | Integrate browser, capture and OBS adapters with capability states | `media-adapters`; `rust/omnia-media-capture/src/` | Real service discovery, stale handle, permission error and reconnect contracts | `rust/omnia-media-capture/src/{lib,browser_cdp,capability,obs_v5,window_capture}.rs` | `INT-03` | `cargo test -p omnia-media-capture --offline --locked` + negative-path checks | `D:\OmniaData\qa\media-adapters-<timestamp>\receipt.json` | `partial` | Bind capability receipts to live capture UI/API | Stop on fake success, stale handle acceptance or missing authorization |
| `INT-08` | Add paired remote media and two-way input transport | `remote-control`; `rust/omnia-remote-control/src/` | Pairing, authentication, sequence, replay, reconnect, screen frames and input audit | `rust/omnia-remote-control/src/{lib,crypto,pairing,protocol,replay,transport}.rs` | `INT-07` | `cargo test -p omnia-remote-control --offline --locked` | `D:\OmniaData\qa\remote-control-<timestamp>\receipt.json` | `partial` | Bind two-peer loopback receipts to Studio UI controls | Stop on unauthenticated input, replay acceptance or missing audit receipt |
| `INT-09` | Produce actual web, Windows and Android packaging contracts | `packaging`; `platform/`, `D:\OmniaData\qa\packaging-*` | Build, install, launch, version, capability and recovery receipts | `platform/{README.md,targets.json,validate_targets.py,test_validate_targets.py}` | `INT-04`, `INT-06`, `INT-08` | `python -B platform/validate_targets.py` & `python -B -m unittest discover -s platform -p "test_*.py"` | `D:\OmniaData\qa\packaging-<timestamp>\receipt.json` | `partial` | Verify packaged target build receipts on supported OS toolchains | Stop when a target has only a manifest or screenshot without a runnable artifact |
| `INT-10` | Execute Full Native Rust 17-crate workspace & Steer #15 Omnia v5 closure | `rust-migration`; `Cargo.toml`, `Cargo.lock`, `rust/*`, `D:\OmniaData\build\omnia-rust-workspace` | Out-of-source Cargo closure (`0` `.cpp`/`.hpp`/`CMake*` in-tree; C++20 backed up in `D:\OmniaData\backups\pre-full-rust-20261115\`) | `Cargo.toml`, `Cargo.lock`, all `17` `rust/` crates, `tools/omnia-benchmark`, `tools/omnia-gemini-extractor` | `INT-05` | Unified `cargo check/clippy/test/build --workspace --offline --locked` + `7/7` `pwsh` QA + Playwright CDP + Suite v5 | `D:\OmniaData\qa\rust-migration-<timestamp>\receipt.json` | `in_progress` | Complete Steer #15 unified build, `pwsh` QA, Playwright CDP, benchmarks & 3 cleanroom rounds | Stop if build dirties source tree or relies on unverified mocks |
| `INT-11` | Reconcile all admitted source dispositions into Omnia ledgers | `evidence-reconciler`; `docs/workspace/` only | Manifest, contract, receipt and duplicate comparison schema | `docs/workspace/SOURCES.md`, `TASKS.md`, `CHECKPOINT.md`, `TRANSFER_CONTRACT.md` | `INT-01` through `INT-10` as applicable | Markdown/UTF-8/LF check, secret scan, `git diff --cached --check` | `D:\OmniaData\qa\integration-reconciliation-<timestamp>\receipt.json` | `next` | Record each item as verified, partial, historical, unresolved or blocked | Stop if a ledger claim lacks a same-snapshot source or receipt |

### Reusable bounded worker prompts

Use one prompt per worker and keep the path set disjoint. The coordinator
supplies the current revision and the exact contract; the worker does not
invent endpoints, silently broaden scope, or claim a capability from a mock.

**Manifest worker**

> Inspect only the assigned source root. Produce a redaction-safe manifest with
> path, byte hash, revision, owner, provenance/license, duplicate relation,
> retrieval state and disposition. Do not copy raw chat bodies, credentials or
> private records into Omnia. Write only the assigned manifest path. Run the
> named validation command, save a same-snapshot receipt outside the product
> tree, and report every unreadable, missing or ambiguous item with a concrete
> next action.

**History worker**

> Modify only the assigned history importer and its tests. Implement the
> stated envelope, redaction, duplicate, pagination and unavailable-body
> contract. Preserve source IDs and hashes. Never synthesize transcript text or
> mark an unavailable source as complete. Add positive and negative cases,
> run the focused test command, and return the source revision, exit status,
> receipt path and remaining gap.

**Adapter worker**

> Modify only the assigned adapter paths. Implement the listed request and
> error contract with real transport calls, bounded buffers, cancellation,
> timeout and audit fields. Return explicit unavailable/error states when the
> configured service is absent. Do not add a fake provider, fixture success
> path or undocumented endpoint. Run the focused build/test command and save a
> same-snapshot receipt.

**UI truthfulness worker**

> Inspect only the named UI modules and their documented API calls. For every
> fallback branch, either bind it to a verified endpoint or render a truthful
> unavailable/error state with the server reason. Preserve existing layout and
> accessible semantics unless the contract requires a change. Run syntax and
> live console/geometry checks, then report exact changed files and evidence.

**Contract verifier**

> Read only the producer, consumer and contract files named in this task.
> Verify method, path, HTTP verb, request fields, response fields, error codes,
> pagination, generation and cancellation behavior. Do not infer product
> meaning or redesign the adjacent module. Report each mismatch with a
> minimal patch location and rerun the focused contract test.

### Execution order, receipts and stop rules

Run `INT-01` and `INT-02` first, then `INT-03` and `INT-04`. Admit provider,
workspace, media and remote-control work only after their contracts are
written and the current Studio endpoint surface is truthful. Run packaging and
selective migration after a bounded runtime path exists. Finish with
`INT-11`, then update `CHECKPOINT.md`, `STEER_QUEUE.md`,
`TRANSFER_CONTRACT.md` and `SESSION_ADMISSION.json` from the same snapshot.

Every completed row must include:

- the current source revision and a canonical input hash;
- exact changed paths and ownership boundaries;
- positive and negative acceptance results;
- a receipt outside the product tree;
- unresolved, blocked and uninspected items with a named next action.

Do not claim whole-product completion while any mandatory row is
`unresolved`, `blocked` or `uninspected`, or while the final three-snapshot
independent audit requirement remains open.

## Navigation to sibling governance files

- **Tasks & product leaves:** [`TASKS.md`](TASKS.md) -> [`GOAL.md`](GOAL.md)
- **Acceptance & audit rules:** [`DOD.md`](DOD.md)
- **Current watermark & hashes:** [`CHECKPOINT.md`](CHECKPOINT.md)
- **Architecture & cleanup decisions:** [`DECISIONS.md`](DECISIONS.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](DEEP_CLEAN_AUDIT_D_DRIVE.md), & [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](DEEP_CLEAN_AUDIT_C_DRIVE.md)
- **Prompt & steer traceability:** [`PROMPTS.md`](PROMPTS.md) & [`STEER_QUEUE.md`](STEER_QUEUE.md)
- **Collaborator & next-session transfer:** [`TRANSFER_CONTRACT.md`](TRANSFER_CONTRACT.md)
