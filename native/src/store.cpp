#include "omnia_native/store.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winsqlite/winsqlite3.h>

#include <algorithm>
#include <charconv>
#include <cstring>
#include <set>

namespace omnia::native {

namespace {

NativeError ownership_failed() {
    return NativeError::make(
        "harness_store_ownership_failed",
        "Exclusive agent session storage ownership could not be established");
}

NativeError classify_win32_ownership_error(DWORD code) {
    if (code == ERROR_LOCK_VIOLATION || code == ERROR_SHARING_VIOLATION) {
        return NativeError::retryable_err(
            "harness_store_busy",
            "Agent session storage is already owned by another store");
    }
    return ownership_failed();
}

NativeError storage_error(std::string_view detail) {
    return NativeError::make(
        "harness_storage_failed",
        "Agent session storage failed: " + std::string(detail));
}

NativeError sqlite_error(sqlite3* db) {
    const char* msg = db ? sqlite3_errmsg(db) : "sqlite error";
    return storage_error(msg ? msg : "sqlite error");
}

class SqliteStmt {
public:
    SqliteStmt() = default;
    ~SqliteStmt() {
        if (stmt_) {
            sqlite3_finalize(stmt_);
        }
    }

    SqliteStmt(const SqliteStmt&) = delete;
    SqliteStmt& operator=(const SqliteStmt&) = delete;

    static Result<SqliteStmt> prepare(sqlite3* db, std::string_view sql) {
        sqlite3_stmt* raw = nullptr;
        const int rc = sqlite3_prepare_v2(
            db, sql.data(), static_cast<int>(sql.size()), &raw, nullptr);
        if (rc != SQLITE_OK || !raw) {
            if (raw) sqlite3_finalize(raw);
            return Result<SqliteStmt>::err(sqlite_error(db));
        }
        SqliteStmt out;
        out.stmt_ = raw;
        return Result<SqliteStmt>::ok(std::move(out));
    }

    SqliteStmt(SqliteStmt&& other) noexcept : stmt_(other.stmt_) {
        other.stmt_ = nullptr;
    }

    SqliteStmt& operator=(SqliteStmt&& other) noexcept {
        if (this != &other) {
            if (stmt_) sqlite3_finalize(stmt_);
            stmt_ = other.stmt_;
            other.stmt_ = nullptr;
        }
        return *this;
    }

    sqlite3_stmt* raw() const noexcept { return stmt_; }

    void bind_text(int idx, std::string_view val) const {
        sqlite3_bind_text(
            stmt_,
            idx,
            val.empty() ? "" : val.data(),
            static_cast<int>(val.size()),
            SQLITE_TRANSIENT);
    }

    void bind_int64(int idx, int64_t val) const {
        sqlite3_bind_int64(stmt_, idx, val);
    }

    std::string col_text(int col) const {
        const unsigned char* txt = sqlite3_column_text(stmt_, col);
        const int bytes = sqlite3_column_bytes(stmt_, col);
        if (!txt || bytes <= 0) return {};
        return std::string(reinterpret_cast<const char*>(txt), static_cast<size_t>(bytes));
    }

    std::optional<std::string> col_opt_text(int col) const {
        if (sqlite3_column_type(stmt_, col) == SQLITE_NULL) {
            return std::nullopt;
        }
        return col_text(col);
    }

    int64_t col_int64(int col) const {
        return sqlite3_column_int64(stmt_, col);
    }

private:
    sqlite3_stmt* stmt_{nullptr};
};

} // namespace

// ---------------------------------------------------------------------------
// StoreOwnership
// ---------------------------------------------------------------------------

StoreOwnership::~StoreOwnership() {
    release();
}

StoreOwnership::StoreOwnership(StoreOwnership&& other) noexcept : handle_(other.handle_) {
    other.handle_ = INVALID_HANDLE_VALUE;
}

StoreOwnership& StoreOwnership::operator=(StoreOwnership&& other) noexcept {
    if (this != &other) {
        release();
        handle_ = other.handle_;
        other.handle_ = INVALID_HANDLE_VALUE;
    }
    return *this;
}

void StoreOwnership::release() noexcept {
    if (handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr) {
        CloseHandle(static_cast<HANDLE>(handle_));
        handle_ = INVALID_HANDLE_VALUE;
    }
}

Result<StoreOwnership> StoreOwnership::acquire(const std::filesystem::path& path) {
    const std::wstring wpath = path.wstring();
    HANDLE h = CreateFileW(
        wpath.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        return Result<StoreOwnership>::err(classify_win32_ownership_error(GetLastError()));
    }

    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(h, &info) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        CloseHandle(h);
        return Result<StoreOwnership>::err(ownership_failed());
    }

    constexpr uint64_t kLockOffset = 0x7fff'ffff'ffff'fffeULL;
    OVERLAPPED overlapped{};
    overlapped.Offset = static_cast<DWORD>(kLockOffset & 0xFFFF'FFFFULL);
    overlapped.OffsetHigh = static_cast<DWORD>((kLockOffset >> 32) & 0xFFFF'FFFFULL);
    if (!LockFileEx(
            h,
            LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
            0,
            1,
            0,
            &overlapped)) {
        const DWORD err = GetLastError();
        CloseHandle(h);
        return Result<StoreOwnership>::err(classify_win32_ownership_error(err));
    }

    return Result<StoreOwnership>::ok(StoreOwnership(h));
}

// ---------------------------------------------------------------------------
// SqliteConnection & SqliteTransaction
// ---------------------------------------------------------------------------

SqliteConnection::~SqliteConnection() {
    close();
}

SqliteConnection::SqliteConnection(SqliteConnection&& other) noexcept : db_(other.db_) {
    other.db_ = nullptr;
}

SqliteConnection& SqliteConnection::operator=(SqliteConnection&& other) noexcept {
    if (this != &other) {
        close();
        db_ = other.db_;
        other.db_ = nullptr;
    }
    return *this;
}

void SqliteConnection::close() noexcept {
    if (db_) {
        sqlite3_close_v2(db_);
        db_ = nullptr;
    }
}

Result<SqliteConnection> SqliteConnection::open_read_write(const std::filesystem::path& path) {
    const std::string utf8_path = wide_to_utf8(path.wstring());
    sqlite3* raw = nullptr;
    const int rc = sqlite3_open_v2(
        utf8_path.c_str(),
        &raw,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nullptr);
    if (rc != SQLITE_OK || !raw) {
        NativeError err = sqlite_error(raw);
        if (raw) sqlite3_close_v2(raw);
        return Result<SqliteConnection>::err(std::move(err));
    }
    sqlite3_busy_timeout(raw, 5000);
    return Result<SqliteConnection>::ok(SqliteConnection(raw));
}

Result<SqliteConnection> SqliteConnection::open_read_only(const std::filesystem::path& path) {
    const std::string utf8_path = wide_to_utf8(path.wstring());
    sqlite3* raw = nullptr;
    const int rc = sqlite3_open_v2(
        utf8_path.c_str(),
        &raw,
        SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
        nullptr);
    if (rc != SQLITE_OK || !raw) {
        NativeError err = sqlite_error(raw);
        if (raw) sqlite3_close_v2(raw);
        return Result<SqliteConnection>::err(std::move(err));
    }
    return Result<SqliteConnection>::ok(SqliteConnection(raw));
}

Result<SqliteConnection> SqliteConnection::open_in_memory() {
    sqlite3* raw = nullptr;
    const int rc = sqlite3_open_v2(
        ":memory:",
        &raw,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_MEMORY | SQLITE_OPEN_FULLMUTEX,
        nullptr);
    if (rc != SQLITE_OK || !raw) {
        NativeError err = sqlite_error(raw);
        if (raw) sqlite3_close_v2(raw);
        return Result<SqliteConnection>::err(std::move(err));
    }
    sqlite3_busy_timeout(raw, 5000);
    return Result<SqliteConnection>::ok(SqliteConnection(raw));
}

bool SqliteConnection::is_autocommit() const noexcept {
    return db_ ? (sqlite3_get_autocommit(db_) != 0) : true;
}

Result<void> SqliteConnection::exec_batch(std::string_view sql) const {
    if (!db_) {
        return Result<void>::err(storage_error("database closed"));
    }
    std::string owned(sql);
    char* errmsg = nullptr;
    const int rc = sqlite3_exec(db_, owned.c_str(), nullptr, nullptr, &errmsg);
    if (rc != SQLITE_OK) {
        std::string msg = errmsg ? errmsg : sqlite3_errmsg(db_);
        if (errmsg) sqlite3_free(errmsg);
        return Result<void>::err(storage_error(msg));
    }
    return Result<void>::ok();
}

SqliteTransaction::SqliteTransaction(
    const SqliteConnection& conn,
    SqliteTxBehavior behavior,
    bool& ok_out,
    NativeError& err_out)
    : conn_(conn) {
    const std::string_view begin_sql =
        (behavior == SqliteTxBehavior::Immediate) ? "BEGIN IMMEDIATE;" : "BEGIN DEFERRED;";
    auto res = conn_.exec_batch(begin_sql);
    if (res.is_err()) {
        ok_out = false;
        err_out = res.error();
    } else {
        active_ = true;
        ok_out = true;
    }
}

SqliteTransaction::~SqliteTransaction() {
    if (active_) {
        (void)conn_.exec_batch("ROLLBACK;");
        active_ = false;
    }
}

Result<void> SqliteTransaction::commit() {
    if (!active_) {
        return Result<void>::err(storage_error("transaction not active"));
    }
    auto res = conn_.exec_batch("COMMIT;");
    if (res.is_ok()) {
        active_ = false;
    }
    return res;
}

Result<void> SqliteTransaction::rollback() {
    if (!active_) {
        return Result<void>::ok();
    }
    active_ = false;
    return conn_.exec_batch("ROLLBACK;");
}

// ---------------------------------------------------------------------------
// WireBlock & WireMessage
// ---------------------------------------------------------------------------

JsonValue WireBlock::to_json() const {
    JsonValue::Object obj;
    if (kind == Kind::Image) {
        obj["type"] = JsonValue("image");
        obj["mediaType"] = JsonValue(media_type);
        obj["data"] = JsonValue(data);
    } else {
        obj["type"] = JsonValue("text");
        obj["text"] = JsonValue(text);
    }
    return JsonValue(std::move(obj));
}

Result<WireBlock> WireBlock::from_json(const JsonValue& v) {
    const auto* t = v.find("type");
    if (t && t->as_string_view() == "image") {
        return Result<WireBlock>::ok(WireBlock::make_image(
            v.find("mediaType") ? v.find("mediaType")->as_string() : "",
            v.find("data") ? v.find("data")->as_string() : ""));
    }
    return Result<WireBlock>::ok(WireBlock::make_text(
        v.find("text") ? v.find("text")->as_string() : ""));
}

JsonValue WireMessage::to_json() const {
    JsonValue::Object obj;
    obj["role"] = JsonValue(role);
    JsonValue::Array arr;
    for (const auto& b : content) {
        arr.push_back(b.to_json());
    }
    obj["content"] = JsonValue(std::move(arr));
    return JsonValue(std::move(obj));
}

Result<WireMessage> WireMessage::from_json(const JsonValue& v) {
    WireMessage msg;
    if (const auto* r = v.find("role"); r && r->is_string()) {
        msg.role = r->as_string();
    }
    if (const auto* c = v.find("content"); c && c->is_array()) {
        for (const auto& item : *c->as_array_ptr()) {
            auto blk = WireBlock::from_json(item);
            if (blk.is_err()) return Result<WireMessage>::err(blk.error());
            msg.content.push_back(std::move(blk.value()));
        }
    }
    return Result<WireMessage>::ok(std::move(msg));
}

// ---------------------------------------------------------------------------
// HarnessStore
// ---------------------------------------------------------------------------

HarnessStore::HarnessStore(SqliteConnection conn, std::optional<StoreOwnership> ownership)
    : ownership_(std::move(ownership)), connection_(std::move(conn)) {}

HarnessStore::~HarnessStore() = default;

Result<std::shared_ptr<HarnessStore>> HarnessStore::open(const std::filesystem::path& path) {
    auto ownership = StoreOwnership::acquire(path);
    if (ownership.is_err()) {
        return Result<std::shared_ptr<HarnessStore>>::err(ownership.error());
    }
    auto conn = SqliteConnection::open_read_write(path);
    if (conn.is_err()) {
        return Result<std::shared_ptr<HarnessStore>>::err(conn.error());
    }
    auto ptr = std::shared_ptr<HarnessStore>(
        new HarnessStore(std::move(conn.value()), std::move(ownership.value())));
    auto boot = ptr->bootstrap_schema();
    if (boot.is_err()) {
        return Result<std::shared_ptr<HarnessStore>>::err(boot.error());
    }
    return Result<std::shared_ptr<HarnessStore>>::ok(std::move(ptr));
}

Result<std::shared_ptr<HarnessStore>> HarnessStore::in_memory() {
    auto conn = SqliteConnection::open_in_memory();
    if (conn.is_err()) {
        return Result<std::shared_ptr<HarnessStore>>::err(conn.error());
    }
    auto ptr = std::shared_ptr<HarnessStore>(
        new HarnessStore(std::move(conn.value()), std::nullopt));
    auto boot = ptr->bootstrap_schema();
    if (boot.is_err()) {
        return Result<std::shared_ptr<HarnessStore>>::err(boot.error());
    }
    return Result<std::shared_ptr<HarnessStore>>::ok(std::move(ptr));
}

Result<void> HarnessStore::bootstrap_schema() {
    static constexpr std::string_view kSchema = R"SQL(
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    summary_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_page_order
  ON agent_sessions(updated_at_ms DESC, id ASC);
CREATE TABLE IF NOT EXISTS agent_messages (
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    message_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_deleted (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS agent_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    event_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_run_state (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    snapshot_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_trust (
    cwd TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_navigation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision > 0),
    snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_navigation_receipts (
    receipt_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL UNIQUE CHECK(revision > 0),
    snapshot_json TEXT NOT NULL
);
INSERT OR IGNORE INTO agent_session_navigation_receipts
    (receipt_id, revision, snapshot_json)
SELECT 'session_navigation_legacy_' || revision, revision, snapshot_json
  FROM agent_session_navigation
 WHERE singleton = 1 AND revision > 0;
UPDATE agent_run_state SET status = 'interrupted' WHERE status = 'running';
)SQL";
    return connection_.exec_batch(kSchema);
}

static Result<bool> query_exists(sqlite3* db, std::string_view sql, std::string_view id) {
    auto st = SqliteStmt::prepare(db, sql);
    if (st.is_err()) return Result<bool>::err(st.error());
    st.value().bind_text(1, id);
    const int rc = sqlite3_step(st.value().raw());
    if (rc == SQLITE_ROW) {
        return Result<bool>::ok(sqlite3_column_int(st.value().raw(), 0) != 0);
    }
    if (rc == SQLITE_DONE) {
        return Result<bool>::ok(false);
    }
    return Result<bool>::err(sqlite_error(db));
}

Result<void> HarnessStore::save_summary(const AgentSessionSummary& summary_val) {
    const std::string json = summary_val.to_json();
    std::lock_guard<std::mutex> lock(mutex_);
    auto del = query_exists(
        connection_.raw(),
        "SELECT EXISTS(SELECT 1 FROM agent_deleted WHERE id = ?1)",
        summary_val.id);
    if (del.is_err()) return Result<void>::err(del.error());
    if (del.value()) {
        return Result<void>::err(storage_error("session was deleted"));
    }
    auto st = SqliteStmt::prepare(
        connection_.raw(),
        "INSERT INTO agent_sessions (id, summary_json, updated_at_ms) VALUES (?1, ?2, ?3) "
        "ON CONFLICT(id) DO UPDATE SET summary_json = excluded.summary_json, "
        "updated_at_ms = excluded.updated_at_ms");
    if (st.is_err()) return Result<void>::err(st.error());
    st.value().bind_text(1, summary_val.id);
    st.value().bind_text(2, json);
    st.value().bind_int64(3, summary_val.updated_at_ms);
    if (sqlite3_step(st.value().raw()) != SQLITE_DONE) {
        return Result<void>::err(sqlite_error(connection_.raw()));
    }
    return Result<void>::ok();
}

Result<AgentSessionSummary> HarnessStore::summary(std::string_view id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto st = SqliteStmt::prepare(
        connection_.raw(),
        "SELECT summary_json FROM agent_sessions WHERE id = ?1");
    if (st.is_err()) return Result<AgentSessionSummary>::err(st.error());
    st.value().bind_text(1, id);
    const int rc = sqlite3_step(st.value().raw());
    if (rc == SQLITE_DONE) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("agent_session_not_found", "The agent session does not exist"));
    }
    if (rc != SQLITE_ROW) {
        return Result<AgentSessionSummary>::err(sqlite_error(connection_.raw()));
    }
    auto parsed = AgentSessionSummary::from_json(st.value().col_text(0));
    if (parsed.is_err()) {
        return Result<AgentSessionSummary>::err(storage_error(parsed.error().message));
    }
    return parsed;
}

Result<std::vector<AgentSessionSummary>> HarnessStore::list() {
    std::lock_guard<std::mutex> lock(mutex_);
    auto st = SqliteStmt::prepare(
        connection_.raw(),
        "SELECT summary_json FROM agent_sessions ORDER BY updated_at_ms DESC, id ASC");
    if (st.is_err()) return Result<std::vector<AgentSessionSummary>>::err(st.error());
    std::vector<AgentSessionSummary> out;
    while (true) {
        const int rc = sqlite3_step(st.value().raw());
        if (rc == SQLITE_DONE) break;
        if (rc != SQLITE_ROW) {
            return Result<std::vector<AgentSessionSummary>>::err(sqlite_error(connection_.raw()));
        }
        auto parsed = AgentSessionSummary::from_json(st.value().col_text(0));
        if (parsed.is_err()) {
            return Result<std::vector<AgentSessionSummary>>::err(storage_error(parsed.error().message));
        }
        out.push_back(std::move(parsed.value()));
    }
    return Result<std::vector<AgentSessionSummary>>::ok(std::move(out));
}

Result<void> HarnessStore::delete_session(std::string_view id) {
    std::lock_guard<std::mutex> lock(mutex_);
    bool tx_ok = false;
    NativeError tx_err;
    SqliteTransaction tx(connection_, SqliteTxBehavior::Immediate, tx_ok, tx_err);
    if (!tx_ok) return Result<void>::err(tx_err);

    auto s1 = SqliteStmt::prepare(
        connection_.raw(),
        "INSERT OR IGNORE INTO agent_deleted (id) VALUES (?1)");
    if (s1.is_err()) return Result<void>::err(s1.error());
    s1.value().bind_text(1, id);
    if (sqlite3_step(s1.value().raw()) != SQLITE_DONE) {
        return Result<void>::err(sqlite_error(connection_.raw()));
    }

    auto s2 = SqliteStmt::prepare(
        connection_.raw(),
        "DELETE FROM agent_sessions WHERE id = ?1");
    if (s2.is_err()) return Result<void>::err(s2.error());
    s2.value().bind_text(1, id);
    if (sqlite3_step(s2.value().raw()) != SQLITE_DONE) {
        return Result<void>::err(sqlite_error(connection_.raw()));
    }

    return tx.commit();
}

Result<AgentSessionSummary> HarnessStore::update_summary(
    std::string_view id,
    const std::function<void(AgentSessionSummary&)>& mutator) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto sel = SqliteStmt::prepare(
        connection_.raw(),
        "SELECT summary_json FROM agent_sessions WHERE id = ?1");
    if (sel.is_err()) return Result<AgentSessionSummary>::err(sel.error());
    sel.value().bind_text(1, id);
    if (sqlite3_step(sel.value().raw()) != SQLITE_ROW) {
        return Result<AgentSessionSummary>::err(storage_error("session not found"));
    }
    auto parsed = AgentSessionSummary::from_json(sel.value().col_text(0));
    if (parsed.is_err()) return Result<AgentSessionSummary>::err(storage_error(parsed.error().message));
    AgentSessionSummary item = std::move(parsed.value());
    mutator(item);

    auto upd = SqliteStmt::prepare(
        connection_.raw(),
        "UPDATE agent_sessions SET summary_json = ?2, updated_at_ms = ?3 WHERE id = ?1");
    if (upd.is_err()) return Result<AgentSessionSummary>::err(upd.error());
    upd.value().bind_text(1, id);
    upd.value().bind_text(2, item.to_json());
    upd.value().bind_int64(3, item.updated_at_ms);
    if (sqlite3_step(upd.value().raw()) != SQLITE_DONE) {
        return Result<AgentSessionSummary>::err(sqlite_error(connection_.raw()));
    }
    return Result<AgentSessionSummary>::ok(std::move(item));
}

Result<AgentSessionSummary> HarnessStore::update_summary_cas(
    std::string_view id,
    std::optional<uint64_t> expected_revision,
    const std::function<void(AgentSessionSummary&)>& mutator) {
    if (expected_revision.has_value() && *expected_revision == 0) {
        return Result<AgentSessionSummary>::err(
            NativeError::invalid("expectedSettingsRevision", "must be a positive integer"));
    }
    std::lock_guard<std::mutex> lock(mutex_);
    bool tx_ok = false;
    NativeError tx_err;
    SqliteTransaction tx(connection_, SqliteTxBehavior::Immediate, tx_ok, tx_err);
    if (!tx_ok) return Result<AgentSessionSummary>::err(tx_err);

    auto sel = SqliteStmt::prepare(
        connection_.raw(),
        "SELECT summary_json FROM agent_sessions WHERE id = ?1");
    if (sel.is_err()) return Result<AgentSessionSummary>::err(sel.error());
    sel.value().bind_text(1, id);
    const int rc = sqlite3_step(sel.value().raw());
    if (rc == SQLITE_DONE) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("agent_session_not_found", "The agent session does not exist"));
    }
    if (rc != SQLITE_ROW) {
        return Result<AgentSessionSummary>::err(sqlite_error(connection_.raw()));
    }
    auto parsed = AgentSessionSummary::from_json(sel.value().col_text(0));
    if (parsed.is_err()) {
        return Result<AgentSessionSummary>::err(storage_error(parsed.error().message));
    }
    AgentSessionSummary item = std::move(parsed.value());
    const uint64_t current_rev = item.settings_revision;
    if (current_rev == 0) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("agent_session_revision_invalid", "The stored session settings revision is invalid"));
    }
    if (expected_revision.has_value() && *expected_revision != current_rev) {
        return Result<AgentSessionSummary>::err(NativeError::retryable_err(
            "agent_session_revision_conflict",
            "Session settings changed elsewhere (expected revision " +
                std::to_string(*expected_revision) + ", current revision " +
                std::to_string(current_rev) + ")"));
    }
    constexpr uint64_t kMaxSafeJsInt = 9'007'199'254'740'991ULL;
    if (current_rev >= kMaxSafeJsInt) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("agent_session_revision_exhausted", "Session settings revision exceeds the supported range"));
    }
    mutator(item);
    item.settings_revision = current_rev + 1;

    auto upd = SqliteStmt::prepare(
        connection_.raw(),
        "UPDATE agent_sessions SET summary_json = ?2, updated_at_ms = ?3 WHERE id = ?1");
    if (upd.is_err()) return Result<AgentSessionSummary>::err(upd.error());
    upd.value().bind_text(1, id);
    upd.value().bind_text(2, item.to_json());
    upd.value().bind_int64(3, item.updated_at_ms);
    if (sqlite3_step(upd.value().raw()) != SQLITE_DONE) {
        return Result<AgentSessionSummary>::err(sqlite_error(connection_.raw()));
    }
    auto committed = tx.commit();
    if (committed.is_err()) {
        return Result<AgentSessionSummary>::err(committed.error());
    }
    return Result<AgentSessionSummary>::ok(std::move(item));
}

// ---------------------------------------------------------------------------
// Session Navigation & Keyset Paging
// ---------------------------------------------------------------------------

namespace {

constexpr size_t kMaxOpenSessions = 256;
constexpr int64_t kMaxSafeNavRevision = (1LL << 53) - 1;
constexpr size_t kMaxPageSummaryBytes = 256 * 1024;
constexpr size_t kMaxPageBytes = 2 * 1024 * 1024;

Result<void> validate_navigation_ids(
    const std::vector<std::string>& open_ids,
    const std::optional<std::string>& active_id) {
    if (open_ids.size() > kMaxOpenSessions) {
        return Result<void>::err(NativeError::invalid("openIds", "contains more than 256 sessions"));
    }
    std::set<std::string_view> seen;
    for (const auto& id : open_ids) {
        if (id.empty() || id.size() > 200 || trim_ascii(id) != id || utf8_has_control_chars(id)) {
            return Result<void>::err(NativeError::invalid("openIds", "contains an invalid session ID"));
        }
        if (!seen.insert(id).second) {
            return Result<void>::err(NativeError::invalid("openIds", "contains a duplicate session ID"));
        }
    }
    if (active_id.has_value() && !seen.contains(*active_id)) {
        return Result<void>::err(NativeError::invalid("activeId", "must reference an open session"));
    }
    return Result<void>::ok();
}

Result<std::string> current_receipt_id(sqlite3* db, int64_t revision) {
    if (revision == 0) {
        return Result<std::string>::ok("session_navigation_empty");
    }
    auto st = SqliteStmt::prepare(
        db, "SELECT receipt_id FROM agent_session_navigation_receipts WHERE revision = ?1");
    if (st.is_err()) return Result<std::string>::err(st.error());
    st.value().bind_int64(1, revision);
    const int rc = sqlite3_step(st.value().raw());
    if (rc == SQLITE_ROW) {
        return Result<std::string>::ok(st.value().col_text(0));
    }
    if (rc == SQLITE_DONE) {
        return Result<std::string>::err(NativeError::make(
            "session_navigation_receipt_missing",
            "The durable navigation receipt is missing for the current revision"));
    }
    return Result<std::string>::err(sqlite_error(db));
}

Result<AgentSessionNavigationSnapshot> read_navigation_snapshot(sqlite3* db) {
    auto st = SqliteStmt::prepare(
        db, "SELECT revision, snapshot_json FROM agent_session_navigation WHERE singleton = 1");
    if (st.is_err()) return Result<AgentSessionNavigationSnapshot>::err(st.error());
    const int rc = sqlite3_step(st.value().raw());
    if (rc == SQLITE_DONE) {
        return Result<AgentSessionNavigationSnapshot>::ok(AgentSessionNavigationSnapshot{});
    }
    if (rc != SQLITE_ROW) {
        return Result<AgentSessionNavigationSnapshot>::err(sqlite_error(db));
    }
    const int64_t revision = st.value().col_int64(0);
    const std::string raw = st.value().col_text(1);
    if (raw.size() > 128 * 1024) {
        return Result<AgentSessionNavigationSnapshot>::err(NativeError::make(
            "session_navigation_invalid",
            "The stored navigation snapshot exceeds its safety limit"));
    }
    auto parsed = AgentSessionNavigationSnapshot::from_json(raw);
    if (parsed.is_err()) return parsed;
    AgentSessionNavigationSnapshot snap = std::move(parsed.value());
    if (snap.schema_version != 1 || revision <= 0 || revision > kMaxSafeNavRevision ||
        snap.revision != revision || snap.updated_at_ms <= 0) {
        return Result<AgentSessionNavigationSnapshot>::err(NativeError::make(
            "session_navigation_invalid",
            "The stored navigation snapshot has invalid revision metadata"));
    }
    auto val = validate_navigation_ids(snap.open_ids, snap.active_id);
    if (val.is_err()) return Result<AgentSessionNavigationSnapshot>::err(val.error());

    std::vector<std::string> retained;
    retained.reserve(snap.open_ids.size());
    for (const auto& id : snap.open_ids) {
        auto ex = query_exists(db, "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)", id);
        if (ex.is_err()) return Result<AgentSessionNavigationSnapshot>::err(ex.error());
        if (ex.value()) {
            retained.push_back(id);
        }
    }
    snap.open_ids = std::move(retained);
    if (snap.active_id.has_value() &&
        std::find(snap.open_ids.begin(), snap.open_ids.end(), *snap.active_id) == snap.open_ids.end()) {
        snap.active_id.reset();
    }
    return Result<AgentSessionNavigationSnapshot>::ok(std::move(snap));
}

Result<AgentSessionSummary> decode_page_summary(
    std::string_view id,
    int64_t updated,
    std::string_view raw,
    size_t& total_bytes) {
    total_bytes += raw.size();
    if (raw.size() > kMaxPageSummaryBytes || total_bytes > kMaxPageBytes) {
        return Result<AgentSessionSummary>::err(NativeError::make(
            "session_page_too_large",
            "Session metadata exceeds the native page byte budget"));
    }
    auto parsed = AgentSessionSummary::from_json(raw);
    if (parsed.is_err()) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("session_page_invalid", "A stored session summary is invalid"));
    }
    if (parsed.value().id != id || parsed.value().updated_at_ms != updated) {
        return Result<AgentSessionSummary>::err(NativeError::make(
            "session_page_invalid",
            "A stored session summary differs from its ordering identity"));
    }
    return parsed;
}

} // namespace

Result<AgentSessionNavigationLoad> HarnessStore::load_session_navigation() {
    std::lock_guard<std::mutex> lock(mutex_);
    auto snap = read_navigation_snapshot(connection_.raw());
    if (snap.is_err()) return Result<AgentSessionNavigationLoad>::err(snap.error());
    auto receipt = current_receipt_id(connection_.raw(), snap.value().revision);
    if (receipt.is_err()) return Result<AgentSessionNavigationLoad>::err(receipt.error());
    return Result<AgentSessionNavigationLoad>::ok(
        AgentSessionNavigationLoad{std::move(snap.value()), std::move(receipt.value())});
}

Result<AgentSessionNavigationSave> HarnessStore::save_session_navigation(
    const SaveAgentSessionNavigationRequest& request) {
    if (request.expected_revision < 0) {
        return Result<AgentSessionNavigationSave>::err(
            NativeError::invalid("expectedRevision", "must be a non-negative revision"));
    }
    auto valid = validate_navigation_ids(request.open_ids, request.active_id);
    if (valid.is_err()) return Result<AgentSessionNavigationSave>::err(valid.error());

    std::lock_guard<std::mutex> lock(mutex_);
    bool tx_ok = false;
    NativeError tx_err;
    SqliteTransaction tx(connection_, SqliteTxBehavior::Immediate, tx_ok, tx_err);
    if (!tx_ok) return Result<AgentSessionNavigationSave>::err(tx_err);

    auto current = read_navigation_snapshot(connection_.raw());
    if (current.is_err()) return Result<AgentSessionNavigationSave>::err(current.error());

    if (current.value().revision != request.expected_revision) {
        auto receipt = current_receipt_id(connection_.raw(), current.value().revision);
        if (receipt.is_err()) return Result<AgentSessionNavigationSave>::err(receipt.error());
        return Result<AgentSessionNavigationSave>::ok(AgentSessionNavigationSave{
            AgentSessionNavigationSave::Status::Conflict,
            std::move(current.value()),
            std::move(receipt.value()),
        });
    }

    for (const auto& id : request.open_ids) {
        auto ex = query_exists(
            connection_.raw(),
            "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)",
            id);
        if (ex.is_err()) return Result<AgentSessionNavigationSave>::err(ex.error());
        if (!ex.value()) {
            return Result<AgentSessionNavigationSave>::err(NativeError::make(
                "agent_session_not_found",
                "Navigation contains a session that no longer exists"));
        }
    }

    if (current.value().revision >= kMaxSafeNavRevision) {
        return Result<AgentSessionNavigationSave>::err(NativeError::make(
            "session_navigation_revision_exhausted",
            "The navigation revision cannot advance"));
    }

    auto ts = now_epoch_ms();
    if (ts.is_err()) return Result<AgentSessionNavigationSave>::err(ts.error());

    AgentSessionNavigationSnapshot next_snap;
    next_snap.schema_version = 1;
    next_snap.revision = current.value().revision + 1;
    next_snap.open_ids = request.open_ids;
    next_snap.active_id = request.active_id;
    next_snap.updated_at_ms = ts.value();

    const std::string raw = next_snap.to_json();
    const std::string receipt_id = "session_navigation_" + uuid_v4_simple();

    auto ins_rec = SqliteStmt::prepare(
        connection_.raw(),
        "INSERT INTO agent_session_navigation_receipts (receipt_id, revision, snapshot_json) "
        "VALUES (?1, ?2, ?3)");
    if (ins_rec.is_err()) return Result<AgentSessionNavigationSave>::err(ins_rec.error());
    ins_rec.value().bind_text(1, receipt_id);
    ins_rec.value().bind_int64(2, next_snap.revision);
    ins_rec.value().bind_text(3, raw);
    if (sqlite3_step(ins_rec.value().raw()) != SQLITE_DONE) {
        return Result<AgentSessionNavigationSave>::err(sqlite_error(connection_.raw()));
    }

    auto ins_nav = SqliteStmt::prepare(
        connection_.raw(),
        "INSERT INTO agent_session_navigation (singleton, revision, snapshot_json) VALUES (1, ?1, ?2) "
        "ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json");
    if (ins_nav.is_err()) return Result<AgentSessionNavigationSave>::err(ins_nav.error());
    ins_nav.value().bind_int64(1, next_snap.revision);
    ins_nav.value().bind_text(2, raw);
    if (sqlite3_step(ins_nav.value().raw()) != SQLITE_DONE) {
        return Result<AgentSessionNavigationSave>::err(sqlite_error(connection_.raw()));
    }

    auto committed = tx.commit();
    if (committed.is_err()) return Result<AgentSessionNavigationSave>::err(committed.error());

    return Result<AgentSessionNavigationSave>::ok(AgentSessionNavigationSave{
        AgentSessionNavigationSave::Status::Saved,
        std::move(next_snap),
        receipt_id,
    });
}

Result<AgentSessionPage> HarnessStore::session_page(const AgentSessionPageRequest& request) {
    if (request.limit < 1 || request.limit > 100) {
        return Result<AgentSessionPage>::err(
            NativeError::invalid("limit", "must be between 1 and 100"));
    }
    if (request.cursor.has_value()) {
        const auto& cid = request.cursor->id;
        if (cid.empty() || cid.size() > 200 || trim_ascii(cid) != cid || utf8_has_control_chars(cid)) {
            return Result<AgentSessionPage>::err(
                NativeError::invalid("cursor", "contains an invalid session ID"));
        }
    }

    std::lock_guard<std::mutex> lock(mutex_);
    bool tx_ok = false;
    NativeError tx_err;
    SqliteTransaction tx(connection_, SqliteTxBehavior::Deferred, tx_ok, tx_err);
    if (!tx_ok) return Result<AgentSessionPage>::err(tx_err);

    auto snap = read_navigation_snapshot(connection_.raw());
    if (snap.is_err()) return Result<AgentSessionPage>::err(snap.error());
    auto receipt = current_receipt_id(connection_.raw(), snap.value().revision);
    if (receipt.is_err()) return Result<AgentSessionPage>::err(receipt.error());

    AgentSessionNavigationLoad nav_load{std::move(snap.value()), std::move(receipt.value())};

    static constexpr std::string_view kPageAfterSql =
        "SELECT id, updated_at_ms, summary_json FROM agent_sessions "
        "WHERE updated_at_ms = ?1 AND id > ?2 "
        "UNION ALL "
        "SELECT id, updated_at_ms, summary_json FROM agent_sessions "
        "WHERE updated_at_ms < ?1 "
        "ORDER BY updated_at_ms DESC, id ASC LIMIT ?3";
    static constexpr std::string_view kPageFirstSql =
        "SELECT id, updated_at_ms, summary_json FROM agent_sessions "
        "ORDER BY updated_at_ms DESC, id ASC LIMIT ?1";

    auto st = SqliteStmt::prepare(
        connection_.raw(),
        request.cursor.has_value() ? kPageAfterSql : kPageFirstSql);
    if (st.is_err()) return Result<AgentSessionPage>::err(st.error());

    const int64_t fetch_limit = static_cast<int64_t>(request.limit) + 1;
    if (request.cursor.has_value()) {
        st.value().bind_int64(1, request.cursor->updated_at_ms);
        st.value().bind_text(2, request.cursor->id);
        st.value().bind_int64(3, fetch_limit);
    } else {
        st.value().bind_int64(1, fetch_limit);
    }

    std::vector<AgentSessionSummary> rows;
    rows.reserve(static_cast<size_t>(request.limit) + 1u);
    size_t total_bytes = 0;

    while (true) {
        const int rc = sqlite3_step(st.value().raw());
        if (rc == SQLITE_DONE) break;
        if (rc != SQLITE_ROW) {
            return Result<AgentSessionPage>::err(sqlite_error(connection_.raw()));
        }
        const std::string row_id = st.value().col_text(0);
        const int64_t row_upd = st.value().col_int64(1);
        const std::string row_raw = st.value().col_text(2);
        auto decoded = decode_page_summary(row_id, row_upd, row_raw, total_bytes);
        if (decoded.is_err()) return Result<AgentSessionPage>::err(decoded.error());
        rows.push_back(std::move(decoded.value()));
    }

    std::optional<AgentSessionPageCursor> next_cursor;
    if (rows.size() > static_cast<size_t>(request.limit)) {
        rows.pop_back();
        if (!rows.empty()) {
            next_cursor = AgentSessionPageCursor{rows.back().updated_at_ms, rows.back().id};
        }
    }

    std::optional<AgentSessionSummary> active;
    if (nav_load.snapshot.active_id.has_value()) {
        auto act_st = SqliteStmt::prepare(
            connection_.raw(),
            "SELECT id, updated_at_ms, summary_json FROM agent_sessions WHERE id = ?1");
        if (act_st.is_err()) return Result<AgentSessionPage>::err(act_st.error());
        act_st.value().bind_text(1, *nav_load.snapshot.active_id);
        const int rc = sqlite3_step(act_st.value().raw());
        if (rc != SQLITE_ROW) {
            return Result<AgentSessionPage>::err(NativeError::make(
                "session_page_invalid",
                "Active session disappeared from the read snapshot"));
        }
        auto decoded = decode_page_summary(
            act_st.value().col_text(0),
            act_st.value().col_int64(1),
            act_st.value().col_text(2),
            total_bytes);
        if (decoded.is_err()) return Result<AgentSessionPage>::err(decoded.error());
        active = std::move(decoded.value());
    }

    auto committed = tx.commit();
    if (committed.is_err()) return Result<AgentSessionPage>::err(committed.error());

    return Result<AgentSessionPage>::ok(AgentSessionPage{
        std::move(rows),
        std::move(active),
        std::move(nav_load),
        std::move(next_cursor),
    });
}

// ---------------------------------------------------------------------------
// Transcript Messages & Event Journal
// ---------------------------------------------------------------------------

Result<void> HarnessStore::save_messages(
    std::string_view session_id,
    const std::vector<WireMessage>& msgs) {
    std::lock_guard<std::mutex> lock(mutex_);
    bool tx_ok = false;
    NativeError tx_err;
    SqliteTransaction tx(connection_, SqliteTxBehavior::Immediate, tx_ok, tx_err);
    if (!tx_ok) return Result<void>::err(tx_err);

    auto del = SqliteStmt::prepare(
        connection_.raw(),
        "DELETE FROM agent_messages WHERE session_id = ?1");
    if (del.is_err()) return Result<void>::err(del.error());
    del.value().bind_text(1, session_id);
    if (sqlite3_step(del.value().raw()) != SQLITE_DONE) {
        return Result<void>::err(sqlite_error(connection_.raw()));
    }

    for (size_t i = 0; i < msgs.size(); ++i) {
        auto ins = SqliteStmt::prepare(
            connection_.raw(),
            "INSERT INTO agent_messages (session_id, seq, message_json) VALUES (?1, ?2, ?3)");
        if (ins.is_err()) return Result<void>::err(ins.error());
        ins.value().bind_text(1, session_id);
        ins.value().bind_int64(2, static_cast<int64_t>(i));
        ins.value().bind_text(3, msgs[i].to_json().dump());
        if (sqlite3_step(ins.value().raw()) != SQLITE_DONE) {
            return Result<void>::err(sqlite_error(connection_.raw()));
        }
    }
    return tx.commit();
}

Result<std::vector<WireMessage>> HarnessStore::messages(std::string_view session_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto st = SqliteStmt::prepare(
        connection_.raw(),
        "SELECT message_json FROM agent_messages WHERE session_id = ?1 ORDER BY seq ASC");
    if (st.is_err()) return Result<std::vector<WireMessage>>::err(st.error());
    st.value().bind_text(1, session_id);
    std::vector<WireMessage> out;
    while (true) {
        const int rc = sqlite3_step(st.value().raw());
        if (rc == SQLITE_DONE) break;
        if (rc != SQLITE_ROW) {
            return Result<std::vector<WireMessage>>::err(sqlite_error(connection_.raw()));
        }
        auto jv = JsonValue::parse(st.value().col_text(0));
        if (jv.is_err()) return Result<std::vector<WireMessage>>::err(storage_error(jv.error().message));
        auto wm = WireMessage::from_json(jv.value());
        if (wm.is_err()) return Result<std::vector<WireMessage>>::err(storage_error(wm.error().message));
        out.push_back(std::move(wm.value()));
    }
    return Result<std::vector<WireMessage>>::ok(std::move(out));
}

Result<StoredAgentEvent> HarnessStore::publish_event(
    std::string_view session_id,
    const JsonValue& event,
    const std::function<bool(const StoredAgentEvent&)>& on_committed) {
    StoredAgentEvent stored;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        bool tx_ok = false;
        NativeError tx_err;
        SqliteTransaction tx(connection_, SqliteTxBehavior::Immediate, tx_ok, tx_err);
        if (!tx_ok) return Result<StoredAgentEvent>::err(tx_err);

        auto ins = SqliteStmt::prepare(
            connection_.raw(),
            "INSERT INTO agent_events (session_id, event_json) VALUES (?1, ?2)");
        if (ins.is_err()) return Result<StoredAgentEvent>::err(ins.error());
        ins.value().bind_text(1, session_id);
        ins.value().bind_text(2, event.dump());
        if (sqlite3_step(ins.value().raw()) != SQLITE_DONE) {
            return Result<StoredAgentEvent>::err(sqlite_error(connection_.raw()));
        }
        const int64_t seq = sqlite3_last_insert_rowid(connection_.raw());

        std::string run_status = "running";
        if (const auto* tv = event.find("type"); tv && tv->as_string_view() == "run_finished") {
            if (const auto* sv = event.find("status"); sv && sv->is_string()) {
                run_status = sv->as_string();
            } else {
                run_status = "completed";
            }
        }
        auto st_run = SqliteStmt::prepare(
            connection_.raw(),
            "INSERT INTO agent_run_state (session_id, status, snapshot_sequence) VALUES (?1, ?2, ?3) "
            "ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, snapshot_sequence = excluded.snapshot_sequence");
        if (st_run.is_err()) return Result<StoredAgentEvent>::err(st_run.error());
        st_run.value().bind_text(1, session_id);
        st_run.value().bind_text(2, run_status);
        st_run.value().bind_int64(3, seq);
        if (sqlite3_step(st_run.value().raw()) != SQLITE_DONE) {
            return Result<StoredAgentEvent>::err(sqlite_error(connection_.raw()));
        }

        auto committed = tx.commit();
        if (committed.is_err()) return Result<StoredAgentEvent>::err(committed.error());

        stored.sequence = seq;
        stored.event = event;
    }

    if (on_committed) {
        (void)on_committed(stored);
    }
    return Result<StoredAgentEvent>::ok(std::move(stored));
}

Result<RunReplay> HarnessStore::replay(std::string_view session_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    RunReplay out;
    {
        auto st = SqliteStmt::prepare(
            connection_.raw(),
            "SELECT status FROM agent_run_state WHERE session_id = ?1");
        if (st.is_err()) return Result<RunReplay>::err(st.error());
        st.value().bind_text(1, session_id);
        if (sqlite3_step(st.value().raw()) == SQLITE_ROW) {
            out.status = st.value().col_text(0);
        }
    }
    {
        auto st = SqliteStmt::prepare(
            connection_.raw(),
            "SELECT sequence, event_json FROM agent_events WHERE session_id = ?1 ORDER BY sequence ASC");
        if (st.is_err()) return Result<RunReplay>::err(st.error());
        st.value().bind_text(1, session_id);
        while (true) {
            const int rc = sqlite3_step(st.value().raw());
            if (rc == SQLITE_DONE) break;
            if (rc != SQLITE_ROW) return Result<RunReplay>::err(sqlite_error(connection_.raw()));
            const int64_t seq = st.value().col_int64(0);
            auto parsed = JsonValue::parse(st.value().col_text(1));
            if (parsed.is_err()) return Result<RunReplay>::err(storage_error(parsed.error().message));
            out.event_cursor = seq;
            out.events.push_back(StoredAgentEvent{seq, std::move(parsed.value())});
        }
    }
    return Result<RunReplay>::ok(std::move(out));
}

// ---------------------------------------------------------------------------
// ProviderProfileRepository, SecretBroker & Provider Routing
// ---------------------------------------------------------------------------

std::string ProviderProfileRecord::to_redacted_json() const {
    JsonValue::Object obj;
    obj["id"] = JsonValue(id);
    obj["profileId"] = JsonValue(profile_id);
    obj["providerType"] = JsonValue(provider_type);
    obj["displayName"] = JsonValue(display_name);
    obj["normalizedBaseUrl"] = JsonValue(normalized_base_url);
    obj["authScheme"] = JsonValue(auth_scheme);
    obj["organizationId"] = organization_id.has_value() ? JsonValue(*organization_id) : JsonValue(nullptr);
    obj["remoteProjectId"] = remote_project_id.has_value() ? JsonValue(*remote_project_id) : JsonValue(nullptr);
    obj["credentialStatus"] = JsonValue(credential_status == CredentialStatus::Present ? "present" : "missing");
    obj["enabled"] = JsonValue(enabled);
    obj["createdAtMs"] = JsonValue(created_at_ms);
    obj["updatedAtMs"] = JsonValue(updated_at_ms);
    return JsonValue(std::move(obj)).dump();
}

ProviderProfileRepository::ProviderProfileRepository(
    const SqliteConnection& conn,
    std::string app_profile_id)
    : conn_(conn), app_profile_id_(std::move(app_profile_id)) {}

static ProviderCredentialSnapshot row_to_profile_snapshot(const SqliteStmt& st) {
    ProviderCredentialSnapshot snap;
    snap.profile.id = st.col_text(0);
    snap.profile.profile_id = st.col_text(1);
    snap.profile.provider_type = st.col_text(2);
    snap.profile.display_name = st.col_text(3);
    snap.profile.normalized_base_url = st.col_text(4);
    snap.profile.auth_scheme = st.col_text(5);
    snap.profile.organization_id = st.col_opt_text(6);
    snap.profile.remote_project_id = st.col_opt_text(7);
    snap.credential_ref = st.col_opt_text(8);
    snap.profile.credential_status =
        (snap.credential_ref.has_value() && !snap.credential_ref->empty())
            ? CredentialStatus::Present
            : CredentialStatus::Missing;
    snap.profile.enabled = st.col_int64(9) != 0;
    snap.profile.created_at_ms = st.col_int64(10);
    snap.profile.updated_at_ms = st.col_int64(11);
    return snap;
}

Result<std::vector<ProviderProfileRecord>> ProviderProfileRepository::list() const {
    auto st = SqliteStmt::prepare(
        conn_.raw(),
        "SELECT id, profile_id, provider_type, display_name, normalized_base_url, "
        "auth_scheme, organization_id, remote_project_id, credential_ref, enabled, "
        "created_at_ms, updated_at_ms FROM provider_profiles "
        "WHERE profile_id = ?1 AND deleted_at_ms IS NULL ORDER BY created_at_ms ASC");
    if (st.is_err()) return Result<std::vector<ProviderProfileRecord>>::err(st.error());
    st.value().bind_text(1, app_profile_id_);
    std::vector<ProviderProfileRecord> out;
    while (true) {
        const int rc = sqlite3_step(st.value().raw());
        if (rc == SQLITE_DONE) break;
        if (rc != SQLITE_ROW) {
            return Result<std::vector<ProviderProfileRecord>>::err(sqlite_error(conn_.raw()));
        }
        out.push_back(row_to_profile_snapshot(st.value()).profile);
    }
    return Result<std::vector<ProviderProfileRecord>>::ok(std::move(out));
}

Result<ProviderCredentialSnapshot> ProviderProfileRepository::credential_snapshot(
    std::string_view id) const {
    auto st = SqliteStmt::prepare(
        conn_.raw(),
        "SELECT id, profile_id, provider_type, display_name, normalized_base_url, "
        "auth_scheme, organization_id, remote_project_id, credential_ref, enabled, "
        "created_at_ms, updated_at_ms FROM provider_profiles "
        "WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL");
    if (st.is_err()) return Result<ProviderCredentialSnapshot>::err(st.error());
    st.value().bind_text(1, id);
    st.value().bind_text(2, app_profile_id_);
    const int rc = sqlite3_step(st.value().raw());
    if (rc == SQLITE_DONE) {
        return Result<ProviderCredentialSnapshot>::err(
            NativeError::make("provider_profile_missing", "Provider profile does not exist"));
    }
    if (rc != SQLITE_ROW) {
        return Result<ProviderCredentialSnapshot>::err(sqlite_error(conn_.raw()));
    }
    return Result<ProviderCredentialSnapshot>::ok(row_to_profile_snapshot(st.value()));
}

Result<ProviderProfileRecord> ProviderProfileRepository::get(std::string_view id) const {
    auto snap = credential_snapshot(id);
    if (snap.is_err()) return Result<ProviderProfileRecord>::err(snap.error());
    return Result<ProviderProfileRecord>::ok(std::move(snap.value().profile));
}

Result<ProviderProfileRecord> ProviderProfileRepository::active(std::string_view id) const {
    auto rec = get(id);
    if (rec.is_err()) return rec;
    if (!rec.value().enabled) {
        return Result<ProviderProfileRecord>::err(
            NativeError::make("provider_disabled", "Provider profile is disabled"));
    }
    return rec;
}

Result<std::optional<std::string>> ProviderProfileRepository::credential_ref(
    std::string_view id) const {
    auto snap = credential_snapshot(id);
    if (snap.is_err()) return Result<std::optional<std::string>>::err(snap.error());
    return Result<std::optional<std::string>>::ok(std::move(snap.value().credential_ref));
}

Result<void> SecretBroker::with_secret(
    SecretPurpose /*purpose*/,
    std::string_view reference,
    const std::function<Result<void>(std::string_view)>& callback) const {
    if (!reference.starts_with("omnia-secret:") || reference.size() < 20 ||
        utf8_has_control_chars(reference)) {
        return Result<void>::err(
            NativeError::invalid("credentialRef", "must be a canonical vault reference"));
    }
    return callback("synthetic-resolved-secret");
}

Result<std::string> SecretBroker::put(SecretPurpose /*purpose*/, std::string secret) const {
    if (trim_ascii(secret).empty() || secret.size() > 16 * 1024 ||
        utf8_has_control_chars(secret)) {
        return Result<std::string>::err(
            NativeError::invalid("secret", "must be nonempty and at most 16 KiB"));
    }
    return Result<std::string>::ok("omnia-secret:" + uuid_v4_simple());
}

Result<ProviderSelection> provider_selection(const ProviderProfileInput& input) {
    const std::string kind = to_lower_utf8(trim_ascii(input.provider_type));
    const std::string scheme = to_lower_utf8(trim_ascii(input.auth_scheme));

    AuthScheme auth = AuthScheme::Bearer;
    if (scheme == "none") {
        auth = AuthScheme::None;
    } else if (scheme == "api-key-header") {
        auth = AuthScheme::ApiKeyHeader;
    } else if (scheme == "bearer") {
        auth = AuthScheme::Bearer;
    } else {
        return Result<ProviderSelection>::err(
            NativeError::invalid("authScheme", "unsupported auth scheme"));
    }

    ProviderSelection sel;
    sel.auth = auth;
    if (kind == "openai") {
        sel.family = AdapterFamily::OpenAiResponses;
        sel.organization = input.organization;
        sel.project = input.project;
    } else if (kind == "openai compatible" || kind == "openai-compatible" || kind == "local") {
        sel.family = AdapterFamily::OpenAiChat;
        sel.organization = input.organization;
        sel.project = input.project;
    } else if (kind == "deepseek") {
        sel.family = AdapterFamily::OpenAiChat;
        sel.organization = std::nullopt;
        sel.project = std::nullopt;
    } else if (kind == "anthropic") {
        sel.family = AdapterFamily::AnthropicMessages;
    } else {
        return Result<ProviderSelection>::err(
            NativeError::invalid("providerType", "unsupported provider type"));
    }
    return Result<ProviderSelection>::ok(std::move(sel));
}

Result<ConfiguredProvider> build_provider(
    const ProviderProfileInput& input,
    std::optional<std::string_view> secret) {
    if (!input.enabled) {
        return Result<ConfiguredProvider>::err(
            NativeError::make("provider_disabled", "Provider profile is disabled", false));
    }
    auto sel = provider_selection(input);
    if (sel.is_err()) {
        return Result<ConfiguredProvider>::err(sel.error());
    }
    if (sel.value().auth != AuthScheme::None && (!secret.has_value() || secret->empty())) {
        return Result<ConfiguredProvider>::err(
            NativeError::make("secret_missing", "Provider secret is missing", false));
    }
    if (!input.base_url.starts_with("http://") && !input.base_url.starts_with("https://")) {
        return Result<ConfiguredProvider>::err(
            NativeError::invalid("baseUrl", "must be an HTTP(S) URL"));
    }
    return Result<ConfiguredProvider>::ok(ConfiguredProvider{
        std::move(sel.value()),
        input.base_url,
    });
}

// ---------------------------------------------------------------------------
// RunCoordinator, RunEvents & Winsock2 HTTP SSE Consumer Execution
// ---------------------------------------------------------------------------

Result<RunTicket> RunRegistry::insert(std::string_view session_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_.contains(session_id)) {
        return Result<RunTicket>::err(
            NativeError::make("session_run_active", "Session already has an active run"));
    }
    const uint64_t tok = next_token_++;
    active_.emplace(std::string(session_id), tok);
    return Result<RunTicket>::ok(RunTicket{std::string(session_id), tok});
}

Result<bool> RunRegistry::remove_current(const RunTicket& ticket) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = active_.find(ticket.session_id);
    if (it == active_.end() || it->second != ticket.token) {
        return Result<bool>::ok(false);
    }
    active_.erase(it);
    return Result<bool>::ok(true);
}

Result<bool> RunRegistry::is_empty() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return Result<bool>::ok(active_.empty());
}

RunCoordinator::RunCoordinator(std::shared_ptr<HarnessStore> store)
    : store_(std::move(store)) {}

Result<AdmittedRun> RunCoordinator::admit(std::string_view session_id) {
    auto sum = store_->summary(session_id);
    if (sum.is_err()) return Result<AdmittedRun>::err(sum.error());
    auto hist = store_->messages(session_id);
    if (hist.is_err()) return Result<AdmittedRun>::err(hist.error());
    auto ticket = runs_.insert(session_id);
    if (ticket.is_err()) return Result<AdmittedRun>::err(ticket.error());
    return Result<AdmittedRun>::ok(AdmittedRun{
        std::move(ticket.value()),
        std::move(hist.value()),
    });
}

AgentEvent AgentEvent::turn_started(uint32_t t) {
    AgentEvent e;
    e.kind = Kind::TurnStarted;
    e.turn = t;
    return e;
}

AgentEvent AgentEvent::plan_presented(std::string id_val, std::string plan_val) {
    AgentEvent e;
    e.kind = Kind::PlanPresented;
    e.id = std::move(id_val);
    e.plan = std::move(plan_val);
    return e;
}

AgentEvent AgentEvent::approval_requested(ApprovalRequest req) {
    AgentEvent e;
    e.kind = Kind::ApprovalRequested;
    e.approval = std::move(req);
    return e;
}

AgentEvent AgentEvent::subagent(std::string parent, AgentEvent inner) {
    AgentEvent e;
    e.kind = Kind::Subagent;
    e.parent_id = std::move(parent);
    e.nested = std::make_shared<AgentEvent>(std::move(inner));
    return e;
}

AgentEvent AgentEvent::stream_delta(std::string text) {
    AgentEvent e;
    e.kind = Kind::StreamDelta;
    e.delta_text = std::move(text);
    return e;
}

AgentEvent AgentEvent::stream_usage(uint64_t prompt, uint64_t completion) {
    AgentEvent e;
    e.kind = Kind::StreamUsage;
    e.prompt_tokens = prompt;
    e.completion_tokens = completion;
    return e;
}

JsonValue AgentEvent::to_json() const {
    JsonValue::Object obj;
    switch (kind) {
        case Kind::TurnStarted:
            obj["type"] = JsonValue("turn_started");
            obj["turn"] = JsonValue(static_cast<uint64_t>(turn));
            break;
        case Kind::PlanPresented:
            obj["type"] = JsonValue("plan_presented");
            obj["id"] = JsonValue(id);
            obj["plan"] = JsonValue(plan);
            break;
        case Kind::ApprovalRequested: {
            obj["type"] = JsonValue("approval_requested");
            JsonValue::Object req;
            req["toolUseId"] = JsonValue(approval.tool_use_id);
            req["tool"] = JsonValue(approval.tool);
            req["input"] = approval.input;
            req["summary"] = JsonValue(approval.summary);
            req["ordinal"] = JsonValue(static_cast<uint64_t>(approval.ordinal));
            req["total"] = JsonValue(static_cast<uint64_t>(approval.total));
            obj["request"] = JsonValue(std::move(req));
            break;
        }
        case Kind::Subagent:
            obj["type"] = JsonValue("subagent");
            obj["parentId"] = JsonValue(parent_id);
            obj["event"] = nested ? nested->to_json() : JsonValue(nullptr);
            break;
        case Kind::StreamDelta:
            obj["type"] = JsonValue("stream_delta");
            obj["text"] = JsonValue(delta_text);
            break;
        case Kind::StreamUsage:
            obj["type"] = JsonValue("stream_usage");
            obj["promptTokens"] = JsonValue(prompt_tokens);
            obj["completionTokens"] = JsonValue(completion_tokens);
            break;
    }
    return JsonValue(std::move(obj));
}

static std::optional<std::string_view> extract_approval_id(const AgentEvent& ev) noexcept {
    if (ev.kind == AgentEvent::Kind::ApprovalRequested) {
        return ev.approval.tool_use_id;
    }
    if (ev.kind == AgentEvent::Kind::Subagent && ev.nested) {
        return extract_approval_id(*ev.nested);
    }
    return std::nullopt;
}

Result<bool> publish_run_event(
    const AgentEvent& event,
    RunEventState& state,
    CancellationToken& cancel,
    const std::function<bool(std::string_view)>& approval_ready,
    const std::function<Result<void>(const JsonValue&)>& publish) {
    if (const auto app_id = extract_approval_id(event); app_id.has_value()) {
        if (!approval_ready || !approval_ready(*app_id)) {
            return Result<bool>::ok(false);
        }
    }
    if (event.kind == AgentEvent::Kind::PlanPresented) {
        state.plan_presented.store(true, std::memory_order_release);
    } else if (event.kind == AgentEvent::Kind::StreamUsage) {
        state.run_tokens.fetch_add(
            event.prompt_tokens + event.completion_tokens, std::memory_order_seq_cst);
    }

    auto res = publish(event.to_json());
    if (res.is_err()) {
        {
            std::lock_guard<std::mutex> lock(state.persistence_error_mutex);
            state.persistence_error = res.error().to_string();
        }
        cancel.cancel();
        return Result<bool>::err(res.error());
    }
    return Result<bool>::ok(true);
}

PreparedSessionConfig prepare_session_config(
    const AgentSessionSummary& summary,
    const std::filesystem::path& workspace_root) {
    PreparedSessionConfig cfg;
    cfg.model = summary.model;
    cfg.reasoning_effort = summary.reasoning_effort;
    cfg.cwd = summary.cwd.empty() ? workspace_root : std::filesystem::path(summary.cwd);
    return cfg;
}

namespace {

bool parse_loopback_http_url(std::string_view url, std::string& host_out, uint16_t& port_out) {
    if (!url.starts_with("http://")) return false;
    std::string_view rest = url.substr(7);
    const size_t slash = rest.find('/');
    if (slash != std::string_view::npos) {
        rest = rest.substr(0, slash);
    }
    const size_t colon = rest.rfind(':');
    if (colon == std::string_view::npos) return false;
    host_out = std::string(rest.substr(0, colon));
    const std::string_view port_sv = rest.substr(colon + 1);
    uint32_t p = 0;
    const auto [ptr, ec] = std::from_chars(port_sv.data(), port_sv.data() + port_sv.size(), p);
    if (ec != std::errc{} || ptr != port_sv.data() + port_sv.size() || p == 0 || p > 65535) {
        return false;
    }
    port_out = static_cast<uint16_t>(p);
    return true;
}

} // namespace

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
    const std::function<void(const AgentEvent&)>& on_event) {
    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        return Result<JsonValue>::err(NativeError::make("network_error", "WSAStartup failed"));
    }
    struct WsaGuard {
        ~WsaGuard() { WSACleanup(); }
    } wsa_guard;

    // Persist user turn first so failed/interrupted runs retain user turn durably.
    history.push_back(WireMessage{"user", user_content});
    auto save_user = store->save_messages(session_id, history);
    if (save_user.is_err()) {
        return Result<JsonValue>::err(save_user.error());
    }

    on_event(AgentEvent::turn_started(1));

    std::string host;
    uint16_t port = 0;
    if (!parse_loopback_http_url(provider.base_url, host, port)) {
        return Result<JsonValue>::err(NativeError::invalid("baseUrl", "invalid loopback URL"));
    }

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        return Result<JsonValue>::err(NativeError::make("network_error", "socket failed"));
    }
    struct SockGuard {
        SOCKET s;
        ~SockGuard() {
            if (s != INVALID_SOCKET) closesocket(s);
        }
    } sock_guard{sock};

    DWORD timeout_ms = 5000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        return Result<JsonValue>::err(NativeError::invalid("baseUrl", "invalid IPv4 address"));
    }
    if (connect(sock, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) != 0) {
        return Result<JsonValue>::err(NativeError::make("network_error", "connect failed"));
    }

    JsonValue::Object req_body;
    req_body["model"] = JsonValue(config.model);
    req_body["stream"] = JsonValue(true);
    JsonValue::Array msgs_arr;
    JsonValue::Object umsg;
    umsg["role"] = JsonValue("user");
    umsg["content"] = JsonValue(prompt_text);
    msgs_arr.push_back(JsonValue(std::move(umsg)));
    req_body["messages"] = JsonValue(std::move(msgs_arr));
    const std::string payload = JsonValue(std::move(req_body)).dump();

    std::string http_req =
        "POST /v1/chat/completions HTTP/1.1\r\n"
        "Host: " + host + ":" + std::to_string(port) + "\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: " + std::to_string(payload.size()) + "\r\n"
        "Connection: close\r\n\r\n" + payload;

    size_t sent_total = 0;
    while (sent_total < http_req.size()) {
        const int sent = send(
            sock,
            http_req.data() + sent_total,
            static_cast<int>(http_req.size() - sent_total),
            0);
        if (sent <= 0) {
            return Result<JsonValue>::err(NativeError::make("network_error", "send failed"));
        }
        sent_total += static_cast<size_t>(sent);
    }

    std::string raw_resp;
    std::string assistant_accum;
    std::string final_status = "completed";
    bool headers_parsed = false;
    int status_code = 200;
    size_t sse_cursor = 0;

    auto flush_tokens = [&]() -> Result<void> {
        const uint64_t spent = event_state.run_tokens.exchange(0, std::memory_order_seq_cst);
        if (spent > 0) {
            auto upd = store->update_summary(session_id, [&](AgentSessionSummary& s) {
                s.tokens_used += spent;
            });
            if (upd.is_err()) return Result<void>::err(upd.error());
        }
        return Result<void>::ok();
    };

    while (true) {
        if (cancel.is_cancelled()) {
            final_status = "interrupted";
            break;
        }
        char buf[1024]{};
        const int n = recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) {
            break;
        }
        raw_resp.append(buf, static_cast<size_t>(n));
        if (!headers_parsed) {
            const size_t hend = raw_resp.find("\r\n\r\n");
            if (hend == std::string::npos) continue;
            headers_parsed = true;
            const std::string_view status_line(raw_resp.data(), raw_resp.find("\r\n"));
            const size_t sp1 = status_line.find(' ');
            if (sp1 != std::string_view::npos) {
                std::string_view code_sv = trim_ascii(status_line.substr(sp1 + 1, 3));
                (void)std::from_chars(code_sv.data(), code_sv.data() + code_sv.size(), status_code);
            }
            sse_cursor = hend + 4;
            if (status_code >= 400) {
                final_status = "failed";
                break;
            }
        }
        while (headers_parsed) {
            const size_t nl = raw_resp.find("\n\n", sse_cursor);
            if (nl == std::string::npos) break;
            std::string_view frame(raw_resp.data() + sse_cursor, nl - sse_cursor);
            sse_cursor = nl + 2;
            frame = trim_ascii(frame);
            if (!frame.starts_with("data:")) continue;
            std::string_view data_sv = trim_ascii(frame.substr(5));
            if (data_sv == "[DONE]") break;
            auto ev_json = JsonValue::parse(data_sv);
            if (ev_json.is_err()) continue;

            if (const auto* choices = ev_json.value().find("choices"); choices && choices->is_array()) {
                for (const auto& ch : *choices->as_array_ptr()) {
                    if (const auto* delta = ch.find("delta"); delta && delta->is_object()) {
                        if (const auto* cnt = delta->find("content"); cnt && cnt->is_string()) {
                            const std::string chunk_txt = cnt->as_string();
                            assistant_accum.append(chunk_txt);
                            on_event(AgentEvent::stream_delta(chunk_txt));
                        }
                    }
                }
            }
            if (const auto* usage = ev_json.value().find("usage"); usage && usage->is_object()) {
                const uint64_t pt = usage->find("prompt_tokens") ? usage->find("prompt_tokens")->as_uint64() : 0;
                const uint64_t ct = usage->find("completion_tokens") ? usage->find("completion_tokens")->as_uint64() : 0;
                on_event(AgentEvent::stream_usage(pt, ct));
            }
            if (cancel.is_cancelled()) {
                final_status = "interrupted";
                break;
            }
        }
        if (final_status != "completed") break;
    }

    if (!assistant_accum.empty() && final_status == "completed") {
        history.push_back(WireMessage{"assistant", {WireBlock::make_text(assistant_accum)}});
        auto sv = store->save_messages(session_id, history);
        if (sv.is_err()) return Result<JsonValue>::err(sv.error());
    }

    auto fl = flush_tokens();
    if (fl.is_err()) return Result<JsonValue>::err(fl.error());

    {
        std::lock_guard<std::mutex> lock(event_state.persistence_error_mutex);
        if (event_state.persistence_error.has_value()) {
            return Result<JsonValue>::err(
                NativeError::make("harness_storage_failed", *event_state.persistence_error));
        }
    }

    JsonValue::Object term;
    term["type"] = JsonValue("run_finished");
    term["status"] = JsonValue(final_status);
    return Result<JsonValue>::ok(JsonValue(std::move(term)));
}

} // namespace omnia::native
