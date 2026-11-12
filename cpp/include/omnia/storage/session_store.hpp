#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

struct sqlite3;

namespace omnia::storage {

struct LeaseRecord {
    std::string lock_name;
    std::string owner_id;
    std::int64_t pid = 0;
    std::int64_t acquired_at_ms = 0;
    std::int64_t heartbeat_at_ms = 0;
    std::int64_t expires_at_ms = 0;
    std::int64_t lease_epoch = 0;
};

struct SessionRecord {
    std::string id;
    std::string title;
    std::string model_id;
    std::string effort;
    std::int64_t created_at_ms = 0;
    std::int64_t updated_at_ms = 0;
    std::int64_t revision = 1;
};

struct SessionCursor {
    std::int64_t updated_at_ms = 0;
    std::string id;
};

struct SessionPage {
    std::vector<SessionRecord> items;
    std::optional<SessionCursor> next_cursor;
    std::size_t total_count = 0;
};

enum class AttachmentPlacement {
    Inline,
    Tray
};

struct StoredAttachment {
    std::string attachment_id;
    std::string session_id;
    std::string sha256;
    std::string file_name;
    std::string mime_type;
    std::uint64_t byte_len = 0;
    AttachmentPlacement placement = AttachmentPlacement::Tray;
    std::optional<std::int64_t> caret_offset;
    std::int64_t created_at_ms = 0;
    bool deduplicated = false;
};

struct RunJournalEntry {
    std::int64_t seq = 0;
    std::string session_id;
    std::string run_id;
    std::string event_kind;
    std::string payload_json;
    std::int64_t created_at_ms = 0;
};

class SessionStore {
public:
    explicit SessionStore(std::string_view db_path);
    ~SessionStore();

    SessionStore(const SessionStore&) = delete;
    SessionStore& operator=(const SessionStore&) = delete;

    std::string journal_mode() const;

    // Cooperative Process Ownership Lease
    std::optional<LeaseRecord> acquire_lease(
        std::string_view owner_id,
        std::int64_t pid,
        std::int64_t ttl_ms,
        std::int64_t now_ms
    );
    bool heartbeat(std::string_view owner_id, std::int64_t ttl_ms, std::int64_t now_ms);
    bool release_lease(std::string_view owner_id);
    std::optional<LeaseRecord> active_lease(std::int64_t now_ms) const;

    // Session CRUD & Keyset Paging
    SessionRecord create_session(
        std::string_view title,
        std::string_view model_id,
        std::string_view effort,
        std::int64_t now_ms,
        std::string_view custom_id = ""
    );

    bool update_session_settings(
        std::string_view session_id,
        std::string_view title,
        std::string_view model_id,
        std::string_view effort,
        std::int64_t now_ms,
        std::optional<std::int64_t> expected_revision = std::nullopt
    );

    std::optional<SessionRecord> get_session(std::string_view session_id) const;

    SessionPage list_sessions_page(
        std::size_t limit,
        std::optional<SessionCursor> cursor = std::nullopt
    ) const;

    // SHA-256 Content-Addressed Inline & Tray Attachments
    StoredAttachment store_attachment(
        std::string_view session_id,
        std::string_view file_name,
        std::string_view mime_type,
        std::span<const std::uint8_t> bytes,
        AttachmentPlacement placement,
        std::optional<std::int64_t> caret_offset,
        std::int64_t now_ms
    );

    std::size_t unique_blob_count() const;
    std::vector<StoredAttachment> list_session_attachments(std::string_view session_id) const;
    std::optional<std::vector<std::uint8_t>> read_blob(std::string_view sha256) const;

    // Secret-Redacted Append-Only Run Journal
    RunJournalEntry append_run_journal(
        std::string_view session_id,
        std::string_view run_id,
        std::string_view event_kind,
        std::string_view payload_json,
        std::int64_t now_ms
    );
    std::vector<RunJournalEntry> list_run_journal(
        std::string_view session_id,
        std::int64_t since_seq = 0
    ) const;

private:
    struct SqliteCloser {
        void operator()(sqlite3* db) const noexcept;
    };

    mutable std::mutex mutex_;
    std::unique_ptr<sqlite3, SqliteCloser> db_;
    std::uint64_t id_counter_ = 0;

    void exec_sql(const char* sql) const;
    std::string next_id(std::string_view prefix, std::int64_t now_ms);
};

} // namespace omnia::storage
