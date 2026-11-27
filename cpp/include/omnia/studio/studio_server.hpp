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
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace omnia::studio {

struct StudioConfig {
    std::uint16_t port = 8787; // 0 selects an OS-assigned ephemeral loopback port
    std::filesystem::path ui_root;
    std::string db_path = ":memory:";
    std::filesystem::path skills_root;
    // Synthetic graph/router/session state is opt-in. A normal Studio process
    // starts with persisted user data only; --demo enables the visual fixture.
    bool demo_mode = false;
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

    /// Missing Origin is allowed for local CLI clients; present Origin must
    /// match the HTTP IPv4 loopback listener, including its actual bound port.
    static bool is_allowed_loopback_origin(std::string_view origin, std::uint16_t port) noexcept;

    /// Requires the listener's canonical 127.0.0.1 authority. Omitted port = 80.
    static bool is_allowed_loopback_host(std::string_view host, std::uint16_t port) noexcept;

    /// Launches chromeless Edge app window (`msedge --app=http://127.0.0.1:<port>`) via Win32 `*W` APIs.
    static bool launch_edge_app_window(std::uint16_t port);

private:
    static constexpr std::size_t kClientWorkerCount = 8;
    static constexpr std::size_t kMaxQueuedClients = 64;

    StudioConfig config_;
    std::atomic<bool> running_{false};
    std::atomic<std::uint16_t> bound_port_{0};
    std::atomic<bool> lease_held_{false};
    std::atomic<bool> accept_loop_active_{false};
    std::atomic<std::uintptr_t> listen_sock_{static_cast<std::uintptr_t>(~0ULL)};
    std::thread accept_thread_;
    std::thread lease_thread_;
    mutable std::mutex lifecycle_mutex_;
    mutable std::mutex lease_mutex_;
    std::condition_variable lease_cv_;

    mutable std::mutex state_mutex_;
    mutable std::mutex worker_mutex_;
    std::condition_variable worker_cv_;
    struct ClientConnection {
        std::uintptr_t socket = 0;
        std::uint64_t generation = 0;
    };
    std::deque<ClientConnection> client_queue_;
    std::unordered_map<std::uintptr_t, std::uint64_t> active_client_sockets_;
    std::vector<std::thread> client_workers_;
    bool workers_stopping_ = false;
    std::uint64_t next_client_generation_ = 0;
    std::unique_ptr<storage::SessionStore> session_store_;
    std::string lease_owner_id_;
    std::int64_t lease_pid_ = 0;
    std::int64_t lease_epoch_ = 0;
    static constexpr std::int64_t kLeaseTtlMs = 30000;
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
    void start_client_workers();
    void stop_client_workers() noexcept;
    void client_worker_loop();
    void start_lease_heartbeat();
    void stop_lease_heartbeat() noexcept;
    void acquire_lease_or_throw();
    void signal_runtime_shutdown() noexcept;
    bool lease_is_current() const;
    void accept_loop();
    void close_client_socket(std::uintptr_t client_sock, std::uint64_t generation) noexcept;
    void handle_client(ClientConnection client);

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
    core::JsonValue build_sessions_json(
        std::int64_t now_ms,
        std::size_t limit = 50,
        std::optional<storage::SessionCursor> cursor = std::nullopt
    ) const;
};

} // namespace omnia::studio
