#include "omnia/harness/memory_graph.hpp"
#include "omnia/core/sha256.hpp"

#include <cctype>
#include <queue>
#include <set>
#include <stdexcept>
#include <unordered_set>

namespace omnia::harness {

namespace {

std::string to_lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& ch : out) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return out;
}

bool valid_segment_chars(std::string_view seg) noexcept {
    if (seg.empty() || seg.size() > 64 || seg == "." || seg == "..") {
        return false;
    }
    for (const char ch : seg) {
        const auto uc = static_cast<unsigned char>(ch);
        if (uc < 0x20U || ch == '\\' || ch == '/' || ch == ':' || ch == '*' ||
            ch == '?' || ch == '"' || ch == '<' || ch == '>' || ch == '|') {
            return false;
        }
        if (std::isalnum(uc) == 0 && ch != '-' && ch != '_' && ch != '.') {
            return false;
        }
    }
    return true;
}

std::vector<std::string> extract_wiki_links(std::string_view content) {
    std::set<std::string> unique;
    std::size_t pos = 0;
    while (pos + 4 <= content.size()) {
        const std::size_t open = content.find("[[", pos);
        if (open == std::string_view::npos) {
            break;
        }
        const std::size_t close = content.find("]]", open + 2);
        if (close == std::string_view::npos) {
            break;
        }
        std::string_view target = content.substr(open + 2, close - (open + 2));
        const std::size_t pipe = target.find('|');
        if (pipe != std::string_view::npos) {
            target = target.substr(0, pipe);
        }
        while (!target.empty() && target.front() == ' ') target.remove_prefix(1);
        while (!target.empty() && target.back() == ' ') target.remove_suffix(1);
        if (!target.empty() && target.find('\n') == std::string_view::npos) {
            unique.insert(std::string(target));
        }
        pos = close + 2;
    }
    return std::vector<std::string>(unique.begin(), unique.end());
}

} // namespace

std::string memory_tier_to_string(MemoryTier tier) {
    return tier == MemoryTier::Working ? "Working" : "Durable";
}

MemoryTier parse_memory_tier(std::string_view raw) {
    const std::string low = to_lower_ascii(raw);
    if (low == "working" || low == "short_term" || low == "short-term") {
        return MemoryTier::Working;
    }
    return MemoryTier::Durable;
}

bool MemoryGraph::is_valid_namespace(std::string_view ns) noexcept {
    if (ns.empty() || ns.size() > 256) {
        return false;
    }
    if (ns.front() == '/' || ns.back() == '/') {
        return false;
    }
    if (ns.find('\\') != std::string_view::npos ||
        ns.find("..") != std::string_view::npos ||
        ns.find(':') != std::string_view::npos) {
        return false;
    }

    std::size_t depth = 0;
    std::size_t start = 0;
    while (start <= ns.size()) {
        const std::size_t slash = ns.find('/', start);
        const std::string_view seg = (slash == std::string_view::npos)
            ? ns.substr(start)
            : ns.substr(start, slash - start);
        if (!valid_segment_chars(seg)) {
            return false;
        }
        ++depth;
        if (depth > 8) {
            return false;
        }
        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }
    return depth >= 1;
}

bool MemoryGraph::is_valid_key(std::string_view key) noexcept {
    return valid_segment_chars(key);
}

MemoryEntry MemoryGraph::upsert(
    std::string_view namespace_path,
    std::string_view key,
    std::string_view content,
    MemoryTier tier,
    const std::vector<std::string>& explicit_links,
    std::int64_t now_ms
) {
    if (!is_valid_namespace(namespace_path)) {
        throw std::invalid_argument(
            "Invalid memory namespace (must be clean multi-segment path without '..' or '\\')"
        );
    }
    if (!is_valid_key(key)) {
        throw std::invalid_argument("Invalid memory key");
    }

    const std::string canonical_id = std::string(namespace_path) + "/" + std::string(key);
    const std::string digest = core::sha256_hex(content);

    std::set<std::string> merged_links = [&]() {
        auto auto_links = extract_wiki_links(content);
        std::set<std::string> s(auto_links.begin(), auto_links.end());
        for (const auto& l : explicit_links) {
            if (!l.empty()) {
                s.insert(l);
            }
        }
        return s;
    }();

    std::lock_guard<std::mutex> lock(mutex_);

    // Remove previous outgoing edges from canonical_id
    edges_.erase(
        std::remove_if(
            edges_.begin(),
            edges_.end(),
            [&](const MemoryEdge& e) { return e.from_id == canonical_id; }
        ),
        edges_.end()
    );

    for (const auto& target : merged_links) {
        edges_.push_back(MemoryEdge{
            canonical_id,
            target,
            "references",
            graph::GraphifyProvenance::Extracted
        });
    }

    MemoryEntry entry{};
    entry.id = canonical_id;
    entry.namespace_path = std::string(namespace_path);
    entry.key = std::string(key);
    entry.content = std::string(content);
    entry.tier = tier;
    entry.content_sha256 = digest;
    entry.updated_at_ms = now_ms;
    entry.links.assign(merged_links.begin(), merged_links.end());

    entries_.insert_or_assign(canonical_id, entry);
    return entry;
}

std::optional<ErasureReceipt> MemoryGraph::erase(
    std::string_view id_or_ns_key,
    std::int64_t now_ms
) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = entries_.find(id_or_ns_key);
    if (it == entries_.end()) {
        return std::nullopt;
    }

    const std::string erased_id = it->second.id;
    const std::string ns = it->second.namespace_path;
    const std::string prev_sha = it->second.content_sha256;

    // Wipe plaintext string buffer before erasing node
    std::fill(it->second.content.begin(), it->second.content.end(), '\0');
    it->second.content.clear();
    entries_.erase(it);

    // Purge both outgoing and incoming edges referencing erased_id
    edges_.erase(
        std::remove_if(
            edges_.begin(),
            edges_.end(),
            [&](const MemoryEdge& e) {
                return e.from_id == erased_id || e.to_id == erased_id;
            }
        ),
        edges_.end()
    );

    // Also scrub links vectors in surviving entries
    for (auto& [other_id, other_entry] : entries_) {
        (void)other_id;
        other_entry.links.erase(
            std::remove(other_entry.links.begin(), other_entry.links.end(), erased_id),
            other_entry.links.end()
        );
    }

    ++receipt_seq_;
    ErasureReceipt rec{};
    rec.receipt_id = "erase-" + std::to_string(receipt_seq_) + "-" + prev_sha.substr(0, 8);
    rec.erased_id = erased_id;
    rec.namespace_path = ns;
    rec.previous_digest_sha256 = prev_sha;
    rec.erased_at_ms = now_ms;
    rec.verified_plaintext_free = true;

    erasures_.push_back(rec);
    return rec;
}

std::optional<MemoryEntry> MemoryGraph::get(std::string_view id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = entries_.find(id);
    if (it == entries_.end()) {
        return std::nullopt;
    }
    return it->second;
}

std::vector<MemoryEntry> MemoryGraph::list_entries() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<MemoryEntry> out;
    out.reserve(entries_.size());
    for (const auto& [id, e] : entries_) {
        (void)id;
        out.push_back(e);
    }
    return out;
}

std::vector<MemoryEdge> MemoryGraph::list_edges() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return edges_;
}

std::vector<ErasureReceipt> MemoryGraph::erasure_receipts() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return erasures_;
}

MemoryTraversal MemoryGraph::traverse_cyclic_safe(
    std::string_view start_id,
    std::uint32_t max_depth
) const {
    std::lock_guard<std::mutex> lock(mutex_);
    MemoryTraversal out{};
    if (entries_.find(start_id) == entries_.end()) {
        return out;
    }

    struct NodeStep {
        std::string id;
        std::uint32_t depth = 0;
        std::vector<std::string> path;
    };

    std::queue<NodeStep> q;
    std::unordered_set<std::string> visited;
    visited.insert(std::string(start_id));
    out.visited_ids.push_back(std::string(start_id));
    q.push(NodeStep{std::string(start_id), 0, {std::string(start_id)}});

    while (!q.empty()) {
        NodeStep cur = std::move(q.front());
        q.pop();
        if (cur.depth >= max_depth) {
            continue;
        }
        for (const auto& edge : edges_) {
            if (edge.from_id != cur.id) {
                continue;
            }
            out.edges.push_back(edge);

            bool cycle = false;
            for (const auto& anc : cur.path) {
                if (anc == edge.to_id) {
                    cycle = true;
                    break;
                }
            }
            if (cycle) {
                auto cyc = cur.path;
                cyc.push_back(edge.to_id);
                out.detected_cycles.push_back(std::move(cyc));
                continue;
            }
            if (visited.insert(edge.to_id).second) {
                out.visited_ids.push_back(edge.to_id);
                auto next_path = cur.path;
                next_path.push_back(edge.to_id);
                q.push(NodeStep{edge.to_id, cur.depth + 1, std::move(next_path)});
            }
        }
    }
    return out;
}

} // namespace omnia::harness
