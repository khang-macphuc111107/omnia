# Omnia definition of done

Each row needs direct evidence from the current source snapshot. Plans, hashes,
fixtures, mocks, previews and agent messages are not substitutes for the
required evidence.

| ID | Definition | Required evidence | Current |
|---|---|---|---|
| `DOD-01` | Source is discoverable at root | Tracked tree, README and source-aware ignores | `PARTIAL` |
| `DOD-02` | Native dependency closure resolves | Locked metadata, path audit and clone metadata | `PARTIAL` |
| `DOD-03` | Scoped native behavior passes | Command logs, exit codes and environment | `PARTIAL` |
| `DOD-04` | Divergent work is reconciled | Per-path ledger, owner, disposition and review | `PARTIAL` |
| `DOD-05` | Nested Git/worktrees are safe | Snapshot, index/untracked/ignored capture and restore | `PARTIAL` |
| `DOD-06` | Generated output does not dirty source | Ignore policy, external target and status receipt | `PARTIAL` |
| `DOD-07` | Code is clean and maintainable | Format/lint/static review and ownership map | `PARTIAL` |
| `DOD-08` | D: cleanup is measured/reversible | Ownership, allocated bytes, candidate ledger and delta | `PARTIAL` |
| `DOD-09` | History corpus is bounded/honest | Watermark, denominator and missing/truncation ledger | `PARTIAL` |
| `DOD-10` | History has semantic review | Ranges, independent audit and redacted synthesis | `PARTIAL` |
| `DOD-11` | Handoff docs agree | Cross-reference validator and readback | `PARTIAL` |
| `DOD-12` | Skills/research are qualified | Query, revision, license, ranges and decision | `PARTIAL` |
| `DOD-13` | Native capabilities are real | Packaged/live receipts for each claim | `PARTIAL` |
| `DOD-14` | QA covers UI/security/performance/recovery | Independent negative/race/reload/resource evidence | `PARTIAL` |
| `DOD-15` | Public delivery is reproducible | Authenticated account, pushed SHA, clone and secret scan | `PARTIAL` |
| `DOD-16` | Follow-up chat starts with durable goal | Thread ID, prompt, activation receipt and checkpoint | `READY` |

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
  `RESEARCH_ONLY`; exhaustive repository, issue/comment/media/runtime review is
  explicitly out of scope.
- **CLEAN-12 — PASS (reversible generated unit):** `dist` moved by exact path
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

## Root scratch quarantine — 2026-11-12

Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.

## Wave 2 scoped verification acceptance — 2026-11-12

Independent audit `OMNIA-FINAL-VERIFICATION-20261112` (`D:\OmniaData\qa\audits-20261112\FINAL_VERIFICATION_RECEIPT_20261112.json`) verified all scoped Wave 1 and Wave 2 lanes with **`0` open defects**, advancing `DOD-04`, `DOD-07`, `DOD-08`, `DOD-10`, `DOD-12`, `DOD-13` and `DOD-14` to **`PARTIAL`** while keeping `DOD-15` `OPEN` (pending remote push and independent clean-clone test), `DOD-16` `DEFERRED`, and whole-goal final audit streak at **`0`**:

- **`DOD-03` / `DOD-07` / `DOD-13` / `DOD-14` (Scoped Rust & Native Win32 QA — PASS within scope):**
  - `cargo fmt --all --check` and `cargo check --locked` exited `0` across both `native/Cargo.toml` and `src-tauri/Cargo.toml`; **`524/524` locked Cargo tests passed** (`omnia-provider-services` `31`, `omnia-harness` `393`, `omnia-session-store` `71`, `omnia-native` `29`) using external `$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'`.
  - All **`7/7` external Win32 PowerShell QA workflows (`90/90` cases, `rc=0`)** passed under `D:\OmniaData\qa\native-20261112\QA_SUITE_SUMMARY_RECEIPT.json` against `debug\omnia-native.exe` (`42e405d2...`) and `release\omnia-native.exe` (`65944d86...`):
    - Resolved historical r7 `Missing UIA control: Edit ` (`qa-smoke.ps1` `4/4`, **`"uiaIssue": null`** via server-side COM `IRawElementProviderSimple` + `IValueProvider` in `native/src/uia_edit.rs`).
    - Resolved historical r7 status-panel text clipping (`0` clipping in pixel-inspected `1220x820` `smoke` and `session` captures).
    - Resolved `#46` non-foreground `#32770` modal `MessageBoxW` UIA `InvokePattern.Invoke()` failure (`qa-guard.ps1` `12/12` `rc=0` via thread-scoped `WH_CBT` `HCBT_ACTIVATE` `modal_message_box` + duplicate-subclass guard).
  - Three offline interactive UI direction candidates + `docs/ui-direction/DIRECTION_DECISION.md` passed anti-slop and `24/24` WCAG 2.2 contrast checks (`>= 5.78:1`), remaining `PENDING_USER_REVIEW`.
  - Live third-party provider billing/streaming, physical Vietnamese IME/Narrator E2E runs, WebView-free Browser/IDE engines, and packaged release CPU/RAM/GPU benchmarks remain required to close `DOD-13` and `DOD-14` in full.
- **`DOD-04` / `DOD-05` / `DOD-08` (Reconciliation, Worktrees & `D:\` Reclamation — PARTIAL):**
  - `138/138` differing focus rows in `SOURCE_DISPOSITION_LEDGER.json` have reviewed dispositions (`127` `incorporated`, `8` `superseded-with-evidence`, `3` `retained-recovery`, `0` `unreviewed`) and `84/84` unique source-delta files/patches are SHA-256 verified in `D:\OmniaData\recovery\unique-source-deltas-20261112\`.
  - `12` root clutter directories (`187,694` files) moved to `D:\OmniaData\externalized-20261112\` (`0` capacity credit); `publish-worktree` and `repos\omnia` relocated to `D:\OmniaData\` and repaired across all `4` checkouts (`retirementEligible=false` preserved for excluded primary boundaries and `D:\Omnia\Roaming` orphaned-SID `WinError 5`).
  - Reclaiming `4` proven regenerable quarantined build caches (`96,461` files / `13,216,664,383` logical bytes) increased `D:\` free space by **`+10,871,586,816` bytes (`+10.125 GiB`)** (`61.05 GiB -> 71.175 GiB`).
- **`DOD-09` / `DOD-10` / `DOD-11` / `DOD-12` (History, Handoff, Skills & Research — PARTIAL):**
  - `1,767`-file multi-host history watermark hashed (`PASS_ZERO_LEAKS` across `294` exported/handoff files); `tools/agy-history-sync/` (`5/5` tests `OK`) synchronized AGY Desktop (`144/144`), AGY CLI (`126/126`), and unified FTS5 (`1,102` threads) with `0` ghost records (`18` active swarm DBs excluded).
  - `103/103` flagship URLs + `8` REA URLs + `github/spec-kit` (`v1.4.0`) qualified; `12` curated skills synced byte-identically across Codex and `.agents/skills/` (`24/24` `quick_validate.py` `PASS`), `100`-category / `1,001`-skill catalog extracted to `omni-deep-1000-catalog.json`, and 8 navigable workspace index files bound in [STATUS.md](STATUS.md).

## Wave 3B delivery, clean-clone & admission acceptance — 2026-11-12

- **`DOD-01` / `DOD-02` / `DOD-06` / `DOD-15` (GitHub Delivery & Independent Clean Clone — `PARTIAL`, `SESSION-G01` & `SESSION-G06` `PASS_SCOPED`):**
  - Authenticated private repository `https://github.com/khang-macphuc111107/omnia` created under `khang-macphuc111107` and pushed with Commit #1 `d8b456e357dde65d8ee314194743fb93655f5d6a` (tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb`, `2,039` tracked files; zero secrets `PASS_ZERO_LEAKS` `sha256=883739f6...`).
  - Independent remote GitHub clone and isolated `--no-local --no-hardlinks` local clone verified in `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` (`sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`): locked Cargo metadata (`rc=0`), `cargo fmt --all --check` (`rc=0`), `524/524` Cargo tests (`rc=0`), `5/5` `agy_history_sync` unit tests (`rc=0`), and `12/12` `.agents/skills/*` `quick_validate.py` checks (`rc=0`).
  - `DOD-15` remains `PARTIAL` only for user-managed collaborator invitation (`HTMusTC` Discord handle -> GitHub username under `/settings/access`) and any future public-visibility release decision.
- **`DOD-14` (Release Native Shell Telemetry — `PARTIAL`):**
  - `release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d86...`) verified in `native-shell-cycle24-runtime.json` (`sha256=1a4aa5cac935a76687432cb9ccf54fb4e390c2ef50cfc26c95b545fb9dd93a77`) and `native-shell-cycle24-window.png` (`sha256=68b669ce7e26e0d9abe2836490ca78f9566184607c7903d81e259a7f4e0c7ded`): `15.79 MiB` working set (`16,560,128 B`), `0.0%` idle CPU, `163.2 ms` window discovery, `uiaIssue: null`, cleanly terminated inside Antigravity's isolated `exebox-*` desktop (`0` orphan processes).
- **`DOD-16` & 3-Round Frozen Audit Protocol (`SESSION-01` -> `READY`):**
  - All seven gates `SESSION-G01..G07` in [SESSION_ADMISSION.json](SESSION_ADMISSION.json) are now satisfied (`decision: "READY"`, `promptSha256=ef94c52e0c68763aecf8c94dd650ed396a987c8e402d1131bcb1f7a3e54de592`). Advancing `DOD-16` to full `PASS` (`LAUNCHED`) requires creating the follow-up chat with [NEXT_SESSION_PROMPT.md](NEXT_SESSION_PROMPT.md) and recording its `threadId` and persistent-goal activation readback.
  - Three independent read-only audit rounds against Commit #2's frozen `HEAD === origin/master` snapshot write external receipts to `D:\OmniaData\qa\audits-20261112\final-streak-3\` so audit evidence never self-mutates tracked repository hashes.
