#pragma once

#include "omnia/graph/peer_mesh.hpp"

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace omnia::graph {

enum class GraphifyEntityKind : std::uint8_t {
    Agent = 0,
    CodeModule = 1,
    Symbol = 2,
    Skill = 3,
    MemoryNote = 4,
    Artifact = 5,
    Requirement = 6
};

std::string entity_kind_to_string(GraphifyEntityKind kind);

struct GraphifyEntity {
    std::string id;
    GraphifyEntityKind kind = GraphifyEntityKind::CodeModule;
    std::string label;
    std::string path;
    std::string summary;
};

struct GraphifyEdge {
    std::string from_id;
    std::string to_id;
    std::string relation;
    GraphifyProvenance provenance = GraphifyProvenance::Extracted;
    std::uint16_t confidence_bps = 10000;
    std::string rationale;
};

struct TraversedGraphifyEdge {
    GraphifyEdge edge;
    std::uint32_t depth = 1;
};

struct GraphifyTraversalResult {
    std::string start_id;
    TraversalDirection direction = TraversalDirection::Both;
    std::uint32_t max_depth = 3;
    std::vector<GraphifyEntity> visited_entities;
    std::vector<TraversedGraphifyEdge> traversed_edges;
    std::vector<GraphifyEdge> quarantined_ambiguous;
    std::vector<std::vector<std::string>> detected_cycles;
};

class GraphifyIndex {
public:
    GraphifyIndex() = default;

    void upsert_entity(GraphifyEntity entity);
    void add_edge(GraphifyEdge edge);

    const GraphifyEntity* entity(std::string_view id) const noexcept;
    std::vector<GraphifyEntity> entities() const;
    const std::vector<GraphifyEdge>& edges() const noexcept { return edges_; }

    // O(1) incident edge lookups
    std::vector<GraphifyEdge> outgoing_edges(std::string_view id) const;
    std::vector<GraphifyEdge> incoming_edges(std::string_view id) const;

    // Bidirectional BFS with AMBIGUOUS provenance quarantine
    GraphifyTraversalResult traverse_bfs(
        std::string_view start_id,
        TraversalDirection direction = TraversalDirection::Both,
        std::uint32_t max_depth = 3,
        bool include_ambiguous = false
    ) const;

private:
    std::map<std::string, GraphifyEntity, std::less<>> entities_;
    std::vector<GraphifyEdge> edges_;
    std::unordered_map<std::string, std::vector<std::size_t>> outgoing_idx_;
    std::unordered_map<std::string, std::vector<std::size_t>> incoming_idx_;
};

} // namespace omnia::graph
