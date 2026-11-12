#pragma once

#include "omnia/graph/peer_mesh.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::harness {

struct RagCorpusSource {
    std::string id;
    std::string title;
    std::string locator;
    std::string snippet;
    graph::GraphifyProvenance provenance = graph::GraphifyProvenance::Extracted;
    std::vector<std::string> keywords;
    bool superseded = false;
};

struct DecomposedSubQuery {
    std::string angle;
    std::string query;
};

struct CitedSource {
    std::string id;
    std::string title;
    std::string locator;
    std::string snippet;
    std::string provenance;
    double score = 0.0;
};

struct UnusedSource {
    std::string id;
    std::string title;
    std::string locator;
    std::string reason;
};

struct ProactiveRagPlan {
    std::string query;
    std::string language; // "en", "vi", or "bilingual"
    std::uint16_t uncertainty_score_bps = 0;
    double uncertainty_score = 0.0;
    bool should_retrieve = false;
    std::vector<std::string> triggers;
    std::vector<DecomposedSubQuery> sub_queries;
    std::vector<CitedSource> cited_sources;
    std::vector<UnusedSource> unused_sources;
};

class ProactiveRag {
public:
    ProactiveRag();

    void add_source(RagCorpusSource source);
    const std::vector<RagCorpusSource>& corpus() const noexcept { return corpus_; }

    /// Evaluates English & Vietnamese prompt uncertainty without requiring `"search"`
    /// keywords, decomposes into multi-angle sub-queries, and partitions corpus
    /// candidates into `cited_sources` vs `unused_sources`.
    ProactiveRagPlan plan(std::string_view query) const;

private:
    std::vector<RagCorpusSource> corpus_;
};

} // namespace omnia::harness
