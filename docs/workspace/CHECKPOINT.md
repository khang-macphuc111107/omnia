# Omnia workspace checkpoint — 2026-11-11

- Root: `D:\Omnia`
- Root Git: initialized for governance files only.
- Nested Git metadata: preserved; see `WORKSPACE_OWNERSHIP.json`.
- Product source: `repos\omnia` remains the owning repository.
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
