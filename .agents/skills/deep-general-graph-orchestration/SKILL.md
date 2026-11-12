---
name: deep-general-graph-orchestration
description: Design, execute, and verify bidirectional all-to-all agent peer-mesh graphs, cyclic/event/state/hypergraph workflows, and Graphify-style deterministic bidirectional code-and-knowledge graphs with explicit provenance and execution receipts.
metadata:
  short-description: Bidirectional all-to-all agent graphs and Graphify provenance navigation
---

# Deep General Graph Orchestration & Bidirectional Peer Mesh

Use this skill whenever an agent swarm, control plane, runtime workflow, or repository knowledge index is a **general bidirectional graph** rather than a 1-way parent-to-child tree or strictly acyclic DAG. The graph may contain **2-way (`Duplex`, `A <-> B`) all-to-all peer links**, feedback cycles, self-loops, parallel edges, hyperedges, conditional state transitions, or strongly connected components (SCCs). Never silently flatten a general bidirectional graph into a 1-way hierarchy or DAG.

For concrete Rust/runtime data structures and Graphify pipeline contracts, read [references/bidirectional-peer-mesh-and-graphify.md](references/bidirectional-peer-mesh-and-graphify.md).

## Core Architectural Pillars

### 1. Bidirectional All-to-All Agent Graph (`PeerMeshGraph`, `A <-> B`)
- **Universal 2-Way Connectivity**: Every agent role (`coordinator`, `worker`, `specialist`, `verifier`, `subagent`) is a first-class graph node capable of symmetric duplex edges (`A <-> B`) with any other agent (`sibling <-> sibling`, `author <-> verifier`, `child <-> parent`, `all-to-all` peer addressing).
- **O(1) Symmetric Adjacency & Duplex Routing**: Maintain both `outgoing` and `incoming` neighbor sets per node so forward dispatch, reverse callbacks, peer negotiation, `send_peer`, `broadcast`, `reply`, and cursor-based `read_since(seq)` operate in both directions without routing bottlenecks through a single root parent.
- **Disjoint Write Ownership (`disjoint_paths`)**: Bidirectional communication never implies shared mutable file state. Enforce disjoint owned-path sets across concurrently active writers and reject overlapping path claims before mutation.
- **Cyclic Safety Without Forbidding Cycles**: Allow multi-turn cyclic collaboration (`A <-> B <-> C -> A` or `author <-> verifier` repair loops) guarded by explicit `max_hops`, `epoch` counters, idempotency keys, stall detection, and falsifiable convergence predicates.

### 2. Graphify Deterministic Graph-First Navigation & Provenance
- **Graph-First Before Raw Grep**: Build or query deterministic structural graphs across code ASTs, docs, SQL schemas, configs, and PDFs (`detect -> extract -> build -> cluster -> analyze -> report`) with zero mandatory vector-store dependency.
- **Explained Bidirectional Provenance Edges**: Every knowledge/code relationship is traversable in both **forward** (`calls`, `imports`, `implements`, `verifies`) and **reverse** (`called_by`, `imported_by`, `implemented_by`, `verified_by`) directions and carries an explicit provenance tag:
  - `EXTRACTED`: Deterministically parsed from AST, manifest, schema, or explicit link.
  - `INFERRED`: Derived via structural clustering (such as Leiden community cohesion), symbol resolution, or cross-artifact heuristic with recorded rationale.
  - `AMBIGUOUS`: Candidate link retained with competing targets/uncertainty—never silently merged on name similarity alone.

## Required Execution Workflow

1. **Scope, Authority & Disjoint Ownership**
   - Record graph identity/revision, node roles, allowed effect classes, `disjoint_paths` ownership map, and bounded run budgets (`max_hops`, node visits, edge traversals, retries, concurrent peers; keep user-facing `token_budget` uncapped unless explicitly requested).
2. **Canonical Graph & Edge Model**
   - Give every node stable ID, role, state, preconditions/postconditions, owned paths, cursor (`last_read_seq`), and authority.
   - Give every edge stable ID, endpoints, directionality (`Duplex` vs `Directed`), relation type, provenance tag (`EXTRACTED | INFERRED | AMBIGUOUS`), guard, and revision. Preserve parallel edges and graph revisions.
3. **Static Invariants & SCC / Cycle Policy**
   - Verify endpoint existence, bidirectional adjacency symmetry (`B in outgoing(A) <=> A in incoming(B)`, and symmetric peer visibility for `Duplex` links), disjoint path non-overlap, reachability, god-node bottlenecks, and SCC termination predicates. A cycle lacking a measurable bound or convergence predicate is `blocked` or `unverified`.
4. **Bounded Simulation & Live Duplex Execution**
   - Exercise cyclic negotiation (`A <-> B <-> C`), `child -> parent -> sibling -> child` round-trips, reverse provenance queries, path-conflict rejection, duplicate/out-of-order message cursors, and `max_hops` termination before claiming runtime readiness.
   - Emit append-only lifecycle events (`accepted`, `dispatched`, `delivered`, `replied`, `completed`, `failed`, `stalled`, `outcome_unknown`) and preserve immutable prior revisions on rewire.
5. **Verification & 6-State Graph Receipt**
   - Produce a secret-free receipt recording graph hash/revision, node/duplex-edge counts, SCC/hop-budget results, provenance breakdown (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`), test/runtime observations, and exact status (`verified`, `partially_verified`, `blocked`, `unverified`, `outcome_unknown`, `cancelled`, `rolled_back`).

## Anti-Hallucination Rules

- Never restrict peer agents to 1-way parent-to-child communication when `Duplex` peer links are requested or beneficial.
- Never call a cyclic peer mesh a DAG, or infer live provider/process execution from planned traversals or queued messages alone.
- Keep credentials, tokens, cookies, and private PII out of all graph nodes, edges, and exported artifacts.
