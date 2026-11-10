# Omnia root migration and professional handoff goal

**Goal ID:** `OMNIA-ROOT-CLEAN-2026-11-11`  
**Status:** `ACTIVE`  
**Owner:** root integrator  
**Workspace:** `D:\Omnia`  
**Last reviewed:** 2026-11-11  

## Outcome

Deliver one discoverable, professional Omnia repository whose product source
is directly under `D:\Omnia`, with native Rust as the preferred runtime,
reproducible build entrypoints, a compact handoff, and evidence-backed
ownership for every retained or moved artifact. The workspace must be clean
because each file has a deliberate owner and lifecycle, not because unknown
work was hidden or deleted.

## Non-negotiable boundaries

1. Preserve dirty source, staged work, branch divergence, linked worktrees,
   ignored valuable data, recovery snapshots and research until a disposition
   and restore path exist.
2. Never publish credentials, tokens, cookies, browser profiles, private chat
   bodies, personal records or access-bearing URLs.
3. Native Rust is the target. WebView, Electron and Node remain compatibility
   dependencies only when a measured, documented native seam is not available.
4. A hash, enumeration, fixture, mock, preview or green structural check cannot
   prove semantic understanding, live integration, performance, security,
   feature parity or zero defects.
5. Every mutation has a before/after receipt, containment check, owner,
   rollback route and explicit limitation.
6. A failed or contradicted gate reopens all dependent claims and resets the
   relevant consecutive-audit counter.

## Atomic tasks

| ID | Task | State | Exit evidence |
|---|---|---|---|
| `ROOT-01` | Admit native Rust and complete shared-crate closure at root | `IN_PROGRESS` | Byte receipt, metadata, format, tests and review |
| `ROOT-02` | Reconcile primary/release/rebuild/goal-control differences | `OPEN` | Per-change incorporated/retained/superseded/unresolved ledger |
| `ROOT-03` | Repair or retire nested Git/worktree ownership | `OPEN` | Snapshot, path repair and restore drill |
| `ROOT-04` | Refactor and organize code without behavior loss | `OPEN` | Scoped diff, review, tests and explainable status |
| `ROOT-05` | Make root build and clean clone self-contained | `OPEN` | Fresh clone metadata/build/test and private-path scan |
| `DRIVE-01` | Inventory D: ownership and disk consumers | `IN_PROGRESS` | Bounded top-level inventory and reparse classification |
| `DRIVE-02` | Reclaim only proven disposable caches/duplicates | `BLOCKED_BY_DRIVE-01` | Candidate manifest, retention decision and free-space delta |
| `HISTORY-01` | Freeze and inventory accessible Codex history | `IN_PROGRESS` | Watermark, denominator and missing/truncated ledger |
| `HISTORY-02` | Perform hierarchical semantic review | `OPEN` | Session owner, bounded reviewers and independent audit |
| `HISTORY-03` | Extract prompts, requirements, goals, plans and tool evidence | `OPEN` | Redacted Markdown and traceability matrix |
| `HANDOFF-01` | Maintain specs, tasks, DoD, state, checkpoint, decisions and memory | `IN_PROGRESS` | Cross-file consistency and evidence links |
| `RESEARCH-01` | Qualify research/skills and project supported improvements | `OPEN` | Query/source/revision/license/admit-defer-reject records |
| `PRODUCT-01` | Complete native shell, provider, editor, browser, IDE and harness | `OPEN` | Runtime receipts for each claimed capability |
| `QUALITY-01` | Run code, security, UI, performance, accessibility and recovery QA | `OPEN` | Independent positive/negative/race/reload/resource results |
| `DELIVERY-01` | Verify GitHub identity, publication and clone handoff | `OPEN` | Account receipt, pushed SHA and clean clone |
| `SESSION-01` | Create follow-up Omnia chat only after handoff gates | `DEFERRED` | Thread ID, immediate goal activation and checkpoint |

## Evidence states

`ACQUIRED` means bytes/records have bounded hashes; `READ` means bounded
content was inspected; `SYNTHESIZED` means requirements were derived with
links; `REVIEWED` means an independent reviewer checked source and receipt;
`RUNTIME_VERIFIED` means behavior ran in the named environment;
`PUBLISHED` means the exact tree was pushed and clone-checked. Missing evidence
is `UNPROVEN`, never silently upgraded.

## Completion rule

Remain active until every mandatory task has a reviewed exit receipt, unresolved
rows have an owner and next action, root status is explainable, and a clean
clone follows README without private paths. Product capability, research
qualification, history comprehension and disk cleanup are reported separately.

## Current proof and limits

- Native admission: 197 files / 2,588,993 bytes, SHA-256 checked before/after.
- `cargo metadata --locked`, `cargo fmt --check` and `cargo test --locked`
  passed with build output outside `D:\Omnia`; this is not final product proof.
- History inventory: 852 rollout JSONL files, 2,256,736,449 bytes, 528,619
  records and 14,630 bounded units; semantic review credit is zero.
- D: scan was started read-only and stopped before completion because it was
  too broad; no D: deletion has been performed.
- Current source ledger records primary `4,783`, release `133`, rebuild `81`
  and goal-control `0` porcelain entries. The ledger is bounded and does not
  decide whether a path is source, generated output or recoverable work.

## Immediate next actions

1. Read this goal and `DOD.md` before each cycle.
2. Build the source divergence ledger before touching nested `.git`.
3. Replace the interrupted D: walk with bounded top-level and cache inventories.
4. Freeze the history corpus, then begin private semantic review and redacted synthesis.
5. Re-run root status, diff, clone and audit gates after each material change.
