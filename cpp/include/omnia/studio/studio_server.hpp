#pragma once

#include "omnia/core/json.hpp"
#include "omnia/graph/graphify_index.hpp"
#include "omnia/graph/peer_mesh.hpp"
#include "omnia/harness/composer_steer.hpp"
#include "omnia/harness/memory_graph.hpp"
#include "omnia/harness/proactive_rag.hpp"
#include "omnia/harness/skill_registry.hpp"
#include "omnia/routing/dynamic_router.hpp"
#include "omnia/storage/session_store.hpp"

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

namespace omnia::studio {

struct StudioConfig {
    std::uint16_t port = 8787; // 0 selects an OS-assigned ephemeral loopback port
    std::filesystem::path ui_root;
    std::string db_path = ":memory:";
    std::filesystem::path skills_root;
    bool open_window = false;
};

struct HttpResponse {
    int status = 200;
    std::string status_text = "OK";
    std::string content_type = "application/json; charset=utf-8";
    std::string allow_origin;
    std::string body;
};

class StudioServer {
public:
    explicit StudioServer(StudioConfig config);
    ~StudioServer();

    StudioServer(const StudioServer&) = delete;
    StudioServer& operator=(const StudioServer&) = delete;

    /// Starts the Winsock2 `127.0.0.1` loopback listener in a background accept thread.
    void start();

    /// Runs the Winsock2 `127.0.0.1` accept loop synchronously on the calling thread until `stop()`.
    void run_blocking();

    /// Signals shutdown and closes the listening socket cleanly.
    void stop() noexcept;

    std::uint16_t bound_port() const noexcept { return bound_port_.load(); }
    bool is_running() const noexcept { return running_.load(); }

    /// Validates whether an HTTP `Origin` header is an allowed local loopback origin.
    static bool is_allowed_loopback_origin(std::string_view origin) noexcept;

    /// Validates whether an HTTP `Host` header targets local loopback (`127.0.0.1` or `localhost`).
    static bool is_allowed_loopback_host(std::string_view host) noexcept;

    /// Launches chromeless Edge app window (`msedge --app=http://127.0.0.1:<port>`) via Win32 `*W` APIs.
    static bool launch_edge_app_window(std::uint16_t port);

private:
    StudioConfig config_;
    std::atomic<bool> running_{false};
    std::atomic<std::uint16_t> bound_port_{0};
    std::uintptr_t listen_sock_ = static_cast<std::uintptr_t>(~0ULL);
    std::thread accept_thread_;

    mutable std::mutex state_mutex_;
    std::unique_ptr<storage::SessionStore> session_store_;
    routing::DynamicProviderRouter router_;
    graph::PeerMeshGraph peer_mesh_{14};
    graph::GraphifyIndex graphify_;
    harness::MemoryGraph memory_;
    harness::ProactiveRag rag_;
    harness::SkillRegistry skills_;
    harness::ComposerModel composer_;
    harness::SteerQueue steer_queue_;
    std::uint64_t auto_idem_seq_ = 0;

    void seed_flagship_state();
    void open_listener();
    void accept_loop();
    void handle_client(std::uintptr_t client_sock);

    HttpResponse route_http(
        std::string_view method,
        std::string_view raw_target,
        std::string_view host_header,
        std::string_view origin_header,
        std::string_view body
    );

    HttpResponse serve_static_asset(std::string_view req_path) const;

    core::JsonValue build_health_json() const;
    core::JsonValue build_graph_json() const;
    core::JsonValue build_router_candidates_json(std::int64_t now_ms) const;
    core::JsonValue build_router_state_json(std::int64_t now_ms) const;
    core::JsonValue build_memory_json() const;
    core::JsonValue build_sessions_json(std::int64_t now_ms) const;
};

} // namespace omnia::studio
