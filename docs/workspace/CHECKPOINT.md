# Omnia checkpoint — 2026-11-12, continuation revision 9 (Wave 3B delivery & session admission)

## Resume here

- Goal `OMNIA-ROOT-CLEAN-2026-11-11` remains **ACTIVE**. Read [GOAL.md](GOAL.md)
  for the objective, 16 parent tasks, 12 product leaves and seven chat-admission
  gates; read [DOD.md](DOD.md) for acceptance and the independent audit rule.
- Persistent tool goal was read active in this chat. Its API has no active
  objective-edit operation; GOAL revision 8 owns the detailed objective.
- Additive steer is queued: finish the interrupted deliverable, checkpoint
  its next action, then consume additions in order. Corrections affecting
  current correctness apply at a safe boundary. Explicit cancellation or
  incompatible replacement supersedes only the named work.
- Inspected committed baseline: `177bfbd0ddba226974e8da13975cd86d288370a7`,
  tree `13609bdf58e72d964e0e8e05d2a1d5e2f7650a56`, branch `master`,
  `docs: checkpoint scoped source preservation`.
  R10 checkpoint-r4 freshly observed clean root status and no staged paths.
  The r7 QA and r9 documentation are committed; `8d2ad69` remains the earlier
  layout milestone. The receipt for this logical preservation checkpoint belongs
  in external `continuation-r10-source-preservation/checkpoint-r4`, avoiding a
  self-hash update. No product implementation is changed by this document batch.
- Pushed GitHub baseline (Commit #1): `d8b456e357dde65d8ee314194743fb93655f5d6a`,
  tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb`, `2,039` tracked files on
  `https://github.com/khang-macphuc111107/omnia` (`origin/master`), verified by
  independent remote & local clean clones (`GITHUB_DELIVERY_AND_CLONE_RECEIPT.json`,
  `sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`).
- Session admission in [SESSION_ADMISSION.json](SESSION_ADMISSION.json) is now
  **`READY`** (`SESSION-G01..G07` satisfied against `d8b456e357dde65d8ee314194743fb93655f5d6a`,
  `promptSha256=ef94c52e0c68763aecf8c94dd650ed396a987c8e402d1131bcb1f7a3e54de592`; follow-up chat `threadId` not yet launched).
  Three independent read-only final audit rounds against Commit #2's frozen
  `HEAD === origin/master` snapshot record receipts externally under
  `D:\OmniaData\qa\audits-20261112\final-streak-3\` without mutating tracked files.

## Completed QA batch and current documentation ownership

The r7 intake observed these exact intentional QA changes, all preserved in
external `continuation-r7/before` before document edits:

| State at intake | Paths |
|---|---|
| Modified | `native/README.md`, `native/qa-guard.ps1`, `native/qa-ownership.ps1`, `native/qa-paging.ps1`, `native/qa-session.ps1`, `native/qa-smoke.ps1` |
| New, untracked | `native/qa-capture.ps1`, `native/qa-capture.tests.ps1`, `native/qa-paths.ps1`, `native/qa-paths.tests.ps1` |
| Owning documents repaired in r7 | `GOAL.md`, `DOD.md`, this checkpoint |

All of that logical batch is in commit `952c211`; r7/COMMIT.json records its
successful commit and clean status. These paths are historical intake states,
not a claim that they are currently dirty. The r9 three-document correction is
committed as `828c9e8`. The prior r10 preservation checkpoint is committed as
`177bfbd`, with before-bytes and receipts under external `checkpoint-r3`.
The current bounded deliverable records primary materialization in the existing
goal/DoD/disposition/admission/prompt/decision consumers. It preserves the complete
task, product, DoD, research and admission denominators. The present checkpoint
uses external `checkpoint-r4` for before-bytes, commands, checks and its commit
receipt.
The first baseline's unquoted `HEAD^{tree}` failed PowerShell argument parsing;
`BASELINE-CORRECTED.json` uses the quoted argument and records the actual tree.
The failed partial baseline is retained and supplies no tree evidence.

Root integrator owns this serialized integration. Logs, captures, SQLite
fixtures, executable targets, contracts and before/after receipts stay outside
`D:\Omnia`. Git history owns the prior tracked bytes; external baseline copies
own the pre-existing uncommitted QA bytes. No old checkout metadata is retired.

## Scoped QA evidence

Private receipt root:
`C:\Users\khang\.codex\research\omnia-restructure\20261111\handoff-intake`.
`continuation-r7` contains the recorded command/exit/stdout/stderr rerun receipts.
They are historical checks, not newly executed by this documentation batch:

| Check | Cases | Result receipt | Scope |
|---|---:|---|---|
| QA paths | 40 | `path-contract-rerun.result.json` | Isolated path fixtures; no product execution |
| Capture helper | 14 | `capture-contract-rerun.result.json` | Actual native window, ownership/DPI/overwrite/bounds/exit negatives |
| Session | 5 | `session-rerun.result.json` | Synthetic metadata, settings and reopen via UIA |
| Ownership | 6 | `ownership-rerun.result.json` | Cooperative store exclusion, preserved owner and successor reopen |
| Paging | 9 | `paging-rerun.result.json` | 125-row synthetic fixture, navigation and pending writer |
| Unsaved-form/selection guard | 12 | `guard-rerun.result.json` | Unsaved metadata, discard/cancel and failed-selection preservation |
| Smoke | 4 | `smoke-rerun.result.json` | Mode/draft/unsaved-close via control messages; UIA warning retained |

All seven named rerun receipts record exit 0. Separate paging and guard
fixture-producer receipts also record exit 0. Each wrapper binds all nine QA
script hashes and the external executable. The final smoke rerun finished
`2026-11-10T22:08:06.3266916Z`. No Rust application rebuild occurred.
Historical r5 receipts stay historical. Native QA entrypoints
now share `qa-paths.ps1` and `qa-capture.ps1` instead of writing captures and
fixtures under the source tree. The capture helper uses one DPI-unaware
geometry/capture space, limits dimensions, refuses overwrite, rechecks owner
and bounds, and restores caller DPI in `finally`.

Bound external debug executable:
`C:\Users\khang\.codex\cache\omnia-root-native-target\debug\omnia-native.exe`.
SHA-256: `1CA3C8A98B81F733B5588D283D7EAECA4FA243DE81847CE5014D0E64F862172F`.
Capture helper: `486644EFD7C2AD8BCC974AF1F2A815C056D228635D82443668D71EB9B934B228`.
Repaired path helper:
`E78DD779761CB19567A093547138C90537B500FAF36EEF53A6F098891C67B240`.
Path tests:
`87EC7B99464CAFB0FB713C4540959BFE13577A3505618E1E760AA7EC5D2187BA`.
The r7 source/evidence manifest binds the final batch and records reuse limits.

### Executable-boundary repair

Root review found that an absolute executable inside the product repository
was accepted. The new negative case first failed with exit 1, retained as
`path-contract-r7.result.json` and its stdout/stderr. The helper now routes the
executable through `Resolve-OmniaQaExternalPath`; the 40-case rerun and every
affected native QA workflow passed against external fixtures. The failed
receipt is neither overwritten nor counted as passing. Location guards do
not establish that an arbitrary external executable or database is trustworthy.

### Open visual/accessibility findings

- The large right/bottom black padding in the earlier r4 capture was repaired.
  The inspected r7 session image is 1220 × 820; API success, dimensions and hashes
  alone do not prove complete rendering.
- The r7 session capture still clips status-panel text near the bottom.
  Keep this open under `QUALITY-01`; it is not a flawless screenshot.
- Smoke retains `uiaIssue: "Missing UIA control: Edit "`. Its exit-0 control-
  message cases are not a passing native accessibility assessment.
- None of these receipts establishes provider Send/streaming/cancel, final UI,
  persistent composer/transcript/attachments, browser/IDE, physical keyboard,
  Vietnamese IME, Narrator, hidden/minimized capture, process-private input,
  DPI/resize matrix, packaged performance or absolute absence of bugs.

## Preview and active commands

Continuation-r6 records that old preview PID `2272` was stopped during resume;
the r7 baseline then observed no `omnia-native.exe`. After commit `952c211`,
continuation-r8 launched and retained a replacement evaluation shell:

- PID `38256`; start UTC `2026-11-10T22:22:44.9797906Z`; HWND `3014860`.
- Executable is the external debug binary bound above; working directory
  `D:\Omnia`; no `--session-db` was supplied.
- r8/BASELINE.json, OBSERVATION.json and RETENTION.json own the launch,
  visibility and retention evidence. The recording failure involving read-only
  `$PID` occurred after launch; recovery identified the existing process and
  recorded it without launching a duplicate.
- r8 observed visible/responding/not minimized/not foreground. Capture:
  `D:\OmniaData\qa\native\continuation-r8\native-preview-r8-window.png`,
  1220 × 820, SHA-256
  `460541807FA61BD2BCDE78E2A8468A675826BDCE05B445B6A8EB96178E37199F`.
- r9/PREVIEW-REOBSERVATION.json, recorded
  `2026-11-10T22:47:09.5471586Z`, found the same PID/start/path/hash/HWND,
  alive and responding. This is a process check; visibility and pixel state
  still have r8's observation time.

Preserve this preview for the user. Reobserve identity before acting, relaunching
or stopping it. No persistent terminal command session is owned here. The
evaluation shell reports provider delivery, storage and draft persistence
disconnected; this is not a final UI or working provider-chat qualification.

## Source closure and reconciliation

Actual product source is tracked at `D:\Omnia`: independent `native/`, shared
`src-tauri/crates/` and retained React/Tauri compatibility source. Native
admission verified 197 files / 2,588,993 bytes. Root admissions are committed;
this is still not a semantic merge of primary/release/rebuild/goal-control work.
Both local manifest/format checks passed. Native tests passed their recorded
suites. The repaired Tauri root rerun ended `2026-11-10T19:43:52.8602675Z`,
exit 0: 833 host unit tests, 6 project-file-watch tests and 4 + 17 integration
tests. The original missing-schema failure remains in the receipt root.

Continuation-r3 records an isolated local `--no-local --no-hardlinks` clone
of `8d2ad69`, both locked no-deps metadata checks and native tests with exit 0.
Existing Cargo registry/build caches were used; this is not a GitHub clone,
cold installation, packaged behavior or complete compatibility build. Reuse
only unchanged input scope; the QA helpers belong to later commit `952c211`.

Corrected private NUL/rename-aware inventory at `2026-11-10T20:12:44Z`:

| Owner | Changed tracked | Untracked | Total status entries |
|---|---:|---:|---:|
| Primary | 3,008 | 1,775 | 4,783 |
| Release | 25 | 108 | 133 |
| Rebuild | 80 | 1 | 81 |
| Goal-control | 0 | 0 | 0 |

`continuation-r2/source-state-v2` contains complete HEAD/index/status records;
no rename occurred in that read. A stable read is not an atomic backup.
HEAD-only union is 42,012 paths, four-way intersection 2,020 and current focus
276 paths / 138 differing paths. Historical 277-focus counts used a different
predicate. Semantic reconciliation remains open. R10 advanced scoped
preservation and isolated restore as recorded below; excluded owners and
consumer boundaries still prevent metadata retirement. Revalidate current
bytes before carrying any disposition.

## Source preservation and isolated restore — r10

Private evidence root (LANE):
`C:\Users\khang\.codex\research\omnia-restructure\20261111\handoff-intake\continuation-r10-source-preservation`.
Snapshot root (SNAP):
`C:\Users\khang\.codex\recovery\omnia-root-r10-20261111`.
Isolated restore (RESTORE):
`C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111`.
These private inputs remain outside published Git.

### Acquired and restored scope

- `SNAP/SNAPSHOT.json`: 184,169 regular files / 8,342,167,917 logical bytes
  across common Git, primary, release, rebuild and goal-control. The method
  checks per-file stability with pinned ancestors; it is not volume-atomic.
- `SNAP/SUPPLEMENT.json`: 23 PNG files / 5,273,303 bytes whose parent directory
  has a trailing space. Extended Windows path semantics preserve that name;
  do not normalize it onto a different directory. The supplement is separate
  from the base snapshot denominator and was consumed during primary restore.
- `LANE/restore-reconciliation-r2/RESTORE-R2.json`, SHA-256
  `102b1fc8217faa3796517a5dcdec30f68ae21cf79d9c2bddd45a243b11e43786`,
  finished `2026-11-10T23:47:18.236997Z`: 20/20 comparisons match HEAD, refs,
  index stage records, index flags and status for goal-control, release, rebuild
  and the nested Pydantic owner. `WORKING-BYTE-READBACK.json` separately verifies
  all 10,076 included regular files from the three linked worktrees.
- Nested Pydantic was separately acquired and restored: 28 physical files /
  287,343 bytes; HEAD `0f7648a1b0685389ea368ea4f7b754b393cea8c7`.
  Its absent/empty index and many tracked deletions are preserved; 28 physical
  files does not mean 28 entries in the Git tree. Use `SNAP/manifests/
  rebuild_pydantic.jsonl` and `LANE/restore-reconciliation-r2/NESTED-OWNER.json`.
- `LANE/restore-reconciliation-r2/PRIMARY-MATERIALIZATION.json`, SHA-256
  `5345bb971b723af654e19fddb4e70dce2df8b64518a236985fbb8b8ca76ab5a7`,
  finished `2026-11-11T13:52:58.621312Z`: 172,415 ordinary files /
  6,795,557,609 bytes, 21,881 directories and the separate 23 PNG files /
  5,273,303 bytes were materialized under `RESTORE/primary`. Every included
  file was read back for size and SHA-256; no missing files or size/hash
  mismatches were recorded. Windows extended-length paths preserve the exact
  trailing-space name.
- The first materialization attempt wrote and checked 168,499 primary files
  before ordinary path handling failed at the trailing-space destination.
  Corrected terminal session `78177` reused and verified those existing bytes,
  then completed the supplement; its observed terminal exit is 0. No second
  full restore was created. The receipt leaves 1,029 primary boundaries
  unmaterialized and does not compare primary Git status or establish current
  source drift, consumer validity or deletion eligibility.

### Corrected diagnosis and conditional status equality

The earlier missing-linked-index diagnosis is **superseded**. The snapshot
already includes all three indexes and 24 linked-worktree admin files;
`LANE/ADMIN-AND-STAT-CACHE-PROBE.json` records every admin hash matching live
and restored copies. Initial restore mismatches involved `core.autocrlf=false`
versus source semantics, new stat metadata and the absent nested owner.

R2 preserves raw indexes, restores captured mtimes only in the isolated
working directories and uses explicit isolated Git/work-tree paths with
`core.autocrlf=true`, `core.longpaths=true`, `core.ignorecase=true` and
`core.trustctime=false`. Its status equality is conditional on those inputs.

Separate `CONTENT-REEVALUATION.json` with `core.trustctime=true` still matches
goal-control and release; rebuild has 130 records versus the source's 81,
exposing 49 inherited EOL/stat-cache differences. Keep this finding alongside
the matching byte receipt. Neither matching cached status nor matching bytes
proves semantic cleanliness. Historical `RESTORE/RESTORE.json` and the exit-0
common-Git fsck receipt remain historical; R2 did not rerun fsck.

### Source-side diagnostic correction

`probe_restore_cause2.py` accidentally invoked `git sparse-checkout reapply`
on source goal-control, release and rebuild. Return codes/stdout/stderr for
those calls were not retained. Do not describe all r10 source operations as
read-only. `LANE/SOURCE-POST-PROBE-CORRECTION.json` records that all four owners'
HEAD/refs/index stage/index flags/status and raw index hashes still matched
acquisition afterward; the later admin probe matched all 24 admin files.
The R2 implementation now allowlists source query commands. Do not rerun the
erroneous diagnostic. These checks support only their named postconditions.

### Remaining preservation gates

`retirementEligible=false`; `ROOT-02` and `ROOT-03` are `IN_PROGRESS`, `DOD-05`
is `PARTIAL`, `SESSION-G02` is `PARTIAL`, session decision is `DEFERRED`, and
whole-goal independent audit streak remains **0**. No metadata retirement,
source relocation or deletion is credited to this batch.

Primary included-byte materialization is verified within the receipt's scope.
Primary Git-state comparison remains pending. Its 11 Gitlink owners,
57 reparse records and 961 generated boundaries, plus remaining release/rebuild
boundaries and actual consumers, need separate ownership/disposition. The
supplement also lists further nested owners. Preserve these boundaries and
reacquire current source state before retiring anything. The 403 byte-delta
candidates and the disposition ledger's 138 unreviewed HEAD focus rows do not
have semantic review or merge credit. Repeated root readback is not an
independent audit, and tool-dispatch failures provide no agent-review credit.

## Layout and capacity

Ten classified nonproduct trees moved to `D:\OmniaData`, retaining 92,460 files
and 15,156,174,074 logical bytes; [EXTERNAL_LAYOUT.json](EXTERNAL_LAYOUT.json)
owns the mappings. Full path/type/size/mtime, nonzero directory identities and
selected anchor hashes were checked. Before-file device/inode fields were
zero, so per-file identity and an all-content-hash backup are not proven.
Same-volume relocation has **zero reclaimed-capacity credit**.

Supported Cargo cleanup of the former native integration target reported
9,632 files / 12.1 GiB, exit 0. Observed D: free-byte delta was 11,357,032,448
(about 10.58 GiB); it differs from Cargo logical-byte accounting and can include
concurrent activity. Earlier Cargo/pnpm cleanup has separate receipts; do not
double count. The historical D_DRIVE_TOPLEVEL_INVENTORY file inventories
`D:\Omnia`, not a complete drive-root recursive size survey. Primary/common Git,
linked worktrees, backups, profiles, downloads/logs/output and other operational
consumers still require classified ownership before relocation or reclamation.

## History, research and skills

The historical structural watermark is 852 rollout files, 2,256,736,449 bytes,
528,619 physical records and 14,630 bounded units. Semantic review credit at
that watermark remains **0**. Of 101 source-DB/raw-rollout gaps, 99 have alternate
projected items; growth, truncation, missing state and review remain open.
See private `handoff-intake/history`. Neither discovery nor hashing proves
reading or understanding all chats.

Queued-steer guidance already exists in `goal-plan-loop-dod`, `deep-steer`
and root instructions. Validation/projection is not proof Omnia loaded or
invoked the skills. Research quotas, atomic source qualification and native
product requirements remain in GOAL without changing their denominator.

## Queued additive requirements — UI direction and dynamic routing

The latest queued request adds two bounded contracts without changing the
16-parent, 12-product-leaf, 16-DoD or seven-admission denominators:

- `PRODUCT-CHAT` now has the atomic
  [DYNAMIC_ROUTING_REQUIREMENTS.md](DYNAMIC_ROUTING_REQUIREMENTS.md) contract.
  It is specification-only at this checkpoint. Existing provider profiles,
  models, token/cost fields, generations, attempts and run journals must be
  inspected before introducing storage. Quota reservation, post-run
  reconciliation, stale/unknown usage, health, rate limits, privacy boundaries,
  fallback and route/outcome receipts need runtime evidence before status can
  advance.
- `PRODUCT-WORKSPACE` now requires preview-first visual direction. The local
  `deep-ui-direction` skill was created and passed the skill creator validator.
  It owns reference provenance, three-candidate style exploration, weighted
  direction decisions, direction briefs, measurable token seeds, addressable
  previews, independent critique, anti-slop review and user-review status.
  `modern-tech-ui-design`, `deep-ui-quantitative` and `deep-ui-qa`
  retain token implementation, measurement and behavior QA respectively.
  No Omnia preview, user approval or live UI credit exists yet.
- The bounded UI-style receipt is now stored outside the product tree at
  `C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json`.
  It records ten GitHub queries, 68 unique first-seen repository identities,
  eight fetched official design/accessibility pages and eleven selected README
  retrievals, plus a content-extract receipt. It admits only process-level
  lessons; no source code, assets, fonts or visual identity were copied. The
  supplied social/video material and related terms remain unreviewed. The
  receipt is not exhaustive source review or Omnia runtime proof.
These additions are open requirements. They do not alter the preservation,
history, publication, admission or final-audit states.

## Bounded UI-style research receipt

A receipt is stored outside the product tree at C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json. It records 10 GitHub queries, 68 unique first-seen repository identities, 8 fetched official design/accessibility pages, 11 selected README retrievals and a separate content-extract receipt. It admits process-level lessons only: reference provenance, layered tokens, accessible primitives, state coverage, preview/QA separation and measurable contrast/focus checks. No source code, assets, fonts or visual identity were copied. Social/video links remain unreviewed and the receipt is not exhaustive source or runtime proof.

## Four-keyword research and Cargo-cache cleanup — 2026-11-12

The exact GitHub queries `agent`, `memory`, `code` and `open` each returned 100
repositories sorted by stars descending. The metadata envelope records the query
URLs, retrieval time, result totals and repository fields; identity
deduplication produced 324 unique entries. A bounded canonical-source ledger
then inspected README, license endpoint and recursive tree metadata for 16
unique top-five selections. README hashes and HTTP statuses are recorded in
`C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-bounded-source-ledger.json`.
This is discovery and bounded inspection evidence only. It is not exhaustive
source, issue, comment, media or runtime review and no repository code or asset
was admitted to Omnia.

Three ignored, untracked, ordinary Cargo target directories in
`D:\Omnia\repos\omnia` were moved by exact path to
`D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets` after a
path-specific receipt. The after readback matched 4,513, 3,709 and 4,727 files
and their recorded logical bytes. The same-volume move produced zero D: free
space delta, so it earns no reclamation credit. The child status remains 4,783
entries with 12 missing-directory warnings; no source, nested repository,
worktree, profile, backup or recovery data was deleted.

Receipts:

- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-pre.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-move.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-after-cargo-move.json`

## Next executable actions

1. Finish this primary-materialization checkpoint before consuming queued additions.
   Verify exact task/DoD/product/admission IDs and transfer states, evidence
   hashes, local references, JSON and `git diff --check`; inspect the complete
   staged diff and commit only the intended documentation update. Record the
   returned commit/tree/status under LANE/checkpoint-r4; do not rewrite this
   checkpoint merely to embed its own hash.
2. Reuse verified `RESTORE/primary`; compare primary Git state under recorded
   source semantics with isolated configuration, retaining conditional status
   and independent content reevaluation as separate results. Do not duplicate
   the full restore or rerun the erroneous source sparse-checkout diagnostic.
3. Preserve/classify all remaining nested/Gitlink/reparse/generated boundaries,
   inspect consumers and reacquire source state for drift. Keep retirement
   ineligible. Continue ROOT-02 semantic reconciliation, safe externalization,
   measured drive cleanup, isolated closure and bounded refactoring afterward.
4. Inspect and plan the dynamic routing contract against the existing native
   provider/storage source; do not duplicate ledgers before a schema/ownership
   map exists.
5. For each UI surface, make the direction record and preview before full
   implementation, then collect independent critique and user-review status.
   Preserve the retained preview and known visual/UIA findings.
6. Carry complete history/research/product/quality requirements in GOAL's queue.
   Publish only after privacy/license/account/clone gates; launch the requested
   follow-up chat under all seven reviewed admission gates with detailed goal
   activation.
7. Continue child-repository classification from the unchanged 4,783-entry
   status. Reconcile missing-directory warnings and nested/reparse owners before
   touching profiles, upstream extractions, backups or deleted source. Treat the
   Cargo quarantine as reversible and decide on deletion only with a separate
   retention and restore proof.

## Four-keyword research and cache quarantine — 2026-11-12

The exact GitHub queries `agent`, `memory`, `code` and `open` each returned 100
repositories sorted by stars descending. The metadata envelope records query
URLs, retrieval time, result totals and repository fields; identity
deduplication produced 324 unique entries. A bounded canonical-source ledger
inspected README, license endpoint and recursive tree metadata for 16 unique
top-five selections. This is discovery and bounded inspection evidence only;
it is not exhaustive source, issue, comment, media or runtime review and no
external code or asset was admitted to Omnia.

The generated-cache cleanup then moved `.pytest-cache` (one status-visible
five-byte marker) and `.pytest_cache` (four standard pytest cache files) to
`D:\OmniaData\quarantine\omnia-clean-20261112\pytest-cache`. Exact containment,
ordinary-directory status, zero tracked files and destination collision checks
passed. The same-volume move measured zero free-space delta. The child
repository still has 4,783 status entries and the previously recorded missing
upstream-directory warnings; no source, nested repository, worktree, profile,
backup or recovery data was deleted.

Receipt: `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-pytest-cache-move.json`.

## Graphify supplement and dist quarantine — 2026-11-12

A canonical public GitHub API review was recorded for `Graphify-Labs/graphify`
at ref `v8`. Repository, README, license and recursive tree endpoints returned
HTTP 200; the tree response contained 1,306 entries with `truncated=false`.
The repository metadata reports `Apache-2.0`. The README and six selected files
(`ARCHITECTURE.md`, `docs/how-it-works.md`, `graphify/manifest.py`,
`graphify/querylog.py`, `graphify/rcfile.py`, and
`graphify/always_on/claude-md.md`) were decoded, hashed and retained in the
external supplement directory. This is bounded review evidence, not exhaustive
source, issue, discussion, comment, media or runtime review.

The useful candidate patterns are deterministic code indexing separate from
semantic extraction, explicit `EXTRACTED`/`INFERRED`/`AMBIGUOUS` provenance,
module input/output contracts, bounded configurable query depth/budget, and
scoped graph-first navigation before broad raw search. Admission is
`RESEARCH_ONLY`: no external source, asset, credential, private content or
runtime was copied into Omnia. Full disposition:
`C:\Users\khang\.codex\research\omnia-clean-2026-11-12\supplement-20261112\graphify-disposition.md`.

The next generated-only cleanup unit classified `dist` as an ordinary ignored
and untracked Vite build output (140 files, 6,924,863 logical bytes). The
`package.json` build route is `tsc -b && vite build`; no reparse point, tracked
file, status entry or active process reference remained at the mutation check.
The directory was moved by exact path to
`D:\OmniaData\quarantine\omnia-clean-20261112\dist`. Readback matched file
count and bytes. The move stayed on D:, so free-space delta was 0 and no
reclamation credit is claimed. Restore is a single exact reverse move recorded
in the receipt. Child repository source/profile/worktree state remains dirty and
independently owned.

Receipts:

- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-dist-pre.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-dist-move.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-after-dist-move.json`

## Latest bounded unit — Graphify disposition and Vite dist quarantine

Graphify was reviewed from public GitHub API evidence at ref `v8`: repository,
README, license and recursive tree all returned 200; 1,306 tree entries were
reported without truncation. README plus six canonical files were actually
opened. The Apache-2.0 metadata and candidate lessons are recorded outside the
product tree. Admission is `RESEARCH_ONLY`; this does not claim exhaustive
source/comment/media/runtime review and no external code was copied.

`D:\Omnia\repos\omnia\dist` was an ordinary, ignored, untracked generated
Vite output with 140 files and 6,924,863 logical bytes. Its producer is the
tracked `package.json` build script (`tsc -b && vite build`) and
`package-lock.json` is present. A path-specific receipt proved containment,
zero reparse entries, zero tracked/status-visible files and no active process
reference at mutation time. The directory was moved to
`D:\OmniaData\quarantine\omnia-clean-20261112\dist`; readback matched. This
same-volume move changed free space by 0 bytes, so it is reversible
externalization and earns no capacity credit. The source path is absent and
path-scoped Git status is clean after the move.

The child repository remains dirty and independently owned. The root control
plane is clean at the last committed checkpoint. Remaining candidates include
`node_modules`, `.toolchains\openhands-uv-cache`, `.omnia\cache`, Chrome
profile data, upstream extraction trees and mixed source deletions; they remain
preserved until owner, consumer, retention and restore evidence are complete.


## Node dependency quarantine — 2026-11-12

The generated `node_modules` directory was separately classified as a normal,
ignored and untracked dependency install: 12,111 files and 194,672,966 logical
bytes, no reparse entries, zero tracked/status-visible files and no active
process reference at the final gate. `package.json` declares the build/test
scripts and the unchanged `package-lock.json` provides the regeneration route.
An exact-path move placed it at
`D:\OmniaData\quarantine\omnia-clean-20261112\node_modules`; readback counts
and bytes matched and the source path is absent. This is reversible
same-volume externalization with zero free-space delta, not deletion or
capacity reclamation. Restore command and pre/move receipts are recorded
outside the product tree. No source, lockfile, nested repository, profile or
worktree data was touched.

## OpenHands uv cache quarantine — 2026-11-12

The generated `D:\Omnia\repos\omnia\.toolchains\openhands-uv-cache` directory was separately classified as an ignored, untracked uv/OpenHands package cache. Pre-move evidence recorded 85,557 entries, 71,261 files, 2,083,312,334 logical bytes, zero reparse entries, zero tracked files, zero status-visible files and no active process reference at the final gate. The retained `.gitignore`, `.lock` and `CACHEDIR.TAG` markers, plus `uv` cache producer and regeneration route, are recorded in the external receipts. An exact-path move placed it at `D:\OmniaData\quarantine\omnia-clean-20261112\openhands-uv-cache`; readback counts and bytes matched and the source path is absent. This is reversible same-volume externalization with a zero-byte free-space delta, not deletion or capacity reclamation. The recorded reverse move is the restore route. No source edits, nested repository, profile, worktree or unknown cache data was touched.

## Root scratch quarantine — 2026-11-12

Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.

## Wave 2 & additive execution receipts — 2026-11-12

Independent final lane audit: `D:\OmniaData\qa\audits-20261112\FINAL_VERIFICATION_RECEIPT_20261112.json` and `FINAL_VERIFICATION_REPORT_20261112.md` -> **`PASS_ALL_SCOPED_LANES_ZERO_OPEN_DEFECTS` (`0` open defects; all 3 mid-wave findings `DEFECT-01..03` repaired and re-verified)**.

### Bound artifacts, test counts and SHA-256 digests

- **Serialized Cargo build & tests (`$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'`, `524/524` passed)**:
  - `omnia-provider-services` (`31/31`): `src-tauri/crates/omnia-provider-services/src/dynamic_router.rs` (`133,752 B`, `sha256=ce1ef4abdeb631c09fcb6bee1ebcbb1d3d6f6fb88527e7acf81be576ec97c930`).
  - `omnia-harness` (`393/393`; `1` ignored): `proactive_rag.rs` (`52,745 B`, `sha256=e2fa4d338b9fdc4fe8522c4ce895b11bfd1f2f0ec527f962dcd55ba4ec5b9a7b`), `agent_graph.rs` (`55,618 B`, `sha256=adc1da5e9f91db375616707141c03a1f1b9c631f229828274dc31cf14da1b0ef`), `skills.rs` (`sha256=37e29aea7387dc71...`), plus hierarchical/cyclic-graph `memory.rs`.
  - `omnia-session-store` (`71/71`) & `omnia-native` (`29/29`): `native/src/composer.rs` (`82,419 B`, `sha256=2a5463baa284b78346acd2b1bfa205e665399b82bc7d10930d530b3d1f3c78b5`), `native/src/uia_edit.rs` (`20,965 B`, `sha256=1cd9a2649bc3b38c184a68f627abf9b6b29cdcafcbfe3507937560954457a98b`), `native/src/session_panel.rs` (`24,563 B`, `sha256=4c638e4123c851e4d0e4032165cea890fbc4eb47098fb103cba8a6927ebc8c09`), `native/src/win32.rs` (`18,895 B`, `sha256=942c3b648ccc343ac89a9e826c80655b180f64eea96b1bebcda6f1d52157d5cf`).
  - External binaries: `debug\omnia-native.exe` (`3,488,256 B`, `sha256=42e405d28e4b583eb97d56107c63192cb0f4ebbd83aa9c89e7448b95feaa6d7f`) and `release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d8685fa4e219cbcf43f5d6bf99eb7fb379fa1a4bb2d8caab077380a2872`).
- **External Win32 Native QA (`7/7` workflows, `90/90` cases `rc=0`)**:
  - Receipt: `D:\OmniaData\qa\native-20261112\QA_SUITE_SUMMARY_RECEIPT.json` (`qa-paths.tests.ps1` `40/40`, `qa-capture.tests.ps1` `14/14`, `qa-smoke.ps1` `4/4` with `"uiaIssue": null`, `qa-session.ps1` `5/5`, `qa-paging.ps1` `9/9`, `qa-guard.ps1` `12/12`, `qa-ownership.ps1` `6/6`; `0` status-panel clipping in `1220x820` PNG captures). Note: the two open r7 `QUALITY-01` defects recorded earlier in this file (lines 107–110) are now resolved for this evaluation shell; live provider/IME/Narrator scope remains open.
- **Skills, catalog, history, research, UI direction & cleanup**:
  - `12` curated skills in `.agents/skills/` (`24/24` `quick_validate.py` `PASS`, incl. `deep-proposal` `SKILL.md` `sha256=c33d1650e106f95b7bee5101552dbaf8f12dc20af7f74a87f55c47abc141dc1e`); external sanitized GDoc `GDOC_1YSB_SANITIZED.md` (`sha256=099ea575...`) & `omni-deep-1000-catalog.json` (`100` categories / `1,001` specs, `sha256=5075c05b...`); `273` unique skills mounted live across 4 roots in Windows Antigravity.
  - `tools/agy-history-sync/` (`agy_history_sync.py` `sha256=f029c2b1...`, `test_agy_history_sync.py` `sha256=acf55a6d...`, `5/5` tests `OK`): Desktop `144/144` DBs (`0` ghost), CLI `126/126` DBs (`0` ghost), unified FTS5 `1,102` threads (`sha256=efee7f1e...`), `PASS_ZERO_LEAKS` (`sha256=883739f6...`) across `294` files.
  - `COMPLETE_103_URL_LEDGER.json` (`sha256=ef6d38dc...`) + `REA_8_URL_SUPPLEMENT_LEDGER.json` (`sha256=a9a9eadd...`, `8` REA URLs + `github/spec-kit` `v1.4.0`).
  - `docs/ui-direction/DIRECTION_DECISION.md` (`sha256=7366e4aa...`, `PENDING_USER_REVIEW`) + 3 interactive prototypes under `D:\OmniaData\qa\ui-direction-20261112\`.
  - `SOURCE_DISPOSITION_LEDGER.json` (`138/138` focus rows reviewed, `84/84` delta files/patches hashed; `retirementEligible=false`), `EXTERNAL_LAYOUT.json` (`12` root clutter dirs externalized + `4` worktrees healthy; `Roaming` orphaned SID documented), and `d-drive-reclamation-receipt-20261112.json` (**`+10,871,586,816` B / `+10.125 GiB`** reclaimed on `D:\`).

### Navigable workspace index map

Use [STATUS.md](STATUS.md) to jump directly to [PLAN.md](PLAN.md), [TASKS.md](TASKS.md), [PROMPTS.md](PROMPTS.md), [SESSIONS.md](SESSIONS.md), [SOURCES.md](SOURCES.md), [REFS.md](REFS.md), [STEER_QUEUE.md](STEER_QUEUE.md), and [TRANSFER_CONTRACT.md](TRANSFER_CONTRACT.md).

## Wave 3B GitHub delivery, clean-clone and session admission — 2026-11-12

- **GitHub remote & Commit #1 push (`DELIVERY-01` / `SESSION-G06` -> `PASS_SCOPED`)**:
  - Private repository `https://github.com/khang-macphuc111107/omnia` (`origin` -> `https://github.com/khang-macphuc111107/omnia.git`, owner `khang-macphuc111107`, `credential.https://github.com.username=khang-macphuc111107`) received Commit #1 `d8b456e357dde65d8ee314194743fb93655f5d6a` (tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb`, `2,039` tracked files). Collaborator handle `HTMusTC` was verified to be a Discord handle rather than a GitHub login; collaborator invite is left to the user's exact GitHub login choice under `https://github.com/khang-macphuc111107/omnia/settings/access`.
- **Independent remote GitHub clone & isolated local clone (`ROOT-05` / `SESSION-G01` -> `PASS_SCOPED`)**:
  - Receipt: `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` (`8,958 B`, `sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`).
  - Verified checks on `remote-github-clone` and `isolated-local-clone`: both `HEAD` SHAs equal `d8b456e357dde65d8ee314194743fb93655f5d6a` (`2,039` tracked files), `cargo metadata --locked --no-deps` `rc=0` on `src-tauri/Cargo.toml` and `native/Cargo.toml`, `cargo fmt --all --check` `rc=0` on both workspaces, `524/524` locked Cargo tests `rc=0`, `5/5` `tools/agy-history-sync` unit tests `rc=0`, and `12/12` `.agents/skills/*` `quick_validate.py` validations `rc=0`.
- **Release native shell runtime telemetry & `exebox-*` desktop boundary (`QUALITY-01`)**:
  - Receipt: `D:\OmniaData\qa\native-20261112\retained-preview\native-shell-cycle24-runtime.json` (`6,111 B`, `sha256=1a4aa5cac935a76687432cb9ccf54fb4e390c2ef50cfc26c95b545fb9dd93a77`) and `native-shell-cycle24-window.png` (`107,800 B`, `sha256=68b669ce7e26e0d9abe2836490ca78f9566184607c7903d81e259a7f4e0c7ded`).
  - Measured `D:\OmniaData\tools\cargo-target\release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d8685fa4e219cbcf43f5d6bf99eb7fb379fa1a4bb2d8caab077380a2872`): `16,560,128 B` (`15.79 MiB`) working set (`17,453,056 B` peak), `0.0%` idle CPU, `163.22 ms` window discovery, `4/4` mode/close smoke checks passed, `uiaIssue: null`.
  - Honest desktop boundary: Antigravity executes tool commands inside isolated `exebox-*` Windows desktops rather than the interactive `Default` desktop, so `PID 11532` was cleanly terminated after capture (`0` orphan processes) rather than leaving an invisible background process. Launch `D:\OmniaData\tools\cargo-target\release\omnia-native.exe` directly from an interactive `Default`-desktop terminal/Explorer session to inspect live.
- **4-way `/learn` synchronization & `SESSION_ADMISSION.json` `READY`**:
  - `~/.codex/AGENTS.md` updated with `OMNIA_CONTINUITY_AND_PEER_MESH`, all `12` curated skills synchronized byte-identically across `D:\Omnia\.agents\skills\`, `~/.codex/skills/`, `~/.agents/skills/`, and Antigravity (`4-way` parity), and `59` pure-`LF` notes maintained in `~/.codex/memories_v2/extensions/ad_hoc/notes/` (including `2026-11-12-antigravity-win32-uia-and-git-lessons.md`).
  - [SESSION_ADMISSION.json](SESSION_ADMISSION.json) advanced to **`READY`** (`SESSION-G01..G07` satisfied, `promptSha256=ef94c52e0c68763aecf8c94dd650ed396a987c8e402d1131bcb1f7a3e54de592`). Commit #2 binds these Wave 3B receipts and pushes `HEAD === origin/master`, after which 3 independent frozen-snapshot verification rounds write external audit receipts to `D:\OmniaData\qa\audits-20261112\final-streak-3\`.
