# Omnia execution plan and wave architecture

**Index role:** Concise navigable execution plan routing to authoritative contracts in [`GOAL.md`](GOAL.md), [`DOD.md`](DOD.md), and [`CHECKPOINT.md`](CHECKPOINT.md). Do not duplicate mutable counters here.

## Orchestration topology

Omnia executes multi-lane engineering work through a **bidirectional 2-way peer-mesh graph** (`A <-> B` duplex links, `sibling <-> sibling`, `author <-> verifier`, `child <-> parent`) rather than a rigid one-way tree:

- **Specification & handoff doc:** [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
- **Rust runtime implementation:** [`../../src-tauri/crates/omnia-harness/src/agent_graph.rs`](../../src-tauri/crates/omnia-harness/src/agent_graph.rs) (`PeerMeshGraph` + `GraphifyIndex`)
- **Concurrency & safety invariants:**
  1. Strict `disjoint_paths` single-writer ownership per active peer (`excluded_paths` carve-out where required).
  2. Single serialized Cargo build/test runner (`$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'`) on 16 GB RAM hosts.
  3. Bounded cyclic feedback loops (`max_hops`, `epoch` fencing, convergence criteria, cursor-based `read_since(seq)` wakeup).
  4. Graph-first code/knowledge traversal (`GraphifyIndex` `Forward` / `Reverse` / `Both` with `EXTRACTED` / `INFERRED` / `AMBIGUOUS` edge provenance) before broad text grep.
  5. Additive steer intake (`ADDITIVE_INTAKE` with `token_budget IS NULL`) governed by [`STEER_QUEUE.md`](STEER_QUEUE.md).

## Multi-wave execution phases

| Wave | Scope | Key deliverables & owning locators | Verification gate |
|---|---|---|---|
| **Wave 1** | Root cleanup, source reconciliation, multi-host history, URL qualification, core native/crate slices | `138/138` focus rows reconciled ([`SOURCES.md`](SOURCES.md)), `12` clutter dirs externalized + `4` worktrees repaired + `+10.125 GiB` `D:\` reclaimed ([`CLEANUP_STATUS_20261112.md`](CLEANUP_STATUS_20261112.md)), `1,767`-file history watermark ([`SESSIONS.md`](SESSIONS.md)), `103`-URL qualification ([`REFS.md`](REFS.md)), 3 UI direction candidates ([`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)), dynamic router, hierarchical/graph memory + proactive RAG, rich Win32 composer + server-side UIA | Independent lane audits under `D:\OmniaData\qa\audits-20261112\` |
| **Wave 2** | Queued additive steers (`Steer #1..#8`) & full regression verification | Google Doc `100`-category / `1,001`-skill catalog extraction, `12` curated repo skills incl. `deep-proposal` + Windows drive-absolute Antigravity `skills.json` mount (`273` live skills), Antigravity 3-surface sync tool ([`../../tools/agy-history-sync/README.md`](../../tools/agy-history-sync/README.md)), `8` REA URLs + `github/spec-kit`, `agent_graph.rs` (`PeerMeshGraph` + `GraphifyIndex`), `#32770` `WH_CBT` modal UIA fix (`qa-guard.ps1` `12/12`) | `524/524` Cargo tests + `7/7` Win32 QA workflows (`90/90` cases `rc=0`) -> `PASS_ALL_SCOPED_LANES_ZERO_OPEN_DEFECTS` |
| **Wave 3** | Pre-commit ledger sync, Commit #1, GitHub publication, clean-clone check & handoff transfer | Navigable workspace indexes (`PLAN`, `TASKS`, `PROMPTS`, `SESSIONS`, `SOURCES`, `REFS`, `STEER_QUEUE`, `TRANSFER_CONTRACT`), clean `LF` commit on `master`, authenticated push to `https://github.com/khang-macphuc111107/omnia` ([`REMOTE_SETUP.md`](REMOTE_SETUP.md)), isolated clean-clone build/test (`DOD-15`), and honest `SESSION-01` transfer ([`SESSION_ADMISSION.json`](SESSION_ADMISSION.json)) | `git diff --check` exit `0`, zero-secret scan, remote SHA match & isolated clone build/test |

## Navigation to sibling governance files

- **Tasks & product leaves:** [`TASKS.md`](TASKS.md) -> [`GOAL.md`](GOAL.md)
- **Acceptance & audit rules:** [`DOD.md`](DOD.md)
- **Current watermark & hashes:** [`CHECKPOINT.md`](CHECKPOINT.md)
- **Architecture & cleanup decisions:** [`DECISIONS.md`](DECISIONS.md)
- **Prompt & steer traceability:** [`PROMPTS.md`](PROMPTS.md) & [`STEER_QUEUE.md`](STEER_QUEUE.md)
- **Collaborator & next-session transfer:** [`TRANSFER_CONTRACT.md`](TRANSFER_CONTRACT.md)
