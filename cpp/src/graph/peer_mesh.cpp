#include "omnia/graph/peer_mesh.hpp"

#include <algorithm>
#include <cctype>

namespace omnia::graph {

namespace {

std::string to_lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return out;
}

std::string normalize_path_pattern(std::string_view raw) {
    std::string s;
    s.reserve(raw.size());
    for (const char ch : raw) {
        if (ch == '\\') {
            s.push_back('/');
        } else {
            s.push_back(ch);
        }
    }
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) {
        s.erase(s.begin());
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) {
        s.pop_back();
    }
    while (s.size() >= 2 && s[0] == '.' && s[1] == '/') {
        s.erase(0, 2);
    }
    if (s == "**" || s == "*") {
        return "*";
    }
    if (s.size() >= 3 && s.substr(s.size() - 3) == "/**") {
        s.erase(s.size() - 3);
    } else if (s.size() >= 2 && s.substr(s.size() - 2) == "/*") {
        s.erase(s.size() - 2);
    }
    while (s.size() > 1 && s.back() == '/') {
        s.pop_back();
    }
    return s;
}

bool prefix_covers(std::string_view parent, std::string_view child) noexcept {
    if (parent.empty() || child.empty()) {
        return false;
    }
    if (parent == "*") {
        return true;
    }
    if (parent == child) {
        return true;
    }
    if (child.size() > parent.size() &&
        child.substr(0, parent.size()) == parent &&
        child[parent.size()] == '/') {
        return true;
    }
    return false;
}

bool is_excluded_by(const std::vector<std::string>& exclusions, std::string_view target) noexcept {
    for (const auto& ex : exclusions) {
        if (prefix_covers(ex, target)) {
            return true;
        }
    }
    return false;
}

std::optional<std::string> find_effective_overlap(const AgentNode& a, const AgentNode& b) {
    for (const auto& pa : a.owned_paths) {
        if (pa.empty() || is_excluded_by(a.excluded_paths, pa)) {
            continue;
        }
        for (const auto& pb : b.owned_paths) {
            if (pb.empty() || is_excluded_by(b.excluded_paths, pb)) {
                continue;
            }
            if (pa == pb) {
                return pa;
            }
            if (prefix_covers(pa, pb) && !is_excluded_by(a.excluded_paths, pb)) {
                return pb;
            }
            if (prefix_covers(pb, pa) && !is_excluded_by(b.excluded_paths, pa)) {
                return pa;
            }
        }
    }
    return std::nullopt;
}

bool valid_agent_id(std::string_view id) noexcept {
    if (id.empty() || id.size() > 64) {
        return false;
    }
    for (const char c : id) {
        const auto uc = static_cast<unsigned char>(c);
        if (std::isalnum(uc) == 0 && c != '-' && c != '_' && c != '.') {
            return false;
        }
    }
    return true;
}

} // namespace

std::string role_to_string(AgentRole role) {
    switch (role) {
        case AgentRole::Coordinator: return "coordinator";
        case AgentRole::Worker: return "worker";
        case AgentRole::Specialist: return "specialist";
        case AgentRole::Verifier: return "verifier";
        case AgentRole::Subagent: return "subagent";
    }
    return "worker";
}

AgentRole parse_role(std::string_view raw) {
    const std::string low = to_lower(raw);
    if (low == "coordinator") return AgentRole::Coordinator;
    if (low == "specialist") return AgentRole::Specialist;
    if (low == "verifier") return AgentRole::Verifier;
    if (low == "subagent") return AgentRole::Subagent;
    return AgentRole::Worker;
}

std::string provenance_to_string(GraphifyProvenance p) {
    switch (p) {
        case GraphifyProvenance::Extracted: return "EXTRACTED";
        case GraphifyProvenance::Inferred: return "INFERRED";
        case GraphifyProvenance::Ambiguous: return "AMBIGUOUS";
    }
    return "EXTRACTED";
}

GraphifyProvenance parse_provenance(std::string_view raw) {
    const std::string low = to_lower(raw);
    if (low == "inferred") return GraphifyProvenance::Inferred;
    if (low == "ambiguous") return GraphifyProvenance::Ambiguous;
    return GraphifyProvenance::Extracted;
}

std::uint16_t default_confidence_bps(GraphifyProvenance p) noexcept {
    switch (p) {
        case GraphifyProvenance::Extracted: return 10000;
        case GraphifyProvenance::Inferred: return 7500;
        case GraphifyProvenance::Ambiguous: return 3500;
    }
    return 10000;
}

std::string direction_to_string(TraversalDirection d) {
    switch (d) {
        case TraversalDirection::Forward: return "Forward";
        case TraversalDirection::Reverse: return "Reverse";
        case TraversalDirection::Both: return "Both";
    }
    return "Both";
}

TraversalDirection parse_direction(std::string_view raw) {
    const std::string low = to_lower(raw);
    if (low == "forward") return TraversalDirection::Forward;
    if (low == "reverse") return TraversalDirection::Reverse;
    return TraversalDirection::Both;
}

PeerMeshGraph::PeerMeshGraph(std::uint32_t default_max_hops)
    : default_max_hops_(default_max_hops == 0 ? 1 : default_max_hops) {}

void PeerMeshGraph::register_agent(AgentNode node) {
    if (!valid_agent_id(node.agent_id)) {
        throw AgentGraphError(
            AgentGraphError::Code::InvalidAgentId,
            "Invalid agent identifier: " + node.agent_id
        );
    }
    if (node.label.empty()) {
        node.label = node.agent_id;
    }
    if (node.epoch == 0) {
        node.epoch = 1;
    }
    if (node.max_hops == 0) {
        node.max_hops = default_max_hops_;
    }

    for (auto& p : node.owned_paths) {
        p = normalize_path_pattern(p);
    }
    for (auto& ex : node.excluded_paths) {
        ex = normalize_path_pattern(ex);
    }

    if (node.active) {
        for (const auto& [other_id, other] : agents_) {
            if (other_id == node.agent_id || !other.active) {
                continue;
            }
            if (const auto conflict = find_effective_overlap(node, other); conflict.has_value()) {
                throw AgentGraphError(
                    AgentGraphError::Code::OwnershipConflict,
                    "Disjoint path conflict between '" + node.agent_id + "' and '" +
                    other_id + "' on '" + *conflict + "'"
                );
            }
        }
    }

    outgoing_[node.agent_id];
    incoming_[node.agent_id];
    duplex_peers_[node.agent_id];
    const std::string id = node.agent_id;
    agents_.insert_or_assign(id, std::move(node));
}

const AgentNode* PeerMeshGraph::agent(std::string_view agent_id) const noexcept {
    const auto it = agents_.find(agent_id);
    if (it == agents_.end()) {
        return nullptr;
    }
    return &it->second;
}

std::vector<AgentNode> PeerMeshGraph::agents() const {
    std::vector<AgentNode> out;
    out.reserve(agents_.size());
    for (const auto& [id, node] : agents_) {
        (void)id;
        out.push_back(node);
    }
    return out;
}

std::uint64_t PeerMeshGraph::bump_agent_epoch(std::string_view agent_id) {
    auto it = agents_.find(agent_id);
    if (it == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent: " + std::string(agent_id)
        );
    }
    ++it->second.epoch;
    return it->second.epoch;
}

void PeerMeshGraph::set_agent_active(std::string_view agent_id, bool active) {
    auto it = agents_.find(agent_id);
    if (it == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent: " + std::string(agent_id)
        );
    }
    it->second.active = active;
}

void PeerMeshGraph::connect_duplex(
    std::string_view agent_a,
    std::string_view agent_b,
    std::string_view relation,
    GraphifyProvenance provenance,
    std::uint64_t now_ms
) {
    if (agent_a == agent_b) {
        throw AgentGraphError(
            AgentGraphError::Code::SelfLink,
            "Self-link not permitted: " + std::string(agent_a)
        );
    }
    if (agents_.find(agent_a) == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent: " + std::string(agent_a)
        );
    }
    if (agents_.find(agent_b) == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent: " + std::string(agent_b)
        );
    }

    const std::string a(agent_a);
    const std::string b(agent_b);
    const std::string rel = relation.empty() ? "duplex_peer" : std::string(relation);

    const PeerChannelEdge ab{a, b, rel, true, provenance, now_ms};
    const PeerChannelEdge ba{b, a, rel, true, provenance, now_ms};

    outgoing_[a].insert_or_assign(b, ab);
    incoming_[b].insert_or_assign(a, ab);

    outgoing_[b].insert_or_assign(a, ba);
    incoming_[a].insert_or_assign(b, ba);

    duplex_peers_[a].insert(b);
    duplex_peers_[b].insert(a);
}

void PeerMeshGraph::connect_directed(
    std::string_view from,
    std::string_view to,
    std::string_view relation,
    GraphifyProvenance provenance,
    std::uint64_t now_ms
) {
    if (from == to) {
        throw AgentGraphError(
            AgentGraphError::Code::SelfLink,
            "Self-link not permitted: " + std::string(from)
        );
    }
    if (agents_.find(from) == agents_.end() || agents_.find(to) == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent endpoint for directed link"
        );
    }
    const std::string f(from);
    const std::string t(to);
    const bool rev_exists = outgoing_[t].find(f) != outgoing_[t].end();
    const PeerChannelEdge edge{
        f,
        t,
        relation.empty() ? "directed_peer" : std::string(relation),
        rev_exists,
        provenance,
        now_ms
    };
    outgoing_[f].insert_or_assign(t, edge);
    incoming_[t].insert_or_assign(f, edge);

    if (rev_exists) {
        outgoing_[t][f].duplex = true;
        incoming_[f][t].duplex = true;
        duplex_peers_[f].insert(t);
        duplex_peers_[t].insert(f);
    }
}

std::size_t PeerMeshGraph::connect_all_to_all(
    std::string_view relation,
    GraphifyProvenance provenance,
    std::uint64_t now_ms
) {
    std::vector<std::string> ids;
    ids.reserve(agents_.size());
    for (const auto& [id, node] : agents_) {
        if (node.active) {
            ids.push_back(id);
        }
    }
    std::size_t pairs = 0;
    for (std::size_t i = 0; i < ids.size(); ++i) {
        for (std::size_t j = i + 1; j < ids.size(); ++j) {
            connect_duplex(ids[i], ids[j], relation, provenance, now_ms);
            ++pairs;
        }
    }
    return pairs;
}

bool PeerMeshGraph::has_duplex_link(
    std::string_view agent_a,
    std::string_view agent_b
) const noexcept {
    const auto it = duplex_peers_.find(std::string(agent_a));
    if (it == duplex_peers_.end()) {
        return false;
    }
    return it->second.find(std::string(agent_b)) != it->second.end();
}

std::vector<std::string> PeerMeshGraph::outgoing_peers(std::string_view agent_id) const {
    std::vector<std::string> out;
    const auto it = outgoing_.find(std::string(agent_id));
    if (it != outgoing_.end()) {
        out.reserve(it->second.size());
        for (const auto& [peer, edge] : it->second) {
            (void)edge;
            out.push_back(peer);
        }
    }
    return out;
}

std::vector<std::string> PeerMeshGraph::incoming_peers(std::string_view agent_id) const {
    std::vector<std::string> out;
    const auto it = incoming_.find(std::string(agent_id));
    if (it != incoming_.end()) {
        out.reserve(it->second.size());
        for (const auto& [peer, edge] : it->second) {
            (void)edge;
            out.push_back(peer);
        }
    }
    return out;
}

std::vector<std::string> PeerMeshGraph::duplex_peers(std::string_view agent_id) const {
    std::vector<std::string> out;
    const auto it = duplex_peers_.find(std::string(agent_id));
    if (it != duplex_peers_.end()) {
        out.assign(it->second.begin(), it->second.end());
    }
    return out;
}

std::vector<PeerChannelEdge> PeerMeshGraph::all_edges() const {
    std::vector<PeerChannelEdge> out;
    for (const auto& [id, node] : agents_) {
        (void)node;
        const auto it = outgoing_.find(id);
        if (it != outgoing_.end()) {
            for (const auto& [to, edge] : it->second) {
                (void)to;
                out.push_back(edge);
            }
        }
    }
    return out;
}

const AgentNode& PeerMeshGraph::require_active_agent(std::string_view id) const {
    const auto it = agents_.find(id);
    if (it == agents_.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownAgent,
            "Unknown agent: " + std::string(id)
        );
    }
    if (!it->second.active) {
        throw AgentGraphError(
            AgentGraphError::Code::InactiveAgent,
            "Inactive agent: " + std::string(id)
        );
    }
    return it->second;
}

void PeerMeshGraph::require_link(std::string_view from, std::string_view to) const {
    const auto it = outgoing_.find(std::string(from));
    if (it == outgoing_.end() || it->second.find(std::string(to)) == it->second.end()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnlinkedPeers,
            "No active peer channel from '" + std::string(from) + "' to '" + std::string(to) + "'"
        );
    }
}

PeerEnvelope PeerMeshGraph::send_peer(const SendPeerRequest& req) {
    const AgentNode& sender = require_active_agent(req.from);
    (void)require_active_agent(req.to);
    require_link(req.from, req.to);

    if (req.sender_epoch.has_value() && *req.sender_epoch != sender.epoch) {
        throw AgentGraphError(
            AgentGraphError::Code::StaleEpoch,
            "Stale sender epoch for '" + req.from + "'"
        );
    }

    const std::uint32_t eff_max_hops = req.max_hops == 0 ? default_max_hops_ : req.max_hops;
    if (req.hop_count >= eff_max_hops) {
        throw AgentGraphError(
            AgentGraphError::Code::HopBudgetExceeded,
            "Conversation '" + req.conversation_id + "' exceeded max_hops"
        );
    }

    const std::uint64_t seq = static_cast<std::uint64_t>(messages_.size()) + 1;
    PeerEnvelope env{};
    env.seq = seq;
    env.conversation_id = req.conversation_id.empty() ? "default" : req.conversation_id;
    env.from = req.from;
    env.primary_to = req.to;
    env.recipients.insert(req.to);
    env.hop_count = req.hop_count;
    env.max_hops = eff_max_hops;
    env.sender_epoch = sender.epoch;
    env.provenance = req.provenance;
    env.payload = req.payload;
    if (req.expect_reply) {
        env.expect_reply_from = req.to;
    }
    env.timestamp_ms = req.now_ms;

    conversations_.insert_or_assign(
        env.conversation_id,
        ConversationTracker{seq, env.from, env.expect_reply_from, req.now_ms}
    );
    messages_.push_back(env);
    return env;
}

PeerEnvelope PeerMeshGraph::reply(
    std::string_view from,
    std::uint64_t in_reply_to_seq,
    std::string_view payload,
    GraphifyProvenance provenance,
    bool expect_further_reply,
    std::uint64_t now_ms
) {
    const AgentNode& sender = require_active_agent(from);
    if (in_reply_to_seq == 0 || in_reply_to_seq > messages_.size()) {
        throw AgentGraphError(
            AgentGraphError::Code::UnknownMessageSeq,
            "Message sequence not found for reply"
        );
    }
    const PeerEnvelope orig = messages_[static_cast<std::size_t>(in_reply_to_seq - 1)];
    (void)require_active_agent(orig.from);
    require_link(from, orig.from);

    const std::uint32_t next_hop = orig.hop_count + 1;
    if (next_hop >= orig.max_hops) {
        throw AgentGraphError(
            AgentGraphError::Code::HopBudgetExceeded,
            "Reply exceeded max_hops in conversation '" + orig.conversation_id + "'"
        );
    }

    const std::uint64_t seq = static_cast<std::uint64_t>(messages_.size()) + 1;
    PeerEnvelope env{};
    env.seq = seq;
    env.conversation_id = orig.conversation_id;
    env.from = std::string(from);
    env.primary_to = orig.from;
    env.is_reply = true;
    env.recipients.insert(orig.from);
    env.in_reply_to_seq = in_reply_to_seq;
    env.hop_count = next_hop;
    env.max_hops = orig.max_hops;
    env.sender_epoch = sender.epoch;
    env.provenance = provenance;
    env.payload = std::string(payload);
    if (expect_further_reply) {
        env.expect_reply_from = orig.from;
    }
    env.timestamp_ms = now_ms;

    conversations_.insert_or_assign(
        env.conversation_id,
        ConversationTracker{seq, env.from, env.expect_reply_from, now_ms}
    );
    messages_.push_back(env);
    return env;
}

PeerEnvelope PeerMeshGraph::broadcast(
    std::string_view from,
    std::string_view conversation_id,
    std::string_view payload,
    GraphifyProvenance provenance,
    std::uint32_t max_hops,
    std::uint64_t now_ms
) {
    const AgentNode& sender = require_active_agent(from);
    std::set<std::string> recips;
    const auto out_it = outgoing_.find(std::string(from));
    if (out_it != outgoing_.end()) {
        for (const auto& [peer_id, edge] : out_it->second) {
            (void)edge;
            const auto ag_it = agents_.find(peer_id);
            if (ag_it != agents_.end() && ag_it->second.active) {
                recips.insert(peer_id);
            }
        }
    }

    const std::uint64_t seq = static_cast<std::uint64_t>(messages_.size()) + 1;
    PeerEnvelope env{};
    env.seq = seq;
    env.conversation_id = conversation_id.empty() ? "broadcast" : std::string(conversation_id);
    env.from = std::string(from);
    env.primary_to = "@all";
    env.is_broadcast = true;
    env.recipients = std::move(recips);
    env.hop_count = 0;
    env.max_hops = max_hops == 0 ? default_max_hops_ : max_hops;
    env.sender_epoch = sender.epoch;
    env.provenance = provenance;
    env.payload = std::string(payload);
    env.timestamp_ms = now_ms;

    conversations_.insert_or_assign(
        env.conversation_id,
        ConversationTracker{seq, env.from, std::nullopt, now_ms}
    );
    messages_.push_back(env);
    return env;
}

std::vector<PeerEnvelope> PeerMeshGraph::read_since(
    std::string_view agent_id,
    std::uint64_t since_seq
) const {
    std::vector<PeerEnvelope> out;
    if (since_seq >= messages_.size()) {
        return out;
    }
    const std::string target(agent_id);
    for (std::size_t idx = static_cast<std::size_t>(since_seq); idx < messages_.size(); ++idx) {
        const auto& m = messages_[idx];
        if (m.recipients.find(target) != m.recipients.end()) {
            out.push_back(m);
        }
    }
    return out;
}

std::vector<PeerEnvelope> PeerMeshGraph::drain_unread(std::string_view agent_id) {
    const std::string key(agent_id);
    const std::uint64_t since = read_cursors_[key];
    auto msgs = read_since(agent_id, since);
    read_cursors_[key] = static_cast<std::uint64_t>(messages_.size());
    return msgs;
}

std::vector<StalledConversation> PeerMeshGraph::detect_stalled_conversations(
    std::uint64_t now_ms,
    std::uint64_t stall_timeout_ms
) const {
    std::vector<StalledConversation> stalled;
    for (const auto& [conv_id, tr] : conversations_) {
        if (tr.waiting_on_peer.has_value() && now_ms >= tr.last_activity_ms) {
            const std::uint64_t elapsed = now_ms - tr.last_activity_ms;
            if (elapsed >= stall_timeout_ms) {
                stalled.push_back(StalledConversation{
                    conv_id,
                    tr.last_seq,
                    tr.last_sender,
                    *tr.waiting_on_peer,
                    elapsed
                });
            }
        }
    }
    return stalled;
}

} // namespace omnia::graph
