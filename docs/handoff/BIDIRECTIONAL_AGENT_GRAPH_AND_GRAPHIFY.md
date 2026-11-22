# Bidirectional All-to-All Agent Graph & Graphify Architecture (`PRODUCT-GRAPH`)

> **Audience**: Collaborator **HTMusTC**, Omnia **Full Native Rust** & Studio UI maintainers, and Codex / Antigravity / Omnia swarm agents
>
> **Authoritative Rust & UI Implementation**: [peer_mesh.rs](../../rust/omnia-graph/src/peer_mesh.rs), [graphify_index.rs](../../rust/omnia-graph/src/graphify_index.rs), [graph_tests.rs](../../rust/omnia-graph/tests/graph_tests.rs), and [ui/app/peer-graph.js](../../ui/app/peer-graph.js) *(archived Wave 4 C++20 implementation backed up externally in `D:\OmniaData\backups\pre-full-rust-20261115\`)*
>
> **Related Skills**: [`.agents/skills/deep-general-graph-orchestration`](../../.agents/skills/deep-general-graph-orchestration/SKILL.md), [`.agents/skills/deep-cpp-native`](../../.agents/skills/deep-cpp-native/SKILL.md) *(historical C++ diagnostics)*, [`.agents/skills/autonomous-power-continuity`](../../.agents/skills/autonomous-power-continuity/SKILL.md), [`.agents/skills/omni-bilingual-skill-router`](../../.agents/skills/omni-bilingual-skill-router/SKILL.md)
>
> **Research Qualification Provenance**: `Graphify-Labs/graphify` (`Apache-2.0`, `ADMIT_CONCEPT`, `code_import_admitted = 0`)

---

## 1. Architectural Mandate: 2-Way All-to-All Peer Mesh (`A <-> B`) Over 1-Way Trees

Conventional agent frameworks force communication into a rigid **1-way parent-to-child tree** (`coordinator -> worker -> coordinator`) or a strictly **acyclic pipeline (DAG)**. That restriction creates three structural failure modes in real engineering runs:
1. **Coordinator Bottlenecks**: Sibling authors, build-runner specialists, and read-only verifiers cannot exchange interface contracts or audit findings directly without waking the root coordinator on every intermediate step.
2. **Broken Iterative Repair Loops**: Real verification (`author <-> build-specialist <-> verifier`) is inherently cyclic until `0` defects remain; flattening it into a one-shot DAG either drops repair turns or hides ad-hoc retries outside the graph ledger.
3. **One-Way Context Blindness**: Child or specialist agents cannot query upstream/peer rationale or traverse reverse provenance links (*"what depends on this Rust module or spec?"*) on demand.

Omnia's native **Rust** `omnia-graph` crate (`omnia_graph::PeerMeshGraph` + `omnia_graph::GraphifyIndex`), exposed via Rust `omnia-studio.exe` (`/api/graph/snapshot`, `/api/graph/send`, `/api/graph/traverse`) and rendered interactively in [ui/app/peer-graph.js](../../ui/app/peer-graph.js), models agent collaboration and codebase/knowledge navigation as a **general bidirectional multigraph**:

```mermaid
flowchart LR
    Coord["Coordinator Node"] <-->|"Duplex (A <-> B)"| RustCore["rust-core-storage-routing (omnia-studio.exe)"]
    Coord <-->|"Duplex (A <-> B)"| Win32["rust-native-win32 (omnia-native.exe)"]
    Coord <-->|"Duplex (A <-> B)"| StudioUI["flagship-ui-architect (ui/**)"]
    Coord <-->|"Duplex (A <-> B)"| Verifier["Read-Only Verifier"]
    StudioUI <-->|"Duplex /api/* Contract"| RustCore
    RustCore <-->|"Duplex Audit Loop"| Verifier
    Win32 <-->|"Duplex Audit Loop"| Verifier
    StudioUI <-->|"Duplex Audit Loop"| Verifier
    KG["GraphifyIndex (Rust AST + Docs + SQL + PDF)"] <-->|"Forward & Reverse BFS"| RustCore
    KG <-->|"Forward & Reverse BFS"| Win32
    KG <-->|"Forward & Reverse BFS"| Verifier
```

---

## 2. Core Invariants of `omnia_graph::PeerMeshGraph` (Rust)

Implemented in [peer_mesh.rs](../../rust/omnia-graph/src/peer_mesh.rs) and verified in [graph_tests.rs](../../rust/omnia-graph/tests/graph_tests.rs) (`cargo test -p omnia-graph --offline --locked`):

| Capability | 1-Way Hierarchy / DAG Legacy | Omnia Rust Bidirectional General Graph (`PeerMeshGraph`) |
| :--- | :--- | :--- |
| **Topology** | `parent -> child` tree or acyclic DAG only | Arbitrary general graph across `AgentRole::{Coordinator,Worker,Specialist,Verifier,Subagent}`: `connect_duplex` (`A <-> B`), `connect_all_to_all`, `connect_directed`, sibling-to-sibling, child-to-parent, and cyclic SCCs |
| **Adjacency Index** | Outgoing children list only | Symmetric `outgoing` + `incoming` + `duplex_peers` indexes providing `O(1)` forward and reverse peer lookup |
| **Message Primitives** | One-shot prompt in, single final string out | Full-duplex `send_peer`, auto-reverse `reply`, `broadcast`, and cursor-based `read_since(agent_id, since_seq)` wakeup (zero-cost sleep while waiting) |
| **Write Isolation** | Implicit or unguarded shared workspace | Explicit `owned_paths` + `excluded_paths` disjoint ownership guard (`AgentGraphError` ownership conflict) rejecting overlapping concurrent write scopes before mutation (`DISJOINT_OWNERSHIP.json`) |
| **Cycle & Epoch Control** | Cycles rejected as graph errors | Intentional cycles permitted with explicit `max_hops` (`HopBudgetExceeded`), monotonic `epoch` fencing (`bump_agent_epoch` / `StaleEpoch`), and `detect_stalled_conversations` |
| **Out-of-Source Build Isolation** | Competing in-tree compiler outputs | Strict out-of-source Cargo target directory (`CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace`) and serialized workspace compilation |

---

## 3. Graphify-Inspired Bidirectional Code & Knowledge Graph (`omnia_graph::GraphifyIndex`)

Qualified from `Graphify-Labs/graphify` (`Apache-2.0`, clean-room architectural concept admission with **zero** third-party code copied into Omnia) and implemented in [graphify_index.rs](../../rust/omnia-graph/src/graphify_index.rs):

1. **Deterministic Multi-Artifact Entity & Edge Indexing**:
   - Connects `GraphifyEntityKind::{Agent,CodeModule,Symbol,Skill,MemoryNote,Artifact,Requirement}` across Rust crates (`rust/*`), Flagship Studio JS/CSS modules, Markdown governance & handoff specs ([GOAL.md](../workspace/GOAL.md), [DOD.md](../workspace/DOD.md), [DECISIONS.md](../workspace/DECISIONS.md)), `winsqlite3` schemas, `Cargo.toml` / JSON configs, and reference PDFs into one local queryable graph—**without** requiring an external vector database.
2. **Bidirectional `O(1)` Incidence & BFS Traversal (`TraversalDirection::{Forward,Reverse,Both}`)**:
   - Every relationship is indexed in both `outgoing_edges(id)` and `incoming_edges(id)` and traversable via `traverse_bfs(start_id, direction, max_depth, include_ambiguous)`:
     - **Forward (`Forward`)**: `module -> defines -> symbol`, `spec -> requires -> test`, `omnia_studio -> calls -> router`.
     - **Reverse (`Reverse`)**: `symbol -> defined_in -> module`, `test -> verifies -> spec`, `router -> called_by -> omnia_studio` (answering *"what breaks or needs re-verification if I edit this module?"* in `O(degree)`).
3. **Explicit Three-Tier Epistemic Provenance (`GraphifyProvenance`)**:
   - `Extracted` (`10000` bps default): Deterministically parsed from Rust/Cargo syntax, SQL foreign keys, or explicit file/URI links.
   - `Inferred`: Derived from structural clustering, symbol resolution, or cross-document correspondence with recorded `rationale`.
   - `Ambiguous` (**quarantined by default**): Retained in `quarantined_ambiguous` when `include_ambiguous == false` rather than silently merged into active traversal paths.
4. **Interactive Studio Visualization ([ui/app/peer-graph.js](../../ui/app/peer-graph.js))**:
   - Renders High-DPI `A <-> B` duplex peer channels, animated directional message pulses (`POST /api/graph/send`), `disjoint_paths` ownership inspectors, and live `Forward` / `Reverse` / `Both` `GraphifyIndex` BFS neighborhoods (`GET /api/graph/traverse`).

---

## 4. Cross-Host Workflow Synchronization (Omnia + Codex + `~/.agents` + Antigravity)

*(Pre-Wave-4 snapshot remains archived on pushed Git tag `archive/pre-cpp-rust-snapshot-20261112`; Wave 4 C++20 snapshot is backed up under `D:\OmniaData\backups\pre-full-rust-20261115\`.)*

This bidirectional peer-mesh and Graphify architecture is synchronized byte-for-byte across all **`19` repository skills** (`13` curated + `6` `kdense-*` research projections, `0` cross-host drift via `validate_skills.py --strict-all-skills`):
- **Omnia Repository ([`.agents/skills/`](../../.agents/skills/) + [skill_registry.rs](../../rust/omnia-harness/src/skill_registry.rs))**: `deep-general-graph-orchestration`, `deep-cpp-native` *(historical C++ diagnostics)*, `autonomous-power-continuity`, and `omni-bilingual-skill-router`.
- **Codex (`~/.codex/skills/` & `~/.codex/AGENTS.md`)** and **Global Agent Skills (`~/.agents/skills/`)**: Byte-identical pure UTF-8 `LF` skill packages across all `19` repo skills (`cross_host_drift_count: 0`).
- **Antigravity (`~/.gemini/config/skills.json` + `~/.gemini/GEMINI.md`)**: Global rule enforcement in `~/.gemini/GEMINI.md` plus drive-absolute forward-slash skill mounting in `~/.gemini/config/skills.json`.
