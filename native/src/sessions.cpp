#include "omnia_native/sessions.hpp"

#include <algorithm>

namespace omnia::native {

namespace {

Result<void> validate_metadata_text(std::string_view value, std::string_view name, size_t max_bytes) {
    if (trim_ascii(value).empty() || value.size() > max_bytes || utf8_has_control_chars(value)) {
        return Result<void>::err(
            NativeError::invalid(name, "must be nonempty, bounded and control-free"));
    }
    return Result<void>::ok();
}

} // namespace

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

Result<Sessions> Sessions::open(const std::filesystem::path& database) {
    auto store = HarnessStore::open(database);
    if (store.is_err()) {
        return Result<Sessions>::err(store.error());
    }
    return Result<Sessions>::ok(Sessions::from_shared(std::move(store.value())));
}

Sessions Sessions::from_shared(std::shared_ptr<HarnessStore> store) {
    return Sessions(std::move(store));
}

Result<SessionSnapshot> Sessions::snapshot() const {
    return page(std::nullopt);
}

Result<SessionSnapshot> Sessions::page(std::optional<AgentSessionPageCursor> cursor) const {
    auto loaded = store_->session_page(AgentSessionPageRequest{50, cursor});
    if (loaded.is_err()) {
        return Result<SessionSnapshot>::err(loaded.error());
    }
    auto& pg = loaded.value();
    return Result<SessionSnapshot>::ok(SessionSnapshot{
        std::move(pg.rows),
        std::move(pg.active),
        pg.navigation.snapshot.revision,
        std::move(cursor),
        std::move(pg.next_cursor),
    });
}

Result<SessionSnapshot> Sessions::execute(const SessionCommand& command) const {
    if (const auto* pg = std::get_if<SessionCommand::Page>(&command.payload)) {
        return page(pg->cursor);
    }

    std::optional<AgentSessionNavigationSave> selection;
    if (std::holds_alternative<SessionCommand::Refresh>(command.payload)) {
        // Refresh only
    } else if (const auto* cr = std::get_if<SessionCommand::Create>(&command.payload)) {
        auto created = create("New chat");
        if (created.is_err()) return Result<SessionSnapshot>::err(created.error());
        auto sel = select(created.value().id, cr->expected_revision);
        if (sel.is_err()) return Result<SessionSnapshot>::err(sel.error());
        selection = std::move(sel.value());
    } else if (const auto* sl = std::get_if<SessionCommand::Select>(&command.payload)) {
        auto sel = select(sl->id, sl->expected_revision);
        if (sel.is_err()) return Result<SessionSnapshot>::err(sel.error());
        selection = std::move(sel.value());
    } else if (const auto* up = std::get_if<SessionCommand::Update>(&command.payload)) {
        auto upd = update_settings(
            up->id, up->expected_revision, up->title, up->model, up->effort);
        if (upd.is_err()) return Result<SessionSnapshot>::err(upd.error());
    }

    if (selection.has_value() && selection->is_conflict()) {
        return Result<SessionSnapshot>::err(NativeError::make(
            "navigation_conflict",
            "Navigation changed. Refresh and select again; a newly created session remains in the session list."));
    }
    return snapshot();
}

Result<std::vector<AgentSessionSummary>> Sessions::list() const {
    return store_->list();
}

Result<AgentSessionNavigationLoad> Sessions::navigation() const {
    return store_->load_session_navigation();
}

Result<AgentSessionSummary> Sessions::summary(std::string_view id) const {
    return store_->summary(id);
}

Result<AgentSessionSummary> Sessions::create(std::string_view title) const {
    auto v = validate_metadata_text(title, "title", 256);
    if (v.is_err()) return Result<AgentSessionSummary>::err(v.error());
    auto ts = now_epoch_ms();
    if (ts.is_err()) return Result<AgentSessionSummary>::err(ts.error());

    AgentSessionSummary item;
    item.id = uuid_v4();
    item.title = std::string(title);
    item.scope = SessionScope::Projectless;
    item.cwd.clear();
    item.profile_id.clear();
    item.model.clear();
    item.permission_mode = PermissionMode::AskAll;
    item.settings_revision = 1;
    item.message_count = 0;
    item.created_at_ms = ts.value();
    item.updated_at_ms = ts.value();

    auto saved = store_->save_summary(item);
    if (saved.is_err()) return Result<AgentSessionSummary>::err(saved.error());
    return store_->summary(item.id);
}

Result<AgentSessionNavigationSave> Sessions::select(
    std::string_view id,
    int64_t expected_revision) const {
    auto current = navigation();
    if (current.is_err()) {
        return Result<AgentSessionNavigationSave>::err(current.error());
    }
    std::vector<std::string> ids = std::move(current.value().snapshot.open_ids);
    if (std::find(ids.begin(), ids.end(), id) == ids.end()) {
        ids.emplace_back(id);
    }
    return store_->save_session_navigation(SaveAgentSessionNavigationRequest{
        expected_revision,
        std::move(ids),
        std::string(id),
    });
}

Result<AgentSessionSummary> Sessions::update_settings(
    std::string_view id,
    uint64_t expected_revision,
    std::string_view title,
    std::string_view model,
    std::string_view effort) const {
    auto vt = validate_metadata_text(title, "title", 256);
    if (vt.is_err()) return Result<AgentSessionSummary>::err(vt.error());
    auto vm = validate_metadata_text(model, "model", 256);
    if (vm.is_err()) return Result<AgentSessionSummary>::err(vm.error());

    const bool known_effort = std::find(kEfforts.begin(), kEfforts.end(), effort) != kEfforts.end();
    if (!known_effort) {
        return Result<AgentSessionSummary>::err(NativeError::invalid(
            "effort",
            "must be a supported effort name; ultra requires a separate workflow policy"));
    }
    auto ts = now_epoch_ms();
    if (ts.is_err()) return Result<AgentSessionSummary>::err(ts.error());

    const std::string title_owned(title);
    const std::string model_owned(model);
    const std::string effort_owned(effort);
    const int64_t stamp = ts.value();

    return store_->update_summary_cas(id, expected_revision, [&](AgentSessionSummary& session) {
        session.title = title_owned;
        session.model = model_owned;
        session.reasoning_effort = effort_owned;
        session.updated_at_ms = stamp;
    });
}

// ---------------------------------------------------------------------------
// SessionWorker
// ---------------------------------------------------------------------------

SessionWorker::SessionWorker(SessionWorker&& other) noexcept
    : queue_(std::move(other.queue_)),
      cancelled_(std::move(other.cancelled_)),
      in_sqlite_(std::move(other.in_sqlite_)),
      thread_(std::move(other.thread_)) {}

SessionWorker& SessionWorker::operator=(SessionWorker&& other) noexcept {
    if (this != &other) {
        if (cancelled_) {
            cancelled_->store(true, std::memory_order_release);
        }
        if (queue_) {
            std::lock_guard<std::mutex> lock(queue_->mutex);
            queue_->cmd_cv.notify_all();
        }
        if (thread_.joinable()) {
            if (in_sqlite_ && !in_sqlite_->load(std::memory_order_acquire)) {
                thread_.join();
            } else {
                thread_.detach();
            }
        }
        queue_ = std::move(other.queue_);
        cancelled_ = std::move(other.cancelled_);
        in_sqlite_ = std::move(other.in_sqlite_);
        thread_ = std::move(other.thread_);
    }
    return *this;
}

SessionWorker::~SessionWorker() {
    if (cancelled_) {
        cancelled_->store(true, std::memory_order_release);
    }
    if (queue_) {
        std::lock_guard<std::mutex> lock(queue_->mutex);
        queue_->cmd_cv.notify_all();
    }
    if (thread_.joinable()) {
        if (in_sqlite_ && !in_sqlite_->load(std::memory_order_acquire)) {
            thread_.join();
        } else {
            thread_.detach();
        }
    }
}

void SessionWorker::stop_and_wait() {
    if (cancelled_) {
        cancelled_->store(true, std::memory_order_release);
    }
    if (queue_) {
        std::lock_guard<std::mutex> lock(queue_->mutex);
        queue_->cmd_cv.notify_all();
    }
    if (thread_.joinable()) {
        thread_.join();
    }
}

Result<std::unique_ptr<SessionWorker>> SessionWorker::start(
    const std::filesystem::path& database,
    std::function<void()> notify) {
    auto worker = std::unique_ptr<SessionWorker>(new SessionWorker());
    worker->queue_ = std::make_shared<SharedQueue>();
    worker->cancelled_ = std::make_shared<std::atomic<bool>>(false);
    worker->in_sqlite_ = std::make_shared<std::atomic<bool>>(true);

    auto q = worker->queue_;
    auto cancelled = worker->cancelled_;
    auto in_sqlite = worker->in_sqlite_;

    try {
        worker->thread_ = std::thread([q, cancelled, in_sqlite, database, notify = std::move(notify)]() {
            auto mark_dead = [&]() {
                std::lock_guard<std::mutex> lock(q->mutex);
                q->worker_alive = false;
                q->resp_cv.notify_all();
            };

            auto opened = Sessions::open(database);
            if (opened.is_err()) {
                {
                    std::lock_guard<std::mutex> lock(q->mutex);
                    if (q->responses.size() < 2) {
                        q->responses.push_back(Result<SessionSnapshot>::err(opened.error()));
                    }
                    q->worker_alive = false;
                    q->resp_cv.notify_all();
                }
                in_sqlite->store(false, std::memory_order_release);
                if (notify) notify();
                return;
            }

            Sessions service = std::move(opened.value());
            {
                auto initial = service.snapshot();
                std::lock_guard<std::mutex> lock(q->mutex);
                if (q->responses.size() < 2) {
                    q->responses.push_back(std::move(initial));
                }
                q->resp_cv.notify_all();
            }
            in_sqlite->store(false, std::memory_order_release);
            if (!cancelled->load(std::memory_order_acquire) && notify) {
                notify();
            }

            while (true) {
                SessionCommand cmd = SessionCommand::refresh();
                {
                    std::unique_lock<std::mutex> lock(q->mutex);
                    q->cmd_cv.wait(lock, [&]() {
                        return cancelled->load(std::memory_order_acquire) || !q->commands.empty();
                    });
                    if (cancelled->load(std::memory_order_acquire)) {
                        q->worker_alive = false;
                        q->resp_cv.notify_all();
                        return;
                    }
                    cmd = std::move(q->commands.front());
                    q->commands.pop_front();
                }

                in_sqlite->store(true, std::memory_order_release);
                auto result = service.execute(cmd);
                in_sqlite->store(false, std::memory_order_release);

                if (cancelled->load(std::memory_order_acquire)) {
                    mark_dead();
                    return;
                }
                {
                    std::lock_guard<std::mutex> lock(q->mutex);
                    if (q->responses.size() >= 2) {
                        q->worker_alive = false;
                        q->resp_cv.notify_all();
                        return;
                    }
                    q->responses.push_back(std::move(result));
                    q->resp_cv.notify_all();
                }
                if (notify) notify();
            }
        });
    } catch (...) {
        return Result<std::unique_ptr<SessionWorker>>::err(
            NativeError::make("session_worker_unavailable", "The session worker could not start"));
    }

    return Result<std::unique_ptr<SessionWorker>>::ok(std::move(worker));
}

std::unique_ptr<SessionWorker> SessionWorker::create_unbacked_for_queue_test(
    std::shared_ptr<std::atomic<bool>> external_cancelled) {
    auto worker = std::unique_ptr<SessionWorker>(new SessionWorker());
    worker->queue_ = std::make_shared<SharedQueue>();
    worker->cancelled_ = std::move(external_cancelled);
    worker->in_sqlite_ = std::make_shared<std::atomic<bool>>(false);
    return worker;
}

Result<void> SessionWorker::submit(SessionCommand command) {
    if (!queue_ || (cancelled_ && cancelled_->load(std::memory_order_acquire))) {
        return Result<void>::err(NativeError::make(
            "session_worker_busy",
            "Session worker is busy or stopped; no automatic retry"));
    }
    std::lock_guard<std::mutex> lock(queue_->mutex);
    if (!queue_->worker_alive || queue_->commands.size() >= 1) {
        return Result<void>::err(NativeError::make(
            "session_worker_busy",
            "Session worker is busy or stopped; no automatic retry"));
    }
    queue_->commands.push_back(std::move(command));
    queue_->cmd_cv.notify_one();
    return Result<void>::ok();
}

std::optional<Result<SessionSnapshot>> SessionWorker::poll() {
    if (!queue_) {
        return Result<SessionSnapshot>::err(NativeError::make(
            "session_worker_stopped",
            "Session worker stopped; reopen storage explicitly"));
    }
    std::lock_guard<std::mutex> lock(queue_->mutex);
    if (!queue_->responses.empty()) {
        auto front = std::move(queue_->responses.front());
        queue_->responses.pop_front();
        return front;
    }
    if (!queue_->worker_alive) {
        return Result<SessionSnapshot>::err(NativeError::make(
            "session_worker_stopped",
            "Session worker stopped; reopen storage explicitly"));
    }
    return std::nullopt;
}

std::optional<Result<SessionSnapshot>> SessionWorker::wait_response(
    std::chrono::milliseconds timeout) {
    if (!queue_) return std::nullopt;
    std::unique_lock<std::mutex> lock(queue_->mutex);
    const bool ready = queue_->resp_cv.wait_for(lock, timeout, [&]() {
        return !queue_->responses.empty() || !queue_->worker_alive;
    });
    if (!ready) return std::nullopt;
    if (!queue_->responses.empty()) {
        auto front = std::move(queue_->responses.front());
        queue_->responses.pop_front();
        return front;
    }
    return Result<SessionSnapshot>::err(NativeError::make(
        "session_worker_stopped",
        "Session worker stopped; reopen storage explicitly"));
}

} // namespace omnia::native
