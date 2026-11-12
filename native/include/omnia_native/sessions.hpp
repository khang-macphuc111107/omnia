#pragma once

#include "omnia_native/store.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <variant>
#include <vector>

namespace omnia::native {

inline constexpr std::array<std::string_view, 7> kEfforts = {
    "none", "minimal", "low", "medium", "high", "xhigh", "max"
};

struct SessionSnapshot {
    std::vector<AgentSessionSummary> rows;
    std::optional<AgentSessionSummary> active;
    int64_t navigation_revision{0};
    std::optional<AgentSessionPageCursor> cursor;
    std::optional<AgentSessionPageCursor> next_cursor;
};

struct SessionCommand {
    struct Refresh {};
    struct Page {
        std::optional<AgentSessionPageCursor> cursor;
    };
    struct Create {
        int64_t expected_revision{0};
    };
    struct Select {
        std::string id;
        int64_t expected_revision{0};
    };
    struct Update {
        std::string id;
        uint64_t expected_revision{1};
        std::string title;
        std::string model;
        std::string effort;
    };

    using Payload = std::variant<Refresh, Page, Create, Select, Update>;
    Payload payload{Refresh{}};

    static SessionCommand refresh() { return SessionCommand{Refresh{}}; }
    static SessionCommand page(std::optional<AgentSessionPageCursor> c) {
        return SessionCommand{Page{std::move(c)}};
    }
    static SessionCommand create(int64_t rev) { return SessionCommand{Create{rev}}; }
    static SessionCommand select(std::string id, int64_t rev) {
        return SessionCommand{Select{std::move(id), rev}};
    }
    static SessionCommand update(
        std::string id,
        uint64_t rev,
        std::string title,
        std::string model,
        std::string effort) {
        return SessionCommand{Update{
            std::move(id), rev, std::move(title), std::move(model), std::move(effort)}};
    }

    bool is_update() const noexcept { return std::holds_alternative<Update>(payload); }
};

class Sessions {
public:
    static Result<Sessions> open(const std::filesystem::path& database);
    static Sessions from_shared(std::shared_ptr<HarnessStore> store);

    const std::shared_ptr<HarnessStore>& store() const noexcept { return store_; }

    Result<SessionSnapshot> snapshot() const;
    Result<SessionSnapshot> page(std::optional<AgentSessionPageCursor> cursor) const;
    Result<SessionSnapshot> execute(const SessionCommand& command) const;

    Result<std::vector<AgentSessionSummary>> list() const;
    Result<AgentSessionNavigationLoad> navigation() const;
    Result<AgentSessionSummary> summary(std::string_view id) const;
    Result<AgentSessionSummary> create(std::string_view title) const;
    Result<AgentSessionNavigationSave> select(std::string_view id, int64_t expected_revision) const;
    Result<AgentSessionSummary> update_settings(
        std::string_view id,
        uint64_t expected_revision,
        std::string_view title,
        std::string_view model,
        std::string_view effort) const;

private:
    explicit Sessions(std::shared_ptr<HarnessStore> store) : store_(std::move(store)) {}
    std::shared_ptr<HarnessStore> store_;
};

class SessionWorker {
public:
    ~SessionWorker();

    SessionWorker(const SessionWorker&) = delete;
    SessionWorker& operator=(const SessionWorker&) = delete;
    SessionWorker(SessionWorker&& other) noexcept;
    SessionWorker& operator=(SessionWorker&& other) noexcept;

    static Result<std::unique_ptr<SessionWorker>> start(
        const std::filesystem::path& database,
        std::function<void()> notify);

    static std::unique_ptr<SessionWorker> create_unbacked_for_queue_test(
        std::shared_ptr<std::atomic<bool>> external_cancelled);

    Result<void> submit(SessionCommand command);
    std::optional<Result<SessionSnapshot>> poll();
    std::optional<Result<SessionSnapshot>> wait_response(std::chrono::milliseconds timeout);
    void stop_and_wait();

private:
    struct SharedQueue {
        std::mutex mutex;
        std::condition_variable cmd_cv;
        std::condition_variable resp_cv;
        std::deque<SessionCommand> commands;
        std::deque<Result<SessionSnapshot>> responses;
        bool worker_alive{true};
    };

    SessionWorker() = default;

    std::shared_ptr<SharedQueue> queue_;
    std::shared_ptr<std::atomic<bool>> cancelled_;
    std::shared_ptr<std::atomic<bool>> in_sqlite_;
    std::thread thread_;
};

} // namespace omnia::native
