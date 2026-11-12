---
name: omnia-session-governance-handoff
description: Govern Omnia repository startup preflight, canonical workspace artifacts, cross-session transfer contracts, and the 5-phase execution protocol with 6-state completion receipts so inspected, modified, and runtime-verified states are never conflated.
metadata:
  short-description: Omnia session admission, canonical artifact map, and 6-state receipts
---

# Omnia Session Governance & Handoff

Enforce deterministic session startup, single-source-of-truth artifact ownership, and honest 6-state completion receipts across multi-session and collaborator workflows (distilled from *Khởi động và Quy trình Omnia*).

## Phase 0 — Session Admission & Preflight Gate

Before modifying tracked repository files or resuming an interrupted session:
1. **Inspect Live Workspace State**: Check `SESSION_ADMISSION.json`, `git status --short`, current `HEAD` commit, worktree topology (`git worktree list`), and externalized build/data layout (`EXTERNAL_LAYOUT.json`, `SOURCE_DISPOSITION_LEDGER.json`).
2. **Read Authoritative Contracts Directly**: Read `README.md`, `AGENTS.md`, `GOAL.md`, `DOD.md`, `CHECKPOINT.md`, `DECISIONS.md`, and relevant subsystem specs (`COMPOSER_REQUIREMENTS.md`, `DYNAMIC_ROUTING_REQUIREMENTS.md`) by literal path—never rely solely on prior chat summaries.
3. **Lock Scope & Preserve Backlog**: Preserve all open parent/leaf requirement IDs (`ROOT-*`, `DRIVE-*`, `HISTORY-*`, `RESEARCH-*`, `PRODUCT-*`, `QUALITY-*`, `DOD-*`, `SESSION-G*`) and pre-existing dirty worktree files owned by other lanes.
4. For the complete 7-layer canonical repository file taxonomy, read [references/canonical-repo-artifacts.md](references/canonical-repo-artifacts.md).

## Phase 1 — Non-Negotiable Anti-Slop & Ownership Invariants

- **One Canonical Owner Per Fact**: Update authoritative governance/spec files in place rather than spawning duplicate scratch summaries in the repository root. Put large raw exports, build caches (`CARGO_TARGET_DIR`), media, and quarantine trees outside the product root (`D:\OmniaData\...`).
- **Strict State Separation**: Never conflate **Inspected** (file read), **Modified** (bytes written), and **Runtime-Verified** (executed and measured via tests, binary run, UIA/browser check, or hash receipt).
- **Zero-Slop Rejection**: Reject wrapper-only stubs, mock-only completions, silent scope reductions, literal shell-escape corruptions (`0x0b` vertical tabs, stray here-strings, CRLF drift), and unredacted secrets/PII.

## Phase 2 — Deterministic Execution & Atomic Synchronization

1. Pinpoint root causes and interface contracts with `file:line` evidence.
2. Apply minimal, backwards-compatible source or documentation changes using pure UTF-8 `LF` line endings.
3. Synchronize affected workspace ledgers (`CHECKPOINT.md`, `DECISIONS.md`, or external JSON receipts) from the same snapshot.

## Phase 3 — Quantitative Runtime Verification

Run objective checks (`cargo test --locked`, `native/qa-*.ps1`, `git diff --check`, `quick_validate.py`, or `omni-deterministic-verifiers`) and record exact exit codes, test counts, and SHA-256 digests.

## Phase 4 — 6-State Completion & Handoff Receipt

Structure every session checkpoint or collaborator handoff (`docs/handoff/COLLABORATOR_HANDOFF.md`) with these six explicit buckets:
- **Verified**: Proven by independent test, runtime execution, or cryptographic receipt on the current snapshot.
- **Partial**: Implemented or inspected subset with exact boundaries stated.
- **Unresolved**: Known open defects or remaining requirements still in the queue.
- **Blocked**: External environmental/auth/ACL blockers with exact unblocking commands or conditions.
- **Next**: Immediate executable next step for the resuming agent or collaborator.
- **Exact Practical Limits**: Honest statement of unexecuted surfaces, login-walled URLs, or hardware/OS constraints.
