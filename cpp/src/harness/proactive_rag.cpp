#include "omnia/harness/proactive_rag.hpp"
#include "omnia/core/utf8.hpp"

#include <algorithm>
#include <cctype>
#include <set>

namespace omnia::harness {

namespace {

std::string to_lower_utf8_ascii(std::string_view s) {
    std::string out(s);
    for (char& ch : out) {
        const auto uc = static_cast<unsigned char>(ch);
        if (uc < 0x80U) {
            ch = static_cast<char>(std::tolower(uc));
        }
    }
    return out;
}

bool contains_sub(std::string_view haystack, std::string_view needle) noexcept {
    return !needle.empty() && haystack.find(needle) != std::string_view::npos;
}

bool has_vietnamese_markers(std::string_view raw, std::string_view lower) noexcept {
    // Common Vietnamese UTF-8 diacritics & function words
    constexpr std::string_view kVnMarkers[] = {
        "như", "thế", "nào", "tại sao", "kiến trúc", "so sánh", "hiện tại",
        "mới nhất", "phiên bản", "cập nhật", "hạn mức", "nguyên nhân", "lỗi",
        "không", "được", "của", "trong", "với", "tối ưu", "kiểm chứng",
        "dẫn chứng", "hệ thống", "thiết kế", "định tuyến"
    };
    for (const auto m : kVnMarkers) {
        if (contains_sub(lower, m)) {
            return true;
        }
    }
    std::size_t idx = 0;
    char32_t cp = 0;
    while (idx < raw.size()) {
        if (core::decode_next_utf8(raw, idx, cp)) {
            // Latin Extended Additional (U+1EA0..U+1EF9) or đ/Đ (U+0110/U+0111)
            if ((cp >= 0x1EA0U && cp <= 0x1EF9U) || cp == 0x0110U || cp == 0x0111U) {
                return true;
            }
        } else {
            ++idx;
        }
    }
    return false;
}

bool has_english_words(std::string_view lower) noexcept {
    constexpr std::string_view kEnWords[] = {
        "how", "why", "what", "compare", "versus", "architecture", "router",
        "circuit", "quota", "sqlite", "latency", "graph", "memory", "cors",
        "latest", "current", "design", "native", "studio"
    };
    for (const auto w : kEnWords) {
        if (contains_sub(lower, w)) {
            return true;
        }
    }
    return false;
}

std::vector<std::string> tokenize_query(std::string_view lower) {
    std::vector<std::string> tokens;
    std::string cur;
    for (const char ch : lower) {
        const auto uc = static_cast<unsigned char>(ch);
        if (uc >= 0x80U || std::isalnum(uc) != 0 || ch == '-' || ch == '_' || ch == '+') {
            cur.push_back(ch);
        } else {
            if (cur.size() >= 2) {
                tokens.push_back(cur);
            }
            cur.clear();
        }
    }
    if (cur.size() >= 2) {
        tokens.push_back(cur);
    }
    return tokens;
}

} // namespace

ProactiveRag::ProactiveRag() {
    // Seed default Omnia C++20 repository architectural corpus
    corpus_.push_back(RagCorpusSource{
        "src-dynamic-router",
        "Dynamic Provider & Quota Router Specification",
        "docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md",
        "Enforces privacy_tier boundaries, explicit Known/Unknown/Stale/Contradictory quota states, idempotent reservations, and Closed/Open/HalfOpen circuit breakers.",
        graph::GraphifyProvenance::Extracted,
        {"router", "routing", "quota", "circuit", "breaker", "privacy", "latency", "fallback", "provider", "định", "tuyến", "hạn", "mức"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-peer-mesh",
        "Bidirectional 2-Way PeerMeshGraph & Graphify Index",
        "docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md",
        "Connects Coordinator, Worker, Specialist, Verifier, and Subagent nodes via O(1) symmetric Duplex links, disjoint_paths guards, epoch fencing, and EXTRACTED/INFERRED/AMBIGUOUS provenance.",
        graph::GraphifyProvenance::Extracted,
        {"graph", "peer", "mesh", "duplex", "bidirectional", "graphify", "provenance", "epoch", "disjoint", "kiến", "trúc", "đồ", "thị"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-session-wal",
        "Native WinSQLite3 WAL SessionStore & Cooperative Leases",
        "cpp/include/omnia/storage/session_store.hpp",
        "Uses Windows 11 SDK winsqlite3.dll in WAL mode with BEGIN IMMEDIATE cooperative process ownership leases, keyset session paging, and BCrypt SHA-256 attachment deduplication.",
        graph::GraphifyProvenance::Extracted,
        {"sqlite", "winsqlite3", "wal", "lease", "session", "paging", "sha256", "attachment", "storage", "lưu", "trữ"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-cors-loopback",
        "Loopback Origin Allowlist & Cross-Origin Mutation Guard",
        ".agents/skills/deep-cors-diagnostics/SKILL.md",
        "Binds Studio HTTP API strictly to 127.0.0.1 and rejects foreign Origin headers with HTTP 403 Forbidden on POST mutations while preserving Vary: Origin.",
        graph::GraphifyProvenance::Inferred,
        {"cors", "origin", "loopback", "127.0.0.1", "localhost", "403", "security", "http", "webview2", "bảo", "mật"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-composer-steer",
        "Scientific LaTeX Composer & Additive Steer Queue",
        "docs/workspace/COMPOSER_REQUIREMENTS.md",
        "Provides 15 Math/Physics/Chemistry LaTeX templates, honest /Encrypt PDF guard, zero-mutation Esc cancel, and ADDITIVE_INTAKE queue with token_budget = null.",
        graph::GraphifyProvenance::Extracted,
        {"composer", "latex", "math", "physics", "chemistry", "pdf", "encrypt", "steer", "queue", "token_budget", "soạn", "thảo"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-ambiguous-draft",
        "Unverified External Gateway Rumor Note",
        "notes/quarantine/unverified-gateway-draft.md",
        "Low-confidence third-party benchmark rumor with conflicting latency numbers; quarantined as AMBIGUOUS.",
        graph::GraphifyProvenance::Ambiguous,
        {"router", "routing", "latency", "gateway", "benchmark", "quota", "provider"},
        false
    });
    corpus_.push_back(RagCorpusSource{
        "src-legacy-tauri-superseded",
        "Superseded Legacy Tauri Prototype Notes",
        "archive/pre-cpp-rust-snapshot-20261112",
        "Historical pre-C++20 prototype superseded by the native MSVC C++20 Studio & Win32 architecture.",
        graph::GraphifyProvenance::Inferred,
        {"tauri", "legacy", "rust", "prototype", "architecture", "kiến", "trúc"},
        true
    });
}

void ProactiveRag::add_source(RagCorpusSource source) {
    corpus_.push_back(std::move(source));
}

ProactiveRagPlan ProactiveRag::plan(std::string_view query) const {
    ProactiveRagPlan out{};
    out.query = std::string(query);

    std::string_view trimmed = query;
    while (!trimmed.empty() && std::isspace(static_cast<unsigned char>(trimmed.front())) != 0) {
        trimmed.remove_prefix(1);
    }
    while (!trimmed.empty() && std::isspace(static_cast<unsigned char>(trimmed.back())) != 0) {
        trimmed.remove_suffix(1);
    }
    if (trimmed.empty()) {
        out.language = "en";
        return out;
    }

    const std::string lower = to_lower_utf8_ascii(trimmed);
    const bool is_vn = has_vietnamese_markers(trimmed, lower);
    const bool is_en = has_english_words(lower);
    out.language = (is_vn && is_en) ? "bilingual" : (is_vn ? "vi" : "en");

    std::uint32_t score = 0;

    // 1. Time-sensitive / mutable state (EN + VN, zero "search" keyword needed!)
    constexpr std::string_view kTemporal[] = {
        "latest", "current", "currently", "recent", "today", "now", "release",
        "roadmap", "pricing", "quota", "rate limit", "status", "outage", "2025", "2026",
        "mới nhất", "hiện tại", "gần đây", "hôm nay", "phiên bản", "cập nhật", "hạn mức", "giá"
    };
    for (const auto t : kTemporal) {
        if (contains_sub(lower, t)) {
            out.triggers.push_back("time_sensitive_or_mutable_state");
            score += 3600;
            break;
        }
    }

    // 2. Named technical specs / protocols / engines
    constexpr std::string_view kSpecs[] = {
        "rfc", "cve-", "wcag", "oauth", "winsqlite", "bcrypt", "webview2", "direct2d",
        "uia", "cors", "c++20", "msvc", "cmake", "sqlite", "wal", "claude", "gemini",
        "openai", "graphify", "peermesh", "sha-256", "sha256"
    };
    for (const auto s : kSpecs) {
        if (contains_sub(lower, s)) {
            out.triggers.push_back("external_named_entities_or_specs");
            score += 2900;
            break;
        }
    }

    // 3. Architectural / comparative / trade-off synthesis (EN + VN)
    constexpr std::string_view kComparative[] = {
        "compare", "versus", " vs ", "tradeoff", "trade-off", "architecture",
        "best practice", "difference", "design", "end-to-end", "how does",
        "so sánh", "kiến trúc", "ưu nhược điểm", "khác nhau", "thiết kế", "tối ưu", "như thế nào"
    };
    for (const auto c : kComparative) {
        if (contains_sub(lower, c)) {
            out.triggers.push_back("broad_architectural_or_comparative_scope");
            score += 3100;
            break;
        }
    }

    // 4. Diagnostic / error / failure investigation (EN + VN)
    constexpr std::string_view kDiagnostic[] = {
        "why", "root cause", "intermittent", "edge case", "403", "timeout", "stale",
        "circuit", "drift", "conflict", "error", "bug",
        "tại sao", "nguyên nhân", "lỗi", "không hoạt động"
    };
    for (const auto d : kDiagnostic) {
        if (contains_sub(lower, d)) {
            out.triggers.push_back("diagnostic_or_failure_boundary");
            score += 2700;
            break;
        }
    }

    // 5. Verification / citation grounding
    constexpr std::string_view kVerify[] = {
        "verify", "citation", "cite", "specification", "evidence", "audit",
        "kiểm chứng", "dẫn chứng", "bằng chứng", "đối chiếu"
    };
    for (const auto v : kVerify) {
        if (contains_sub(lower, v)) {
            out.triggers.push_back("explicit_verification_grounding");
            score += 2500;
            break;
        }
    }

    if (score == 0 && trimmed.find('?') != std::string_view::npos) {
        out.triggers.push_back("interrogative_grounding_check");
        score = 3200;
    }

    out.uncertainty_score_bps = static_cast<std::uint16_t>(std::min<std::uint32_t>(10000, score));
    out.uncertainty_score = static_cast<double>(out.uncertainty_score_bps) / 10000.0;
    out.should_retrieve = out.uncertainty_score_bps >= 2500;

    // Multi-angle sub-query decomposition
    const std::string short_topic = core::truncate_utf8_words(trimmed, 72, "");
    out.sub_queries.push_back(DecomposedSubQuery{
        "specification_contract",
        short_topic + " normative contract invariants & schema"
    });
    out.sub_queries.push_back(DecomposedSubQuery{
        "cpp20_implementation",
        short_topic + " native C++20 implementation & concurrency guards"
    });
    out.sub_queries.push_back(DecomposedSubQuery{
        "failure_and_security_edges",
        short_topic + " failure recovery, fencing & security boundaries"
    });
    if (is_vn) {
        out.sub_queries.push_back(DecomposedSubQuery{
            "bilingual_cross_reference",
            "Omnia C++20 architecture specification evidence for: " + short_topic
        });
    }

    // Score & partition corpus into cited_sources vs unused_sources
    const auto q_tokens = tokenize_query(lower);
    for (const auto& src : corpus_) {
        if (src.provenance == graph::GraphifyProvenance::Ambiguous) {
            out.unused_sources.push_back(UnusedSource{
                src.id,
                src.title,
                src.locator,
                "quarantined_ambiguous_provenance"
            });
            continue;
        }
        if (src.superseded) {
            out.unused_sources.push_back(UnusedSource{
                src.id,
                src.title,
                src.locator,
                "superseded_historical_artifact"
            });
            continue;
        }

        int hits = 0;
        for (const auto& kw : src.keywords) {
            if (contains_sub(lower, kw)) {
                hits += 2;
                continue;
            }
            for (const auto& qt : q_tokens) {
                if (qt == kw) {
                    hits += 2;
                    break;
                }
            }
        }
        const std::string title_low = to_lower_utf8_ascii(src.title);
        for (const auto& qt : q_tokens) {
            if (qt.size() >= 3 && contains_sub(title_low, qt)) {
                ++hits;
            }
        }

        if (hits >= 2 || (out.should_retrieve && hits >= 1)) {
            const double prov_weight =
                (src.provenance == graph::GraphifyProvenance::Extracted) ? 1.0 : 0.82;
            const double rel = std::min(0.99, (0.45 + static_cast<double>(hits) * 0.11) * prov_weight);
            out.cited_sources.push_back(CitedSource{
                src.id,
                src.title,
                src.locator,
                src.snippet,
                graph::provenance_to_string(src.provenance),
                rel
            });
        } else {
            out.unused_sources.push_back(UnusedSource{
                src.id,
                src.title,
                src.locator,
                "below_relevance_threshold"
            });
        }
    }

    std::sort(
        out.cited_sources.begin(),
        out.cited_sources.end(),
        [](const CitedSource& a, const CitedSource& b) {
            if (a.score != b.score) return a.score > b.score;
            return a.id < b.id;
        }
    );

    return out;
}

} // namespace omnia::harness
