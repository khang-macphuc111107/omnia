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
| `DOD-16` | Follow-up chat starts with durable goal | Thread ID, prompt, activation receipt and checkpoint | `PARTIAL` |

## Gate protocol

Record `before`, exact command/inspection, `after`, hashes, reviewer,
limitations and next action for each row. Any missing evidence remains
`OPEN`/`PARTIAL`. A source change, failed check, drifted hash, missing record
or contradiction resets the affected row and its consecutive-audit count.

## Acceptance details

- **DOD-01:** Source is tracked at the actual root; README and AGENTS resolve
  to current files. Bulk archives, upstream clones and recovery data have
  deliberate external ownership. Ignoring a folder does not count as moving it.
- **DOD-02:** Root [`Cargo.toml`](../../Cargo.toml) + [`Cargo.lock`](../../Cargo.lock) (`18` Rust crates under `rust/`, incl. `omnia-computer` + POSIX `libsqlite3` foundation in `omnia-winsqlite/src/ffi.rs`) resolve cleanly `--offline --locked` in an isolated clone/export using Windows 11 SDK (`winsqlite3`, `windows-sys`, `windows`) with zero network downloads and external `CARGO_TARGET_DIR` (Wave 4 C++20 snapshot archived in `D:\OmniaData\backups\pre-full-rust-20261115\`; earlier pre-Wave-4 snapshot archived on tag `archive/pre-cpp-rust-snapshot-20261112`). Local developer caches are not repository inputs.
- **DOD-03:** Match each claimed native behavior to an executed oracle. Report fixtures, `cargo test --workspace --offline --locked`, `pwsh -File native/qa-*.ps1`, and live provider/Studio/packaged behavior separately.
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
- **DOD-13:** Cover all `PRODUCT-*` leaves in GOAL. **Full Native Rust** (`18`-crate Cargo workspace under `Cargo.toml` / `rust/`, expanded from `13` -> `17` -> `18` crates with `omnia-computer` alongside `tools/omnia-benchmark` & `tools/omnia-gemini-extractor`) is the canonical active runtime; any external runtime exception requires a recorded resource-backed reason. Complete composer and
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
  - All **`7/7` external Win32 PowerShell QA workflows (`90/90` cases, `rc=0`)** passed under `D:\OmniaData\qa\native-20261112\QA_SUITE_SUMMARY_RECEIPT.json` against `debug\omnia-native.exe` (`42e405d2...` at Wave 2 QA execution time; relinked to `d2f7edf1...` during Wave 3B clean-clone `cargo test`) and `release\omnia-native.exe` (`65944d86...`):
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
  - Authenticated private repository `https://github.com/khang-macphuc111107/omnia` created under `khang-macphuc111107` and pushed with Commit #1 `d8b456e357dde65d8ee314194743fb93655f5d6a` (tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb`, `2,039` tracked files; zero secrets `PASS_ZERO_LEAKS` `sha256=f89557e4...`).
  - Independent remote GitHub clone and isolated `--no-local --no-hardlinks` local clone verified in `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` (`sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`): locked Cargo metadata (`rc=0`), `cargo fmt --all --check` (`rc=0`), `524/524` Cargo tests (`rc=0`), `5/5` `agy_history_sync` unit tests (`rc=0`), and `12/12` `.agents/skills/*` `quick_validate.py` checks (`rc=0`).
  - `DOD-15` remains `PARTIAL` only for user-managed collaborator invitation (`HTMusTC` Discord handle -> GitHub username under `/settings/access`) and any future public-visibility release decision.
- **`DOD-14` (Release Native Shell Telemetry — `PARTIAL`):**
  - `release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d86...`) verified in `native-shell-cycle24-runtime.json` (`sha256=1a4aa5cac935a76687432cb9ccf54fb4e390c2ef50cfc26c95b545fb9dd93a77`) and `native-shell-cycle24-window.png` (`sha256=68b669ce7e26e0d9abe2836490ca78f9566184607c7903d81e259a7f4e0c7ded`): `15.79 MiB` working set (`16,560,128 B`), `0.0%` idle CPU, `163.2 ms` window discovery, `uiaIssue: null`, cleanly terminated inside Antigravity's isolated `exebox-*` desktop (`0` orphan processes).
- **`DOD-16` & 3-Round Frozen Audit Protocol (`SESSION-01` -> `READY`):**
  - All seven gates `SESSION-G01..G07` in [SESSION_ADMISSION.json](SESSION_ADMISSION.json) are now satisfied (`decision: "READY"`, `promptSha256=d277af284a6e2d8716f9ccb77ef07a16326321d53b725520c4499015d8619cfb`). Advancing `DOD-16` to full `PASS` (`LAUNCHED`) requires creating the follow-up chat with [NEXT_SESSION_PROMPT.md](NEXT_SESSION_PROMPT.md) and recording its `threadId` and persistent-goal activation readback.
  - Three independent read-only audit rounds against the pushed frozen `HEAD === origin/master` snapshot write external receipts to `D:\OmniaData\qa\audits-20261112\final-streak-3\` so audit evidence never self-mutates tracked repository hashes.

## Wave 3 3-round clean audit & Wave 4 C++20, Flagship Studio UI and C:/D: deep-clean acceptance — 2026-11-12

- **Pre-C++20 3-Round Audit Closure (Archived on `archive/pre-cpp-rust-snapshot-20261112`):**
  - Commit #3 (`c3033728abe6f0a4906a796bf7652c84408356d7`) earned **3/3 consecutive zero-finding independent audits** (`D:\OmniaData\qa\audits-20261112\final-streak-3\round-{1,2,3}-v2-receipt.json`, `errors=0, warnings=0`) before the explicit Wave 4 user C++20 migration reset the active snapshot streak for Commit #5 per Gate Protocol (`DOD.md` line 30).
- **`DOD-01` / `DOD-02` / `DOD-03` / `DOD-06` / `DOD-07` / `DOD-13` / `DOD-14` (Wave 4 Native C++20 & Flagship Studio UI — `PARTIAL`, `0` Open Scoped Defects):**
  - Independent audit `FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json` (`sha256=0e776c268a90fd712d390f3427a26bc503641438439cd69411c4221fd4ba47fc`) verified **`7/7` Wave 4 lanes with `0` open defects**: `0` `.rs` and `0` `Cargo.*` files in `D:\Omnia`, MSVC `19.51` `/std:c++20 /utf-8 /EHsc /W4 /WX` `0` warnings, **`35/35` unified CTest cases passing** (`6` `cpp/` core/HTTP suites + `29` `native/` cases), **`7/7` Win32 PowerShell QA workflows (`90/90` cases `rc=0`)** (`QA_SUITE_SUMMARY_RECEIPT.json` `sha256=6f668cb0...`, `uiaIssue: null`, `WH_CBT` `#32770` modal button `IInvokeProvider`, `0` status-panel clipping), and Flagship Studio UI (`ui/` + [FLAGSHIP_STUDIO_UI_SPEC.md](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md) `sha256=db381ed0...`, `87/87` WCAG 2.2 pairs `>= 5.12:1`, `45/45` Edge CDP states `maxOverflowX = 0 px`, live `12/12` `omnia-studio.exe` `/api/*` endpoints).
  - Live third-party LLM API billing/streaming, physical Vietnamese IME/Narrator E2E runs, and packaged cold-machine benchmarks remain required to close `DOD-13` and `DOD-14` in full.
- **`DOD-08` (Exhaustive `D:\` + `C:\` Deep-Clean Reclamation — `PARTIAL`):**
  - `D:\` reclaimed **`+778.1512 GiB` physical** (`59.42 GiB -> 837.57 GiB` free; [DEEP_CLEAN_AUDIT_D_DRIVE.md](DEEP_CLEAN_AUDIT_D_DRIVE.md) `sha256=a51f017a...`, `D_DRIVE_DEEP_CLEAN_RECEIPT.json` `sha256=70f2781d...`) and `C:\` reclaimed **`+166.1357 GiB` physical** (`23.47 GiB -> 189.60 GiB` free; [DEEP_CLEAN_AUDIT_C_DRIVE.md](DEEP_CLEAN_AUDIT_C_DRIVE.md) `sha256=1a88e1fe...`, `C_DRIVE_DEEP_CLEAN_RECEIPT.json` `sha256=ee08c5a0...`) = **`+944.29 GiB` physical** with `0x400` reparse guards (`4/4` worktrees healthy, `retirementEligible=false` preserved).
- **`DOD-12` / `DOD-15` / `DOD-16` (`13` Skills, Commit #5 Clean-Clone CTest & Session Admission `READY`):**
  - `13/13` curated skills (`deep-cpp-native` `sha256=b87fd5ca...`) synced 4-way (`39/39` `quick_validate.py` `rc=0`, `cpp-skill-sync-receipt.json` `sha256=27df8cf8...`); `SECRET_SCAN_VERIFICATION.json` (`sha256=a01b88f6...`, `leak_count=0`).
  - Commit #5 pushed to `https://github.com/khang-macphuc111107/omnia` and verified via fresh remote GitHub clone + out-of-source Release C++20 build + `35/35` `ctest --output-on-failure` in `D:\OmniaData\qa\github-cpp20-clean-clone-20261112\GITHUB_CPP20_DELIVERY_RECEIPT.json` (temporary clone/build dirs immediately purged). [SESSION_ADMISSION.json](SESSION_ADMISSION.json) remains **`READY`**.

## Wave 6 (`v5.1.0` / `Steer #24–#25`) 18-crate SOTA integration & `AUD-02/24/25` closure acceptance — 2026-11-28

- Prior frozen milestones (`c3033728` Wave 3 `3/3`, `FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json` on archived C++20, and Steer #15–#21 `6a82180` `3/3` consecutive cleanroom rounds) remain snapshot-scoped historical evidence (`SESSION_ADMISSION.json` stays `DEFERRED`, whole-goal final audit streak = **`0`** on the uncommitted `v5.1.0` integration working tree over `1c9342c`).
- **`DOD-01` / `DOD-02` / `DOD-03` / `DOD-06` / `DOD-07` / `DOD-13` / `DOD-14` (`18`-Crate Rust, UI & Tooling — `PARTIAL` Pending 5 Live Win32 QA + Commit + 3x Cleanroom):**
  - `18` Rust crates (`+omnia-computer`), `cargo check --workspace --all-targets` PASS, `3/3` `clippy --all-targets -- -D warnings` clean (`--workspace`, `omnia-cli`, `omnia-studio --features embed-ui`), and **`734 passed, 0 failed, 1 ignored`** across `50` suites (`omnia-cli` `20/20`, `omnia-studio --features embed-ui` `34/34`), with `5/5` release binaries staged externally (`omnia.exe` `12.763 MiB <= 14 MiB` + `5/5` smoke checks `0.11 ms` / `5.71 MiB` RSS; `omnia-studio.exe` `36.413 MiB`; `omnia-runtime.exe` `15.757 MiB`; `omnia-native.exe` `0.366 MiB`; `omnia_qa_seed.exe` `0.222 MiB`).
  - `ui-v5` built cleanly (`2,564` modules -> `D:\OmniaData\build\ui-dist`); modular fallback `ui/` passes **`127/127`** `node --test`; PR #1 **`AUD-02`, `AUD-24`, `AUD-25` closed (`32/32`)**; `qa-paths.tests.ps1` (`40/40`) and `qa-capture.tests.ps1` (`14/14`) pass on staged `omnia-native.exe`.
  - Issue #8 (`container_runner.py`, `47/47` benchmark tests PASS) keeps Dockerless `Terminal-Bench 4.1` and `SWE-bench Verified/Pro` honestly in `DEFERRED_BOUNDARY`; Issue #10 (`#[cfg(not(windows))] #[link(name = "sqlite3")]` + `platform/targets.json` `14/14`) establishes POSIX foundation without claiming Linux/macOS binary release verification on this Windows host.
- **`DOD-09` / `DOD-10` / `DOD-11` / `DOD-12` / `DOD-15` / `DOD-16` (`PARTIAL` / `DEFERRED`):**
  - `22/22` shards of `mega-deep-read` complete externally in `D:\OmniaData\research\mega-deep-read-20261128\`; `22/22` synced skills (`0` drift) + `16/16` bilingual golden eval PASS; `audit.py --secret-scope all` finds `0` secrets across `1,189` files (`0` CRLF, `0` TWS); `git diff --check` exits `0`.
  - Remaining gates before next frozen tag / admission: live execution of `qa-{smoke,session,paging,guard,ownership}` on staged `v5.1.0` binaries, `git commit` of `v5.1.0` (`18` crates incl. `rust/omnia-computer/`, closing `stage-public-release.test.mjs` `#10` currently at `9/10`), and **`3` consecutive independent frozen-snapshot Cleanroom Audit Rounds** (`DOD-16` / `SESSION_ADMISSION.json` `DEFERRED`).

## Wave 5 (`Steer #14..#23`) Full Native Rust 17-crate, Omnia v5, PR #1, Full-Freedom YOLO & AI Studio/Canvas/NotebookLM++ closure gating — 2026-11-24..2026-11-28

- Historical Wave 3 (`3/3` clean streak on `c3033728...`), Wave 4 (`FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json` on archived C++20), and Steer #15–#21 frozen milestone **`6a82180769e9147c1d452e40a9a36e06f0561c18`** (`3/3` consecutive zero-defect Cleanroom Audit Rounds in `cleanroom-round-{1,2,3}.json`, `0` errors / `0` warnings) remain preserved as snapshot-scoped evidence (`D:\OmniaData\backups\pre-full-rust-20261115\`). Through commit **`a41c4d6`** (`05eafbb` Steer #22+#23 code/UI -> `2f61380` Canvas Drawer + `qa-capture` IME -> `a41c4d6` all 5 Win32 QA IME fixes), all 5 implementation & Phase 4 live verification layers below have passed `100%`, leaving only the final frozen `dirty_total: 0` commit and a fresh **3 consecutive independent cleanroom audit streak** before `SESSION_ADMISSION.json` advances from `DEFERRED` to `READY`:
  1. **Unified 17-Crate Out-of-Source Cargo Verification (`PASS` at `05eafbb` / `2f61380` / `a41c4d6`)**: `CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace`, `3/3` `clippy --all-targets --offline --locked -- -D warnings` clean (`--workspace`, `omnia-studio --features embed-ui`, standalone `omnia-cli`), **`575/575`** workspace Rust tests + `27/27` `embed-ui` + `15/15` standalone `omnia-cli` PASS (`196` Rust files, `0` `.cpp`/`.hpp`/`CMake*` in-tree, `0` new external crates), and `5/5` release binaries staged (`omnia.exe` `12.389 MiB <= 14 MiB` SHA-256 `5EFB97E4...` / warm 10x `--version` median `8.29–10.40 ms <= 15 ms`, `omnia-studio.exe` `embed-ui` `35.695 MiB` SHA-256 `6A771FFA...`).
  2. **Win32 Native QA, ConPTY TUI & CLI v5 Runtime (`PASS` at `a41c4d6`)**: `native-qa-final` **`7/7` `pwsh` Win32 QA (`90/90` `rc=0`)** with `QUALITY-01` closed (`uiaIssue: null` asserting BOTH `Edit` `114` & `Document` `112`) and Windows 11 Vietnamese IME `UAC_InputIndicatorOverlayWnd` resilience (`Find-OmniaQaMainWindow`/`Close-OmniaQaWindow`) across all 7 scripts; `diag_tui_pty.py` (`RC=0`, `YOLO · AUTO | FOCUS:CODE | GEM:STD`, `/arena /persona /focus /fork`, `budget:NULL`); `parallel/cli_v5_steer22_23.json` (`16/16` gates PASS incl. default `yolo`, `omnia arena --offline --json` `3/3` honest, `--acp`, `omnia net`, `omnia skills doctor|route|pipelines`, `omnia rag sources|status|ingest|query`, `omnia lifecycle`, `omnia think`, `omnia research`).
  3. **Isolated 4×4 4x-CPU Playwright E2E, Full-Stack & PR #1 UI (`PASS` at `2f61380` / `a41c4d6`)**: `wave4-playwright-oracle.json` (`PW_RC=0`, `MICA_RC=0`, **`16/16`** 4 themes × 4 viewports WCAG `>= 5.94:1`, `0px` overflow, `layoutContinuityOk: true`, **`defaultSoloOk: true`**, **`arenaOk: true`**, **`canvasDrawerOk: true`**, `lifecycleLinkOk: true`, `hasRealV5Scoreboard: true` `#1 omnia 90.8% (69/76)`, `0` console/page/4xx/5xx/external errors); `wave4-steer22-23-fullstack.json` (`9/9` Steer #22 YOLO + Steer #23 Arena/Elo/Gems/Estimate/Branches/Fork/ResearchAnswer/Atelier v2 + `Origin: 403` + OmniDrive non-bypass); `wave4-final-systems.json` (`14/14`); `wave4-steer17-fullstack.json` (`13/13` `/api/v5/*`); `wave4-steer18-20-fullstack.json` (`RC=0`); modular fallback `ui/` (`f76b4a5`, `59/59` `node --check`, `11/11` suites `119/119` `node --test`).
  4. **Tools, Platform Packaging, PR #1 `AUD-01..32` & Canonical Benchmarks (`PASS`)**: `parallel/post_05eafbb_audit.json` (`13/13` PASS: `10/10` Python tool suites `179/181`, `2` zstd-skipped, `0` failures, `0` `__pycache__`, incl. `platform` `14/14` closing `TRK-06` and `agy-history-sync` `AUD-30`/`AUD-31` `7/7`, plus `maintained-scripts` `10/10`); PR #1 `pr1_audit_checklist.json` v1.1 **`29/32` `VERIFIED_PASS`**, `2` `PARTIAL_IN_RUST` (`AUD-02` `omnia-studio/src/http.rs` alternate loopback port, `AUD-25` UI capability matrix), `1` `OPEN_PRODUCT_ENHANCEMENT` (`AUD-24` chat cancel UX); and canonical `FINAL_SCOREBOARD_V5` audited PASS (`wave3-final-audit.json` `6/6` scopes `finding_count: 0`, `793` trials/rows, `51/51` models probed, Suite v5 `#1 omnia 69/76 = 90.79%`, `0` `agy`, `0` leaks, `0` secrets, honest Dockerless `DEFERRED_BOUNDARY` for `Terminal-Bench 4.1` & `SWE-bench`).
  5. **`22/22` Cross-Host Skill Parity & Strict Audit Hygiene (`PASS`)**: `validate_skills.py --strict-all-skills` (`22/22` valid: `16` curated + `6` `kdense-*`, `0` drift), `skill_router.py golden-eval` (`16/16` `100%`), and `audit.py --secret-scope all --strict --strict-scope full` (`strict_ready: true`, `0` secrets/CRLF/BOM/non-UTF8/TWS/overlaps/in-tree clutter).
  6. **Fresh 3 Consecutive Independent Frozen-Snapshot Cleanroom Audit Rounds (`PENDING_FINAL_FREEZE`)**: Execute `cleanroom-round-{1,2,3}.json` (including isolated `--no-local --no-hardlinks` clean clone) on the final frozen post-Steer-#23 `dirty_total: 0` commit (`0` findings, `0` warnings) before advancing `SESSION_ADMISSION.json` to `READY`.
