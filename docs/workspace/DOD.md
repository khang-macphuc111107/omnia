# Omnia definition of done

Each row needs direct evidence from the current source snapshot. Plans, hashes,
fixtures, mocks, previews and agent messages are not substitutes for the
required evidence.

| ID | Definition | Required evidence | Current |
|---|---|---|---|
| `DOD-01` | Source is discoverable at root | Tracked tree, README and source-aware ignores | `PARTIAL` |
| `DOD-02` | Native dependency closure resolves | Locked metadata, path audit and clone metadata | `PARTIAL` |
| `DOD-03` | Scoped native behavior passes | Command logs, exit codes and environment | `PARTIAL` |
| `DOD-04` | Divergent work is reconciled | Per-path ledger, owner, disposition and review | `OPEN` |
| `DOD-05` | Nested Git/worktrees are safe | Snapshot, index/untracked/ignored capture and restore | `OPEN` |
| `DOD-06` | Generated output does not dirty source | Ignore policy, external target and status receipt | `PARTIAL` |
| `DOD-07` | Code is clean and maintainable | Format/lint/static review and ownership map | `OPEN` |
| `DOD-08` | D: cleanup is measured/reversible | Ownership, allocated bytes, candidate ledger and delta | `OPEN` |
| `DOD-09` | History corpus is bounded/honest | Watermark, denominator and missing/truncation ledger | `PARTIAL` |
| `DOD-10` | History has semantic review | Ranges, independent audit and redacted synthesis | `OPEN` |
| `DOD-11` | Handoff docs agree | Cross-reference validator and readback | `PARTIAL` |
| `DOD-12` | Skills/research are qualified | Query, revision, license, ranges and decision | `OPEN` |
| `DOD-13` | Native capabilities are real | Packaged/live receipts for each claim | `OPEN` |
| `DOD-14` | QA covers UI/security/performance/recovery | Independent negative/race/reload/resource evidence | `OPEN` |
| `DOD-15` | Public delivery is reproducible | Authenticated account, pushed SHA, clone and secret scan | `OPEN` |
| `DOD-16` | Follow-up chat starts with durable goal | Thread ID, prompt, activation receipt and checkpoint | `DEFERRED` |

## Gate protocol

Record `before`, exact command/inspection, `after`, hashes, reviewer,
limitations and next action for each row. Any missing evidence remains
`OPEN`/`PARTIAL`. A source change, failed check, drifted hash, missing record
or contradiction resets the affected row and its consecutive-audit count.

## Acceptance details

- **DOD-01:** Source is tracked at the actual root; README and AGENTS resolve
  to current files. Bulk archives, upstream clones and recovery data have
  deliberate external ownership. Ignoring a folder does not count as moving it.
- **DOD-02:** Both retained manifest closures and compile-time input files
  resolve in an isolated clone/export. Record Rust/toolchain/OS and locked
  dependency behavior. Local caches are not repository inputs.
- **DOD-03:** Match each claimed native behavior to an executed oracle.
  Report fixtures, direct package tests, shared-crate integration and live
  provider/packaged behavior separately.
- **DOD-04:** Reconciliation includes HEAD, staged, unstaged, renamed and
  untracked changes. Every retained unique product change has an owner,
  disposition, rationale, snapshot and review. Correct parsing precedes counts.
- **DOD-05:** Before retiring a common Git store, preserve refs/objects,
  staged index, dirty/untracked/valuable ignored bytes and all linked-worktree
  registrations. A bundle covers reachable history, not that whole state.
  Restore to an isolated destination and compare the relevant state.
- **DOD-06:** Builds/logs/exports use external owned directories. Source-aware
  ignores, cleanup retention, reparse boundaries and explainable Git status
  remain correct after build, test and export.
- **DOD-07:** Name concrete reviewed modules, findings and repairs.
  Preserve behavior/contracts, error handling and dependencies; report format,
  lint and focused tests without treating them as an exhaustive clean-code proof.
- **DOD-08:** Distinguish drive-root inventory from Omnia inventory.
  Record each candidate's producer, ownership, size method, active-use check,
  disposition and restore/regeneration route. Measure free bytes before/after;
  same-volume relocation is layout progress, not reclaimed capacity.
- **DOD-09:** State exact source watermark, accessible denominator and
  per-source acquisition limits. Preserve gaps, truncation, growing tails,
  alternate projections and remote/deleted/unavailable records explicitly.
- **DOD-10:** Review source ranges and associated prompt/output/state/artifacts,
  derive requirements with locators, and audit those derivations independently.
  Acquisition hashes prove identity, not reading, understanding or completeness.
- **DOD-11:** Each fact has one owning document; indexes route to it.
  Include specs, tasks, plan, DoD, state, checkpoint, decisions and lessons,
  with next executable actions and rules for additive steer.
  Finish interrupted text before moving to queued additions.
- **DOD-12:** Bind each adopted skill improvement to actual reviewed sources,
  revisions/licenses and a supported use case. Check duplicates and references;
  validate changed skills and project to both requested environments.
  Installation/projection is distinct from discovery, loading and invocation.
- **DOD-13:** Cover all `PRODUCT-*` leaves in GOAL. Native Rust is preferred;
  exceptions require a recorded resource-backed reason. Complete composer and
  attachment ordering/persistence/provider contracts. Do not claim universal
  hidden-window capture, process-private input or encrypted-content access.
- **DOD-14:** Cover actual navigation and nested/dynamic UI, all interactive
  controls, resize/DPI/zoom/scroll/drag/drop, input-length tiers, Vietnamese IME,
  accessibility, animation and backend effects. Combine code checks with
  repeated UI observations and addressable image/video evidence. Include
  negative, boundary, property/fuzz, race, recovery and resource tests where
  applicable; mark unsupported scenarios rather than passing them.
- **DOD-15:** Verify GitHub account, exact target, visibility and license
  obligations. Review/redact secrets/private material before publication.
  Compare the remote SHA and test documented steps from a clean clone.
- **DOD-16:** Wait for root migration/handoff admission, then create the
  requested Omnia chat. Its prompt must request an immediate detailed
  persistent goal with tasks/plan/specs/DoD and exact evidence status.
  Record the returned thread and activation outcome; a prepared prompt is not
  a created chat or an active goal.

## Final audit rounds

Before completion, run at least three independent end-to-end audits from the
same immutable tracked snapshot. Each must report zero unresolved errors or
warnings in scope; any new finding resets the counter. This cannot create
runtime evidence for features that remain unimplemented.

Use distinct reviewers or independent evidence collection with the same frozen
scope, documented oracle and complete main-scope coverage. Record round ID,
reviewer, source commit/tree and external input hashes, checks, errors, warnings
and findings. Three identical reruns or three summaries of one run are not three
independent audits. Prefer a full recheck after a finding; document any narrower
impact-based recheck and the unaffected-scope argument.

The default required streak is three; a risk-based plan may choose four or five.
Changing scope or a material input resets affected streaks. Whole-goal completion
requires every mandatory parent task and DoD gate, not merely a passing subset.
Current final streak: **0**. No finite test set proves absolute absence of bugs
or complete understanding of inaccessible history.
