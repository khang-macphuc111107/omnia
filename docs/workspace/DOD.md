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

## Final audit rounds

Before completion, run at least three independent end-to-end audits from the
same immutable tracked snapshot. Each must report zero unresolved errors or
warnings in scope; any new finding resets the counter. This cannot create
runtime evidence for features that remain unimplemented.
