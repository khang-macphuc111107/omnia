#include "omnia/storage/session_store.hpp"
#include "omnia/core/redactor.hpp"
#include "omnia/core/sha256.hpp"

#include <winsqlite/winsqlite3.h>

#include <stdexcept>

namespace omnia::storage {

namespace {

struct StmtCloser {
    void operator()(sqlite3_stmt* stmt) const noexcept {
        if (stmt != nullptr) {
            sqlite3_finalize(stmt);
        }
    }
};
using UniqueStmt = std::unique_ptr<sqlite3_stmt, StmtCloser>;

UniqueStmt prepare_stmt(sqlite3* db, const char* sql) {
    sqlite3_stmt* raw = nullptr;
    const int rc = sqlite3_prepare_v2(db, sql, -1, &raw, nullptr);
    if (rc != SQLITE_OK || raw == nullptr) {
        const char* msg = sqlite3_errmsg(db);
        throw std::runtime_error(
            std::string("SQLite prepare failed: ") + (msg != nullptr ? msg : "unknown")
        );
    }
    return UniqueStmt(raw);
}

std::string col_text(sqlite3_stmt* stmt, int col) {
    const unsigned char* raw = sqlite3_column_text(stmt, col);
    const int len = sqlite3_column_bytes(stmt, col);
    if (raw == nullptr || len <= 0) {
        return {};
    }
    return std::string(reinterpret_cast<const char*>(raw), static_cast<std::size_t>(len));
}

void bind_text_view(sqlite3_stmt* stmt, int idx, std::string_view val) {
    const char* ptr = val.empty() ? "" : val.data();
    const int rc = sqlite3_bind_text(
        stmt,
        idx,
        ptr,
        static_cast<int>(val.size()),
        SQLITE_TRANSIENT
    );
    if (rc != SQLITE_OK) {
        throw std::runtime_error("SQLite bind_text failed");
    }
}

bool is_valid_effort(std::string_view effort) noexcept {
    return effort == "none" || effort == "minimal" || effort == "low" ||
           effort == "medium" || effort == "high" || effort == "xhigh" ||
           effort == "max";
}

} // namespace

void SessionStore::SqliteCloser::operator()(sqlite3* db) const noexcept {
    if (db != nullptr) {
        sqlite3_close_v2(db);
    }
}

SessionStore::SessionStore(std::string_view db_path) {
    sqlite3* raw_db = nullptr;
    const std::string path_str(db_path);
    const int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
    const int rc = sqlite3_open_v2(path_str.c_str(), &raw_db, flags, nullptr);
    db_.reset(raw_db);
    if (rc != SQLITE_OK || !db_) {
        throw std::runtime_error("Failed to open winsqlite3 database: " + path_str);
    }

    sqlite3_busy_timeout(db_.get(), 5000);
    exec_sql("PRAGMA journal_mode = WAL;");
    exec_sql("PRAGMA synchronous = NORMAL;");
    exec_sql("PRAGMA foreign_keys = ON;");

    exec_sql(R"SQL(
        CREATE TABLE IF NOT EXISTS store_leases (
            lock_name TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            pid INTEGER NOT NULL,
            acquired_at_ms INTEGER NOT NULL,
            heartbeat_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            lease_epoch INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            model_id TEXT NOT NULL,
            effort TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            revision INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_id
            ON sessions (updated_at_ms DESC, id DESC);

        CREATE TABLE IF NOT EXISTS attachment_blobs (
            sha256 TEXT PRIMARY KEY,
            byte_len INTEGER NOT NULL,
            mime_type TEXT NOT NULL,
            data BLOB NOT NULL,
            created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_attachments (
            attachment_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            file_name TEXT NOT NULL,
            placement TEXT NOT NULL,
            caret_offset INTEGER,
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (sha256) REFERENCES attachment_blobs(sha256)
        );
        CREATE INDEX IF NOT EXISTS idx_session_attachments_session
            ON session_attachments (session_id, created_at_ms ASC);

        CREATE TABLE IF NOT EXISTS run_journal (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            event_kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_journal_session_seq
            ON run_journal (session_id, seq ASC);
    )SQL");
}

SessionStore::~SessionStore() = default;

void SessionStore::exec_sql(const char* sql) const {
    char* err_msg = nullptr;
    const int rc = sqlite3_exec(db_.get(), sql, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        std::string err = err_msg != nullptr ? err_msg : "unknown SQLite exec error";
        if (err_msg != nullptr) {
            sqlite3_free(err_msg);
        }
        throw std::runtime_error("SQLite exec failed: " + err);
    }
}

std::string SessionStore::next_id(std::string_view prefix, std::int64_t now_ms) {
    ++id_counter_;
    const std::string seed = std::string(prefix) + ":" +
        std::to_string(now_ms) + ":" + std::to_string(id_counter_);
    return std::string(prefix) + "-" + core::sha256_hex(seed).substr(0, 12);
}

std::string SessionStore::journal_mode() const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(db_.get(), "PRAGMA journal_mode;");
    if (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        return col_text(stmt.get(), 0);
    }
    return {};
}

std::optional<LeaseRecord> SessionStore::acquire_lease(
    std::string_view owner_id,
    std::int64_t pid,
    std::int64_t ttl_ms,
    std::int64_t now_ms
) {
    if (owner_id.empty() || ttl_ms <= 0) {
        throw std::invalid_argument("Invalid lease owner_id or ttl_ms");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    exec_sql("BEGIN IMMEDIATE;");
    try {
        auto sel = prepare_stmt(
            db_.get(),
            "SELECT owner_id, pid, acquired_at_ms, heartbeat_at_ms, expires_at_ms, lease_epoch "
            "FROM store_leases WHERE lock_name = 'primary';"
        );
        const int step_rc = sqlite3_step(sel.get());
        const std::int64_t new_expires = now_ms + ttl_ms;

        if (step_rc != SQLITE_ROW) {
            auto ins = prepare_stmt(
                db_.get(),
                "INSERT INTO store_leases "
                "(lock_name, owner_id, pid, acquired_at_ms, heartbeat_at_ms, expires_at_ms, lease_epoch) "
                "VALUES ('primary', ?1, ?2, ?3, ?3, ?4, 1);"
            );
            bind_text_view(ins.get(), 1, owner_id);
            sqlite3_bind_int64(ins.get(), 2, pid);
            sqlite3_bind_int64(ins.get(), 3, now_ms);
            sqlite3_bind_int64(ins.get(), 4, new_expires);
            if (sqlite3_step(ins.get()) != SQLITE_DONE) {
                throw std::runtime_error("Failed inserting store lease");
            }
            exec_sql("COMMIT;");
            return LeaseRecord{
                "primary", std::string(owner_id), pid, now_ms, now_ms, new_expires, 1
            };
        }

        const std::string cur_owner = col_text(sel.get(), 0);
        const std::int64_t cur_acquired = sqlite3_column_int64(sel.get(), 2);
        const std::int64_t cur_expires = sqlite3_column_int64(sel.get(), 4);
        const std::int64_t cur_epoch = sqlite3_column_int64(sel.get(), 5);
        sel.reset();

        if (cur_owner != owner_id && cur_expires > now_ms) {
            exec_sql("ROLLBACK;");
            return std::nullopt;
        }

        const bool same_owner = (cur_owner == owner_id && cur_expires > now_ms);
        const std::int64_t next_acquired = same_owner ? cur_acquired : now_ms;
        const std::int64_t next_epoch = same_owner ? cur_epoch : (cur_epoch + 1);

        auto upd = prepare_stmt(
            db_.get(),
            "UPDATE store_leases SET owner_id = ?1, pid = ?2, acquired_at_ms = ?3, "
            "heartbeat_at_ms = ?4, expires_at_ms = ?5, lease_epoch = ?6 "
            "WHERE lock_name = 'primary';"
        );
        bind_text_view(upd.get(), 1, owner_id);
        sqlite3_bind_int64(upd.get(), 2, pid);
        sqlite3_bind_int64(upd.get(), 3, next_acquired);
        sqlite3_bind_int64(upd.get(), 4, now_ms);
        sqlite3_bind_int64(upd.get(), 5, new_expires);
        sqlite3_bind_int64(upd.get(), 6, next_epoch);
        if (sqlite3_step(upd.get()) != SQLITE_DONE) {
            throw std::runtime_error("Failed updating store lease");
        }
        exec_sql("COMMIT;");
        return LeaseRecord{
            "primary",
            std::string(owner_id),
            pid,
            next_acquired,
            now_ms,
            new_expires,
            next_epoch
        };
    } catch (...) {
        try { exec_sql("ROLLBACK;"); } catch (...) {}
        throw;
    }
}

bool SessionStore::heartbeat(
    std::string_view owner_id,
    std::int64_t ttl_ms,
    std::int64_t now_ms
) {
    if (owner_id.empty() || ttl_ms <= 0) {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "UPDATE store_leases SET heartbeat_at_ms = ?1, expires_at_ms = ?2 "
        "WHERE lock_name = 'primary' AND owner_id = ?3 AND expires_at_ms > ?1;"
    );
    sqlite3_bind_int64(stmt.get(), 1, now_ms);
    sqlite3_bind_int64(stmt.get(), 2, now_ms + ttl_ms);
    bind_text_view(stmt.get(), 3, owner_id);
    if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
        return false;
    }
    return sqlite3_changes(db_.get()) == 1;
}

bool SessionStore::release_lease(std::string_view owner_id) {
    if (owner_id.empty()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "DELETE FROM store_leases WHERE lock_name = 'primary' AND owner_id = ?1;"
    );
    bind_text_view(stmt.get(), 1, owner_id);
    if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
        return false;
    }
    return sqlite3_changes(db_.get()) == 1;
}

std::optional<LeaseRecord> SessionStore::active_lease(std::int64_t now_ms) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "SELECT lock_name, owner_id, pid, acquired_at_ms, heartbeat_at_ms, expires_at_ms, lease_epoch "
        "FROM store_leases WHERE lock_name = 'primary' AND expires_at_ms > ?1;"
    );
    sqlite3_bind_int64(stmt.get(), 1, now_ms);
    if (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        return LeaseRecord{
            col_text(stmt.get(), 0),
            col_text(stmt.get(), 1),
            sqlite3_column_int64(stmt.get(), 2),
            sqlite3_column_int64(stmt.get(), 3),
            sqlite3_column_int64(stmt.get(), 4),
            sqlite3_column_int64(stmt.get(), 5),
            sqlite3_column_int64(stmt.get(), 6)
        };
    }
    return std::nullopt;
}

SessionRecord SessionStore::create_session(
    std::string_view title,
    std::string_view model_id,
    std::string_view effort,
    std::int64_t now_ms,
    std::string_view custom_id
) {
    const std::string clean_effort = effort.empty() ? "high" : std::string(effort);
    if (!is_valid_effort(clean_effort)) {
        throw std::invalid_argument("Unsupported reasoning effort: " + clean_effort);
    }
    const std::string clean_title = title.empty() ? "New Studio Session" : std::string(title);
    const std::string clean_model = model_id.empty()
        ? "claude-opus-4-6"
        : std::string(model_id);

    std::lock_guard<std::mutex> lock(mutex_);
    const std::string id = custom_id.empty()
        ? next_id("sess", now_ms)
        : std::string(custom_id);

    auto stmt = prepare_stmt(
        db_.get(),
        "INSERT INTO sessions (id, title, model_id, effort, created_at_ms, updated_at_ms, revision) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1);"
    );
    bind_text_view(stmt.get(), 1, id);
    bind_text_view(stmt.get(), 2, clean_title);
    bind_text_view(stmt.get(), 3, clean_model);
    bind_text_view(stmt.get(), 4, clean_effort);
    sqlite3_bind_int64(stmt.get(), 5, now_ms);
    if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
        throw std::runtime_error("Failed inserting session row");
    }

    return SessionRecord{id, clean_title, clean_model, clean_effort, now_ms, now_ms, 1};
}

bool SessionStore::update_session_settings(
    std::string_view session_id,
    std::string_view title,
    std::string_view model_id,
    std::string_view effort,
    std::int64_t now_ms,
    std::optional<std::int64_t> expected_revision
) {
    if (session_id.empty() || title.empty() || model_id.empty() || !is_valid_effort(effort)) {
        throw std::invalid_argument("Invalid session settings update arguments");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (expected_revision.has_value()) {
        auto stmt = prepare_stmt(
            db_.get(),
            "UPDATE sessions SET title = ?1, model_id = ?2, effort = ?3, "
            "updated_at_ms = ?4, revision = revision + 1 "
            "WHERE id = ?5 AND revision = ?6;"
        );
        bind_text_view(stmt.get(), 1, title);
        bind_text_view(stmt.get(), 2, model_id);
        bind_text_view(stmt.get(), 3, effort);
        sqlite3_bind_int64(stmt.get(), 4, now_ms);
        bind_text_view(stmt.get(), 5, session_id);
        sqlite3_bind_int64(stmt.get(), 6, *expected_revision);
        if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
            return false;
        }
        return sqlite3_changes(db_.get()) == 1;
    }

    auto stmt = prepare_stmt(
        db_.get(),
        "UPDATE sessions SET title = ?1, model_id = ?2, effort = ?3, "
        "updated_at_ms = ?4, revision = revision + 1 "
        "WHERE id = ?5;"
    );
    bind_text_view(stmt.get(), 1, title);
    bind_text_view(stmt.get(), 2, model_id);
    bind_text_view(stmt.get(), 3, effort);
    sqlite3_bind_int64(stmt.get(), 4, now_ms);
    bind_text_view(stmt.get(), 5, session_id);
    if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
        return false;
    }
    return sqlite3_changes(db_.get()) == 1;
}

std::optional<SessionRecord> SessionStore::get_session(std::string_view session_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "SELECT id, title, model_id, effort, created_at_ms, updated_at_ms, revision "
        "FROM sessions WHERE id = ?1;"
    );
    bind_text_view(stmt.get(), 1, session_id);
    if (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        return SessionRecord{
            col_text(stmt.get(), 0),
            col_text(stmt.get(), 1),
            col_text(stmt.get(), 2),
            col_text(stmt.get(), 3),
            sqlite3_column_int64(stmt.get(), 4),
            sqlite3_column_int64(stmt.get(), 5),
            sqlite3_column_int64(stmt.get(), 6)
        };
    }
    return std::nullopt;
}

SessionPage SessionStore::list_sessions_page(
    std::size_t limit,
    std::optional<SessionCursor> cursor
) const {
    const std::size_t safe_limit = limit == 0 ? 1 : (limit > 250 ? 250 : limit);
    std::lock_guard<std::mutex> lock(mutex_);

    std::size_t total = 0;
    {
        auto cnt = prepare_stmt(db_.get(), "SELECT COUNT(*) FROM sessions;");
        if (sqlite3_step(cnt.get()) == SQLITE_ROW) {
            total = static_cast<std::size_t>(sqlite3_column_int64(cnt.get(), 0));
        }
    }

    UniqueStmt stmt;
    if (cursor.has_value()) {
        stmt = prepare_stmt(
            db_.get(),
            "SELECT id, title, model_id, effort, created_at_ms, updated_at_ms, revision "
            "FROM sessions "
            "WHERE (updated_at_ms < ?1) OR (updated_at_ms = ?1 AND id < ?2) "
            "ORDER BY updated_at_ms DESC, id DESC LIMIT ?3;"
        );
        sqlite3_bind_int64(stmt.get(), 1, cursor->updated_at_ms);
        bind_text_view(stmt.get(), 2, cursor->id);
        sqlite3_bind_int64(stmt.get(), 3, static_cast<std::int64_t>(safe_limit + 1));
    } else {
        stmt = prepare_stmt(
            db_.get(),
            "SELECT id, title, model_id, effort, created_at_ms, updated_at_ms, revision "
            "FROM sessions "
            "ORDER BY updated_at_ms DESC, id DESC LIMIT ?1;"
        );
        sqlite3_bind_int64(stmt.get(), 1, static_cast<std::int64_t>(safe_limit + 1));
    }

    std::vector<SessionRecord> rows;
    rows.reserve(safe_limit + 1);
    while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        rows.push_back(SessionRecord{
            col_text(stmt.get(), 0),
            col_text(stmt.get(), 1),
            col_text(stmt.get(), 2),
            col_text(stmt.get(), 3),
            sqlite3_column_int64(stmt.get(), 4),
            sqlite3_column_int64(stmt.get(), 5),
            sqlite3_column_int64(stmt.get(), 6)
        });
    }

    SessionPage page;
    page.total_count = total;
    if (rows.size() > safe_limit) {
        rows.resize(safe_limit);
        const auto& last = rows.back();
        page.next_cursor = SessionCursor{last.updated_at_ms, last.id};
    }
    page.items = std::move(rows);
    return page;
}

StoredAttachment SessionStore::store_attachment(
    std::string_view session_id,
    std::string_view file_name,
    std::string_view mime_type,
    std::span<const std::uint8_t> bytes,
    AttachmentPlacement placement,
    std::optional<std::int64_t> caret_offset,
    std::int64_t now_ms
) {
    const std::string digest = core::sha256_hex(bytes);
    const std::string placement_str = (placement == AttachmentPlacement::Inline)
        ? "inline"
        : "tray";

    std::lock_guard<std::mutex> lock(mutex_);
    exec_sql("BEGIN IMMEDIATE;");
    try {
        auto blob_ins = prepare_stmt(
            db_.get(),
            "INSERT OR IGNORE INTO attachment_blobs "
            "(sha256, byte_len, mime_type, data, created_at_ms) "
            "VALUES (?1, ?2, ?3, ?4, ?5);"
        );
        bind_text_view(blob_ins.get(), 1, digest);
        sqlite3_bind_int64(blob_ins.get(), 2, static_cast<std::int64_t>(bytes.size()));
        bind_text_view(blob_ins.get(), 3, mime_type);
        std::uint8_t dummy = 0;
        const void* blob_ptr = bytes.empty() ? static_cast<const void*>(&dummy) : bytes.data();
        sqlite3_bind_blob(
            blob_ins.get(),
            4,
            blob_ptr,
            static_cast<int>(bytes.size()),
            SQLITE_TRANSIENT
        );
        sqlite3_bind_int64(blob_ins.get(), 5, now_ms);
        if (sqlite3_step(blob_ins.get()) != SQLITE_DONE) {
            throw std::runtime_error("Failed storing attachment blob");
        }
        const bool deduplicated = (sqlite3_changes(db_.get()) == 0);

        const std::string att_id = next_id("att", now_ms);
        auto att_ins = prepare_stmt(
            db_.get(),
            "INSERT INTO session_attachments "
            "(attachment_id, session_id, sha256, file_name, placement, caret_offset, created_at_ms) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);"
        );
        bind_text_view(att_ins.get(), 1, att_id);
        bind_text_view(att_ins.get(), 2, session_id);
        bind_text_view(att_ins.get(), 3, digest);
        bind_text_view(att_ins.get(), 4, file_name);
        bind_text_view(att_ins.get(), 5, placement_str);
        if (caret_offset.has_value()) {
            sqlite3_bind_int64(att_ins.get(), 6, *caret_offset);
        } else {
            sqlite3_bind_null(att_ins.get(), 6);
        }
        sqlite3_bind_int64(att_ins.get(), 7, now_ms);
        if (sqlite3_step(att_ins.get()) != SQLITE_DONE) {
            throw std::runtime_error("Failed storing session attachment reference");
        }

        exec_sql("COMMIT;");
        return StoredAttachment{
            att_id,
            std::string(session_id),
            digest,
            std::string(file_name),
            std::string(mime_type),
            static_cast<std::uint64_t>(bytes.size()),
            placement,
            caret_offset,
            now_ms,
            deduplicated
        };
    } catch (...) {
        try { exec_sql("ROLLBACK;"); } catch (...) {}
        throw;
    }
}

std::size_t SessionStore::unique_blob_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(db_.get(), "SELECT COUNT(*) FROM attachment_blobs;");
    if (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        return static_cast<std::size_t>(sqlite3_column_int64(stmt.get(), 0));
    }
    return 0;
}

std::vector<StoredAttachment> SessionStore::list_session_attachments(
    std::string_view session_id
) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "SELECT sa.attachment_id, sa.session_id, sa.sha256, sa.file_name, "
        "ab.mime_type, ab.byte_len, sa.placement, sa.caret_offset, sa.created_at_ms "
        "FROM session_attachments sa "
        "JOIN attachment_blobs ab ON ab.sha256 = sa.sha256 "
        "WHERE sa.session_id = ?1 ORDER BY sa.created_at_ms ASC, sa.attachment_id ASC;"
    );
    bind_text_view(stmt.get(), 1, session_id);
    std::vector<StoredAttachment> out;
    while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        std::optional<std::int64_t> caret;
        if (sqlite3_column_type(stmt.get(), 7) != SQLITE_NULL) {
            caret = sqlite3_column_int64(stmt.get(), 7);
        }
        const std::string pl = col_text(stmt.get(), 6);
        out.push_back(StoredAttachment{
            col_text(stmt.get(), 0),
            col_text(stmt.get(), 1),
            col_text(stmt.get(), 2),
            col_text(stmt.get(), 3),
            col_text(stmt.get(), 4),
            static_cast<std::uint64_t>(sqlite3_column_int64(stmt.get(), 5)),
            pl == "inline" ? AttachmentPlacement::Inline : AttachmentPlacement::Tray,
            caret,
            sqlite3_column_int64(stmt.get(), 8),
            false
        });
    }
    return out;
}

std::optional<std::vector<std::uint8_t>> SessionStore::read_blob(std::string_view sha256) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "SELECT data FROM attachment_blobs WHERE sha256 = ?1;"
    );
    bind_text_view(stmt.get(), 1, sha256);
    if (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        const auto* raw = static_cast<const std::uint8_t*>(sqlite3_column_blob(stmt.get(), 0));
        const int len = sqlite3_column_bytes(stmt.get(), 0);
        if (raw == nullptr || len <= 0) {
            return std::vector<std::uint8_t>{};
        }
        return std::vector<std::uint8_t>(raw, raw + len);
    }
    return std::nullopt;
}

RunJournalEntry SessionStore::append_run_journal(
    std::string_view session_id,
    std::string_view run_id,
    std::string_view event_kind,
    std::string_view payload_json,
    std::int64_t now_ms
) {
    const std::string redacted = core::SecretRedactor::redact(payload_json);
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "INSERT INTO run_journal (session_id, run_id, event_kind, payload_json, created_at_ms) "
        "VALUES (?1, ?2, ?3, ?4, ?5);"
    );
    bind_text_view(stmt.get(), 1, session_id);
    bind_text_view(stmt.get(), 2, run_id);
    bind_text_view(stmt.get(), 3, event_kind);
    bind_text_view(stmt.get(), 4, redacted);
    sqlite3_bind_int64(stmt.get(), 5, now_ms);
    if (sqlite3_step(stmt.get()) != SQLITE_DONE) {
        throw std::runtime_error("Failed appending run_journal row");
    }
    const std::int64_t seq = sqlite3_last_insert_rowid(db_.get());
    return RunJournalEntry{
        seq,
        std::string(session_id),
        std::string(run_id),
        std::string(event_kind),
        redacted,
        now_ms
    };
}

std::vector<RunJournalEntry> SessionStore::list_run_journal(
    std::string_view session_id,
    std::int64_t since_seq
) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto stmt = prepare_stmt(
        db_.get(),
        "SELECT seq, session_id, run_id, event_kind, payload_json, created_at_ms "
        "FROM run_journal WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC;"
    );
    bind_text_view(stmt.get(), 1, session_id);
    sqlite3_bind_int64(stmt.get(), 2, since_seq);
    std::vector<RunJournalEntry> out;
    while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
        out.push_back(RunJournalEntry{
            sqlite3_column_int64(stmt.get(), 0),
            col_text(stmt.get(), 1),
            col_text(stmt.get(), 2),
            col_text(stmt.get(), 3),
            col_text(stmt.get(), 4),
            sqlite3_column_int64(stmt.get(), 5)
        });
    }
    return out;
}

} // namespace omnia::storage
