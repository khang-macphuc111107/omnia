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
- D: inventory is running as a read-only logical-size scan. No deletion has
  been performed in this checkpoint.
- Source divergence ledger: primary `4,783` status entries, release `133`,
  rebuild `81`, goal-control `0`; HEAD tree counts are recorded in
  `docs/workspace/source-divergence-ledger.json`. These counts are inventory
  evidence only, not a semantic merge or deletion decision.
- HEAD reconciliation: 42,012-path union, 2,020-path four-way intersection;
  138 of 277 common focus paths differ by bytes. Receipt:
  `docs/workspace/head-path-reconciliation.json` and
  `docs/workspace/shared-path-differences.json`.
- Bounded D: top-level inventory: 46 immediate entries, no observed reparse
  points at that level, and 50.57 GiB free. Recursive ownership/size
  classification remains open; receipt:
  `docs/workspace/D_DRIVE_TOPLEVEL_INVENTORY.json`.

- Root: `D:\Omnia`
- Root Git: initialized; product source admission is staged but not yet committed.
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

- Created and verified a complete Git bundle for `projects\omnia-public`; nested `.git` removal is recoverable but remains pending a separately isolated safe-delete step.
