#pragma once

#include "omnia/graph/peer_mesh.hpp"

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::harness {

enum class MemoryTier : std::uint8_t {
    Working = 0,
    Durable = 1
};

std::string memory_tier_to_string(MemoryTier tier);
MemoryTier parse_memory_tier(std::string_view raw);

struct MemoryEdge {
    std::string from_id;
    std::string to_id;
    std::string relation = "related_to";
    graph::GraphifyProvenance provenance = graph::GraphifyProvenance::Extracted;
};

struct MemoryEntry {
    std::string id;
    std::string namespace_path;
    std::string key;
    std::string content;
    MemoryTier tier = MemoryTier::Durable;
    std::string content_sha256;
    std::int64_t updated_at_ms = 0;
    std::vector<std::string> links;
};

/// Plaintext-free cryptographic erasure receipt. Never stores or echoes erased content.
struct ErasureReceipt {
    std::string receipt_id;
    std::string erased_id;
    std::string namespace_path;
    std::string previous_digest_sha256;
    std::int64_t erased_at_ms = 0;
    bool verified_plaintext_free = true;
};

struct MemoryTraversal {
    std::vector<std::string> visited_ids;
    std::vector<MemoryEdge> edges;
    std::vector<std::vector<std::string>> detected_cycles;
};

class MemoryGraph {
public:
    MemoryGraph() = default;

    /// Validates hierarchical multi-segment namespaces (e.g. `architecture/cpp20/routing`),
    /// rejecting empty segments, `.` / `..`, `\`, `:`, control characters, or depth > 8.
    static bool is_valid_namespace(std::string_view ns) noexcept;
    static bool is_valid_key(std::string_view key) noexcept;

    MemoryEntry upsert(
        std::string_view namespace_path,
        std::string_view key,
        std::string_view content,
        MemoryTier tier = MemoryTier::Durable,
        const std::vector<std::string>& explicit_links = {},
        std::int64_t now_ms = 0
    );

    std::optional<ErasureReceipt> erase(
        std::string_view id_or_ns_key,
        std::int64_t now_ms = 0
    );

    std::optional<MemoryEntry> get(std::string_view id) const;
    std::vector<MemoryEntry> list_entries() const;
    std::vector<MemoryEdge> list_edges() const;
    std::vector<ErasureReceipt> erasure_receipts() const;

    MemoryTraversal traverse_cyclic_safe(
        std::string_view start_id,
        std::uint32_t max_depth = 4
    ) const;

private:
    mutable std::mutex mutex_;
    std::map<std::string, MemoryEntry, std::less<>> entries_;
    std::vector<MemoryEdge> edges_;
    std::vector<ErasureReceipt> erasures_;
    std::uint64_t receipt_seq_ = 0;
};

} // namespace omnia::harness
