# Omnia workspace checkpoint — 2026-11-11

## Current migration checkpoint

- Native admission: **byte-copy verified**, 197 files / 2,588,993 bytes from
  the rebuild checkout into `D:\Omnia\native` and `D:\Omnia\src-tauri\crates`.
  Receipt: external `handoff-intake/NATIVE_ADMISSION.json`.
- Root checks: `cargo metadata --locked` passed, `cargo fmt --check` passed,
  and root native tests passed with output target outside `D:\Omnia`
  (`4 + 1` direct native tests plus shared integration suites; see external
  `native-root-tests.stdout.txt`). This is source/build evidence, not final
  product or live-provider evidence.
- Root README and ignore policy now describe the actual source-bearing root.
- The previous primary/release/rebuild/goal-control trees remain preserved.
  Reconciliation and Git retirement are still open.
- History inventory: 852 rollout JSONL files, 2,256,736,449 bytes,
  528,619 physical records and 14,630 bounded review units; semantic review
  credit remains zero. Exact report is external under
  `handoff-intake/history/REPORT.md`.
- The broad inventory scans were stopped, not left running. A separate
  drive-cleanup lane previously reclaimed build/store data; current cleanup
  actions must cite fresh receipts rather than claim no deletion ever occurred.
- The historical source ledger's `4,783 / 133 / 81 / 0` are raw NUL-field
  counts from a rename-unaware parser, with stored listings truncated at
  2,000 fields. They must not be repeated as status-entry counts.
- HEAD reconciliation: 42,012-path union, 2,020-path four-way intersection;
  138 of 277 common focus paths differ by bytes. Receipt:
  `docs/workspace/head-path-reconciliation.json` and
  `docs/workspace/shared-path-differences.json`.
- Bounded **D:\Omnia** top-level inventory: 46 immediate entries, no observed reparse
  points at that level, and 50.57 GiB free. Recursive ownership/size
  classification remains open; receipt:
  `docs/workspace/D_DRIVE_TOPLEVEL_INVENTORY.json`.
- Compatibility host repair: 132 missing `src-tauri` source/resource files
  admitted with zero conflicts; Tauri metadata and formatting now pass.
  Receipts are external `handoff-intake/compatibility-host-admission.json`,
  `tauri-root-metadata.json` and `tauri-root-format.txt`.
- Missing compile-time schema repair is committed at `98c1a04`.
  The Tauri rerun finished at `2026-11-10T19:43:52.8602675Z`, exit 0:
  833 host unit tests, 6 project-file-watch tests and 4 + 17 integration tests.
  Evidence: external `tauri-root-tests-rerun.txt` and `.result.json`.
  The initial failure remains preserved; this is local regression evidence.

- Root: `D:\Omnia`
- Root Git: native and compatibility admissions are committed through `98c1a04`.
- Nested Git metadata: preserved; see `WORKSPACE_OWNERSHIP.json`.
- Product source: native source is now present at root; legacy/rebuild checkouts
  remain independently owned until source reconciliation.
- Linked worktree: `publish-worktree` remains linked.
- Reversible changes: root-level loose files moved earlier with SHA-256 mapping in the research receipts.
- Next gate: classify and snapshot any nested repo before flattening or metadata removal.

- Repo registry: docs/workspace/REPO_REGISTRY.md; relocation candidates are deferred until reference audit.


- Reference triage: docs/workspace/REFERENCE_AUDIT.md; no candidate moved because text hits require semantic review.


- Relocated `upstream_tools\rea` to `research\repos\rea`; 34,866-file hash verification passed. Receipt is external under the restructure research folder.

- Reclassified `repo-original-20261001` as recovery-immutable after finding an empty Git history and active cleanup-script references; it was not moved.

- Relocated clean public staging repo `repos\omnia-public` to `projects\omnia-public`; 17,446-file hash verification passed and release script paths were updated.

- Moved recovery snapshot `repo-original-20261001` into `backups\recovery\`; 1,379-file hash verification passed and cleanup tooling was updated.

- A bundle for `projects\omnia-public` passed history verification. It does
  not preserve index, unstaged, untracked or ignored data, nor prove a restore
  drill. Nested Git retirement remains pending those specific gates.

## Current continuation

- Goal remains `ACTIVE`; GOAL revision 2 expands all 16 parent task contracts,
  product leaves, research backlog, execution order and acceptance details.
- Additive steer is queued by the user's explicit preference. Finish
  interrupted work, checkpoint it, then consume queued additions. A correctness
  correction applies at a safe boundary without discarding remaining tasks.
- Final independent audit streak remains **0**.
- Next: repair root AGENTS/navigation, correct complete source-state records,
  then perform classified external relocation and supported cache cleanup.
