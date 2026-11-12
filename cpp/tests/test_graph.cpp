#include "test_support.hpp"

#include "omnia/graph/graphify_index.hpp"
#include "omnia/graph/peer_mesh.hpp"

#include <iostream>

namespace {

using namespace omnia::graph;

void test_peer_mesh_duplex_and_guards() {
    PeerMeshGraph mesh(4); // default max_hops = 4

    mesh.register_agent(AgentNode{
        "coord", "Coordinator", AgentRole::Coordinator,
        {"docs/handoff/**"}, {}, {}, 1, 4, true, 100
    });
    mesh.register_agent(AgentNode{
        "cpp-core", "C++ Core", AgentRole::Worker,
        {"cpp/**"}, {"cpp/plugin/**"}, {}, 1, 4, true, 100
    });
    // Allowed because cpp-core carved out cpp/plugin/** in excluded_paths!
    mesh.register_agent(AgentNode{
        "plugin-sub", "Plugin Subagent", AgentRole::Subagent,
        {"cpp/plugin/**"}, {}, {}, 1, 4, true, 100
    });
    mesh.register_agent(AgentNode{
        "verifier", "Verifier", AgentRole::Verifier,
        {"qa/virtual/**"}, {}, {}, 1, 4, true, 100
    });

    // Overlapping path without carve-out MUST throw OwnershipConflict!
    OMNIA_CHECK_THROWS(mesh.register_agent(AgentNode{
        "rogue-writer", "Rogue", AgentRole::Specialist,
        {"cpp/src/**"}, {}, {}, 1, 4, true, 100
    }));

    const std::size_t pairs = mesh.connect_all_to_all("mesh_a_b", GraphifyProvenance::Extracted, 200);
    OMNIA_CHECK(pairs == 6); // 4 choose 2 = 6 symmetric 2-way links
    OMNIA_CHECK(mesh.has_duplex_link("cpp-core", "verifier"));
    OMNIA_CHECK(mesh.duplex_peers("cpp-core").size() == 3);
    OMNIA_CHECK(mesh.outgoing_peers("plugin-sub").size() == 3);
    OMNIA_CHECK(mesh.incoming_peers("coord").size() == 3);

    // Send peer -> auto-reverse reply -> hop budget check
    const auto e1 = mesh.send_peer(SendPeerRequest{
        "cpp-core", "verifier", "audit-loop", "Ready for audit",
        GraphifyProvenance::Extracted, 0, 3, std::nullopt, true, 1000
    });
    OMNIA_CHECK(e1.seq == 1 && e1.hop_count == 0);

    // Stall check before verifier replies
    OMNIA_CHECK(mesh.detect_stalled_conversations(6000, 4000).size() == 1);

    const auto e2 = mesh.reply("verifier", e1.seq, "1 minor question", GraphifyProvenance::Extracted, true, 6100);
    OMNIA_CHECK(e2.primary_to == "cpp-core" && e2.hop_count == 1);

    const auto e3 = mesh.reply("cpp-core", e2.seq, "Clarified", GraphifyProvenance::Extracted, true, 6200);
    OMNIA_CHECK(e3.primary_to == "verifier" && e3.hop_count == 2);

    // Next reply reaches hop 3 == max_hops(3) -> HopBudgetExceeded!
    OMNIA_CHECK_THROWS(mesh.reply("verifier", e3.seq, "Too many hops", GraphifyProvenance::Extracted, false, 6300));

    // Epoch fencing check
    const std::uint64_t new_ep = mesh.bump_agent_epoch("cpp-core");
    OMNIA_CHECK(new_ep == 2);
    OMNIA_CHECK_THROWS(mesh.send_peer(SendPeerRequest{
        "cpp-core", "coord", "stale-conv", "Stale packet",
        GraphifyProvenance::Extracted, 0, 4, 1, false, 7000
    }));

    // Broadcast & read_since(seq) cursor delivery
    const auto b = mesh.broadcast("coord", "wave-sync", "Sync checkpoint", GraphifyProvenance::Extracted, 4, 8000);
    OMNIA_CHECK(b.recipients.size() == 3);
    const auto inbox = mesh.read_since("plugin-sub", 0);
    OMNIA_CHECK(inbox.size() == 1 && inbox.front().seq == b.seq);
}

void test_graphify_bidirectional_traversal() {
    GraphifyIndex idx;
    idx.upsert_entity({"mod_router", GraphifyEntityKind::CodeModule, "Router", "cpp/routing", ""});
    idx.upsert_entity({"mod_core", GraphifyEntityKind::CodeModule, "Core", "cpp/core", ""});
    idx.upsert_entity({"spec_routing", GraphifyEntityKind::Requirement, "Spec", "docs/routing.md", ""});
    idx.upsert_entity({"ambig_cand", GraphifyEntityKind::Symbol, "Ambiguous", "", ""});

    idx.add_edge({"mod_router", "mod_core", "depends_on", GraphifyProvenance::Extracted, 10000, "CMake"});
    idx.add_edge({"mod_router", "spec_routing", "implements", GraphifyProvenance::Inferred, 8000, "Spec trace"});
    idx.add_edge({"mod_core", "ambig_cand", "weak_match", GraphifyProvenance::Ambiguous, 3500, "Quarantine"});

    // Forward from mod_core: ambig_cand must be quarantined, not visited!
    const auto fwd = idx.traverse_bfs("mod_core", TraversalDirection::Forward, 3, false);
    OMNIA_CHECK(fwd.visited_entities.size() == 1);
    OMNIA_CHECK(fwd.quarantined_ambiguous.size() == 1);

    // Reverse from mod_core: discovers mod_router!
    const auto rev = idx.traverse_bfs("mod_core", TraversalDirection::Reverse, 3, false);
    OMNIA_CHECK(rev.visited_entities.size() == 2);

    // Both from mod_core (depth 2): mod_core <- mod_router -> spec_routing!
    const auto both = idx.traverse_bfs("mod_core", TraversalDirection::Both, 2, false);
    OMNIA_CHECK(both.visited_entities.size() == 3);
    OMNIA_CHECK(both.quarantined_ambiguous.size() == 1);
}

} // namespace

int main() {
    test_peer_mesh_duplex_and_guards();
    test_graphify_bidirectional_traversal();
    std::cout << "[PASS] test_omnia_graph (2-Way Duplex PeerMeshGraph & Bidirectional GraphifyIndex)\n";
    return 0;
}
