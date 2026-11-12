# Omnia cleanup status — 2026-11-12

## Current evidence

- Root repository: `D:\Omnia`, branch `master`, HEAD `a36c6f9ec4f3df84258d49aa280e94b5360da987`.
- Root working tree after the documentation commit is clean (`git status --short --branch` reports only `## master`).
- Child repository `D:\Omnia\repos\omnia` remains independently owned and dirty: the inventory recorded 4,783 status entries, including 1,775 untracked, 199 modified and 2,809 deleted entries at HEAD `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`.
- `D:\Omnia\repos\omnia` contains registered linked worktrees under the Codex worktree directory and `D:\Omnia\publish-worktree`; this prevents treating it as an ordinary folder to flatten or delete.
- Physical inventory identified approximately 304,486,395,505 bytes under `D:\Omnia\repos\omnia` excluding reparse-file bytes, but 20,198 reparse boundaries were observed. The value is an inventory estimate, not a reclaimable-space proof.
- Drive D had approximately 65,614,209,024 bytes free at inspection. Same-volume moves do not count as reclaimed capacity.

## What was changed in this pass

- Four GitHub REST API searches were recorded outside the product tree for exact keywords `agent`, `memory`, `code`, and `open`, each sorted by stars descending with 100 results. The query and result artifacts are under `C:\Users\khang\.codex\research\omnia-clean-2026-11-12`.
- A bounded canonical-source ledger was added for 16 unique repositories selected from the top five star-ranked results per keyword. It records README status, content hash, license endpoint status, default-branch tree metadata and a bounded path sample. It does not claim exhaustive source, issue, comment, media or runtime review.
- Three historical Cargo target caches were classified as generated, ignored, untracked, non-reparse output with zero status entries. A pre-mutation receipt was written, then the directories were moved by exact path to `D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets`. File counts and logical bytes matched after the move. This is reversible externalization, not deletion or a backup proof.
- The same-volume move measured a `0` byte D: free-space delta. No capacity reclamation credit is claimed. The child repository status remained 4,783 entries (199 modified, 2,809 deleted, 1,775 untracked) after the move. Root governance documents were then committed as the current HEAD.

## Deferred cleanup

The child repository is not clean because its changes include active source edits, deleted/untracked extraction/profile data, nested repositories and generated/toolchain material. The Cargo target unit is now quarantined, but it does not make the child clean. Before any further mutation, each candidate needs an owner, reproducibility or restore route, containment proof, active-use check and before/after receipt. The `.pytest-cache` item has an untracked file and remains retained; `.pytest_cache`, `.omnia\cache`, `dist`, `node_modules` and `.toolchains\openhands-uv-cache` remain classified but untouched. Chrome profiles and upstream extraction trees remain preserved because their status and reparse boundaries are mixed.

Do not use `git clean`, `git reset --hard`, force push, nested `.git` deletion or broad recursive deletion as a substitute for reconciliation. The next safe unit is a path-specific quarantine or supported producer cleanup, starting with one generated candidate and an isolated restore test. Keep root cleanliness and child-repository cleanliness as separate gates.

## Evidence links

- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-four-keywords.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-four-keywords-unique.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\git-root-inventory-before.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\root-before-snapshot.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\filesystem-boundary-before.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\generated-candidate-inventory.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-summary.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-top20-selection.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-bounded-source-ledger.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-bounded-source-ledger.md`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-pre.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-move.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-after-cargo-move.json`
- `D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets`

This status file does not claim exhaustive repository review, complete source understanding, zero defects, or a clean child repository.

## Exact four-keyword search result

The recorded API queries returned 100 repositories each:

| Keyword | API sort | Returned | Search total at retrieval |
|---|---:|---:|---:|
| `agent` | stars descending | 100 | 2,168,326 |
| `memory` | stars descending | 100 | 504,894 |
| `code` | stars descending | 100 | 7,668,461 |
| `open` | stars descending | 100 | 1,750,296 |

Repository identity deduplication produced 324 unique repositories in the saved
metadata envelope. The bounded ledger intentionally covers 16 selected
repositories rather than pretending that 324 repositories were opened and
understood in full. A useful idea remains a research candidate until its
license, privacy, compatibility, security and implementation evidence are
reviewed.

## Cleanup unit receipt

The three moved directories contained 12,949 files and 10,931,752,220 logical
bytes in total. The destination readback matched each pre-move file count and
logical-byte sum. The move used exact resolved paths, rejected reparse points,
required `git check-ignore` exit 0, required zero tracked files and zero status
entries, and checked destination collisions before mutation. The operation did
not use `git clean`, `git reset`, nested Git deletion, a broad computed path or a
history rewrite. Because source and quarantine are both on D:, measured free
space stayed unchanged. Deletion or recycle-bin purge is a separate future
decision and is not implied by the quarantine.

## Second cleanup unit — pytest cache quarantine

After the Cargo-target move, the status-visible `.pytest-cache` contained one
five-byte `clean` marker. `.pytest_cache` contained four standard pytest cache
files (`.gitignore`, `CACHEDIR.TAG`, `README.md` and `v/cache/lastfailed`). No
tracked files were present. Both directories were ordinary, contained under the
child repository, and had no destination collision. They were moved to
`D:\OmniaData\quarantine\omnia-clean-20261112\pytest-cache` by exact path.
The measured D: free-space delta was `0` bytes because this is same-volume
externalization. The status-visible marker was preserved before the move; its
producer is not proven and remains an evidence limitation, not a deletion
claim.

Receipt: `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-pytest-cache-move.json`.

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


## Latest generated dependency unit — node_modules

`D:\Omnia\repos\omnia\node_modules` was moved to
`D:\OmniaData\quarantine\omnia-clean-20261112\node_modules` after exact
containment, ordinary-directory, ignore, tracked/status and active-process
checks. It contained 12,111 files and 194,672,966 logical bytes; readback
matched exactly. The source path is absent and path-scoped Git status is clean.
Because source and quarantine share D:, the free-space delta is 0 bytes; this
is reversible externalization, not deletion or disk reclamation. `npm ci` with
the unchanged lockfile is a regeneration route, but it was not run. Keep the
quarantine until the next controlled build/restore check and do not infer that
other generated or mixed-ownership trees are disposable.

## Latest generated cache unit — OpenHands uv cache

`D:\Omnia\repos\omnia\.toolchains\openhands-uv-cache` was moved to `D:\OmniaData\quarantine\omnia-clean-20261112\openhands-uv-cache` after exact containment, ordinary-directory, ignore, tracked/status, reparse and active-process checks. The pre-move receipt records 71,261 files and 2,083,312,334 logical bytes across 85,557 entries; the move receipt confirms matching readback and source absence. Its producer is the uv/OpenHands package cache and the restore route is the exact reverse move or supported cache regeneration. Because source and quarantine share D:, the free-space delta is 0 bytes; this action is reversible externalization, not deletion or disk reclamation. Keep the quarantine and receipts until a controlled restore/build check qualifies retention. Other generated, mixed-ownership, profile, nested-repository, worktree and source-deletion candidates remain open.

## Root scratch quarantine — 2026-11-12Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.
