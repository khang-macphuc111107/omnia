# Omnia root migration and professional handoff goal

**Goal ID:** `OMNIA-ROOT-CLEAN-2026-11-11`
**Status:** `ACTIVE`
**Owner:** root integrator
**Workspace:** `D:\Omnia`
**Revision:** 7 — scoped source restore reconciled; preservation boundaries remain open, 2026-11-11
**Persistent tool goal:** active in chat `01a1bce9-bcd9-75f3-b63a-28b855d6978f`

## Outcome

Deliver one discoverable, professional Omnia repository whose product source
is directly under `D:\Omnia`, with native Rust as the preferred runtime,
reproducible build entrypoints, a compact handoff, and evidence-backed
ownership for every retained or moved artifact. The workspace must be clean
because each file has a deliberate owner and lifecycle, not because unknown
work was hidden or deleted.

## Non-negotiable boundaries

1. Preserve dirty source, staged work, branch divergence, linked worktrees,
   ignored valuable data, recovery snapshots and research until a disposition
   and restore path exist.
2. Never publish credentials, tokens, cookies, browser profiles, private chat
   bodies, personal records or access-bearing URLs.
3. Native Rust is the target. WebView, Electron and Node remain compatibility
   dependencies only when a measured, documented native seam is not available.
4. A hash, enumeration, fixture, mock, preview or green structural check cannot
   prove semantic understanding, live integration, performance, security,
   feature parity or zero defects.
5. Every mutation has a before/after receipt, containment check, owner,
   rollback route and explicit limitation.
6. A failed or contradicted gate reopens all dependent claims and resets the
   relevant consecutive-audit counter.

## Atomic tasks

| ID | Task | State | Exit evidence |
|---|---|---|---|
| `ROOT-01` | Admit native Rust and complete shared-crate closure at root | `IN_PROGRESS` | Byte receipt, metadata, format, tests and review |
| `ROOT-02` | Reconcile primary/release/rebuild/goal-control differences | `IN_PROGRESS` | Per-change incorporated/retained/superseded/unresolved ledger |
| `ROOT-03` | Repair or retire nested Git/worktree ownership | `IN_PROGRESS` | Snapshot, path repair and restore drill |
| `ROOT-04` | Refactor and organize code without behavior loss | `OPEN` | Scoped diff, review, tests and explainable status |
| `ROOT-05` | Make root build and clean clone self-contained | `OPEN` | Fresh clone metadata/build/test and private-path scan |
| `DRIVE-01` | Inventory D: ownership and disk consumers | `IN_PROGRESS` | Bounded top-level inventory and reparse classification |
| `DRIVE-02` | Reclaim only proven disposable caches/duplicates | `PARTIAL` | Candidate manifest, retention decision and free-space delta |
| `HISTORY-01` | Freeze and inventory accessible Codex history | `IN_PROGRESS` | Watermark, denominator and missing/truncated ledger |
| `HISTORY-02` | Perform hierarchical semantic review | `OPEN` | Session owner, bounded reviewers and independent audit |
| `HISTORY-03` | Extract prompts, requirements, goals, plans and tool evidence | `OPEN` | Redacted Markdown and traceability matrix |
| `HANDOFF-01` | Maintain specs, tasks, DoD, state, checkpoint, decisions and memory | `IN_PROGRESS` | Cross-file consistency and evidence links |
| `RESEARCH-01` | Qualify research/skills and project supported improvements | `OPEN` | Query/source/revision/license/admit-defer-reject records |
| `PRODUCT-01` | Complete native shell, provider, editor, browser, IDE and harness | `OPEN` | Runtime receipts for each claimed capability |
| `QUALITY-01` | Run code, security, UI, performance, accessibility and recovery QA | `OPEN` | Independent positive/negative/race/reload/resource results |
| `DELIVERY-01` | Verify GitHub identity, publication and clone handoff | `OPEN` | Account receipt, pushed SHA and clean clone |
| `SESSION-01` | Create follow-up Omnia chat only after handoff gates | `DEFERRED` | Thread ID, immediate goal activation and checkpoint |

## Evidence states

`ACQUIRED` means bytes/records have bounded hashes; `READ` means bounded
content was inspected; `SYNTHESIZED` means requirements were derived with
links; `REVIEWED` means an independent reviewer checked source and receipt;
`RUNTIME_VERIFIED` means behavior ran in the named environment;
`PUBLISHED` means the exact tree was pushed and clone-checked. Missing evidence
is `UNPROVEN`, never silently upgraded.

## Completion rule

Remain active until every mandatory task has a reviewed exit receipt, unresolved
rows have an owner and next action, root status is explainable, and a clean
clone follows README without private paths. Product capability, research
qualification, history comprehension and disk cleanup are reported separately.

## Execution order and incoming requests

Finish the current incomplete deliverable before starting a newly received
addition. In this chat the user explicitly uses steer to submit requests
quickly: an additive steer is queued. It does not cancel, replace or restart
unfinished work. Apply a correction that affects current correctness at the
next safe boundary; preserve the interrupted step and its next action.
Only an explicit stop, cancellation or incompatible replacement changes that
rule. Record scope changes against stable task IDs rather than silently
overwriting the plan.

Current sequence:

1. Finish, check and commit the interrupted source-preservation checkpoint.
   The r9 documentation correction is committed as `828c9e8`; r10 now has a
   scoped isolated restore receipt requiring the correction below. Preserve
   the completed QA commit and retained preview without repeating either effect.
2. Repair any remaining root-instruction or evidence contradictions against
   the current owning bytes before carrying their claims.
3. Correct source reconciliation and preserve working-tree/index ownership.
4. Move classified bulk operations, research and recovery material outside
   the product checkout, repairing actual consumers.
5. Reclaim proven disposable generated output and measure free-space change.
6. Validate root source closure from an isolated clone/export.
7. Reconcile source differences, refactor in bounded components and qualify
   the remaining native product work.
8. Continue history review and skills/research in independent bounded lanes.
9. Review the publishable tree, verify GitHub destination, publish and
   clone-check before launching the requested follow-up Omnia chat.

These are dependency boundaries, not a claim that the work is already done.
Independent read-only review may run alongside an earlier step. Shared file
mutations and resource-heavy Cargo builds are serialized.

## Task contracts

The 16 parent IDs above remain the completion denominator. The following
contracts expand their scope; a completed subtask does not complete its parent.
Root integrator owns integration and status. Delegated reviewers return
source-bound findings; they do not grant their own integration or runtime
approval.

| Parent | Required work and output | Prerequisite / acceptance |
|---|---|---|
| `ROOT-01` | Native package, all local crate dependencies, required assets, schema and retained compatibility host at root | File provenance; locked metadata; formatting; scoped tests; missing-input audit |
| `ROOT-02` | Compare primary, release, rebuild and goal-control HEADs **and** index, dirty and untracked bytes; classify every unique relevant change | Correct NUL/rename parsing, complete external records, semantic incorporated/retained/superseded/unresolved decisions |
| `ROOT-03` | End with one product Git root; preserve old objects, refs, index, working bytes and linked worktrees outside it | Common-store topology, reparse/handle checks, restore drill and repaired consumers before metadata retirement |
| `ROOT-04` | Improve names, modules, imports, formatting, dead code and error boundaries in reviewed components | Behavioral contract before edits; focused positive/negative tests; no unexplained diff |
| `ROOT-05` | README commands, native/compatibility boundaries, release tooling and all compile-time inputs work without former machine paths | Fresh isolated clone/export, locked manifest checks, build/tests and required-file/private-path checks |
| `DRIVE-01` | Inventory actual `D:\` separately from `D:\Omnia`; classify large consumers by owner and lifecycle | Bounded scans, logical/allocated-byte distinction, explicit omissions, no reparse traversal |
| `DRIVE-02` | Clean generated caches and duplicate output; retain source, unrelated projects, valuable backups and unknown data | Producer and retention evidence, checked literal path, supported cleanup, before/after free bytes and failed/skipped list |
| `HISTORY-01` | Freeze accessible raw prefixes and alternate projected history privately; inventory active/archived/child chats and growth | Snapshot watermark, session/record/byte denominators, gaps, truncation and projection limitations |
| `HISTORY-02` | Session owner -> bounded record reviewers -> independent audit; separate user-prompt extraction | Exact reviewed ranges and source hashes; conflicts, missing state and remaining units remain visible |
| `HISTORY-03` | Local Markdown exports and compact reviewed specifications/tasks/lessons with provenance | Include prompts, assistant/tool output, goal/plan/task state and referenced artifacts; redact shared derivatives; distinguish historical claims |
| `HANDOFF-01` | Maintain specs, atomic tasks, plan, DoD, state, checkpoint, decisions, instructions and reusable lessons | One authoritative location per fact; resolvable navigation; current status; clear read/write/stop rules |
| `RESEARCH-01` | Discover, read, qualify, deduplicate and distill useful atomic skills for Codex and Omnia | Query/time/revision/license/source ranges, novelty and admission decisions; projection, loading and invocation are separate |
| `PRODUCT-01` | Implement native capabilities enumerated below; retain justified compatibility exceptions | Feature-specific implementation and packaged/live behavior evidence, performance budgets and remaining gaps |
| `QUALITY-01` | Requirement, code, security, UI, recovery, accessibility and resource QA | Current snapshot; meaningful oracles; negative/edge/race/stress cases; independent review; final audit protocol |
| `DELIVERY-01` | Publish a self-explanatory repository to the verified requested destination | Authenticated account/repository identity, visibility/privacy review, pushed SHA and independent clean clone |
| `SESSION-01` | After admission gates create an Omnia chat using `NEXT_SESSION_PROMPT.md` | Real thread ID; immediate persistent goal request; activation readback or explicit limitation; no premature completion claim |

## Follow-up chat admission — `SESSION-01`

The next chat continues unfinished work. Admission does not require the whole
product, every history review unit or every research source to be complete.
It requires a safe, reproducible root and an explicit transfer of the remaining
requirements. None of the following scoped prerequisites completes a broader
parent task or waives its DoD.

The decision artifact is [SESSION_ADMISSION.json](SESSION_ADMISSION.json).
Root integrator owns it. Its initial decision is `DEFERRED`; advance it to
`READY` only after a reviewer checks all seven prerequisites against the same
candidate commit/tree and the named external inputs. Record evidence identity,
inspection time, reviewer and limitations. A failed or stale prerequisite
returns the decision to `DEFERRED`. A missing receipt never counts as a pass.

| Gate | Parent task / DoD | Required state and receipt |
|---|---|---|
| `SESSION-G01` | `ROOT-01`, `ROOT-05`; `DOD-01`, `DOD-02`, `DOD-03`, `DOD-06` | `PASS_SCOPED`: actual root source, required native/retained compatibility inputs and documented commands resolve in an isolated clone/export; native tests and manifest closure checks pass with external build output. Name every check and its source tree. This does not establish packaged provider/UI parity. |
| `SESSION-G02` | `ROOT-02`, `ROOT-03`; `DOD-04`, `DOD-05` | `PASS_PRESERVATION`: every unreconciled source has complete HEAD/ref/index/dirty/untracked/valuable-ignored ownership, a recoverable snapshot and an isolated restore receipt; linked/common Git owners and consumers remain valid. The semantic reconciliation parent may stay `IN_PROGRESS` only with per-change pending rows, owner and next action. No unproved metadata retirement. |
| `SESSION-G03` | `DRIVE-01`, `DRIVE-02`; `DOD-08` | `PASS_SCOPED`: an actual drive-root inventory records scope and omissions; every action already taken has containment, ownership, retention, relocation/restore or regeneration evidence and a measured space delta. Unclassified/active data is preserved and transferred. This is not whole-drive cleanup completion. |
| `SESSION-G04` | `HISTORY-01`; `DOD-09` | `PASS_SCOPED`: privately owned frozen prefixes or snapshots have a watermark, retrieval instructions, denominators, missing/projected/growing-tail records and integrity checks. Enumeration alone does not satisfy this acquisition/preservation gate or semantic review. |
| `SESSION-G05` | `HANDOFF-01`; `DOD-11` | `PASS_SCOPED`: README, instructions, specs/tasks/DoD, state/checkpoint/decisions and the launch prompt agree on current scope, queue order, evidence and next actions; references resolve and independent review has no unresolved handoff error. |
| `SESSION-G06` | `DELIVERY-01`; `DOD-15` | `PASS_SCOPED`: authenticated destination is the requested Omnia repository under `khang-macphuc11107`; visibility, licenses and privacy are reviewed, exact tree is pushed, and an independent clean clone follows the documented entrypoints. Record repository identity, pushed commit/tree and clone receipt. |
| `SESSION-G07` | All unfinished parent tasks and `PRODUCT-*` leaves | `PASS_TRANSFER`: the decision artifact names each open item, current state, owner, source/receipt locator, next action and acceptance gate. The new prompt preserves this denominator and immediately requests its own detailed persistent goal. |

In `SESSION-G07`, explicitly transfer `ROOT-02`/`ROOT-03` semantic work,
`ROOT-04`, remaining `ROOT-05` delivery work, unclassified `DRIVE-*` items,
`HISTORY-01` growth/gaps, `HISTORY-02`, `HISTORY-03`, `RESEARCH-01`,
`PRODUCT-01` and every product leaf, `QUALITY-01`, ongoing `HANDOFF-01`
maintenance and any still-open delivery requirement. Closed items retain their
receipts and are reopened on relevant drift. This list is a minimum; reconcile
it against the current task table at admission.

Only after `READY` create the requested chat with the reviewed
`NEXT_SESSION_PROMPT.md`. Record the returned chat ID, exact prompt hash and
immediate goal activation/readback outcome; then set admission to `LAUNCHED`.
A creation response alone does not prove activation. A tool limitation stays
explicit, with the detailed file-backed goal available. Do not mark this chat's
whole objective complete merely because responsibility was transferred.

## Product breakdown retained in the queue

These are required work families under `PRODUCT-01`, not implemented features:

| Leaf | Scope | Observable completion |
|---|---|---|
| `PRODUCT-NATIVE` | Windows native Rust shell and shared services; minimal CPU/RAM/disk/GPU use | Native entrypoint, dependency/resource measurements, justified exceptions, startup/idle/interaction evidence |
| `PRODUCT-COMPOSER` | Rich prompt editor, live Markdown/LaTeX, Word-like formatting, tables, rendered equation/symbol palettes | `COMPOSER_REQUIREMENTS.md` matrix including Unicode/IME, undo/restart, inline/tray caret placement and serialized provider order |
| `PRODUCT-ATTACHMENTS` | Auto attachment, paste/drop, conversion and extraction | Original/derived provenance, stable IDs, progress/cancel/retry, unsupported/encrypted status, no silent omission |
| `PRODUCT-CHAT` | Provider/API/model/settings, streaming, tool calls, profiles, sessions and transcript | Actual provider delivery, error/cancel/retry behavior, ordering, durable state and credential protection |
| `PRODUCT-CONTROL` | Goal/plan/task/prompt CRUD, queue/steer/continue, active and idle edits | Durable revisions and receipts, stale-revision rejection, cancellation fencing, restart/recovery and UI parity |
| `PRODUCT-GRAPH` | General graph orchestration, roles, hierarchical subagents and feedback loops | Explicit cyclic policies, ownership/leases, bounded concurrency, termination and independent result reconciliation |
| `PRODUCT-MEMORY` | Memory, RAG, retrieval, compaction, summaries and continuous learning | Provenance, freshness/supersession, erasure, retrieval evaluation and verified integration |
| `PRODUCT-USE` | Browser/DOM, native accessibility, computer/process use with low disruption | A declared capability matrix for background/minimized/headless/visible/isolated execution; actual capture/control evidence per supported mode |
| `PRODUCT-MEDIA` | Image/video/audio/document capture, parsing and addressable evidence | Frame/time/region/coordinate/transcript references, adaptive sampling plus detail reinspection, unsupported-state reports |
| `PRODUCT-WORKSPACE` | IDE/browser/project/artifact/file/navigation surfaces and live observability | Real actions, persistence, failure/recovery, accessibility and resize/DPI/keyboard behavior |
| `PRODUCT-SECURITY` | Defensive security, authorization, state transitions and configuration/OS audits | Authorized test scope, caller/scope checks, secret handling, audit receipts and bounded rollback |
| `PRODUCT-KNOWLEDGE` | Study, tutoring, scientific research, curricula, subject/problem solving and document artifacts | Source-derived coverage, appropriate domain checks, citations, runnable/reproducible artifacts and uncertainty |

Background capture/control is a capability to establish per API and target;
ordinary desktop input is not automatically process-private. Hidden/protected
surfaces, exclusive input and encrypted contents require real support and
authority. Neither skill wording nor repeated attempts proves universal access.

## Research and skill backlog

Preserve the earlier request families through atomic capability boundaries:
planning/goal/queue/steer/continue; clean Git/backup/rollback/recovery;
architecture/refactor/code quality; research/source/citation/proof;
memory/RAG/context; browser/computer/Windows/process capture and control;
media/document/artifact workflows; modern quantitative UI/UX/QA;
security and defensive adversarial evaluation; native Rust/toolchains and
performance; academic curricula, tutoring, problem solving and communication.
Synonyms and repeated “deep” names are aliases or additional scenarios, not
automatic new skill folders. Merge only supported improvements into their
owning skill; preserve scope and avoid unrelated catchalls.

Research requests remain open: supplied GitHub/social/video links and comments;
HCMUT program/curriculum links; GitHub searches for the requested keyword
families with recorded ranking and recency; batches of at least 50 previously
unsearched repository identities where requested; relevant scientific sources.
Record the actual result denominator, filters, inaccessible pages and unused
sources. Downloading, README reading, implementation review, licensing admission
and runtime qualification have different credits. Do not claim a top-50-per-
keyword quota from one mixed batch of 50, or bypass access controls to fabricate
coverage. Complete useful authorized fallback research and retain the gap.

## Current proof and limits

- Native admission: 197 files / 2,588,993 bytes, SHA-256 checked before/after.
- Compatibility admission: 1,630 files copied or already identical from the
  rebuild checkout, with zero destination conflicts; receipt is external
  `handoff-intake/compatibility-admission.json`. Generated trees and caches
  were excluded, and no existing destination bytes were overwritten.
- A follow-up host admission added 132 missing `src-tauri` source/resource
  files with zero conflicts. `cargo metadata --locked` and `cargo fmt --check`
  now pass for both `native/Cargo.toml` and `src-tauri/Cargo.toml`.
- The historical file `D_DRIVE_TOPLEVEL_INVENTORY.json` records **D:\Omnia**,
  with 46 immediate entries and 50.57 GiB free on D: at that time. It is
  not an inventory of the drive root and has no recursive-size/deletion credit.
- `cargo metadata --locked`, `cargo fmt --check` and `cargo test --locked`
  passed with build output outside `D:\Omnia`; this is not final product proof.
- After adding the missing `docs/storage-schema.sql`, the Tauri rerun finished
  with exit 0 at `2026-11-10T19:43:52.8602675Z`: 833 host unit tests and
  6 project-file-watch tests passed, alongside 4 + 17 native integration
  tests. Logs are external `handoff-intake/tauri-root-tests-rerun.txt` and
  its `.result.json`. The initial missing-schema failure is retained.
- History inventory: 852 rollout JSONL files, 2,256,736,449 bytes, 528,619
  records and 14,630 bounded units; semantic review credit is zero.
- Earlier broad scans were stopped; they are not running. The drive-cleanup
  lane separately recorded prior Cargo/pnpm cleanup, so this checkpoint must
  not claim that no D: deletion ever occurred. Fresh actions need fresh receipts.
- Corrected full NUL/rename-aware source inventory records
  `4,783 / 133 / 81 / 0` total status entries for primary/release/rebuild/
  goal-control. Changed tracked/untracked counts are `3,008/1,775`,
  `25/108`, `80/1`, `0/0`. No rename records occurred in this snapshot.
  Complete private index/HEAD/status records replace the earlier truncated,
  rename-unaware listing; stable status/HEAD during a read is not a backup.
- HEAD path reconciliation found `42,012` paths in the union and only `2,020`
  in the intersection of all four trees. Current focus predicate includes
  276 paths (`src-tauri`, manifests, CI and README); 138 differ. Historical
  277-focus metrics used a different predicate. Exclusive-source counts are
  `37,609 / 0 / 1,357 / 0`; outside-four-way-intersection counts are separate.
  HEAD comparisons omit dirty/index/untracked changes and do not bind root
  admission lineage. Semantic reconciliation remains open.
- Ten classified trees moved to `D:\OmniaData`: 92,460 files /
  15,156,174,074 logical bytes, with full relative-path/type/size/mtime checks,
  nonzero directory identities and selected anchor hashes. Before-file
  device/inode fields were zero, so per-file identity is unproved. All-file
  content hashing and recoverable backup completion are not claimed.
  Same-volume relocation earns
  zero capacity-reclamation credit. See `EXTERNAL_LAYOUT.json`.
- Supported Cargo cleanup removed the former native integration target:
  exit 0, 9,632 files / 12.1 GiB reported. Observed drive free-space increase
  was 11,357,032,448 bytes (about 10.58 GiB); the metrics have different
  definitions and concurrent system activity can affect the latter.
- The layout milestone is `8d2ad69fbe5b402c51cd92f285b2cc1ffc8686fe`.
  The later QA/documentation batch is committed as
  `952c211c219cb22fb851113139b66342d369c924`, tree
  `2a0c592ed8c39b43ec411716a7546cecd0def230`; continuation-r7/COMMIT.json
  records exit 0 and clean status after that commit. The r9 documentation
  baseline reobserved that HEAD and clean status. Earlier admission milestones
  remain in Git history. Continuation-r3 records
  an isolated local `--no-local --no-hardlinks` clone, both locked no-deps
  manifest checks and native tests with exit 0. Existing Cargo caches were
  used. It is not a cold installation, GitHub clone or final delivery receipt.
- Native QA continuation-r7 records fresh exit-0 path-contract (40 cases),
  capture contract (14), session metadata (5), cooperative ownership (6),
  paging (9), unsaved-form/selection guard (12) and smoke mode/draft/close (4)
  checks. Separate paging/guard fixture producers also returned exit 0.
  All nine QA script hashes are bound in each rerun wrapper. No Rust application
  rebuild occurred in this batch. The external debug executable SHA-256 is
  `1CA3C8A98B81F733B5588D283D7EAECA4FA243DE81847CE5014D0E64F862172F`.
- The r7 negative executable-boundary reproducer failed with exit 1 before
  repair and is retained separately from the passing rerun. The repaired helper
  now requires executables, QA output and SQLite fixtures outside the repository,
  rejects reparse ancestors and refuses existing output destinations.
  Path-helper SHA-256 is
  `E78DD779761CB19567A093547138C90537B500FAF36EEF53A6F098891C67B240`;
  path-test SHA-256 is
  `87EC7B99464CAFB0FB713C4540959BFE13577A3505618E1E760AA7EC5D2187BA`.
  Historical r5 evidence remains historical; no QA result completes a parent.
- The capture helper
  verifies HWND/PID ownership, restores caller DPI, bounds dimensions and
  records logical coordinates. The former right/bottom black-padding defect
  remains repaired in the inspected 1220 × 820 r7 session capture.
  Visual status-panel text clipping and the
  smoke receipt's `Missing UIA control: Edit ` remain open under `QUALITY-01`.
- Continuation-r6 records that old preview process `2272` was stopped during
  resume. At the r7 baseline no `omnia-native.exe` process was observed.
  Continuation-r8 then launched and retained the evaluation shell: PID `38256`,
  start `2026-11-10T22:22:44.9797906Z`, HWND `3014860`, using the bound external
  debug executable without `--session-db`. Its BASELINE, OBSERVATION and
  RETENTION receipts record visible/responding/not minimized/not foreground
  and a 1220 × 820 capture. The initial receipt-recording error is preserved;
  recovery reobserved the process without a duplicate launch.
  Continuation-r9-doc-reconciliation/PREVIEW-REOBSERVATION.json reobserved
  the same PID/start/executable/hash/window at `2026-11-10T22:47:09.5471586Z`
  as alive and responding. This later process check does not refresh r8's
  visibility or pixels. Keep the preview for the user; recheck identity before
  operating it. It is an evaluation shell with provider/storage disconnected,
  not completed native chat, final UI or measured performance.
- Continuation-r10 privately preserved a scoped snapshot of 184,169 regular
  files / 8,342,167,917 logical bytes across common Git and four worktrees.
  A separate supplement preserves 23 trailing-space-path PNG files /
  5,273,303 bytes. Generated, nested-owner and reparse boundaries are excluded
  contents, with pending ownership; this is not an atomic volume snapshot.
- Restore reconciliation R2 records 20/20 matching HEAD/ref/index-stage/
  index-flag/status comparisons across goal-control, release, rebuild and the
  nested Pydantic owner. All 10,076 included regular files from the three linked
  worktrees were reread and SHA-256 matched; the separately acquired nested
  owner has 28 physical files / 287,343 bytes, with absent/empty index and many
  tracked deletions. Physical file count is not its Git tree denominator.
- The missing-index diagnosis is superseded: all three linked indexes were
  already in the snapshot, and all 24 linked admin-file hashes matched live
  and restored copies. Status equality depends on captured mtimes, source
  `core.autocrlf=true` semantics and isolated `core.trustctime=false`.
  Content reevaluation exposes 130 rebuild status records versus the source's
  81: 49 inherited EOL/stat-cache differences remain findings. Byte matching
  does not resolve those differences or establish semantic cleanliness.
- One r10 diagnostic accidentally invoked `git sparse-checkout reapply` on
  source goal-control/release/rebuild without retaining its return/output.
  The correction receipt verifies the four owners' HEAD/refs/index/flags/status
  and raw index hashes still match acquisition. Do not claim this continuation
  was entirely read-only. No metadata retirement or source relocation is credited.
- R10 retirement eligibility remains **false**. Primary materialization,
  11 primary Gitlink owners, 57 reparse records, 961 generated boundaries and
  remaining release/rebuild boundaries/consumers remain open. See CHECKPOINT's
  source-preservation section and SOURCE_DISPOSITION_LEDGER's evidence locators.
- GitHub publication and clean-clone delivery remain unverified.
- Consecutive independent final audit rounds earned: **0**.

## Immediate next actions

1. Finish this interrupted preservation checkpoint before consuming additive
   steer. Preserve all 16 parent tasks, 12 product leaves, research denominators,
   16 DoD gates and seven admission gates. Validate references, IDs, transfer
   states, evidence hashes, JSON and `git diff --check`; inspect exact staged
   paths and commit only this logical update. Save its commit receipt externally.
2. Materialize primary's included regular bytes and the trailing-space supplement
   into the isolated restore; compare HEAD/refs/raw index/index-stage/flags/status
   under recorded source semantics and retain a separate content reevaluation.
   Do not rerun the erroneous sparse-checkout diagnostic on source.
3. Classify and preserve each remaining nested/Gitlink/reparse/generated owner,
   repair consumer paths and reacquire source state to detect drift. Keep
   `retirementEligible=false` until every required boundary and restore gate is
   satisfied. Then continue semantic ROOT-02 reconciliation; 403 byte-delta
   candidates and the 138 unreviewed focus rows are inputs, not reviewed merges.
4. Externalize classified nonproduct owners, reclaim only proven disposable
   output and measure free-space change. Continue isolated source closure and
   bounded refactoring with real behavioral checks. Preserve the retained
   preview and the status-clipping/UIA findings; historical QA stays historical.
5. Continue private history acquisition/review/synthesis, research/skill
   qualification and native product work with their complete denominators.
   Project supported reusable corrections to Codex and Omnia; projection is not
   harness loading or invocation. Serialize shared mutations and Cargo builds.
6. Recheck affected claims on drift or failure. Whole-goal audit streak stays
   zero until eligible frozen scope passes DOD's independent protocol. Review
   privacy/licenses/destination, publish and clean-clone verify before admission;
   create the requested chat only when SESSION_ADMISSION is READY and record
   actual goal activation separately from creation.
