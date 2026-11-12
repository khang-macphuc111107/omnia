# Omnia execution plan and wave architecture

**Index role:** Concise navigable execution plan routing to authoritative contracts in [`GOAL.md`](GOAL.md), [`DOD.md`](DOD.md), and [`CHECKPOINT.md`](CHECKPOINT.md). Do not duplicate mutable counters here.

## Orchestration topology

Omnia executes multi-lane engineering work through a **bidirectional 2-way peer-mesh graph** (`A <-> B` duplex links, `sibling <-> sibling`, `author <-> verifier`, `child <-> parent`) rather than a rigid one-way tree:

- **Specification & handoff doc:** [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
- **Native C++20 runtime implementation:** [`../../cpp/include/omnia/graph/peer_mesh.hpp`](../../cpp/include/omnia/graph/peer_mesh.hpp), [`../../cpp/src/graph/peer_mesh.cpp`](../../cpp/src/graph/peer_mesh.cpp), [`../../cpp/include/omnia/graph/graphify_index.hpp`](../../cpp/include/omnia/graph/graphify_index.hpp), and [`../../cpp/src/graph/graphify_index.cpp`](../../cpp/src/graph/graphify_index.cpp) (`PeerMeshGraph` + `GraphifyIndex`, exposed live via `omnia-studio.exe` `/api/graph/*`)
- **Concurrency & safety invariants:**
  1. Strict `disjoint_paths` single-writer ownership per active peer (`excluded_paths` carve-out where required).
  2. Strictly out-of-source C++20 CMake + Ninja builds (`D:\OmniaData\build\...` or `..\OmniaData\build\...` via [`../../CMakePresets.json`](../../CMakePresets.json)) with zero in-tree build artifacts.
  3. Bounded cyclic feedback loops (`max_hops`, `epoch` fencing, convergence criteria, cursor-based `read_since(seq)` wakeup).
  4. Graph-first code/knowledge traversal (`GraphifyIndex` `Forward` / `Reverse` / `Both` with `EXTRACTED` / `INFERRED` / `AMBIGUOUS` edge provenance) before broad text grep.
  5. Additive steer intake (`ADDITIVE_INTAKE` with `token_budget IS NULL`) governed by [`STEER_QUEUE.md`](STEER_QUEUE.md).

## Multi-wave execution phases

| Wave | Scope | Key deliverables & owning locators | Verification gate |
|---|---|---|---|
| **Wave 1** | Root cleanup, source reconciliation, multi-host history, URL qualification, core subsystem specs | `138/138` focus rows reconciled ([`SOURCES.md`](SOURCES.md)), `12` clutter dirs externalized + `4` worktrees repaired + `+10.125 GiB` initial `D:\` cache cleanup ([`CLEANUP_STATUS_20261112.md`](CLEANUP_STATUS_20261112.md)), `1,767`-file history watermark ([`SESSIONS.md`](SESSIONS.md)), `103`-URL qualification ([`REFS.md`](REFS.md)), 3 UI direction candidates ([`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)) | Independent lane audits under `D:\OmniaData\qa\audits-20261112\` |
| **Wave 2** | Queued additive steers (`Steer #1..#7`) & initial native/domain verification | Google Doc `100`-category / `1,001`-skill catalog extraction, curated repo skills incl. `deep-proposal` + Windows drive-absolute Antigravity `skills.json` mount, Antigravity 3-surface sync tool ([`../../tools/agy-history-sync/README.md`](../../tools/agy-history-sync/README.md)), `8` REA URLs + `github/spec-kit`, `#32770` `WH_CBT` modal UIA invoke | `7/7` Win32 QA workflows (`90/90` cases `rc=0`) -> `PASS_ALL_SCOPED_LANES_ZERO_OPEN_DEFECTS` |
| **Wave 3** | Pre-C++20 baseline publication, clean-clone check & `3/3` independent zero-defect audit streak (`Steer #8`) | Navigable workspace indexes, Commits #1–#3 pushed to `https://github.com/khang-macphuc111107/omnia`, `3/3` consecutive zero-finding audits (`c3033728abe6f0a4906a796bf7652c84408356d7`, archived as tag `archive/pre-cpp-rust-snapshot-20261112`) | `errors=0, warnings=0` across rounds 1–3 (`round-{1,2,3}-v2-receipt.json`) |
| **Wave 4** | Full Native C++20 migration (`0` `.rs`/`Cargo.*`), Flagship Studio UI, `13` skills (`deep-cpp-native`), exhaustive `D:\` + `C:\` deep clean (`+944.29 GiB` physical) & Commit #5 clean-clone CTest (`Steer #9..#12`) | [`../../CMakeLists.txt`](../../CMakeLists.txt), [`../../cpp/`](../../cpp/) (`omnia-studio.exe` `671.5 KB` + 5 `.lib` targets), [`../../native/`](../../native/) (`omnia-native.exe` `283 KiB` + `omnia_qa_seed.exe`), [`../../ui/`](../../ui/) & [`../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md), [`../../.agents/skills/deep-cpp-native/`](../../.agents/skills/deep-cpp-native/), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](DEEP_CLEAN_AUDIT_D_DRIVE.md) (`+778.15 GiB`), [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](DEEP_CLEAN_AUDIT_C_DRIVE.md) (`+166.14 GiB`) | `35/35` unified CTest cases, `7/7` Win32 QA (`90/90` `rc=0`), `45/45` Edge CDP UI states, `6/6` Wave 4 verifier audits, remote GitHub clean-clone C++20 Release build + CTest (`GITHUB_CPP20_DELIVERY_RECEIPT.json`) |

## Navigation to sibling governance files

- **Tasks & product leaves:** [`TASKS.md`](TASKS.md) -> [`GOAL.md`](GOAL.md)
- **Acceptance & audit rules:** [`DOD.md`](DOD.md)
- **Current watermark & hashes:** [`CHECKPOINT.md`](CHECKPOINT.md)
- **Architecture & cleanup decisions:** [`DECISIONS.md`](DECISIONS.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](DEEP_CLEAN_AUDIT_D_DRIVE.md), & [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](DEEP_CLEAN_AUDIT_C_DRIVE.md)
- **Prompt & steer traceability:** [`PROMPTS.md`](PROMPTS.md) & [`STEER_QUEUE.md`](STEER_QUEUE.md)
- **Collaborator & next-session transfer:** [`TRANSFER_CONTRACT.md`](TRANSFER_CONTRACT.md)
