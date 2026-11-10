---
name: deep-clean
description: Use when an authorized repository or artifact tree must be cleaned through inventory, provenance, quarantine, and verification so stale files, generated output, duplicate backups, and dirty-worktree causes are handled without deleting unknown work.
---
# Deep Clean

Clean by evidence and lifecycle, never by filename alone.

## Boundary

Use this skill for an end-to-end cleanup pass. Use `git-safe-backup-and-clean-worktree`
for risky Git operations and `repo-hygiene-and-artifact-lifecycle` for the
retention ledger and artifact classification. Use `deep-organize` for placement
or module taxonomy; use `deep-refactor` for behavior-preserving code changes.
Cleaning does not authorize deleting user or agent work, rewriting history, or
removing credentials, caches, or generated artifacts without a proven owner.

## Workflow

1. Record a baseline: repository root, branch, worktrees, open handles when
   available, `git status --porcelain=v1 -uall`, ignored build output, and a
   content hash manifest outside the source tree.
2. Classify every candidate as tracked source, intentional untracked work,
   generated output, evidence, temporary data, cache, duplicate backup, or
   unknown. For each candidate record owner, producer, reason, retention,
   destination, and confidence.
3. Detect stale build directories, root scratch files, adjacent `.bak/.old/.orig`
   copies, duplicate exports, abandoned logs, and files excluded by ignore rules
   but still consuming space. Do not infer staleness from age alone.

When moving same-volume copies to quarantine, confirm whether the source uses hard links or reparse points; a copy on the same volume may share mutable file identity and will not reduce disk usage until the source itself is deleted or moved across volumes. For same-volume moves that do not free space, state the free-space delta and the next operation required to reclaim space.

On Windows, do not treat zero `st_dev`/`st_ino` values from an enumeration API
as file identity. Verify that the chosen stat/handle API returns meaningful
values before the move. If the before identity is missing, compare available
path/type/size/time and content hashes while marking identity unproved; fresh
after-only identities cannot reconstruct the missing before observation.

4. Prefer reversible actions: regenerate, move to an approved quarantine,
   update ignore rules, or archive with a manifest. Delete only when ownership,
   reproducibility, retention expiry, and path containment are proven.
5. Re-run source scans, build/test discovery, link checks, manifest hashes,
   `git diff --check`, and `git status`. Compare before/after counts and bytes.
6. Produce a cleanup receipt listing each action, skipped unknown, retained
   artifact, rollback path, and remaining dirty causes.

## Hard gates

- Never run `git reset --hard`, `git clean -fdx`, recursive deletion, or broad
  moves against a computed path without resolving and checking containment.
- Never create beside-source backups; use Git history, worktrees, or an external
  dated evidence/quarantine root.
- Preserve pre-existing untracked files until ownership is established.
- A clean status is not the goal if it would hide legitimate work; report
  intentional dirty state explicitly.

## Done when

Every candidate has a disposition, all destructive actions have a manifest and
rollback evidence, source behavior checks pass, no adjacent backup files were
introduced, and the final status/diff is explainable line by line. Unknown or
unowned items remain preserved and are listed for follow-up.
