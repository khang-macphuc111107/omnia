# Relocation log

## 2026-11-11 — `rea`

- Source: `D:\Omnia\upstream_tools\rea`
- Destination: `D:\Omnia\research\repos\rea`
- Reason: zero text-reference hits in the scoped audit; independent upstream origin.
- Method: same-volume move, no copy/delete operation.
- Verification: 34,866 files; 915,767,448 bytes before and after; SHA-256/path manifest matched with zero mismatches or missing files.
- Nested `.git` was preserved at the destination to retain upstream provenance.
- Receipt: `C:\Users\khang\.codex\research\omnia-restructure\20261111\relocation-rea\AFTER.json`

## 2026-11-11 — `omnia-public`

- Source: `D:\Omnia\repos\omnia-public`
- Destination: `D:\Omnia\projects\omnia-public`
- Verification: 17,446 files; 582,041,675 bytes before and after; SHA-256/path manifest matched with zero mismatches or missing files.
- Nested `.git` was preserved. The export tool's destination at this historical
  step was `projects/omnia-public`; current behavior is described below.

## 2026-11-11 — `repo-original-20261001`

- Source: `D:\Omnia\repo-original-20261001`
- Destination: `D:\Omnia\backups\recovery\repo-original-20261001`
- Reason: empty-history recovery snapshot, now placed under the recovery tree.
- Verification: 1,379 files; 16,836,960 bytes before and after; SHA-256/path manifest matched with zero mismatches or missing files.
- Cleanup script `tools/migration/cleanup-verified-leftovers-20261012.ps1` was updated to the new path.

## Nested Git removal readiness — `projects\omnia-public`

- The public staging repository is clean and its full history is preserved in `backups\git-bundles\omnia-public-20261111.bundle`.
- `git bundle verify` completed successfully with 16 refs and a complete history.
- The nested `.git` directory was retained. Bundle verification alone does not
  satisfy the later isolated-restore and worktree-ownership gates.

## 2026-11-11 — External nonproduct ownership

The earlier destinations above are historical capture locations. Current paths
are resolved through [EXTERNAL_LAYOUT.json](EXTERNAL_LAYOUT.json). Ten trees
were moved to `D:\OmniaData`, with 92,460 files and 15,156,174,074 logical bytes
retained. Full relative path/type/size/mtime comparisons, nonzero directory
identities and selected anchor hashes matched. Before-file device/inode fields
were zero for all 92,460 files; per-file identity is unproved. The separate
`continuation-r2/RELOCATION_IDENTITY_CORRECTION.json` supersedes that part of
the original receipt's interpretation. This was not an all-file SHA-256 sweep.

`research\repos\rea` and `projects\omnia-public` still retain their own Git
metadata at the new external locations; both HEADs and clean statuses were
rechecked. Historical bundles preserve reachable history only. Index, ignored
and untracked data and a restore drill require separate evidence.

Same-volume relocation reclaimed no capacity. The separately logged supported
Cargo clean removed the former generated integration target. See CHECKPOINT
for logical output and observed free-space measurements.

## 2026-11-11 — Committed-source export

`tools/maintained-scripts/stage-public-release.mjs` now exports all regular
tracked files from one resolved commit, including native code, project-owned
skills and tooling. It reads Git objects instead of silently skipping missing
working files. Required-input checks, object verification and per-file SHA-256
readback accompany the external export receipt. The default destination is a
new directory under `D:\OmniaData\exports`; overrides must be outside and must
not contain the source. Symlinks, gitlinks, path collisions, reparse parents,
generated/private tracked paths and existing destinations are rejected.

This is an export candidate, not a publication/privacy/license or build
approval. Uncommitted work is excluded and remains owned by its checkout.
