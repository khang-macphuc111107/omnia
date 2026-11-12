#include "omnia/studio/studio_server.hpp"
#include "omnia/core/redactor.hpp"
#include "omnia/core/sha256.hpp"
#include "omnia/core/utf8.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <psapi.h>
#include <shellapi.h>
#endif

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <fstream>
#include <set>
#include <stdexcept>

namespace omnia::studio {

namespace {

std::int64_t now_unix_ms() noexcept {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string to_lower_ascii(std::string_view sv) {
    std::string out(sv);
    for (char& ch : out) {
        const auto uc = static_cast<unsigned char>(ch);
        if (uc < 0x80U) {
            ch = static_cast<char>(std::tolower(uc));
        }
    }
    return out;
}

std::string trim_ascii(std::string_view sv) {
    while (!sv.empty() && (sv.front() == ' ' || sv.front() == '\t' || sv.front() == '\r' || sv.front() == '\n')) {
        sv.remove_prefix(1);
    }
    while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\t' || sv.back() == '\r' || sv.back() == '\n')) {
        sv.remove_suffix(1);
    }
    return std::string(sv);
}

std::string url_decode(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '+') {
            out.push_back(' ');
        } else if (in[i] == '%' && i + 2 < in.size()) {
            auto hex_val = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
                if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
                return -1;
            };
            const int hi = hex_val(in[i + 1]);
            const int lo = hex_val(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
            } else {
                out.push_back(in[i]);
            }
        } else {
            out.push_back(in[i]);
        }
    }
    return out;
}

std::map<std::string, std::string, std::less<>> parse_query_params(std::string_view query) {
    std::map<std::string, std::string, std::less<>> params;
    std::size_t pos = 0;
    while (pos < query.size()) {
        const std::size_t amp = query.find('&', pos);
        const std::string_view pair = (amp == std::string_view::npos)
            ? query.substr(pos)
            : query.substr(pos, amp - pos);
        if (!pair.empty()) {
            const std::size_t eq = pair.find('=');
            if (eq == std::string_view::npos) {
                params.insert_or_assign(url_decode(pair), "");
            } else {
                params.insert_or_assign(
                    url_decode(pair.substr(0, eq)),
                    url_decode(pair.substr(eq + 1))
                );
            }
        }
        if (amp == std::string_view::npos) break;
        pos = amp + 1;
    }
    return params;
}

bool is_digits_only(std::string_view sv) noexcept {
    if (sv.empty() || sv.size() > 5) return false;
    for (const char c : sv) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

bool is_path_prefix_contained(
    const std::filesystem::path& canon_root,
    const std::filesystem::path& canon_target
) {
    auto r = canon_root.begin();
    auto t = canon_target.begin();
    for (; r != canon_root.end(); ++r, ++t) {
        if (t == canon_target.end()) return false;
        if (to_lower_ascii(r->generic_string()) != to_lower_ascii(t->generic_string())) {
            return false;
        }
    }
    return true;
}

std::string mime_type_for_ext(std::string_view ext) {
    const std::string low = to_lower_ascii(ext);
    if (low == ".html" || low == ".htm") return "text/html; charset=utf-8";
    if (low == ".css") return "text/css; charset=utf-8";
    if (low == ".js" || low == ".mjs") return "text/javascript; charset=utf-8";
    if (low == ".json") return "application/json; charset=utf-8";
    if (low == ".svg") return "image/svg+xml";
    if (low == ".png") return "image/png";
    if (low == ".ico") return "image/x-icon";
    if (low == ".woff2") return "font/woff2";
    return "application/octet-stream";
}

#ifdef _WIN32
struct WinsockInit {
    WinsockInit() {
        WSADATA wsa{};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            throw std::runtime_error("WSAStartup(2.2) failed");
        }
    }
    ~WinsockInit() {
        WSACleanup();
    }
};

void ensure_winsock() {
    static WinsockInit s_wsa;
    (void)s_wsa;
}

struct SocketCloser {
    SOCKET sock = INVALID_SOCKET;
    ~SocketCloser() noexcept {
        if (sock != INVALID_SOCKET) {
            closesocket(sock);
        }
    }
};

std::wstring utf8_to_utf16(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        utf8.data(),
        static_cast<int>(utf8.size()),
        nullptr,
        0
    );
    if (needed <= 0) return {};
    std::wstring wide(static_cast<std::size_t>(needed), L'\0');
    MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        utf8.data(),
        static_cast<int>(utf8.size()),
        wide.data(),
        needed
    );
    return wide;
}

std::uint64_t query_working_set_bytes() noexcept {
    PROCESS_MEMORY_COUNTERS pmc{};
    pmc.cb = sizeof(pmc);
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)) != 0) {
        return static_cast<std::uint64_t>(pmc.WorkingSetSize);
    }
    return 0;
}

std::uint64_t query_current_binary_bytes() noexcept {
    wchar_t path_buf[MAX_PATH * 2]{};
    const DWORD len = GetModuleFileNameW(nullptr, path_buf, static_cast<DWORD>(std::size(path_buf)));
    if (len == 0 || len >= std::size(path_buf)) {
        return 0;
    }
    std::error_code ec;
    const auto sz = std::filesystem::file_size(std::filesystem::path(path_buf), ec);
    return ec ? 0 : static_cast<std::uint64_t>(sz);
}
#endif

HttpResponse make_json_response(
    int status,
    std::string status_text,
    const core::JsonValue& payload,
    std::string allow_origin = ""
) {
    HttpResponse r{};
    r.status = status;
    r.status_text = std::move(status_text);
    r.content_type = "application/json; charset=utf-8";
    r.allow_origin = std::move(allow_origin);
    r.body = payload.dump();
    return r;
}

std::string format_hms_utc(std::uint64_t unix_ms) {
    const std::uint64_t day_sec = (unix_ms / 1000ULL) % 86400ULL;
    const std::uint64_t hh = day_sec / 3600ULL;
    const std::uint64_t mm = (day_sec % 3600ULL) / 60ULL;
    const std::uint64_t ss = day_sec % 60ULL;
    auto two = [](std::uint64_t v) {
        std::string s = std::to_string(v);
        return s.size() < 2 ? ("0" + s) : s;
    };
    return two(hh) + ":" + two(mm) + ":" + two(ss);
}

std::string normalize_peer_id(std::string_view raw) {
    if (raw == "cpp-core-architect") return "cpp-core";
    if (raw == "cpp-native-win32") return "win32-shell";
    if (raw == "flagship-ui-architect") return "ui-atelier";
    if (raw == "root-cleaner") return "deep-cleaner";
    return std::string(raw);
}

std::string ui_privacy_tier_label(routing::PrivacyTier tier) {
    switch (tier) {
        case routing::PrivacyTier::LocalOnly: return "strict_local_zero_retention";
        case routing::PrivacyTier::ZeroDataRetention: return "enterprise_zdr";
        case routing::PrivacyTier::PrivateVpc: return "private_vpc";
        case routing::PrivacyTier::Public: return "standard_cloud";
    }
    return "enterprise_zdr";
}

core::JsonValue serialize_peer_envelope(const graph::PeerEnvelope& m) {
    core::JsonArray recips;
    for (const auto& r : m.recipients) {
        recips.emplace_back(r);
    }
    core::JsonObject obj;
    obj["seq"] = m.seq;
    obj["conversationId"] = m.conversation_id;
    obj["from"] = m.from;
    obj["to"] = m.primary_to;
    obj["recipients"] = std::move(recips);
    obj["text"] = m.payload;
    obj["epoch"] = m.sender_epoch;
    obj["hop"] = static_cast<std::uint64_t>(m.hop_count);
    obj["maxHops"] = static_cast<std::uint64_t>(m.max_hops);
    obj["provenance"] = graph::provenance_to_string(m.provenance);
    obj["timestamp"] = format_hms_utc(m.timestamp_ms);
    obj["timestampMs"] = m.timestamp_ms;
    return core::JsonValue(std::move(obj));
}

core::JsonValue serialize_memory_entry(const harness::MemoryEntry& e) {
    core::JsonArray links;
    for (const auto& l : e.links) {
        links.emplace_back(l);
    }
    core::JsonObject obj;
    obj["id"] = e.id;
    obj["namespace"] = e.namespace_path;
    obj["key"] = e.key;
    obj["content"] = e.content;
    obj["tier"] = harness::memory_tier_to_string(e.tier);
    obj["contentSha256"] = e.content_sha256;
    obj["updatedAt"] = e.updated_at_ms;
    obj["links"] = std::move(links);
    return core::JsonValue(std::move(obj));
}

core::JsonValue serialize_erasure_receipt(const harness::ErasureReceipt& er) {
    core::JsonObject obj;
    obj["receiptId"] = er.receipt_id;
    obj["erasedId"] = er.erased_id;
    obj["namespace"] = er.namespace_path;
    obj["previousDigestSha256"] = er.previous_digest_sha256;
    obj["erasedAt"] = er.erased_at_ms;
    obj["verifiedPlaintextFree"] = er.verified_plaintext_free;
    return core::JsonValue(std::move(obj));
}

core::JsonValue serialize_steer_item(const harness::SteerItem& it) {
    core::JsonObject obj;
    obj["id"] = it.id;
    obj["seq"] = it.seq;
    obj["text"] = it.text;
    obj["mode"] = harness::steer_mode_to_string(it.mode);
    obj["status"] = it.status;
    obj["createdAt"] = it.created_at_ms;
    return core::JsonValue(std::move(obj));
}

} // namespace

bool StudioServer::is_allowed_loopback_origin(std::string_view origin) noexcept {
    if (origin.empty()) {
        return true; // Non-CORS same-origin GET or local CLI client without Origin header
    }
    const std::string low = to_lower_ascii(trim_ascii(origin));
    if (low == "null") {
        return false;
    }
    constexpr std::string_view kAllowedPrefixes[] = {
        "http://127.0.0.1",
        "http://localhost",
        "http://[::1]"
    };
    for (const auto pref : kAllowedPrefixes) {
        if (low == pref) {
            return true;
        }
        if (low.size() > pref.size() &&
            low.substr(0, pref.size()) == pref &&
            low[pref.size()] == ':') {
            const std::string_view port_sv = std::string_view(low).substr(pref.size() + 1);
            if (is_digits_only(port_sv)) {
                return true;
            }
        }
    }
    return false;
}

bool StudioServer::is_allowed_loopback_host(std::string_view host) noexcept {
    if (host.empty()) {
        return true;
    }
    const std::string low = to_lower_ascii(trim_ascii(host));
    constexpr std::string_view kHosts[] = {"127.0.0.1", "localhost", "[::1]"};
    for (const auto h : kHosts) {
        if (low == h) return true;
        if (low.size() > h.size() && low.substr(0, h.size()) == h && low[h.size()] == ':') {
            if (is_digits_only(std::string_view(low).substr(h.size() + 1))) {
                return true;
            }
        }
    }
    return false;
}

bool StudioServer::launch_edge_app_window(std::uint16_t port) {
#ifdef _WIN32
    const std::wstring url_arg = L"--app=http://127.0.0.1:" + std::to_wstring(port);
    HINSTANCE res = ShellExecuteW(
        nullptr,
        L"open",
        L"msedge.exe",
        url_arg.c_str(),
        nullptr,
        SW_SHOWNORMAL
    );
    return reinterpret_cast< std::intptr_t >(res) > 32;
#else
    (void)port;
    return false;
#endif
}

StudioServer::StudioServer(StudioConfig config)
    : config_(std::move(config)) {
    session_store_ = std::make_unique<storage::SessionStore>(
        config_.db_path.empty() ? ":memory:" : config_.db_path
    );
    seed_flagship_state();
}

StudioServer::~StudioServer() {
    stop();
}

void StudioServer::seed_flagship_state() {
    const std::int64_t now_ms = now_unix_ms();
    const auto now_u64 = static_cast<std::uint64_t>(now_ms);

    // 1. Cooperative Lease + Seeded Sessions
#ifdef _WIN32
    const auto pid = static_cast<std::int64_t>(GetCurrentProcessId());
#else
    const std::int64_t pid = 1000;
#endif
    (void)session_store_->acquire_lease("omnia-studio-host", pid, 3600000, now_ms);
    session_store_->create_session(
        "Wave 4 \u2022 Native C++20 Studio & UIA",
        "gemini-3.1-pro",
        "high",
        now_ms - 30000,
        "sess-cpp20-atelier"
    );
    session_store_->create_session(
        "Dynamic Provider Router & Circuit Breaker Verification",
        "claude-opus-4-6",
        "high",
        now_ms - 90000,
        "sess-router-audit"
    );
    session_store_->create_session(
        "Win32 Mica + Server-Side COM UIA Shell Parity",
        "gpt-5.4-thinking",
        "xhigh",
        now_ms - 180000,
        "sess-win32-uia"
    );

    // 2. 6-Node 2-Way All-to-All PeerMeshGraph
    peer_mesh_.register_agent(graph::AgentNode{
        "coordinator",
        "Coordinator",
        graph::AgentRole::Coordinator,
        {"docs/handoff/**"},
        {},
        {"orchestration", "cas_steer"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.register_agent(graph::AgentNode{
        "cpp-core",
        "C++ Core",
        graph::AgentRole::Specialist,
        {"CMakeLists.txt", "CMakePresets.json", "cpp/**"},
        {},
        {"cpp20", "winsqlite3", "winsock2", "bcrypt"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.register_agent(graph::AgentNode{
        "win32-shell",
        "Win32 Shell",
        graph::AgentRole::Specialist,
        {"native/**"},
        {},
        {"win32", "direct2d", "dwm_mica", "com_uia"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.register_agent(graph::AgentNode{
        "ui-atelier",
        "UI Atelier",
        graph::AgentRole::Specialist,
        {"ui/**", "docs/ui-direction/**"},
        {},
        {"studio_ui", "wcag_contrast", "canvas_60fps"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.register_agent(graph::AgentNode{
        "deep-cleaner",
        "Deep Cleaner",
        graph::AgentRole::Worker,
        {"docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md"},
        {},
        {"deep_clean", "quarantine_provenance"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.register_agent(graph::AgentNode{
        "verifier",
        "Independent Verifier",
        graph::AgentRole::Verifier,
        {"audit/readonly-virtual/**"},
        {},
        {"ctest_audit", "browser_qa", "lf_secret_gate"},
        4,
        8,
        true,
        now_u64
    });
    peer_mesh_.connect_all_to_all(
        "duplex_mesh_a_b",
        graph::GraphifyProvenance::Extracted,
        now_u64
    );

    const auto m1 = peer_mesh_.send_peer(graph::SendPeerRequest{
        "ui-atelier",
        "cpp-core",
        "api-contract-sync",
        "Proposing 12 loopback /api/* JSON shapes for Studio Chat, Peer Graph, Router Lab, RAG, and Memory Vault.",
        graph::GraphifyProvenance::Extracted,
        0,
        8,
        std::nullopt,
        true,
        now_u64 - 40000
    });
    (void)peer_mesh_.reply(
        "cpp-core",
        m1.seq,
        "Locked 1:1 on all 12 /api/* endpoints with Winsock2 127.0.0.1 binding and 403 cross-origin Origin guard.",
        graph::GraphifyProvenance::Extracted,
        false,
        now_u64 - 25000
    );
    (void)peer_mesh_.send_peer(graph::SendPeerRequest{
        "win32-shell",
        "verifier",
        "win32-uia-gate",
        "Server-side IRawElementProviderSimple + WH_CBT #32770 modal button hook active for background UIA QA.",
        graph::GraphifyProvenance::Extracted,
        0,
        8,
        std::nullopt,
        false,
        now_u64 - 10000
    });

    // 3. Bidirectional GraphifyIndex of this C++20 Repository
    using graph::GraphifyEntity;
    using graph::GraphifyEntityKind;
    using graph::GraphifyEdge;
    using graph::GraphifyProvenance;

    graphify_.upsert_entity(GraphifyEntity{
        "omnia-studio", GraphifyEntityKind::Artifact,
        "omnia-studio.exe", "cpp/apps/omnia_studio/main.cpp",
        "Native C++20 Winsock2 loopback Studio Desktop & API Host"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia_core", GraphifyEntityKind::CodeModule,
        "omnia_core", "cpp/include/omnia/core/",
        "BCrypt SHA-256, RFC-8259 JsonValue, UTF-8 safe truncation, SecretRedactor"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia_storage", GraphifyEntityKind::CodeModule,
        "omnia_storage", "cpp/include/omnia/storage/session_store.hpp",
        "RAII winsqlite3 WAL SessionStore with cooperative leases & attachment deduplication"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia_routing", GraphifyEntityKind::CodeModule,
        "omnia_routing", "cpp/include/omnia/routing/dynamic_router.hpp",
        "DynamicProviderRouter with explicit QuotaState, circuit breakers, and receipts"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia_graph", GraphifyEntityKind::CodeModule,
        "omnia_graph", "cpp/include/omnia/graph/",
        "2-way PeerMeshGraph and bidirectional GraphifyIndex"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia_harness", GraphifyEntityKind::CodeModule,
        "omnia_harness", "cpp/include/omnia/harness/",
        "MemoryGraph, EN/VN ProactiveRag, SkillRegistry, ComposerModel, SteerQueue"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "omnia-native", GraphifyEntityKind::Artifact,
        "omnia-native.exe", "native/CMakeLists.txt",
        "Pure C++20 Win32 + DWM Mica + Direct2D + COM UIA desktop shell"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "ui-atelier-bundle", GraphifyEntityKind::Artifact,
        "Flagship Studio UI", "ui/index.html",
        "Zero-CDN Obsidian Kinetic Atelier studio frontend"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "DOD-14", GraphifyEntityKind::Requirement,
        "DOD-14 Runtime Verification", "docs/workspace/DOD.md",
        "Normative runtime UIA, session lease, and loopback verification gates"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "spec-dynamic-routing", GraphifyEntityKind::Requirement,
        "DYNAMIC_ROUTING_REQUIREMENTS.md", "docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md",
        "Normative capability, privacy, quota, circuit, and reconciliation contract"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "spec-peer-graph", GraphifyEntityKind::Requirement,
        "BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md", "docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md",
        "Normative 2-way Duplex peer mesh and 3-tier Graphify provenance spec"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "skill-deep-cpp-native", GraphifyEntityKind::Skill,
        "deep-cpp-native", ".agents/skills/deep-cpp-native/SKILL.md",
        "Windows 11 C++20 CMake/Ninja/MSVC, winsqlite3, BCrypt, UIA, Winsock2 skill"
    });
    graphify_.upsert_entity(GraphifyEntity{
        "ambiguous-legacy-rpc", GraphifyEntityKind::Symbol,
        "LegacyUnverifiedRpcCandidate", "archive/quarantine/legacy_rpc_hint",
        "Quarantined low-confidence name collision excluded from strict traversal"
    });

    graphify_.add_edge(GraphifyEdge{
        "omnia-studio", "omnia_harness", "links_public", GraphifyProvenance::Extracted, 10000,
        "CMake target_link_libraries(omnia-studio PRIVATE omnia_harness)"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_harness", "omnia_routing", "links_public", GraphifyProvenance::Extracted, 10000,
        "Studio router workbench dispatches directly into omnia_routing"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_harness", "omnia_graph", "links_public", GraphifyProvenance::Extracted, 10000,
        "Hosts PeerMeshGraph and GraphifyIndex state"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_harness", "omnia_storage", "links_public", GraphifyProvenance::Extracted, 10000,
        "Persists WAL sessions, cooperative leases, and deduplicated blobs"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_storage", "omnia_core", "links_public", GraphifyProvenance::Extracted, 10000,
        "Uses BCrypt sha256_hex and SecretRedactor"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_routing", "omnia_core", "links_public", GraphifyProvenance::Extracted, 10000,
        "Hashes policies via sha256_hex and redacts outcome diagnostics"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_routing", "spec-dynamic-routing", "implements_spec", GraphifyProvenance::Extracted, 10000,
        "Implements QuotaState, idempotent reservations, and circuit breakers"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia_graph", "spec-peer-graph", "implements_spec", GraphifyProvenance::Extracted, 10000,
        "Implements symmetric Duplex peers and Graphify provenance"
    });
    graphify_.add_edge(GraphifyEdge{
        "ui-atelier-bundle", "omnia-studio", "consumes_rpc", GraphifyProvenance::Extracted, 10000,
        "12 loopback JSON endpoints over 127.0.0.1"
    });
    graphify_.add_edge(GraphifyEdge{
        "DOD-14", "omnia-native", "verifies", GraphifyProvenance::Extracted, 10000,
        "7 PowerShell UIA + session + guard suites"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia-studio", "skill-deep-cpp-native", "governed_by_skill", GraphifyProvenance::Inferred, 8200,
        "Follows loopback Origin/Host guards and RAII patterns from deep-cpp-native"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia-native", "skill-deep-cpp-native", "governed_by_skill", GraphifyProvenance::Inferred, 8500,
        "Follows DWM Mica, Direct2D, and COM UIA patterns from deep-cpp-native"
    });
    graphify_.add_edge(GraphifyEdge{
        "omnia-studio", "ambiguous-legacy-rpc", "name_similarity_candidate", GraphifyProvenance::Ambiguous, 3500,
        "Quarantined AMBIGUOUS candidate retained honestly without silent merging"
    });
    graphify_.add_edge(GraphifyEdge{
        "DOD-14", "ui-atelier-bundle", "candidate_match", GraphifyProvenance::Ambiguous, 4200,
        "Quarantined: multiple studio/native surfaces reference DOD-14; requires explicit locator binding"
    });

    // 4. 5 Multi-Provider Candidates in DynamicProviderRouter
    {
        routing::RouteCandidate c1{};
        c1.candidate_id = "local-cpp-llama-q8";
        c1.provider_id = "omnia-local";
        c1.model_id = "qwen3-coder-32b-q8";
        c1.capabilities = {true, false, false, true, true, true, 8};
        c1.context_limit_tokens = 131072;
        c1.max_output_tokens = 16384;
        c1.quality_tier = 4;
        c1.input_cost_per_million_microunits = 0;
        c1.output_cost_per_million_microunits = 0;
        c1.privacy_tier = routing::PrivacyTier::LocalOnly;
        c1.region = "local";
        c1.route_priority = 4;
        routing::CandidateResourceState s1{};
        s1.quota = routing::QuotaState::make_known(480000, 25000, now_ms + 86400000, 500000, 86400000);
        s1.freshness_ms = now_ms;
        s1.success_count = 148;
        s1.error_count = 0;
        for (std::uint64_t ms : {118ULL, 132ULL, 145ULL, 175ULL, 215ULL}) s1.record_latency(ms);
        router_.upsert_candidate(std::move(c1), std::move(s1));

        routing::RouteCandidate c2{};
        c2.candidate_id = "google-gemini-3-1-pro";
        c2.provider_id = "vertex-zdr";
        c2.model_id = "gemini-3.1-pro";
        c2.capabilities = {true, true, true, true, true, true, 32};
        c2.context_limit_tokens = 1000000;
        c2.max_output_tokens = 65536;
        c2.quality_tier = 5;
        c2.privacy_tier = routing::PrivacyTier::ZeroDataRetention;
        c2.region = "us";
        c2.route_priority = 5;
        routing::CandidateResourceState s2{};
        s2.quota = routing::QuotaState::make_known(920000, 40000, now_ms + 3600000, 1000000, 3600000);
        s2.freshness_ms = now_ms;
        s2.success_count = 298;
        s2.error_count = 1;
        for (std::uint64_t ms : {210ULL, 240ULL, 265ULL, 310ULL, 410ULL}) s2.record_latency(ms);
        router_.upsert_candidate(std::move(c2), std::move(s2));

        routing::RouteCandidate c3{};
        c3.candidate_id = "anthropic-opus-4-6";
        c3.provider_id = "anthropic-zdr";
        c3.model_id = "claude-opus-4-6";
        c3.capabilities = {true, true, false, true, true, true, 16};
        c3.context_limit_tokens = 200000;
        c3.max_output_tokens = 32768;
        c3.quality_tier = 5;
        c3.privacy_tier = routing::PrivacyTier::ZeroDataRetention;
        c3.region = "us";
        c3.route_priority = 5;
        routing::CandidateResourceState s3{};
        s3.quota = routing::QuotaState::make_known(310000, 30000, now_ms + 3600000, 500000, 3600000);
        s3.freshness_ms = now_ms;
        s3.success_count = 249;
        s3.error_count = 1;
        for (std::uint64_t ms : {320ULL, 360ULL, 390ULL, 450ULL, 620ULL}) s3.record_latency(ms);
        router_.upsert_candidate(std::move(c3), std::move(s3));

        routing::RouteCandidate c4{};
        c4.candidate_id = "openai-gpt-5-4-thinking";
        c4.provider_id = "openai-enterprise";
        c4.model_id = "gpt-5.4-thinking";
        c4.capabilities = {true, true, false, true, true, true, 16};
        c4.context_limit_tokens = 256000;
        c4.max_output_tokens = 32768;
        c4.quality_tier = 5;
        c4.privacy_tier = routing::PrivacyTier::ZeroDataRetention;
        c4.region = "us";
        c4.route_priority = 3;
        routing::CandidateResourceState s4{};
        s4.quota = routing::QuotaState::make_stale(125000, now_ms - 900000, now_ms - 300000, 20000);
        s4.freshness_ms = now_ms - 900000;
        s4.circuit_state.kind = routing::CircuitState::Kind::HalfOpen;
        s4.success_count = 104;
        s4.error_count = 3;
        for (std::uint64_t ms : {440ULL, 510ULL, 560ULL, 680ULL, 890ULL}) s4.record_latency(ms);
        router_.upsert_candidate(std::move(c4), std::move(s4));

        routing::RouteCandidate c5{};
        c5.candidate_id = "cloud-fast-unverified";
        c5.provider_id = "public-gateway";
        c5.model_id = "deepseek-r2-distill";
        c5.capabilities = {true, false, false, false, false, true, 0};
        c5.context_limit_tokens = 32768;
        c5.max_output_tokens = 4096;
        c5.quality_tier = 2;
        c5.privacy_tier = routing::PrivacyTier::Public;
        c5.region = "eu";
        c5.route_priority = 0;
        routing::CandidateResourceState s5{};
        s5.quota = routing::QuotaState::make_unknown("upstream_quota_header_omitted");
        s5.circuit_state.kind = routing::CircuitState::Kind::Open;
        s5.circuit_state.opened_at_ms = now_ms;
        s5.freshness_ms = now_ms - 600000;
        s5.success_count = 18;
        s5.error_count = 3;
        for (std::uint64_t ms : {760ULL, 890ULL, 1020ULL, 1340ULL, 1640ULL}) s5.record_latency(ms);
        router_.upsert_candidate(std::move(c5), std::move(s5));

        // Record one initial bootstrap routing receipt so recentReceipts is non-empty
        routing::RouteRequestPolicy boot_pol{};
        boot_pol.idempotency_key = "bootstrap-studio-init-1";
        boot_pol.required_capabilities.tool_use = true;
        boot_pol.estimated_input_tokens = 2400;
        boot_pol.estimated_output_tokens = 1200;
        boot_pol.privacy_tier = routing::PrivacyTier::ZeroDataRetention;
        const auto boot_dec = router_.decide_and_reserve(boot_pol, now_ms);
        if (boot_dec.ok && boot_dec.grant.has_value()) {
            (void)router_.mark_dispatched(boot_dec.grant->reservation_id, "att-boot-1", now_ms);
            routing::OutcomeReport rep{};
            rep.reservation_id = boot_dec.grant->reservation_id;
            rep.attempt_id = "att-boot-1";
            rep.succeeded = true;
            rep.acceptance = routing::AcceptanceState::Accepted;
            rep.usage = routing::ObservedUsage::make_known(2310, 1140);
            rep.latency_ms = 265;
            rep.now_ms = now_ms;
            (void)router_.reconcile_outcome(rep);
        }
    }

    // 5. Hierarchical Durable & Working MemoryGraph
    memory_.upsert(
        "architecture/cpp20-core",
        "winsqlite3-wal-lease",
        "SessionStore uses RAII sqlite3 custom deleter + WAL synchronous=NORMAL + cooperative process lease heartbeat. Linked to [[architecture/win32-uia/modal-32770-cbt-hook]].",
        harness::MemoryTier::Durable,
        {"architecture/win32-uia/modal-32770-cbt-hook"},
        now_ms - 120000
    );
    memory_.upsert(
        "architecture/win32-uia",
        "modal-32770-cbt-hook",
        "Thread-scoped WH_CBT HCBT_ACTIVATE hook attaches IInvokeProvider to IDOK/IDCANCEL/IDYES/IDNO so background UIA Invoke succeeds.",
        harness::MemoryTier::Durable,
        {"lessons/uia-background-focus/zero-drop-steer-rule"},
        now_ms - 95000
    );
    memory_.upsert(
        "workspace/ui-atelier",
        "obsidian-contrast-floor",
        "Active working state: serving 12 JSON endpoints on 127.0.0.1 with strict loopback Origin allowlist and WCAG 2.2 contrast >= 5.12:1.",
        harness::MemoryTier::Working,
        {"architecture/cpp20-core/winsqlite3-wal-lease"},
        now_ms - 45000
    );
    memory_.upsert(
        "lessons/uia-background-focus",
        "zero-drop-steer-rule",
        "Mid-run user prompts enter SteerQueue as ADDITIVE_INTAKE with token_budget=NULL; QuotaState::Unknown is never coerced to 0.",
        harness::MemoryTier::Durable,
        {},
        now_ms - 15000
    );

    // 6. Load Live SkillRegistry
    std::filesystem::path skills_dir = config_.skills_root;
    if (skills_dir.empty()) {
        std::error_code ec;
        if (std::filesystem::exists(".agents/skills", ec)) {
            skills_dir = ".agents/skills";
        } else if (std::filesystem::exists("../.agents/skills", ec)) {
            skills_dir = "../.agents/skills";
        }
    }
    if (!skills_dir.empty()) {
        (void)skills_.load_from_directory(skills_dir, ".agents/skills");
    }
    if (skills_.size() == 0) {
        skills_.register_skill(harness::SkillEntry{
            "deep-cpp-native",
            "Architect, build, and verify zero-overhead native Windows 11 C++20 applications with CMake, Ninja, MSVC, winsqlite3, BCrypt, UIA, and Winsock2.",
            ".agents/skills/deep-cpp-native/SKILL.md",
            "native-cpp20"
        });
        skills_.register_skill(harness::SkillEntry{
            "additive-steer-queue",
            "Preserve all unfinished and in-progress tasks as ADDITIVE_INTAKE without artificial token_budget caps.",
            ".agents/skills/additive-steer-queue/SKILL.md",
            "continuity-governance"
        });
    }

    // 7. Seed Additive Steer Queue (token_budget == null invariant)
    steer_queue_.enqueue(
        "Migrate core, storage, routing, graph, and harness to pure MSVC C++20 (/W4 /WX).",
        harness::SteerMode::AdditiveIntake,
        now_ms - 150000,
        "completed"
    );
    steer_queue_.enqueue(
        "Bind Studio Web/WebView2 UI over 127.0.0.1 with 403 cross-origin Origin enforcement.",
        harness::SteerMode::AdditiveIntake,
        now_ms - 45000,
        "in_progress"
    );
}

void StudioServer::open_listener() {
#ifdef _WIN32
    ensure_winsock();
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        throw std::runtime_error("socket(AF_INET) failed");
    }

    BOOL exclusive = TRUE;
    (void)setsockopt(
        s,
        SOL_SOCKET,
        SO_EXCLUSIVEADDRUSE,
        reinterpret_cast<const char*>(&exclusive),
        sizeof(exclusive)
    );

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // Strictly 127.0.0.1!
    addr.sin_port = htons(config_.port);

    if (bind(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
        closesocket(s);
        throw std::runtime_error(
            "bind(127.0.0.1:" + std::to_string(config_.port) + ") failed"
        );
    }

    sockaddr_in bound{};
    int bound_len = sizeof(bound);
    if (getsockname(s, reinterpret_cast<sockaddr*>(&bound), &bound_len) == 0) {
        bound_port_.store(ntohs(bound.sin_port));
    } else {
        bound_port_.store(config_.port);
    }

    if (listen(s, SOMAXCONN) == SOCKET_ERROR) {
        closesocket(s);
        throw std::runtime_error("listen() failed on Studio loopback socket");
    }

    listen_sock_ = static_cast<std::uintptr_t>(s);
    running_.store(true);

    if (config_.open_window) {
        (void)launch_edge_app_window(bound_port_.load());
    }
#else
#error "Winsock2 loopback listener requires Windows target"
#endif
}

void StudioServer::start() {
    if (running_.load()) {
        return;
    }
    open_listener();
    accept_thread_ = std::thread([this]() { accept_loop(); });
}

void StudioServer::run_blocking() {
    if (!running_.load()) {
        open_listener();
    }
    accept_loop();
}

void StudioServer::stop() noexcept {
    running_.store(false);
#ifdef _WIN32
    const auto raw = static_cast<SOCKET>(listen_sock_);
    if (raw != INVALID_SOCKET) {
        listen_sock_ = static_cast<std::uintptr_t>(INVALID_SOCKET);
        closesocket(raw);
    }
#endif
    if (accept_thread_.joinable()) {
        accept_thread_.join();
    }
}

void StudioServer::accept_loop() {
#ifdef _WIN32
    while (running_.load()) {
        const auto ls = static_cast<SOCKET>(listen_sock_);
        if (ls == INVALID_SOCKET) {
            break;
        }
        sockaddr_in peer{};
        int peer_len = sizeof(peer);
        SOCKET client = accept(ls, reinterpret_cast<sockaddr*>(&peer), &peer_len);
        if (client == INVALID_SOCKET) {
            if (!running_.load()) {
                break;
            }
            continue;
        }
        // Handle client synchronously or via short worker so concurrent browser fetches succeed fast
        std::thread([this, client]() {
            handle_client(static_cast<std::uintptr_t>(client));
        }).detach();
    }
#endif
}

void StudioServer::handle_client(std::uintptr_t client_sock) {
#ifdef _WIN32
    SocketCloser guard{static_cast<SOCKET>(client_sock)};
    DWORD timeout_ms = 5000;
    (void)setsockopt(
        guard.sock,
        SOL_SOCKET,
        SO_RCVTIMEO,
        reinterpret_cast<const char*>(&timeout_ms),
        sizeof(timeout_ms)
    );
    (void)setsockopt(
        guard.sock,
        SOL_SOCKET,
        SO_SNDTIMEO,
        reinterpret_cast<const char*>(&timeout_ms),
        sizeof(timeout_ms)
    );

    std::string raw_req;
    raw_req.reserve(4096);
    char buf[4096];
    std::size_t header_end = std::string::npos;
    std::size_t content_len = 0;

    while (raw_req.size() < 1024 * 1024) {
        const int n = recv(guard.sock, buf, static_cast<int>(sizeof(buf)), 0);
        if (n <= 0) {
            break;
        }
        raw_req.append(buf, static_cast<std::size_t>(n));
        if (header_end == std::string::npos) {
            header_end = raw_req.find("\r\n\r\n");
            if (header_end != std::string::npos) {
                const std::string_view hdr_block(raw_req.data(), header_end);
                std::size_t pos = 0;
                while (pos < hdr_block.size()) {
                    const std::size_t nl = hdr_block.find("\r\n", pos);
                    const std::string_view line = (nl == std::string_view::npos)
                        ? hdr_block.substr(pos)
                        : hdr_block.substr(pos, nl - pos);
                    const std::size_t colon = line.find(':');
                    if (colon != std::string_view::npos) {
                        const std::string hname = to_lower_ascii(trim_ascii(line.substr(0, colon)));
                        if (hname == "content-length") {
                            const std::string hval = trim_ascii(line.substr(colon + 1));
                            content_len = static_cast<std::size_t>(
                                std::strtoull(hval.c_str(), nullptr, 10)
                            );
                        }
                    }
                    if (nl == std::string_view::npos) break;
                    pos = nl + 2;
                }
            }
        }
        if (header_end != std::string::npos &&
            raw_req.size() >= header_end + 4 + content_len) {
            break;
        }
    }

    if (header_end == std::string::npos) {
        return;
    }

    const std::string_view hdr_view(raw_req.data(), header_end);
    const std::size_t first_line_end = hdr_view.find("\r\n");
    const std::string_view req_line = (first_line_end == std::string_view::npos)
        ? hdr_view
        : hdr_view.substr(0, first_line_end);

    const std::size_t sp1 = req_line.find(' ');
    if (sp1 == std::string_view::npos) {
        return;
    }
    const std::size_t sp2 = req_line.find(' ', sp1 + 1);
    if (sp2 == std::string_view::npos) {
        return;
    }

    const std::string_view method = req_line.substr(0, sp1);
    const std::string_view target = req_line.substr(sp1 + 1, sp2 - (sp1 + 1));

    std::string host_hdr;
    std::string origin_hdr;
    if (first_line_end != std::string_view::npos) {
        std::size_t pos = first_line_end + 2;
        while (pos < hdr_view.size()) {
            const std::size_t nl = hdr_view.find("\r\n", pos);
            const std::string_view line = (nl == std::string_view::npos)
                ? hdr_view.substr(pos)
                : hdr_view.substr(pos, nl - pos);
            const std::size_t colon = line.find(':');
            if (colon != std::string_view::npos) {
                const std::string hname = to_lower_ascii(trim_ascii(line.substr(0, colon)));
                const std::string hval = trim_ascii(line.substr(colon + 1));
                if (hname == "host") host_hdr = hval;
                else if (hname == "origin") origin_hdr = hval;
            }
            if (nl == std::string_view::npos) break;
            pos = nl + 2;
        }
    }

    const std::size_t body_offset = header_end + 4;
    const std::size_t avail_body = raw_req.size() > body_offset
        ? (raw_req.size() - body_offset)
        : 0;
    const std::string_view body_view(
        raw_req.data() + body_offset,
        std::min(content_len, avail_body)
    );

    HttpResponse resp;
    try {
        resp = route_http(method, target, host_hdr, origin_hdr, body_view);
    } catch (const std::exception& ex) {
        core::JsonObject err;
        err["ok"] = false;
        err["error"] = "internal_error";
        err["message"] = core::SecretRedactor::redact(ex.what());
        resp = make_json_response(500, "Internal Server Error", core::JsonValue(std::move(err)));
    }

    std::string wire;
    wire.reserve(256 + resp.body.size());
    wire.append("HTTP/1.1 ")
        .append(std::to_string(resp.status))
        .append(" ")
        .append(resp.status_text)
        .append("\r\n");
    wire.append("Content-Type: ").append(resp.content_type).append("\r\n");
    wire.append("Content-Length: ").append(std::to_string(resp.body.size())).append("\r\n");
    wire.append("X-Content-Type-Options: nosniff\r\n");
    wire.append("Vary: Origin\r\n");
    if (!resp.allow_origin.empty()) {
        wire.append("Access-Control-Allow-Origin: ").append(resp.allow_origin).append("\r\n");
        wire.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        wire.append("Access-Control-Allow-Headers: Content-Type\r\n");
    }
    wire.append("Cache-Control: no-store\r\n");
    wire.append("Connection: close\r\n\r\n");
    wire.append(resp.body);

    std::size_t sent_total = 0;
    while (sent_total < wire.size()) {
        const int chunk = send(
            guard.sock,
            wire.data() + sent_total,
            static_cast<int>(std::min<std::size_t>(wire.size() - sent_total, 65536)),
            0
        );
        if (chunk <= 0) {
            break;
        }
        sent_total += static_cast<std::size_t>(chunk);
    }
#else
    (void)client_sock;
#endif
}

HttpResponse StudioServer::route_http(
    std::string_view method,
    std::string_view raw_target,
    std::string_view host_header,
    std::string_view origin_header,
    std::string_view body
) {
    // 1. Host DNS-rebinding guard
    if (!is_allowed_loopback_host(host_header)) {
        core::JsonObject err;
        err["ok"] = false;
        err["error"] = "forbidden_host";
        err["message"] = "Host header must target local loopback (127.0.0.1 or localhost)";
        return make_json_response(403, "Forbidden", core::JsonValue(std::move(err)));
    }

    // 2. Cross-Origin Guard (`deep-cors-diagnostics`): reject non-loopback Origin on POST/PUT/PATCH/DELETE/OPTIONS
    const bool is_mutation_or_preflight =
        (method == "POST" || method == "PUT" || method == "PATCH" ||
         method == "DELETE" || method == "OPTIONS");
    if (is_mutation_or_preflight && !is_allowed_loopback_origin(origin_header)) {
        core::JsonObject err;
        err["ok"] = false;
        err["error"] = "forbidden_origin";
        err["message"] = "Cross-origin request rejected by loopback Origin allowlist";
        return make_json_response(403, "Forbidden", core::JsonValue(std::move(err)));
    }

    const std::string allowed_origin_echo =
        (!origin_header.empty() && is_allowed_loopback_origin(origin_header))
        ? std::string(origin_header)
        : std::string{};

    if (method == "OPTIONS") {
        HttpResponse pre{};
        pre.status = 204;
        pre.status_text = "No Content";
        pre.content_type = "text/plain; charset=utf-8";
        pre.allow_origin = allowed_origin_echo;
        return pre;
    }

    const std::size_t qmark = raw_target.find('?');
    const std::string_view path_part = (qmark == std::string_view::npos)
        ? raw_target
        : raw_target.substr(0, qmark);
    const std::string_view query_part = (qmark == std::string_view::npos)
        ? std::string_view{}
        : raw_target.substr(qmark + 1);
    const auto query_params = parse_query_params(query_part);

    const std::int64_t now_ms = now_unix_ms();

    // API Routes
    if (path_part == "/api/health" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        return make_json_response(200, "OK", build_health_json(), allowed_origin_echo);
    }

    if (path_part == "/api/graph" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        return make_json_response(200, "OK", build_graph_json(), allowed_origin_echo);
    }

    if (path_part == "/api/graph/send" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const std::string from = normalize_peer_id(parsed->prop_string("from", "coordinator"));
        const std::string raw_to = parsed->prop_string("to", "@all");
        const std::string to = (raw_to == "@all" || raw_to == "*") ? raw_to : normalize_peer_id(raw_to);
        const std::string text = parsed->prop_string("text", "");
        const bool bcast = parsed->prop_bool("broadcast", false) || to == "@all" || to == "*";
        if (text.empty()) {
            core::JsonObject err{{"ok", false}, {"error", "empty_message"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }

        std::lock_guard<std::mutex> lock(state_mutex_);
        try {
            graph::PeerEnvelope env = bcast
                ? peer_mesh_.broadcast(
                      from,
                      "studio-live",
                      text,
                      graph::GraphifyProvenance::Extracted,
                      8,
                      static_cast<std::uint64_t>(now_ms)
                  )
                : peer_mesh_.send_peer(graph::SendPeerRequest{
                      from,
                      to,
                      "studio-live",
                      text,
                      graph::GraphifyProvenance::Extracted,
                      0,
                      8,
                      std::nullopt,
                      false,
                      static_cast<std::uint64_t>(now_ms)
                  });

            core::JsonArray msgs;
            for (const auto& m : peer_mesh_.all_messages()) {
                msgs.push_back(serialize_peer_envelope(m));
            }
            core::JsonObject out;
            out["ok"] = true;
            out["message"] = serialize_peer_envelope(env);
            out["messages"] = std::move(msgs);
            return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
        } catch (const std::exception& ex) {
            core::JsonObject err{
                {"ok", false},
                {"error", "graph_send_rejected"},
                {"message", ex.what()}
            };
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
    }

    if (path_part == "/api/graph/traverse" && method == "GET") {
        std::string entity = "omnia-studio";
        if (const auto it = query_params.find("entity"); it != query_params.end() && !it->second.empty()) {
            entity = it->second;
        }
        std::string dir_str = "Both";
        if (const auto it = query_params.find("direction"); it != query_params.end() && !it->second.empty()) {
            dir_str = it->second;
        }
        std::uint32_t max_depth = 3;
        if (const auto it = query_params.find("maxDepth"); it != query_params.end() && !it->second.empty()) {
            const auto parsed_d = std::strtoul(it->second.c_str(), nullptr, 10);
            max_depth = static_cast<std::uint32_t>(std::clamp<unsigned long>(parsed_d, 1UL, 8UL));
        }

        const auto dir = graph::parse_direction(dir_str);
        std::lock_guard<std::mutex> lock(state_mutex_);
        const auto tr = graphify_.traverse_bfs(entity, dir, max_depth, false);

        core::JsonArray visited_ids;
        core::JsonArray visited_entities;
        for (const auto& v : tr.visited_entities) {
            visited_ids.emplace_back(v.id);
            core::JsonObject vo;
            vo["id"] = v.id;
            vo["kind"] = graph::entity_kind_to_string(v.kind);
            vo["label"] = v.label;
            vo["path"] = v.path;
            visited_entities.emplace_back(std::move(vo));
        }

        core::JsonArray edges;
        for (const auto& te : tr.traversed_edges) {
            core::JsonObject eo;
            eo["from"] = te.edge.from_id;
            eo["to"] = te.edge.to_id;
            eo["relation"] = te.edge.relation;
            eo["provenance"] = graph::provenance_to_string(te.edge.provenance);
            eo["depth"] = static_cast<std::uint64_t>(te.depth);
            eo["note"] = te.edge.rationale;
            edges.emplace_back(std::move(eo));
        }

        core::JsonArray quarantined;
        for (const auto& qe : tr.quarantined_ambiguous) {
            core::JsonObject qo;
            qo["from"] = qe.from_id;
            qo["to"] = qe.to_id;
            qo["relation"] = qe.relation;
            qo["provenance"] = graph::provenance_to_string(qe.provenance);
            qo["note"] = qe.rationale;
            quarantined.emplace_back(std::move(qo));
        }

        core::JsonObject out;
        out["ok"] = true;
        out["entity"] = entity;
        out["direction"] = graph::direction_to_string(dir);
        out["maxDepth"] = static_cast<std::uint64_t>(max_depth);
        out["visited"] = std::move(visited_ids);
        out["visitedEntities"] = std::move(visited_entities);
        out["edges"] = std::move(edges);
        out["quarantinedAmbiguous"] = std::move(quarantined);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/router/state" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        return make_json_response(200, "OK", build_router_state_json(now_ms), allowed_origin_echo);
    }

    if (path_part == "/api/router/decide" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }

        std::lock_guard<std::mutex> lock(state_mutex_);

        const std::string trip_cid = parsed->prop_string("tripCandidate", "");
        if (!trip_cid.empty()) {
            (void)router_.trip_circuit(trip_cid, now_ms);
        }
        const std::string reset_cid = parsed->prop_string("resetCandidate", "");
        if (!reset_cid.empty()) {
            (void)router_.reset_circuit(reset_cid, now_ms);
        }

        routing::RouteRequestPolicy pol{};
        std::string idem = parsed->prop_string("idempotencyKey", "");
        if (idem.empty()) {
            ++auto_idem_seq_;
            idem = "studio-decide-" + std::to_string(now_ms) + "-" + std::to_string(auto_idem_seq_);
        }
        pol.idempotency_key = idem;

        const std::uint64_t est_total = static_cast<std::uint64_t>(
            std::max<std::int64_t>(64, parsed->prop_int64("estimatedTokens", 4096))
        );
        pol.estimated_input_tokens = (est_total * 7ULL) / 10ULL;
        pol.estimated_output_tokens = est_total - pol.estimated_input_tokens;
        pol.required_capabilities.streaming = parsed->prop_bool("requireStreaming", true);
        pol.privacy_tier = routing::parse_privacy_tier(
            parsed->prop_string("privacyTier", "zero_data_retention")
        );

        const std::string task_class = to_lower_ascii(parsed->prop_string("taskClass", "code_generation"));
        if (task_class == "vision" || task_class == "multimodal" || task_class == "multimodal_vision") {
            pol.required_capabilities.vision = true;
        } else if (task_class == "audio") {
            pol.required_capabilities.audio = true;
        } else if (task_class == "coding" || task_class == "code_generation" ||
                   task_class == "reasoning" || task_class == "architecture" ||
                   task_class == "architecture_synthesis" || task_class == "math_derivation") {
            pol.required_capabilities.tool_use = true;
            pol.min_quality_tier = 4;
            pol.task_risk = routing::TaskRisk::High;
        } else if (task_class == "local") {
            pol.privacy_tier = routing::PrivacyTier::LocalOnly;
        } else if (task_class == "fast" || task_class == "fast_triage") {
            pol.max_latency_p95_ms = 360;
        }

        const auto dec = router_.decide_and_reserve(pol, now_ms);

        core::JsonArray scores_arr;
        for (const auto& sc : dec.receipt.scores) {
            const std::int64_t cap_pct = sc.eligible ? std::max<std::int64_t>(0, (sc.capability_fit_bps + 50) / 100) : 0;
            const std::int64_t priv_pct = sc.eligible ? std::max<std::int64_t>(0, (sc.privacy_fit_bps + 50) / 100) : 0;
            const std::int64_t quota_pct = sc.eligible ? std::max<std::int64_t>(0, (sc.budget_headroom_bps + 50) / 100) : 0;
            const std::int64_t lat_pct = sc.eligible ? std::max<std::int64_t>(0, (sc.latency_health_bps + 50) / 100) : 0;
            const std::int64_t rel_pct = sc.eligible
                ? std::max<std::int64_t>(0, (sc.reliability_bps + sc.user_preference_bps + sc.route_priority_bps + 50) / 100)
                : 0;
            const std::int64_t total_pct = sc.eligible
                ? std::min<std::int64_t>(100, cap_pct + priv_pct + quota_pct + lat_pct + rel_pct)
                : 0;

            core::JsonObject so;
            so["candidateId"] = sc.candidate_id;
            so["eligible"] = sc.eligible;
            so["totalScore"] = total_pct;
            so["totalScoreBps"] = sc.total_score_bps;
            so["capabilityScore"] = cap_pct;
            so["privacyScore"] = priv_pct;
            so["quotaScore"] = quota_pct;
            so["latencyScore"] = lat_pct;
            so["reliabilityScore"] = rel_pct;
            so["preferenceScore"] = (sc.user_preference_bps + 50) / 100;
            so["priorityScore"] = (sc.route_priority_bps + 50) / 100;
            if (sc.rejection_reasons.empty()) {
                so["rejectedReason"] = nullptr;
            } else {
                so["rejectedReason"] = sc.rejection_reasons.front();
            }
            scores_arr.emplace_back(std::move(so));
        }

        core::JsonObject rec_obj;
        rec_obj["receiptId"] = dec.receipt.receipt_id;
        rec_obj["sequenceId"] = dec.receipt.sequence_id;
        rec_obj["schemaVersion"] = "omnia.routing.v2.cpp20";
        rec_obj["redactionPolicy"] = dec.receipt.redaction_policy;
        rec_obj["policyClass"] = dec.receipt.policy_class;
        rec_obj["policyHash"] = "sha256:" + dec.receipt.policy_hash.substr(0, 16);
        rec_obj["selectedRoute"] = dec.receipt.selected_candidate_id.has_value()
            ? core::JsonValue(*dec.receipt.selected_candidate_id)
            : core::JsonValue(nullptr);
        rec_obj["reservationId"] = dec.receipt.reservation_id.has_value()
            ? core::JsonValue(*dec.receipt.reservation_id)
            : core::JsonValue(nullptr);
        rec_obj["reservedTokens"] = dec.receipt.reserved_tokens;
        rec_obj["promptRedacted"] = true;
        rec_obj["secretsExposed"] = 0;
        rec_obj["estimatedCostMicrounits"] = dec.receipt.estimated_cost_microunits.has_value()
            ? core::JsonValue(*dec.receipt.estimated_cost_microunits)
            : core::JsonValue(nullptr);
        rec_obj["scores"] = std::move(scores_arr);

        core::JsonObject out;
        out["ok"] = dec.ok;
        out["selectedCandidateId"] = dec.receipt.selected_candidate_id.has_value()
            ? core::JsonValue(*dec.receipt.selected_candidate_id)
            : core::JsonValue(nullptr);
        out["status"] = dec.ok ? "ROUTED_DETERMINISTIC" : "FENCED_OPERATOR_RECOVERY_REQUIRED";
        out["receipt"] = std::move(rec_obj);
        out["candidates"] = build_router_candidates_json(now_ms);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/memory" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        return make_json_response(200, "OK", build_memory_json(), allowed_origin_echo);
    }

    if (path_part == "/api/memory/upsert" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const std::string ns = parsed->prop_string("namespace", "");
        const std::string key = parsed->prop_string("key", "");
        const std::string content = parsed->prop_string("content", "");
        const auto tier = harness::parse_memory_tier(parsed->prop_string("tier", "durable"));

        std::lock_guard<std::mutex> lock(state_mutex_);
        try {
            const auto entry = memory_.upsert(ns, key, content, tier, {}, now_ms);
            core::JsonObject out;
            out["ok"] = true;
            out["entry"] = serialize_memory_entry(entry);
            out["entries"] = build_memory_json()["entries"];
            return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
        } catch (const std::exception& ex) {
            core::JsonObject err{
                {"ok", false},
                {"error", "invalid_memory_namespace_or_key"},
                {"message", ex.what()}
            };
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
    }

    if (path_part == "/api/memory/erase" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        std::string id = parsed->prop_string("id", "");
        if (id.empty()) {
            const std::string ns = parsed->prop_string("namespace", "");
            const std::string key = parsed->prop_string("key", "");
            if (!ns.empty() && !key.empty()) {
                id = ns + "/" + key;
            }
        }
        std::lock_guard<std::mutex> lock(state_mutex_);
        const auto rec = memory_.erase(id, now_ms);
        if (!rec.has_value()) {
            core::JsonObject err{{"ok", false}, {"error", "memory_entry_not_found"}};
            return make_json_response(404, "Not Found", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        core::JsonObject out;
        out["ok"] = true;
        out["receipt"] = serialize_erasure_receipt(*rec);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/rag/plan" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const std::string q = parsed->prop_string("query", "");
        std::lock_guard<std::mutex> lock(state_mutex_);
        const auto plan = rag_.plan(q);

        core::JsonArray triggers;
        for (const auto& t : plan.triggers) triggers.emplace_back(t);

        core::JsonArray subs;
        for (const auto& sq : plan.sub_queries) {
            core::JsonObject so;
            so["angle"] = sq.angle;
            so["query"] = sq.query;
            subs.emplace_back(std::move(so));
        }

        core::JsonArray cited;
        for (const auto& cs : plan.cited_sources) {
            core::JsonObject co;
            co["id"] = cs.id;
            co["title"] = cs.title;
            co["locator"] = cs.locator;
            co["snippet"] = cs.snippet;
            co["provenance"] = cs.provenance;
            co["score"] = cs.score;
            cited.emplace_back(std::move(co));
        }

        core::JsonArray unused;
        for (const auto& us : plan.unused_sources) {
            core::JsonObject uo;
            uo["id"] = us.id;
            uo["title"] = us.title;
            uo["locator"] = us.locator;
            uo["reason"] = us.reason;
            unused.emplace_back(std::move(uo));
        }

        core::JsonObject out;
        out["ok"] = true;
        out["query"] = plan.query;
        out["language"] = plan.language;
        out["uncertaintyScore"] = plan.uncertainty_score;
        out["uncertaintyScoreBps"] = static_cast<std::uint64_t>(plan.uncertainty_score_bps);
        out["shouldRetrieve"] = plan.should_retrieve;
        out["triggers"] = std::move(triggers);
        out["subQueries"] = std::move(subs);
        out["citedSources"] = std::move(cited);
        out["unusedSources"] = std::move(unused);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/skills" && method == "GET") {
        std::string q;
        if (const auto it = query_params.find("q"); it != query_params.end()) {
            q = it->second;
        }
        std::lock_guard<std::mutex> lock(state_mutex_);
        const auto ranked = skills_.search(q, 128);
        core::JsonArray arr;
        for (const auto& rs : ranked) {
            core::JsonObject so;
            so["name"] = rs.skill.name;
            so["description"] = rs.skill.description;
            so["path"] = rs.skill.relative_path;
            so["category"] = rs.skill.category;
            so["score"] = rs.score;
            arr.emplace_back(std::move(so));
        }
        core::JsonObject out;
        out["ok"] = true;
        out["query"] = q;
        out["total"] = static_cast<std::uint64_t>(arr.size());
        out["skills"] = std::move(arr);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/composer/templates" && method == "GET") {
        core::JsonArray arr;
        for (const auto& t : harness::ComposerModel::templates()) {
            core::JsonArray ph;
            for (const auto& p : t.placeholders) ph.emplace_back(p);
            core::JsonObject to;
            to["id"] = t.id;
            to["category"] = t.category;
            to["title"] = t.title;
            to["symbol"] = t.symbol;
            to["latex"] = t.latex;
            to["description"] = t.description;
            to["placeholders"] = std::move(ph);
            arr.emplace_back(std::move(to));
        }
        core::JsonObject out;
        out["ok"] = true;
        out["templates"] = std::move(arr);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/steer" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        core::JsonArray arr;
        for (const auto& item : steer_queue_.items()) {
            arr.push_back(serialize_steer_item(item));
        }
        core::JsonObject out;
        out["ok"] = true;
        out["tokenBudget"] = nullptr; // Invariant: always null!
        out["items"] = std::move(arr);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/steer/enqueue" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const std::string text = parsed->prop_string("text", "");
        if (text.empty()) {
            core::JsonObject err{{"ok", false}, {"error", "empty_steer_text"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const auto mode = harness::parse_steer_mode(parsed->prop_string("mode", "ADDITIVE_INTAKE"));

        std::lock_guard<std::mutex> lock(state_mutex_);
        const auto added = steer_queue_.enqueue(text, mode, now_ms, "queued");
        core::JsonArray arr;
        for (const auto& it : steer_queue_.items()) {
            arr.push_back(serialize_steer_item(it));
        }
        core::JsonObject out;
        out["ok"] = true;
        out["tokenBudget"] = nullptr;
        out["item"] = serialize_steer_item(added);
        out["items"] = std::move(arr);
        return make_json_response(200, "OK", core::JsonValue(std::move(out)), allowed_origin_echo);
    }

    if (path_part == "/api/sessions" && method == "GET") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        return make_json_response(200, "OK", build_sessions_json(now_ms), allowed_origin_echo);
    }

    if (path_part == "/api/sessions/create" && method == "POST") {
        const auto parsed = core::JsonValue::try_parse(body);
        if (!parsed.has_value() || !parsed->is_object()) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_json"}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
        const std::string title = parsed->prop_string("title", "New Studio Session");
        const std::string model_id = parsed->prop_string("modelId", "claude-opus-4-6");
        const std::string effort = parsed->prop_string("effort", "high");

        std::lock_guard<std::mutex> lock(state_mutex_);
        try {
            const auto created = session_store_->create_session(title, model_id, effort, now_ms);
            auto sessions_val = build_sessions_json(now_ms);
            core::JsonObject cobj;
            cobj["id"] = created.id;
            cobj["title"] = created.title;
            cobj["modelId"] = created.model_id;
            cobj["effort"] = created.effort;
            cobj["updatedAt"] = created.updated_at_ms;
            cobj["revision"] = created.revision;
            sessions_val.as_object()["session"] = std::move(cobj);
            return make_json_response(200, "OK", sessions_val, allowed_origin_echo);
        } catch (const std::exception& ex) {
            core::JsonObject err{{"ok", false}, {"error", "invalid_session_params"}, {"message", ex.what()}};
            return make_json_response(400, "Bad Request", core::JsonValue(std::move(err)), allowed_origin_echo);
        }
    }

    if (method == "GET") {
        return serve_static_asset(path_part);
    }

    core::JsonObject err{{"ok", false}, {"error", "not_found"}};
    return make_json_response(404, "Not Found", core::JsonValue(std::move(err)), allowed_origin_echo);
}

HttpResponse StudioServer::serve_static_asset(std::string_view req_path) const {
    const std::string decoded = url_decode(req_path);
    if (decoded.find("..") != std::string::npos || decoded.find('\\') != std::string::npos) {
        core::JsonObject err{{"ok", false}, {"error", "forbidden_path"}};
        return make_json_response(403, "Forbidden", core::JsonValue(std::move(err)));
    }

    std::string rel = (decoded.empty() || decoded == "/")
        ? "index.html"
        : decoded.substr(decoded.front() == '/' ? 1 : 0);

    std::error_code ec;
    if (!config_.ui_root.empty() && std::filesystem::exists(config_.ui_root, ec)) {
        const auto canon_root = std::filesystem::weakly_canonical(config_.ui_root, ec);
        if (!ec) {
            const auto candidate = canon_root / std::filesystem::path(rel);
            const auto canon_file = std::filesystem::weakly_canonical(candidate, ec);
            if (!ec && is_path_prefix_contained(canon_root, canon_file) &&
                std::filesystem::is_regular_file(canon_file, ec)) {
                std::ifstream ifs(canon_file, std::ios::binary);
                if (ifs) {
                    const auto sz = std::filesystem::file_size(canon_file, ec);
                    if (!ec && sz <= 16 * 1024 * 1024) {
                        std::string content(static_cast<std::size_t>(sz), '\0');
                        if (sz > 0) {
                            ifs.read(content.data(), static_cast<std::streamsize>(sz));
                        }
                        HttpResponse ok{};
                        ok.status = 200;
                        ok.status_text = "OK";
                        ok.content_type = mime_type_for_ext(canon_file.extension().generic_string());
                        ok.body = std::move(content);
                        return ok;
                    }
                }
            }
        }
    }

    if (rel == "index.html") {
        HttpResponse fallback{};
        fallback.status = 200;
        fallback.status_text = "OK";
        fallback.content_type = "text/html; charset=utf-8";
        fallback.body =
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<title>Omnia Native C++20 Studio Host</title></head>"
            "<body style=\"background:#080A0F;color:#E6ECF5;font-family:system-ui\">"
            "<h1>Omnia Native C++20 Studio Host Active</h1>"
            "<p>API telemetry online at <code>/api/health</code>.</p></body></html>\n";
        return fallback;
    }

    core::JsonObject err{{"ok", false}, {"error", "asset_not_found"}};
    return make_json_response(404, "Not Found", core::JsonValue(std::move(err)));
}

core::JsonValue StudioServer::build_health_json() const {
    core::JsonObject obj;
    obj["ok"] = true;
    obj["engine"] = "Omnia Native C++20";
#ifdef _MSC_FULL_VER
    obj["compiler"] = "MSVC 14." + std::to_string((_MSC_VER % 100)) + "." +
                      std::to_string(_MSC_FULL_VER % 100000);
#else
    obj["compiler"] = "C++20 Compiler";
#endif
    obj["cplusplus"] = static_cast<std::int64_t>(__cplusplus);
    obj["rustFiles"] = 0;
#ifdef _WIN32
    obj["pid"] = static_cast<std::int64_t>(GetCurrentProcessId());
    obj["workingSetBytes"] = query_working_set_bytes();
    obj["binaryBytes"] = query_current_binary_bytes();
#else
    obj["pid"] = 0;
    obj["workingSetBytes"] = 0;
    obj["binaryBytes"] = 0;
#endif
    obj["skillCount"] = static_cast<std::uint64_t>(skills_.size());
    obj["peerCount"] = static_cast<std::uint64_t>(peer_mesh_.agents().size());
    return core::JsonValue(std::move(obj));
}

core::JsonValue StudioServer::build_graph_json() const {
    const auto& all_msgs = peer_mesh_.all_messages();
    const std::uint64_t head_seq = static_cast<std::uint64_t>(all_msgs.size());

    core::JsonArray nodes_arr;
    for (const auto& ag : peer_mesh_.agents()) {
        core::JsonArray paths;
        for (const auto& p : ag.owned_paths) paths.emplace_back(p);
        core::JsonArray excl;
        for (const auto& e : ag.excluded_paths) excl.emplace_back(e);
        core::JsonArray dpeers;
        for (const auto& dp : peer_mesh_.duplex_peers(ag.agent_id)) dpeers.emplace_back(dp);

        core::JsonObject no;
        no["id"] = ag.agent_id;
        no["label"] = ag.label;
        no["role"] = graph::role_to_string(ag.role);
        no["state"] = ag.active ? "ACTIVE" : "INACTIVE";
        no["epoch"] = ag.epoch;
        no["maxHops"] = static_cast<std::uint64_t>(ag.max_hops);
        no["disjointPaths"] = std::move(paths);
        no["excludedPaths"] = std::move(excl);
        no["incomingCount"] = static_cast<std::uint64_t>(peer_mesh_.incoming_peers(ag.agent_id).size());
        no["outgoingCount"] = static_cast<std::uint64_t>(peer_mesh_.outgoing_peers(ag.agent_id).size());
        no["duplexPeers"] = std::move(dpeers);
        no["lastSeq"] = head_seq;
        nodes_arr.emplace_back(std::move(no));
    }

    core::JsonArray links_arr;
    std::set<std::pair<std::string, std::string>> emitted_duplex;
    for (const auto& e : peer_mesh_.all_edges()) {
        if (e.duplex) {
            const auto key = (e.from < e.to)
                ? std::make_pair(e.from, e.to)
                : std::make_pair(e.to, e.from);
            if (!emitted_duplex.insert(key).second) {
                continue;
            }
        }
        core::JsonObject lo;
        lo["from"] = e.from;
        lo["to"] = e.to;
        lo["mode"] = e.duplex ? "Duplex" : "Directed";
        lo["label"] = e.relation;
        lo["provenance"] = graph::provenance_to_string(e.provenance);
        links_arr.emplace_back(std::move(lo));
    }

    core::JsonArray msgs_arr;
    for (const auto& m : all_msgs) {
        msgs_arr.push_back(serialize_peer_envelope(m));
    }

    core::JsonArray gnodes;
    for (const auto& ge : graphify_.entities()) {
        core::JsonObject go;
        go["id"] = ge.id;
        go["kind"] = graph::entity_kind_to_string(ge.kind);
        go["label"] = ge.label;
        go["path"] = ge.path;
        go["summary"] = ge.summary;
        gnodes.emplace_back(std::move(go));
    }

    core::JsonArray gedges;
    for (const auto& ed : graphify_.edges()) {
        core::JsonObject eo;
        eo["from"] = ed.from_id;
        eo["to"] = ed.to_id;
        eo["relation"] = ed.relation;
        eo["provenance"] = graph::provenance_to_string(ed.provenance);
        eo["confidenceBps"] = static_cast<std::uint64_t>(ed.confidence_bps);
        eo["note"] = ed.rationale;
        gedges.emplace_back(std::move(eo));
    }

    core::JsonObject out;
    out["ok"] = true;
    out["nodes"] = std::move(nodes_arr);
    out["links"] = std::move(links_arr);
    out["messages"] = std::move(msgs_arr);
    out["graphifyNodes"] = std::move(gnodes);
    out["graphifyEdges"] = std::move(gedges);
    return core::JsonValue(std::move(out));
}

core::JsonValue StudioServer::build_router_candidates_json(std::int64_t now_ms) const {
    core::JsonArray arr;
    for (const auto& snap : router_.snapshots(now_ms)) {
        const auto& c = snap.candidate;
        const auto& s = snap.state;
        core::JsonArray caps_list;
        if (c.capabilities.text) {
            caps_list.emplace_back("code_generation");
            caps_list.emplace_back("fast_triage");
        }
        if (c.capabilities.tool_use) {
            caps_list.emplace_back("architecture_synthesis");
            caps_list.emplace_back("math_derivation");
        }
        if (c.capabilities.vision) {
            caps_list.emplace_back("multimodal_vision");
        }
        if (c.capabilities.streaming) {
            caps_list.emplace_back("streaming");
        }

        core::JsonObject caps_flags;
        caps_flags["text"] = c.capabilities.text;
        caps_flags["vision"] = c.capabilities.vision;
        caps_flags["audio"] = c.capabilities.audio;
        caps_flags["toolUse"] = c.capabilities.tool_use;
        caps_flags["structuredOutput"] = c.capabilities.structured_output;
        caps_flags["streaming"] = c.capabilities.streaming;

        const std::uint64_t total_calls = s.success_count + s.error_count + s.timeout_count;
        const double err_rate = total_calls > 0
            ? std::round((static_cast<double>(s.error_count + s.timeout_count) / static_cast<double>(total_calls)) * 10000.0) / 10000.0
            : 0.0;

        core::JsonObject co;
        co["id"] = c.candidate_id;
        co["providerId"] = c.provider_id;
        co["modelId"] = c.model_id;
        co["capabilities"] = std::move(caps_list);
        co["capabilitiesFlags"] = std::move(caps_flags);
        co["privacyTier"] = ui_privacy_tier_label(c.privacy_tier);
        co["region"] = c.region;
        co["circuit"] = routing::circuit_kind_to_string(s.circuit_state.kind);
        co["quotaState"] = routing::quota_kind_to_string(s.quota.kind);
        co["remainingTokens"] = (s.quota.kind == routing::QuotaState::Kind::Known ||
                                 s.quota.kind == routing::QuotaState::Kind::Stale)
            ? core::JsonValue(s.quota.remaining_tokens > s.reserved_tokens
                              ? (s.quota.remaining_tokens - s.reserved_tokens)
                              : 0ULL)
            : core::JsonValue(nullptr);
        co["reserveTokens"] = s.quota.emergency_reserve_tokens;
        co["ewmaMs"] = static_cast<std::int64_t>(std::llround(s.ewma_latency_ms.value_or(0.0)));
        co["p95Ms"] = s.p95_latency_ms().value_or(0ULL);
        co["errorRate"] = err_rate;
        arr.emplace_back(std::move(co));
    }
    return core::JsonValue(std::move(arr));
}

core::JsonValue StudioServer::build_router_state_json(std::int64_t now_ms) const {
    core::JsonArray receipts_arr;
    const auto all_recs = router_.decision_receipts();
    const std::size_t start = all_recs.size() > 10 ? (all_recs.size() - 10) : 0;
    for (std::size_t i = start; i < all_recs.size(); ++i) {
        const auto& r = all_recs[i];
        core::JsonObject ro;
        ro["receiptId"] = r.receipt_id;
        ro["policyClass"] = r.policy_class;
        ro["policyHash"] = r.policy_hash;
        ro["selectedRoute"] = r.selected_candidate_id.has_value()
            ? core::JsonValue(*r.selected_candidate_id)
            : core::JsonValue(nullptr);
        ro["reservationId"] = r.reservation_id.has_value()
            ? core::JsonValue(*r.reservation_id)
            : core::JsonValue(nullptr);
        ro["reservedTokens"] = r.reserved_tokens;
        ro["decidedAt"] = r.decided_at_ms;
        receipts_arr.emplace_back(std::move(ro));
    }

    core::JsonObject out;
    out["ok"] = true;
    out["candidates"] = build_router_candidates_json(now_ms);
    out["recentReceipts"] = std::move(receipts_arr);
    return core::JsonValue(std::move(out));
}

core::JsonValue StudioServer::build_memory_json() const {
    core::JsonArray entries_arr;
    for (const auto& e : memory_.list_entries()) {
        entries_arr.push_back(serialize_memory_entry(e));
    }
    core::JsonArray erasures_arr;
    for (const auto& er : memory_.erasure_receipts()) {
        erasures_arr.push_back(serialize_erasure_receipt(er));
    }
    core::JsonObject out;
    out["ok"] = true;
    out["entries"] = std::move(entries_arr);
    out["erasures"] = std::move(erasures_arr);
    return core::JsonValue(std::move(out));
}

core::JsonValue StudioServer::build_sessions_json(std::int64_t now_ms) const {
    const auto page = session_store_->list_sessions_page(50);
    core::JsonArray sarr;
    for (const auto& s : page.items) {
        core::JsonObject so;
        so["id"] = s.id;
        so["title"] = s.title;
        so["modelId"] = s.model_id;
        so["effort"] = s.effort;
        so["updatedAt"] = s.updated_at_ms;
        so["revision"] = s.revision;
        sarr.emplace_back(std::move(so));
    }

    core::JsonObject out;
    out["ok"] = true;
    out["sessions"] = std::move(sarr);
    const auto lease = session_store_->active_lease(now_ms);
    if (lease.has_value()) {
        core::JsonObject lo;
        lo["ownerId"] = lease->owner_id;
        lo["pid"] = lease->pid;
        lo["leaseEpoch"] = lease->lease_epoch;
        lo["expiresAt"] = lease->expires_at_ms;
        out["activeLease"] = std::move(lo);
    } else {
        out["activeLease"] = nullptr;
    }
    return core::JsonValue(std::move(out));
}

} // namespace omnia::studio
