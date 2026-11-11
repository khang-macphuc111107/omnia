# Omnia checkpoint — 2026-11-11, continuation revision 7

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
- Final independent whole-goal audit streak: **0**. Session admission remains
  `DEFERRED`; no candidate/reviewer/created-chat/goal-activation receipt exists.

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
4. Carry complete history/research/product/quality requirements in GOAL's queue.
   Preserve the retained preview and known visual/UIA findings. Publish only
   after privacy/license/account/clone gates; launch the requested follow-up chat
   under all seven reviewed admission gates with detailed goal activation.
