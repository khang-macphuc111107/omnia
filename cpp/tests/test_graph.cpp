#include "test_support.hpp"

#include "omnia/graph/graphify_index.hpp"
#include "omnia/graph/peer_mesh.hpp"

#include <iostream>

namespace {

using namespace omnia::graph;

AgentNode writer(std::string id, std::string path, bool active = true) {
    AgentNode node;
    node.agent_id = std::move(id);
    node.owned_paths = {std::move(path)};
    node.active = active;
    return node;
}

void test_ownership_aliases_and_reactivation() {
    PeerMeshGraph mesh;
    mesh.register_agent(writer("owner", "cpp/**"));
    for (const auto alias : {"CPP/src/**", "ui/../cpp/src/**", "./cpp//src/./**", "cpp\\src\\*"}) {
        OMNIA_CHECK_THROWS(mesh.register_agent(writer("alias", alias)));
        OMNIA_CHECK(mesh.agent("alias") == nullptr);
    }
    for (const auto invalid : {"../outside/**", "C:/cpp/**", "/cpp/**", "cpp/**/src", "cpp./src", "cpp/src:stream"}) {
        OMNIA_CHECK_THROWS(mesh.register_agent(writer("invalid", invalid)));
        OMNIA_CHECK(mesh.agent("invalid") == nullptr);
    }
    auto parent = writer("parent", "ui/**");
    parent.excluded_paths = {"UI/temp/../PLUGIN/**"};
    mesh.register_agent(parent);
    mesh.register_agent(writer("plugin", "ui/plugin/**"));
    mesh.register_agent(writer("sibling", "cpp-other/**"));
    mesh.register_agent(writer("paused", "CPP/src/**", false));
    OMNIA_CHECK_THROWS(mesh.set_agent_active("paused", true));
    OMNIA_CHECK(!mesh.agent("paused")->active);
    mesh.set_agent_active("owner", false);
    mesh.set_agent_active("paused", true);
    OMNIA_CHECK(mesh.agent("paused")->active);
    OMNIA_CHECK_THROWS(mesh.set_agent_active("owner", true));
    OMNIA_CHECK(!mesh.agent("owner")->active);
}

void test_reply_authorization_and_epochs() {
    PeerMeshGraph mesh;
    for (const auto id : {"a", "b", "c"}) mesh.register_agent(writer(id, id));
    mesh.connect_all_to_all();
    const auto original = mesh.send_peer(SendPeerRequest{
        "a", "b", "authorization", "question", GraphifyProvenance::Extracted,
        0, 8, std::nullopt, true, 100
    });
    OMNIA_CHECK_THROWS(mesh.reply("c", original.seq, "intruder"));
    OMNIA_CHECK(mesh.all_messages().size() == 1);
    const auto stalled = mesh.detect_stalled_conversations(1000, 100);
    OMNIA_CHECK(stalled.size() == 1 && stalled[0].waiting_on_peer == "b");
    const auto valid = mesh.reply("b", original.seq, "answer");
    OMNIA_CHECK(valid.primary_to == "a");
    OMNIA_CHECK(mesh.detect_stalled_conversations(2000, 100).empty());
    const auto broadcast = mesh.broadcast("a", "broadcast", "everyone");
    mesh.reply("b", broadcast.seq, "first");
    mesh.reply("c", broadcast.seq, "second");
    mesh.bump_agent_epoch("a");
    const auto count = mesh.all_messages().size();
    OMNIA_CHECK_THROWS(mesh.reply("b", broadcast.seq, "old epoch"));
    OMNIA_CHECK(mesh.all_messages().size() == count);
}

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
    test_ownership_aliases_and_reactivation();
    test_reply_authorization_and_epochs();
    test_peer_mesh_duplex_and_guards();
    test_graphify_bidirectional_traversal();
    std::cout << "[PASS] test_omnia_graph (2-Way Duplex PeerMeshGraph & Bidirectional GraphifyIndex)\n";
    return 0;
}
