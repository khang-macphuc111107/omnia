#include "omnia/graph/graphify_index.hpp"

#include <queue>
#include <set>
#include <unordered_set>

namespace omnia::graph {

std::string entity_kind_to_string(GraphifyEntityKind kind) {
    switch (kind) {
        case GraphifyEntityKind::Agent: return "agent";
        case GraphifyEntityKind::CodeModule: return "code_module";
        case GraphifyEntityKind::Symbol: return "symbol";
        case GraphifyEntityKind::Skill: return "skill";
        case GraphifyEntityKind::MemoryNote: return "memory_note";
        case GraphifyEntityKind::Artifact: return "artifact";
        case GraphifyEntityKind::Requirement: return "requirement";
    }
    return "code_module";
}

void GraphifyIndex::upsert_entity(GraphifyEntity entity) {
    if (entity.id.empty()) {
        return;
    }
    if (entity.label.empty()) {
        entity.label = entity.id;
    }
    outgoing_idx_[entity.id];
    incoming_idx_[entity.id];
    const std::string key = entity.id;
    entities_.insert_or_assign(key, std::move(entity));
}

void GraphifyIndex::add_edge(GraphifyEdge edge) {
    if (edge.from_id.empty() || edge.to_id.empty()) {
        return;
    }
    if (entities_.find(edge.from_id) == entities_.end()) {
        upsert_entity(GraphifyEntity{
            edge.from_id, GraphifyEntityKind::Symbol, edge.from_id, "", ""
        });
    }
    if (entities_.find(edge.to_id) == entities_.end()) {
        upsert_entity(GraphifyEntity{
            edge.to_id, GraphifyEntityKind::Symbol, edge.to_id, "", ""
        });
    }
    const std::size_t idx = edges_.size();
    outgoing_idx_[edge.from_id].push_back(idx);
    incoming_idx_[edge.to_id].push_back(idx);
    edges_.push_back(std::move(edge));
}

const GraphifyEntity* GraphifyIndex::entity(std::string_view id) const noexcept {
    const auto it = entities_.find(id);
    if (it == entities_.end()) {
        return nullptr;
    }
    return &it->second;
}

std::vector<GraphifyEntity> GraphifyIndex::entities() const {
    std::vector<GraphifyEntity> out;
    out.reserve(entities_.size());
    for (const auto& [id, ent] : entities_) {
        (void)id;
        out.push_back(ent);
    }
    return out;
}

std::vector<GraphifyEdge> GraphifyIndex::outgoing_edges(std::string_view id) const {
    std::vector<GraphifyEdge> out;
    const auto it = outgoing_idx_.find(std::string(id));
    if (it != outgoing_idx_.end()) {
        out.reserve(it->second.size());
        for (const std::size_t edge_idx : it->second) {
            out.push_back(edges_[edge_idx]);
        }
    }
    return out;
}

std::vector<GraphifyEdge> GraphifyIndex::incoming_edges(std::string_view id) const {
    std::vector<GraphifyEdge> out;
    const auto it = incoming_idx_.find(std::string(id));
    if (it != incoming_idx_.end()) {
        out.reserve(it->second.size());
        for (const std::size_t edge_idx : it->second) {
            out.push_back(edges_[edge_idx]);
        }
    }
    return out;
}

GraphifyTraversalResult GraphifyIndex::traverse_bfs(
    std::string_view start_id,
    TraversalDirection direction,
    std::uint32_t max_depth,
    bool include_ambiguous
) const {
    GraphifyTraversalResult res{};
    res.start_id = std::string(start_id);
    res.direction = direction;
    res.max_depth = max_depth;

    const auto start_it = entities_.find(start_id);
    if (start_it == entities_.end()) {
        return res;
    }

    struct QueueEntry {
        std::string id;
        std::uint32_t depth = 0;
        std::vector<std::string> path;
    };

    std::queue<QueueEntry> q;
    std::unordered_set<std::string> visited;
    std::unordered_set<std::size_t> seen_traversed;
    std::unordered_set<std::size_t> seen_quarantined;

    visited.insert(start_it->first);
    res.visited_entities.push_back(start_it->second);
    q.push(QueueEntry{start_it->first, 0, {start_it->first}});

    while (!q.empty()) {
        QueueEntry cur = std::move(q.front());
        q.pop();

        if (cur.depth >= max_depth) {
            continue;
        }

        std::vector<std::pair<std::size_t, std::string>> candidates;
        if (direction == TraversalDirection::Forward || direction == TraversalDirection::Both) {
            const auto out_it = outgoing_idx_.find(cur.id);
            if (out_it != outgoing_idx_.end()) {
                for (const std::size_t eidx : out_it->second) {
                    candidates.emplace_back(eidx, edges_[eidx].to_id);
                }
            }
        }
        if (direction == TraversalDirection::Reverse || direction == TraversalDirection::Both) {
            const auto in_it = incoming_idx_.find(cur.id);
            if (in_it != incoming_idx_.end()) {
                for (const std::size_t eidx : in_it->second) {
                    candidates.emplace_back(eidx, edges_[eidx].from_id);
                }
            }
        }

        for (const auto& [eidx, neighbor_id] : candidates) {
            const auto& edge = edges_[eidx];
            if (edge.provenance == GraphifyProvenance::Ambiguous && !include_ambiguous) {
                if (seen_quarantined.insert(eidx).second) {
                    res.quarantined_ambiguous.push_back(edge);
                }
                continue;
            }

            if (seen_traversed.insert(eidx).second) {
                res.traversed_edges.push_back(TraversedGraphifyEdge{edge, cur.depth + 1});
            }

            // Detect cycles along the current BFS path
            bool on_path = false;
            for (const auto& anc : cur.path) {
                if (anc == neighbor_id) {
                    on_path = true;
                    break;
                }
            }
            if (on_path) {
                std::vector<std::string> cyc = cur.path;
                cyc.push_back(neighbor_id);
                res.detected_cycles.push_back(std::move(cyc));
                continue;
            }

            if (visited.insert(neighbor_id).second) {
                const auto ent_it = entities_.find(neighbor_id);
                if (ent_it != entities_.end()) {
                    res.visited_entities.push_back(ent_it->second);
                }
                std::vector<std::string> next_path = cur.path;
                next_path.push_back(neighbor_id);
                q.push(QueueEntry{neighbor_id, cur.depth + 1, std::move(next_path)});
            }
        }
    }

    return res;
}

} // namespace omnia::graph
