# Omnia definition of done

Each row needs direct evidence from the current source snapshot. Plans, hashes,
fixtures, mocks, previews and agent messages are not substitutes for the
required evidence.

| ID | Definition | Required evidence | Current |
|---|---|---|---|
| `DOD-01` | Source is discoverable at root | Tracked tree, README and source-aware ignores | `PARTIAL` |
| `DOD-02` | Native dependency closure resolves | Locked metadata, path audit and clone metadata | `PARTIAL` |
| `DOD-03` | Scoped native behavior passes | Command logs, exit codes and environment | `PARTIAL` |
| `DOD-04` | Divergent work is reconciled | Per-path ledger, owner, disposition and review | `OPEN` |
| `DOD-05` | Nested Git/worktrees are safe | Snapshot, index/untracked/ignored capture and restore | `PARTIAL` |
| `DOD-06` | Generated output does not dirty source | Ignore policy, external target and status receipt | `PARTIAL` |
| `DOD-07` | Code is clean and maintainable | Format/lint/static review and ownership map | `OPEN` |
| `DOD-08` | D: cleanup is measured/reversible | Ownership, allocated bytes, candidate ledger and delta | `OPEN` |
| `DOD-09` | History corpus is bounded/honest | Watermark, denominator and missing/truncation ledger | `PARTIAL` |
| `DOD-10` | History has semantic review | Ranges, independent audit and redacted synthesis | `OPEN` |
| `DOD-11` | Handoff docs agree | Cross-reference validator and readback | `PARTIAL` |
| `DOD-12` | Skills/research are qualified | Query, revision, license, ranges and decision | `OPEN` |
| `DOD-13` | Native capabilities are real | Packaged/live receipts for each claim | `OPEN` |
| `DOD-14` | QA covers UI/security/performance/recovery | Independent negative/race/reload/resource evidence | `OPEN` |
| `DOD-15` | Public delivery is reproducible | Authenticated account, pushed SHA, clone and secret scan | `OPEN` |
| `DOD-16` | Follow-up chat starts with durable goal | Thread ID, prompt, activation receipt and checkpoint | `DEFERRED` |

## Gate protocol

Record `before`, exact command/inspection, `after`, hashes, reviewer,
limitations and next action for each row. Any missing evidence remains
`OPEN`/`PARTIAL`. A source change, failed check, drifted hash, missing record
or contradiction resets the affected row and its consecutive-audit count.

## Acceptance details

- **DOD-01:** Source is tracked at the actual root; README and AGENTS resolve
  to current files. Bulk archives, upstream clones and recovery data have
  deliberate external ownership. Ignoring a folder does not count as moving it.
- **DOD-02:** Both retained manifest closures and compile-time input files
  resolve in an isolated clone/export. Record Rust/toolchain/OS and locked
  dependency behavior. Local caches are not repository inputs.
- **DOD-03:** Match each claimed native behavior to an executed oracle.
  Report fixtures, direct package tests, shared-crate integration and live
  provider/packaged behavior separately.
- **DOD-04:** Reconciliation includes HEAD, staged, unstaged, renamed and
  untracked changes. Every retained unique product change has an owner,
  disposition, rationale, snapshot and review. Correct parsing precedes counts.
- **DOD-05:** Before retiring a common Git store, preserve refs/objects,
  staged index, dirty/untracked/valuable ignored bytes and all linked-worktree
  registrations. A bundle covers reachable history, not that whole state.
  Restore to an isolated destination and compare the relevant state. Preserve
  raw indexes/admin files and effective EOL/filter/sparse semantics; compare
  restored bytes separately from cached status. If mtime/stat options reproduce
  source status, retain an additional content-reevaluation result. Do not hide
  inherited differences by overwriting the source index or normalizing bytes.
- **DOD-06:** Builds/logs/exports use external owned directories. Source-aware
  ignores, cleanup retention, reparse boundaries and explainable Git status
  remain correct after build, test and export.
- **DOD-07:** Name concrete reviewed modules, findings and repairs.
  Preserve behavior/contracts, error handling and dependencies; report format,
  lint and focused tests without treating them as an exhaustive clean-code proof.
- **DOD-08:** Distinguish drive-root inventory from Omnia inventory.
  Record each candidate's producer, ownership, size method, active-use check,
  disposition and restore/regeneration route. Measure free bytes before/after;
  same-volume relocation is layout progress, not reclaimed capacity.
- **DOD-09:** State exact source watermark, accessible denominator and
  per-source acquisition limits. Preserve gaps, truncation, growing tails,
  alternate projections and remote/deleted/unavailable records explicitly.
- **DOD-10:** Review source ranges and associated prompt/output/state/artifacts,
  derive requirements with locators, and audit those derivations independently.
  Acquisition hashes prove identity, not reading, understanding or completeness.
- **DOD-11:** Each fact has one owning document; indexes route to it.
  Include specs, tasks, plan, DoD, state, checkpoint, decisions and lessons,
  with next executable actions and rules for additive steer.
  Finish interrupted text before moving to queued additions.
- **DOD-12:** Bind each adopted skill improvement to actual reviewed sources,
  revisions/licenses and a supported use case. Check duplicates and references;
  validate changed skills and project to both requested environments. The
  `deep-ui-direction` skill is admitted only as an atomic art-direction and
  preview workflow; it must not duplicate token measurement, UI behavior QA or
  generic design guidance. Its anti-template mode requires three materially
  different candidates, a weighted comparison, rejected-direction reasons and a
  concrete template-detection pass. Unavailable web/social/video sources remain
  explicit gaps.
  Installation/projection is distinct from discovery, loading and invocation.
- **DOD-13:** Cover all `PRODUCT-*` leaves in GOAL. Native Rust is preferred;
  exceptions require a recorded resource-backed reason. Complete composer and
  attachment ordering/persistence/provider contracts. The provider route must
  bind capability, quota, cost, latency, privacy, authorization, reservation,
  reconciliation, retry/fallback and decision/outcome receipts under
  `DYNAMIC_ROUTING_REQUIREMENTS.md`; static model lists, mocks and successful
  HTTP calls do not qualify runtime behavior. Do not claim universal
  hidden-window capture, process-private input or encrypted-content access.
- **DOD-14:** Cover actual navigation and nested/dynamic UI, all interactive
  controls, resize/DPI/zoom/scroll/drag/drop, input-length tiers, Vietnamese IME,
  accessibility, animation and backend effects. Before full implementation,
  direction records must contain reference provenance, alternatives, a
  measurable token seed, previews for major surfaces/states, independent
  critique, adversarial anti-slop findings, explicit user-review status and a
  record of candidate directions/rejected alternatives. A subjective “good
  taste” claim needs observable hierarchy, density, typography, contrast,
  alignment, state or interaction evidence.
  Combine code checks with repeated UI observations and addressable image/video
  evidence. Include negative, boundary, property/fuzz, race, recovery and
  resource tests where applicable; mark unsupported scenarios rather than
  passing them. Visual resemblance or a polished screenshot is not functional,
  accessibility or performance evidence.
- **DOD-15:** Verify GitHub account, exact target, visibility and license
  obligations. Review/redact secrets/private material before publication.
  Compare the remote SHA and test documented steps from a clean clone.
- **DOD-16:** Apply `SESSION-G01` through `SESSION-G07` in GOAL and record the
  source-bound decision in `SESSION_ADMISSION.json`. All seven must pass their
  named scoped/preservation/transfer conditions before `READY`; whole-product
  completion is not a chat admission prerequisite. Record each task/DoD
  prerequisite, snapshot, receipt, reviewer, limitations and every open task
  being transferred. Then create the requested Omnia chat. Its prompt must
  request an immediate detailed
  persistent goal with tasks/plan/specs/DoD and exact evidence status.
  Record the returned thread, exact prompt hash and activation/readback outcome.
  Creation, activation and whole-goal completion remain separate. A prepared
  prompt is not a created chat or an active goal. Failed/stale prerequisites
  reset admission to `DEFERRED`.

## Native QA batch acceptance and continuation

This scoped batch supports `DOD-03`, `DOD-06`, `DOD-07` and `DOD-11`.
It does not complete these parent gates or claim whole-product QA.

The QA/documentation batch is committed as
`952c211c219cb22fb851113139b66342d369c924` (r7/COMMIT.json). The post-commit
preview was launched and retained in r8. The r9 documentation correction is
committed as `828c9e8`; r10 now records scoped preservation/restore findings.
Neither documentation correction reruns the historical QA suites.
Before committing the correction, preserve before-bytes/hashes externally,
verify all 16 parent task and DoD IDs, 12 product leaves, seven admission gates,
transfer states, local references and JSON, and inspect the complete staged
diff. Session admission remains `DEFERRED`; parent gate states above stay
unchanged except the scoped DOD-05 progress recorded below. ROOT-02/ROOT-03 remain active.

- Bind the five affected QA entrypoints, both helpers, helper tests, native
  README and owning continuation documents to an explicit source manifest.
- Retain historical r5 receipts and the r7 failed executable-boundary
  reproducer separately from its passing rerun. Bind all seven r7 workflows
  (40/14/5/6/9/12/4 cases) and both fixture producers to their command, exit,
  output and script/executable hashes. Reuse only matching bytes and declared
  fixture scope; rerun a check affected by changed inputs.
- External executable/output, fixture/SQLite-sidecar, fresh-destination and reparse
  guards must agree with the named path tests. Capture must bind HWND, process
  creation and dimensions, restore DPI on success/failure and refuse overwrite.
- Verify exact staged paths, parsing, diff whitespace and document references
  before the logical commit. Keep logs, builds, databases, screenshots and
  recovery copies external to the product checkout.
- Preserve `QUALITY-01` findings: status-panel text clipping in the r7 session
  capture and smoke `Missing UIA control: Edit `. A capture API success or
  exit-0 smoke result does not resolve these findings.
- r8 has separate post-commit BASELINE, OBSERVATION and RETENTION receipts for
  the preview's process identity, command, image and deliberate retention.
  r9 reobserved the same live process identity and executable hash; it did not
  refresh r8's pixels/visibility. Reobserve before acting and preserve the
  preview for the user. These receipts cannot establish provider Send,
  physical input/IME, hidden/minimized capture, final design or performance.
- Record agent/reviewer identity honestly. A root readback or repeated test is
  not an independent final audit; the whole-goal streak remains **0**.

## Scoped preservation acceptance — r10

DOD-05 advances only to `PARTIAL`: the base snapshot and trailing-space
supplement are privately retained; R2 matches 20/20 Git-state comparisons for
three linked owners and nested Pydantic, and rereads 10,076 linked-owner regular
files. All three indexes were already captured; the missing-index diagnosis is
superseded. CHECKPOINT owns the exact evidence locators and counts.

DOD-05 remains `PARTIAL` after primary materialization: 172,415 ordinary files /
6,795,557,609 bytes and 23 supplement PNG files / 5,273,303 bytes have size/SHA-256
readback with no recorded errors. This receipt does not compare primary Git
state or complete the 1,029 excluded primary boundaries.

Require primary Git-state comparison, every excluded nested/Gitlink/reparse/generated
owner, consumer repair, source drift reobservation and independent scoped review
before retirement or SESSION-G02 PASS_PRESERVATION. Keep the 49 inherited rebuild
EOL/stat-cache findings and the accidental source sparse-checkout command
correction visible. Conditional status equality is not a clean-content verdict.
Semantic reconciliation, session admission and whole-goal audit streak remain
open/deferred/zero respectively. No historical test or fsck is relabeled as a
fresh run by this checkpoint.

## Final audit rounds

Before completion, run at least three independent end-to-end audits from the
same immutable tracked snapshot. Each must report zero unresolved errors or
warnings in scope; any new finding resets the counter. This cannot create
runtime evidence for features that remain unimplemented.

Use distinct reviewers or independent evidence collection with the same frozen
scope, documented oracle and complete main-scope coverage. Record round ID,
reviewer, source commit/tree and external input hashes, checks, errors, warnings
and findings. Three identical reruns or three summaries of one run are not three
independent audits. Prefer a full recheck after a finding; document any narrower
impact-based recheck and the unaffected-scope argument.

The default required streak is three; a risk-based plan may choose four or five.
Changing scope or a material input resets affected streaks. Whole-goal completion
requires every mandatory parent task and DoD gate, not merely a passing subset.
Current final streak: **0**. No finite test set proves absolute absence of bugs
or complete understanding of inaccessible history.

## Four-keyword research and cleanup acceptance — 2026-11-12

- **RESEARCH-04 — PASS (bounded discovery):** the four requested GitHub API
  searches each returned 100 star-descending repositories and preserved exact
  query URLs, retrieval timestamp, totals and repository metadata.
- **RESEARCH-05 — PARTIAL:** 16 unique top-five selections have canonical
  README/license/tree endpoint records and README hashes. This does not satisfy
  exhaustive repository, source, issue, comment, media or runtime review.
- **CLEAN-07 — PASS (reversible unit):** three ignored, untracked, non-reparse
  Cargo target directories were moved by exact path to external quarantine;
  file counts and logical bytes matched after readback.
- **CLEAN-08 — NO CAPACITY CREDIT:** the quarantine is on the same volume, so
  measured free-space delta is zero. It is not deletion, recycle-bin purge or
  proof that D: has recovered space.
- **CLEAN-09 — OPEN:** the child repository remains independently dirty with
  4,783 status entries and missing-directory warnings. No clean-child or
  flattening credit is earned.

The receipts and bounded source ledger are outside the product tree under
`C:\Users\khang\.codex\research\omnia-clean-2026-11-12`. A later cleanup unit
must preserve this denominator and re-observe status before acting; a clean root
control-plane checkout cannot substitute for child-repository acceptance.

- **CLEAN-10 — PASS (reversible unit):** `.pytest-cache` and `.pytest_cache`
  were moved by exact path to external quarantine after containment, tracked
  status and collision checks. Counts and logical bytes are bound in the
  pytest-cache receipt.
- **CLEAN-11 — NO CAPACITY CREDIT:** the pytest quarantine is on D:, so its
  measured free-space delta is zero. Producer provenance for the five-byte
  marker remains open.

## Graphify and dist acceptance — 2026-11-12

- **RESEARCH-06 — PARTIAL/PASS (bounded):** Graphify repository, README,
  license and complete recursive-tree response were recorded; README plus six
  canonical files were reviewed and hashed. The disposition is
  RESEARCH_ONLY; exhaustive repository, issue/comment/media/runtime review is
  explicitly out of scope.
- **CLEAN-12 — PASS (reversible generated unit):** dist moved by exact path
  to external quarantine after containment, ignore, tracked/status, reparse and
  active-process gates. 140 files and 6,924,863 logical bytes match after
  readback.
- **CLEAN-13 — NO CAPACITY CREDIT:** same-volume quarantine produced a 0-byte
  D: free-space delta. The exact reverse move is recorded; no deletion or
  recycle-bin claim is made.
- **CLEAN-14 — OPEN:** child repository remains dirty with active source,
  deleted/untracked extraction/profile material, nested/worktree boundaries and
  missing-directory warnings. A clean root control plane is not child-clean
  proof.


## Node dependency cleanup acceptance — 2026-11-12

- **CLEAN-15 — PASS (reversible generated unit):** `node_modules` moved by
  exact path after containment, ignore, tracked/status, reparse and process
  gates; 12,111 files and 194,672,966 bytes match after readback.
- **CLEAN-16 — NO CAPACITY CREDIT:** same-volume externalization produced a
  0-byte D: free-space delta. The reverse move and `npm ci` regeneration route
  are recorded; deletion was not performed.
- **CLEAN-17 — OPEN:** the child repository remains dirty and its remaining
  source, profile, extraction, nested/worktree and cache candidates need their
  own owner and restore evidence.

## OpenHands uv cache cleanup acceptance — 2026-11-12

- **CLEAN-18 — PASS (reversible generated unit):** the OpenHands uv cache moved by exact path after containment, ignore, tracked/status, reparse and process gates; 71,261 files, 2,083,312,334 logical bytes and 85,557 entries match after readback, and the source path is absent.
- **CLEAN-19 — NO CAPACITY CREDIT:** source and quarantine share D:, so the observed free-space delta is 0 bytes. The reverse move and uv regeneration route are recorded; deletion was not performed.
- **CLEAN-20 — OPEN:** child-repository dirtiness and all mixed-ownership, profile, nested-repository, worktree, source-deletion and meaningful-cache candidates remain unresolved. This unit does not establish child-repository cleanliness or full-drive reclamation.

## Root scratch quarantine — 2026-11-12Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.
