#pragma once

#include "omnia_native/types.hpp"

#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

struct sqlite3;

namespace omnia::native {

// ---------------------------------------------------------------------------
// Kernel-Backed StoreOwnership (Win32 CreateFileW + LockFileEx at 2^63 - 2)
// ---------------------------------------------------------------------------

class StoreOwnership {
public:
    StoreOwnership() = default;
    ~StoreOwnership();

    StoreOwnership(const StoreOwnership&) = delete;
    StoreOwnership& operator=(const StoreOwnership&) = delete;
    StoreOwnership(StoreOwnership&& other) noexcept;
    StoreOwnership& operator=(StoreOwnership&& other) noexcept;

    static Result<StoreOwnership> acquire(const std::filesystem::path& path);
    void release() noexcept;

private:
    explicit StoreOwnership(void* handle) noexcept : handle_(handle) {}
    void* handle_{reinterpret_cast<void*>(static_cast<intptr_t>(-1))};
};

// ---------------------------------------------------------------------------
// RAII WinSQLite3 Wrapper & Transactions
// ---------------------------------------------------------------------------

enum class SqliteTxBehavior : uint8_t {
    Deferred = 0,
    Immediate = 1,
};

class SqliteConnection {
public:
    SqliteConnection() = default;
    ~SqliteConnection();

    SqliteConnection(const SqliteConnection&) = delete;
    SqliteConnection& operator=(const SqliteConnection&) = delete;
    SqliteConnection(SqliteConnection&& other) noexcept;
    SqliteConnection& operator=(SqliteConnection&& other) noexcept;

    static Result<SqliteConnection> open_read_write(const std::filesystem::path& path);
    static Result<SqliteConnection> open_read_only(const std::filesystem::path& path);
    static Result<SqliteConnection> open_in_memory();

    sqlite3* raw() const noexcept { return db_; }
    bool is_autocommit() const noexcept;
    Result<void> exec_batch(std::string_view sql) const;
    void close() noexcept;

private:
    explicit SqliteConnection(sqlite3* db) noexcept : db_(db) {}
    sqlite3* db_{nullptr};
};

class SqliteTransaction {
public:
    SqliteTransaction(const SqliteConnection& conn, SqliteTxBehavior behavior, bool& ok_out, NativeError& err_out);
    ~SqliteTransaction();

    SqliteTransaction(const SqliteTransaction&) = delete;
    SqliteTransaction& operator=(const SqliteTransaction&) = delete;

    const SqliteConnection& connection() const noexcept { return conn_; }
    Result<void> commit();
    Result<void> rollback();

private:
    const SqliteConnection& conn_;
    bool active_{false};
};

// ---------------------------------------------------------------------------
// Canonical HarnessStore
// ---------------------------------------------------------------------------

struct StoredAgentEvent {
    int64_t sequence{0};
    JsonValue event;
};

struct RunReplay {
    std::string status{"idle"};
    std::vector<StoredAgentEvent> events;
    int64_t event_cursor{0};
};

struct WireBlock {
    enum class Kind : uint8_t { Text = 0, Image = 1 };
    Kind kind{Kind::Text};
    std::string text;
    std::string media_type;
    std::string data;

    bool operator==(const WireBlock&) const = default;

    static WireBlock make_text(std::string t) {
        return WireBlock{Kind::Text, std::move(t), {}, {}};
    }

    static WireBlock make_image(std::string mime, std::string b64) {
        return WireBlock{Kind::Image, {}, std::move(mime), std::move(b64)};
    }

    JsonValue to_json() const;
    static Result<WireBlock> from_json(const JsonValue& v);
};

struct WireMessage {
    std::string role{"user"};
    std::vector<WireBlock> content;

    bool operator==(const WireMessage&) const = default;

    JsonValue to_json() const;
    static Result<WireMessage> from_json(const JsonValue& v);
};

class HarnessStore {
public:
    HarnessStore() = delete;
    ~HarnessStore();

    HarnessStore(const HarnessStore&) = delete;
    HarnessStore& operator=(const HarnessStore&) = delete;

    static Result<std::shared_ptr<HarnessStore>> open(const std::filesystem::path& path);
    static Result<std::shared_ptr<HarnessStore>> in_memory();

    Result<void> save_summary(const AgentSessionSummary& summary);
    Result<AgentSessionSummary> summary(std::string_view id);
    Result<std::vector<AgentSessionSummary>> list();
    Result<void> delete_session(std::string_view id);

    Result<AgentSessionSummary> update_summary(
        std::string_view id,
        const std::function<void(AgentSessionSummary&)>& mutator);

    Result<AgentSessionSummary> update_summary_cas(
        std::string_view id,
        std::optional<uint64_t> expected_revision,
        const std::function<void(AgentSessionSummary&)>& mutator);

    Result<AgentSessionNavigationLoad> load_session_navigation();
    Result<AgentSessionNavigationSave> save_session_navigation(
        const SaveAgentSessionNavigationRequest& request);
    Result<AgentSessionPage> session_page(const AgentSessionPageRequest& request);

    Result<void> save_messages(std::string_view session_id, const std::vector<WireMessage>& msgs);
    Result<std::vector<WireMessage>> messages(std::string_view session_id);

    Result<StoredAgentEvent> publish_event(
        std::string_view session_id,
        const JsonValue& event,
        const std::function<bool(const StoredAgentEvent&)>& on_committed);

    Result<RunReplay> replay(std::string_view session_id);

private:
    HarnessStore(SqliteConnection conn, std::optional<StoreOwnership> ownership);
    Result<void> bootstrap_schema();

    // Note: connection_ is destroyed BEFORE ownership_ in ~HarnessStore()
    // because C++ destroys members in reverse order of declaration:
    // put ownership_ FIRST so connection_ is destroyed FIRST!
    std::optional<StoreOwnership> ownership_;
    SqliteConnection connection_;
    mutable std::mutex mutex_;
};

// ---------------------------------------------------------------------------
// Shared Provider Profile, Secret Broker, Routing & Execution Consumer APIs
// ---------------------------------------------------------------------------

enum class CredentialStatus : uint8_t {
    Missing = 0,
    Present = 1,
};

struct ProviderProfileRecord {
    std::string id;
    std::string profile_id;
    std::string provider_type;
    std::string display_name;
    std::string normalized_base_url;
    std::string auth_scheme;
    std::optional<std::string> organization_id;
    std::optional<std::string> remote_project_id;
    CredentialStatus credential_status{CredentialStatus::Missing};
    bool enabled{true};
    int64_t created_at_ms{0};
    int64_t updated_at_ms{0};

    std::string to_redacted_json() const;
};

struct ProviderCredentialSnapshot {
    ProviderProfileRecord profile;
    std::optional<std::string> credential_ref;
};

class ProviderProfileRepository {
public:
    ProviderProfileRepository(const SqliteConnection& conn, std::string app_profile_id);

    Result<std::vector<ProviderProfileRecord>> list() const;
    Result<ProviderProfileRecord> get(std::string_view id) const;
    Result<ProviderProfileRecord> active(std::string_view id) const;
    Result<ProviderCredentialSnapshot> credential_snapshot(std::string_view id) const;
    Result<std::optional<std::string>> credential_ref(std::string_view id) const;

private:
    const SqliteConnection& conn_;
    std::string app_profile_id_;
};

enum class SecretPurpose : uint8_t {
    ProviderCredential = 0,
};

class SecretBroker {
public:
    Result<void> with_secret(
        SecretPurpose purpose,
        std::string_view reference,
        const std::function<Result<void>(std::string_view)>& callback) const;

    Result<std::string> put(SecretPurpose purpose, std::string secret) const;
};

enum class AdapterFamily : uint8_t {
    OpenAiChat = 0,
    OpenAiResponses = 1,
    AnthropicMessages = 2,
};

enum class AuthScheme : uint8_t {
    None = 0,
    Bearer = 1,
    ApiKeyHeader = 2,
};

struct ProviderProfileInput {
    std::string provider_type;
    std::string base_url;
    std::string auth_scheme;
    std::optional<std::string> organization;
    std::optional<std::string> project;
    bool enabled{true};
    bool local_network_grant{false};
};

struct ProviderSelection {
    AdapterFamily family{AdapterFamily::OpenAiChat};
    AuthScheme auth{AuthScheme::Bearer};
    std::optional<std::string> organization;
    std::optional<std::string> project;
};

struct ConfiguredProvider {
    ProviderSelection selection;
    std::string base_url;
};

Result<ProviderSelection> provider_selection(const ProviderProfileInput& input);
Result<ConfiguredProvider> build_provider(
    const ProviderProfileInput& input,
    std::optional<std::string_view> secret);

// ---------------------------------------------------------------------------
// Run Admission, Event Publication & Prepared HTTP SSE Run Execution
// ---------------------------------------------------------------------------

class CancellationToken {
public:
    void cancel() noexcept { cancelled_->store(true, std::memory_order_release); }
    bool is_cancelled() const noexcept { return cancelled_->load(std::memory_order_acquire); }

private:
    std::shared_ptr<std::atomic<bool>> cancelled_{std::make_shared<std::atomic<bool>>(false)};
};

struct RunTicket {
    std::string session_id;
    uint64_t token{0};
};

class RunRegistry {
public:
    Result<RunTicket> insert(std::string_view session_id);
    Result<bool> remove_current(const RunTicket& ticket);
    Result<bool> is_empty() const;

private:
    mutable std::mutex mutex_;
    std::map<std::string, uint64_t, std::less<>> active_;
    uint64_t next_token_{1};
};

struct AdmittedRun {
    RunTicket ticket;
    std::vector<WireMessage> history;
};

class RunCoordinator {
public:
    explicit RunCoordinator(std::shared_ptr<HarnessStore> store);

    const std::shared_ptr<HarnessStore>& store() const noexcept { return store_; }
    RunRegistry& runs() noexcept { return runs_; }
    Result<AdmittedRun> admit(std::string_view session_id);

private:
    std::shared_ptr<HarnessStore> store_;
    RunRegistry runs_;
};

struct ApprovalRequest {
    std::string tool_use_id;
    std::string tool;
    JsonValue input;
    std::string summary;
    uint32_t ordinal{1};
    uint32_t total{1};
};

struct AgentEvent {
    enum class Kind : uint8_t {
        TurnStarted = 0,
        PlanPresented = 1,
        ApprovalRequested = 2,
        Subagent = 3,
        StreamDelta = 4,
        StreamUsage = 5,
    };

    Kind kind{Kind::TurnStarted};
    uint32_t turn{0};
    std::string id;
    std::string plan;
    ApprovalRequest approval;
    std::string parent_id;
    std::shared_ptr<AgentEvent> nested;
    std::string delta_text;
    uint64_t prompt_tokens{0};
    uint64_t completion_tokens{0};

    static AgentEvent turn_started(uint32_t t);
    static AgentEvent plan_presented(std::string id_val, std::string plan_val);
    static AgentEvent approval_requested(ApprovalRequest req);
    static AgentEvent subagent(std::string parent, AgentEvent inner);
    static AgentEvent stream_delta(std::string text);
    static AgentEvent stream_usage(uint64_t prompt, uint64_t completion);

    JsonValue to_json() const;
};

struct RunEventState {
    std::atomic<uint64_t> run_tokens{0};
    std::atomic<bool> plan_presented{false};
    mutable std::mutex persistence_error_mutex;
    std::optional<std::string> persistence_error;
};

Result<bool> publish_run_event(
    const AgentEvent& event,
    RunEventState& state,
    CancellationToken& cancel,
    const std::function<bool(std::string_view)>& approval_ready,
    const std::function<Result<void>(const JsonValue&)>& publish);

struct PreparedSessionConfig {
    std::string model;
    std::optional<std::string> reasoning_effort;
    std::filesystem::path cwd;
    double compact_threshold{0.85};
    uint32_t max_retries{2};
};

PreparedSessionConfig prepare_session_config(
    const AgentSessionSummary& summary,
    const std::filesystem::path& workspace_root);

Result<JsonValue> execute_prepared_http_run(
    const std::shared_ptr<HarnessStore>& store,
    std::string_view session_id,
    const ConfiguredProvider& provider,
    const PreparedSessionConfig& config,
    CancellationToken& cancel,
    std::vector<WireMessage>& history,
    const std::vector<WireBlock>& user_content,
    std::string_view prompt_text,
    RunEventState& event_state,
    const std::function<void(const AgentEvent&)>& on_event);

} // namespace omnia::native
