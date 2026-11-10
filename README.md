# Omnia workspace

`D:\Omnia` is the workspace control-plane root. It contains manifests, decisions and receipts for the Omnia ecosystem while preserving independent source repositories and recovery material.

## Layout policy

- `repos/omnia`: primary product repository; its Git history and dirty worktree remain independently owned.
- `publish-worktree`: linked worktree; do not move or delete its `.git` pointer casually.
- `docs/workspace`: topology, ownership, decisions and restore mappings.
- `artifacts`, `backups`, `archive`, `quarantine`, `_cleanup-quarantine-*`: evidence or recovery material; excluded from the root index.
- `tools`, `scripts`, `research`, `output`, `downloads`: operational or reference material; index only explicit manifests and documentation.

The root Git repository tracks workspace governance. A clean root status means the governance files are committed; it does not claim that every child repository has no local changes.

## Safety rule

Nested Git metadata is preserved until a source-preserving snapshot, path mapping and restore check exist. Flattening or deleting `.git` metadata without those receipts would destroy provenance and is not a valid cleanup.
