#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace omnia::graph {

enum class AgentRole : std::uint8_t {
    Coordinator = 0,
    Worker = 1,
    Specialist = 2,
    Verifier = 3,
    Subagent = 4
};

enum class GraphifyProvenance : std::uint8_t {
    Extracted = 0,
    Inferred = 1,
    Ambiguous = 2
};

enum class TraversalDirection : std::uint8_t {
    Forward = 0,
    Reverse = 1,
    Both = 2
};

std::string role_to_string(AgentRole role);
AgentRole parse_role(std::string_view raw);

std::string provenance_to_string(GraphifyProvenance p);
GraphifyProvenance parse_provenance(std::string_view raw);
std::uint16_t default_confidence_bps(GraphifyProvenance p) noexcept;

std::string direction_to_string(TraversalDirection d);
TraversalDirection parse_direction(std::string_view raw);

class AgentGraphError : public std::runtime_error {
public:
    enum class Code : std::uint8_t {
        InvalidAgentId,
        UnknownAgent,
        InactiveAgent,
        SelfLink,
        UnlinkedPeers,
        OwnershipConflict,
        HopBudgetExceeded,
        StaleEpoch,
        UnknownMessageSeq
    };

    AgentGraphError(Code code, std::string message)
        : std::runtime_error(std::move(message)), code_(code) {}

    Code code() const noexcept { return code_; }

private:
    Code code_;
};

struct AgentNode {
    std::string agent_id;
    std::string label;
    AgentRole role = AgentRole::Worker;
    std::vector<std::string> owned_paths;
    std::vector<std::string> excluded_paths;
    std::set<std::string> capabilities;
    std::uint64_t epoch = 1;
    std::uint32_t max_hops = 12;
    bool active = true;
    std::uint64_t registered_at_ms = 0;
};

struct PeerChannelEdge {
    std::string from;
    std::string to;
    std::string relation = "duplex_peer";
    bool duplex = true;
    GraphifyProvenance provenance = GraphifyProvenance::Extracted;
    std::uint64_t created_at_ms = 0;
};

struct PeerEnvelope {
    std::uint64_t seq = 0;
    std::string conversation_id;
    std::string from;
    std::string primary_to;
    bool is_broadcast = false;
    bool is_reply = false;
    std::set<std::string> recipients;
    std::optional<std::uint64_t> in_reply_to_seq;
    std::uint32_t hop_count = 0;
    std::uint32_t max_hops = 12;
    std::uint64_t sender_epoch = 1;
    GraphifyProvenance provenance = GraphifyProvenance::Extracted;
    std::string payload;
    std::optional<std::string> expect_reply_from;
    std::uint64_t timestamp_ms = 0;
};

struct SendPeerRequest {
    std::string from;
    std::string to;
    std::string conversation_id = "default";
    std::string payload;
    GraphifyProvenance provenance = GraphifyProvenance::Extracted;
    std::uint32_t hop_count = 0;
    std::uint32_t max_hops = 0;
    std::optional<std::uint64_t> sender_epoch;
    bool expect_reply = false;
    std::uint64_t now_ms = 0;
};

struct StalledConversation {
    std::string conversation_id;
    std::uint64_t last_seq = 0;
    std::string last_sender;
    std::string waiting_on_peer;
    std::uint64_t elapsed_ms = 0;
};

class PeerMeshGraph {
public:
    explicit PeerMeshGraph(std::uint32_t default_max_hops = 12);

    void register_agent(AgentNode node);
    const AgentNode* agent(std::string_view agent_id) const noexcept;
    std::vector<AgentNode> agents() const;

    std::uint64_t bump_agent_epoch(std::string_view agent_id);
    void set_agent_active(std::string_view agent_id, bool active);

    void connect_duplex(
        std::string_view agent_a,
        std::string_view agent_b,
        std::string_view relation = "duplex_peer",
        GraphifyProvenance provenance = GraphifyProvenance::Extracted,
        std::uint64_t now_ms = 0
    );

    void connect_directed(
        std::string_view from,
        std::string_view to,
        std::string_view relation = "directed_peer",
        GraphifyProvenance provenance = GraphifyProvenance::Extracted,
        std::uint64_t now_ms = 0
    );

    std::size_t connect_all_to_all(
        std::string_view relation = "all_to_all_duplex",
        GraphifyProvenance provenance = GraphifyProvenance::Extracted,
        std::uint64_t now_ms = 0
    );

    // O(1) Adjacency Lookups
    bool has_duplex_link(std::string_view agent_a, std::string_view agent_b) const noexcept;
    std::vector<std::string> outgoing_peers(std::string_view agent_id) const;
    std::vector<std::string> incoming_peers(std::string_view agent_id) const;
    std::vector<std::string> duplex_peers(std::string_view agent_id) const;
    std::vector<PeerChannelEdge> all_edges() const;

    // Duplex Messaging, Auto-Reverse Reply, Broadcast & Cursor Delivery
    PeerEnvelope send_peer(const SendPeerRequest& req);

    PeerEnvelope reply(
        std::string_view from,
        std::uint64_t in_reply_to_seq,
        std::string_view payload,
        GraphifyProvenance provenance = GraphifyProvenance::Extracted,
        bool expect_further_reply = false,
        std::uint64_t now_ms = 0
    );

    PeerEnvelope broadcast(
        std::string_view from,
        std::string_view conversation_id,
        std::string_view payload,
        GraphifyProvenance provenance = GraphifyProvenance::Extracted,
        std::uint32_t max_hops = 0,
        std::uint64_t now_ms = 0
    );

    std::vector<PeerEnvelope> read_since(
        std::string_view agent_id,
        std::uint64_t since_seq
    ) const;

    std::vector<PeerEnvelope> drain_unread(std::string_view agent_id);
    const std::vector<PeerEnvelope>& all_messages() const noexcept { return messages_; }

    std::vector<StalledConversation> detect_stalled_conversations(
        std::uint64_t now_ms,
        std::uint64_t stall_timeout_ms
    ) const;

private:
    struct ConversationTracker {
        std::uint64_t last_seq = 0;
        std::string last_sender;
        std::optional<std::string> waiting_on_peer;
        std::uint64_t last_activity_ms = 0;
    };

    std::uint32_t default_max_hops_ = 12;
    std::map<std::string, AgentNode, std::less<>> agents_;
    std::unordered_map<std::string, std::map<std::string, PeerChannelEdge>> outgoing_;
    std::unordered_map<std::string, std::map<std::string, PeerChannelEdge>> incoming_;
    std::unordered_map<std::string, std::set<std::string>> duplex_peers_;
    std::vector<PeerEnvelope> messages_;
    std::unordered_map<std::string, std::uint64_t> read_cursors_;
    std::map<std::string, ConversationTracker, std::less<>> conversations_;

    const AgentNode& require_active_agent(std::string_view id) const;
    void require_link(std::string_view from, std::string_view to) const;
};

} // namespace omnia::graph
