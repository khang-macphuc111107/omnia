# Bidirectional Peer-Mesh Agent Graph & Graphify Reference Contract

## 1. Why 2-Way All-to-All (`PeerMeshGraph`) Replaces 1-Way Hierarchies

Traditional multi-agent trees restrict communication to `parent -> child -> parent`, forcing every clarification, build handoff, and verification finding to bounce through a central coordinator bottleneck. Omnia's general agent graph (`PeerMeshGraph`) models collaboration as a **bidirectional multigraph**:

- **Duplex Peer Links (`A <-> B`)**: Linking `A` and `B` in `Duplex` mode registers symmetric capability in `O(1)` (`outgoing[A]` contains `B`, `incoming[B]` contains `A`, and vice versa), enabling direct `sibling <-> sibling`, `author <-> build-runner`, `author <-> verifier`, and `child <-> parent` round-trips.
- **All-to-All Mesh Helper**: Full peer cohorts can connect in an all-to-all mesh while keeping wakeups disciplined via explicit `@peer` addressing and sequence cursors (`read_since(seq)`), so idle peers consume zero tokens while asleep.
- **Disjoint Path Guard (`disjoint_paths`)**: Every writer node declares canonical path prefixes. Attempting to register or activate two concurrent writers with overlapping owned paths fails deterministically before any file edit occurs.
- **Bounded Cyclic Convergence**: Feedback loops (`author -> verifier -> author -> verifier`) carry a monotonic `epoch` and `hop_count` checked against `max_hops` plus an explicit pass/convergence predicate (`0 defects`, `cargo test` exit `0`).

## 2. Graphify-Inspired Deterministic Knowledge & Code Graph (`ADMIT_CONCEPT`)

Qualified from `Graphify-Labs/graphify` (`Apache-2.0`, clean-room concept admission, `code_import_admitted = 0`):

1. **Deterministic Pipeline**: `detect(root) -> extract(paths) -> build(extractions) -> cluster(graph) -> analyze(god_nodes, surprising_connections) -> report/export`.
2. **Multi-Artifact Scope**: Indexes source ASTs (functions, structs, traits, modules, line spans), Markdown governance/spec docs, SQL schemas, JSON/TOML configs, and curriculum/research PDFs in one local graph without requiring an external vector database.
3. **Bidirectional Provenance Queries**:
   - Every edge stores `(source, target, relation, provenance_tag, explanation)` where `provenance_tag` is `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`.
   - Both `neighbors_forward(node)` and `neighbors_reverse(node)` (plus symmetric `neighbors_both(node)`) are indexed so an agent editing `skills.rs` or `dynamic_router.rs` immediately sees both what it depends on **and** every test, doc, Tauri command, or DoD gate that depends on it.
4. **Pre-Tool Navigation Discipline**: Query symbol/artifact neighborhoods and community clusters first, then read exact `file:line` spans—cutting exploratory grep token waste while preserving 100% deterministic citations.
