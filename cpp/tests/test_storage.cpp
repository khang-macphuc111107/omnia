#include "test_support.hpp"

#include "omnia/storage/session_store.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <set>
#include <string>
#include <vector>

namespace {

struct TempDbDir {
    std::filesystem::path dir;
    TempDbDir() {
        const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        dir = std::filesystem::temp_directory_path() /
              ("omnia-cpp-storage-test-" + std::to_string(stamp));
        std::filesystem::create_directories(dir);
    }
    ~TempDbDir() {
        std::error_code ec;
        std::filesystem::remove_all(dir, ec);
    }
};

} // namespace

int main() {
    TempDbDir tmp{};
    const std::string db_file = (tmp.dir / "sessions.sqlite3").generic_string();

    {
        omnia::storage::SessionStore store(db_file);
        OMNIA_CHECK(store.journal_mode() == "wal");

        // 1. Cooperative Process Ownership Lease
        const auto l1 = store.acquire_lease("owner-alpha", 4100, 10000, 1000);
        OMNIA_CHECK(l1.has_value());
        OMNIA_CHECK(l1->lease_epoch == 1);

        // Competing owner rejected while lease is active
        const auto competing = store.acquire_lease("owner-beta", 4200, 10000, 5000);
        OMNIA_CHECK(!competing.has_value());

        // Heartbeat extends owner-alpha
        OMNIA_CHECK(store.heartbeat("owner-alpha", 10000, 8000));
        OMNIA_CHECK(!store.heartbeat("owner-beta", 10000, 8000));

        // Still active at t=15000 because heartbeat extended to 18000
        OMNIA_CHECK(!store.acquire_lease("owner-beta", 4200, 10000, 15000).has_value());

        // Expired at t=19000 -> owner-beta takes over with incremented epoch
        const auto takeover = store.acquire_lease("owner-beta", 4200, 10000, 19000);
        OMNIA_CHECK(takeover.has_value());
        OMNIA_CHECK(takeover->owner_id == "owner-beta");
        OMNIA_CHECK(takeover->lease_epoch == 2);

        OMNIA_CHECK(store.release_lease("owner-beta"));
        OMNIA_CHECK(!store.active_lease(19500).has_value());

        // 2. Session Settings & Keyset Paging
        for (int i = 0; i < 13; ++i) {
            (void)store.create_session(
                "Session #" + std::to_string(i),
                "claude-opus-4-6",
                "high",
                10000 + (i / 2) * 100 // intentional timestamp ties to test tie-breaking!
            );
        }

        std::set<std::string> seen_ids;
        std::optional<omnia::storage::SessionCursor> cur;
        std::size_t pages = 0;
        while (true) {
            const auto page = store.list_sessions_page(5, cur);
            OMNIA_CHECK(page.total_count == 13);
            for (const auto& s : page.items) {
                OMNIA_CHECK(seen_ids.insert(s.id).second);
            }
            ++pages;
            if (!page.next_cursor.has_value()) {
                break;
            }
            cur = page.next_cursor;
        }
        OMNIA_CHECK(pages == 3);
        OMNIA_CHECK(seen_ids.size() == 13);

        const auto created = store.create_session("Editable", "gemini-3-1-pro", "medium", 50000);
        OMNIA_CHECK(store.update_session_settings(
            created.id, "Edited Title", "gpt-5-4-codex", "max", 51000, 1
        ));
        // Stale revision 1 must now fail CAS
        OMNIA_CHECK(!store.update_session_settings(
            created.id, "Conflicting Edit", "gpt-5-4-codex", "low", 52000, 1
        ));
        const auto reloaded = store.get_session(created.id);
        OMNIA_CHECK(reloaded.has_value());
        OMNIA_CHECK(reloaded->title == "Edited Title");
        OMNIA_CHECK(reloaded->revision == 2);

        // 3. SHA-256 Deduplicated Inline + Tray Attachments
        const std::vector<std::uint8_t> payload = {'O', 'm', 'n', 'i', 'a', '-', 'C', '+', '+', '2', '0'};
        const auto inline_att = store.store_attachment(
            created.id,
            "diagram.svg",
            "image/svg+xml",
            payload,
            omnia::storage::AttachmentPlacement::Inline,
            18,
            60000
        );
        OMNIA_CHECK(!inline_att.deduplicated);
        OMNIA_CHECK(store.unique_blob_count() == 1);

        const auto tray_att = store.store_attachment(
            created.id,
            "diagram-copy.svg",
            "image/svg+xml",
            payload,
            omnia::storage::AttachmentPlacement::Tray,
            std::nullopt,
            60010
        );
        OMNIA_CHECK(tray_att.deduplicated);
        OMNIA_CHECK(tray_att.sha256 == inline_att.sha256);
        OMNIA_CHECK(store.unique_blob_count() == 1);
        OMNIA_CHECK(store.list_session_attachments(created.id).size() == 2);
        const auto raw_back = store.read_blob(inline_att.sha256);
        OMNIA_CHECK(raw_back.has_value() && *raw_back == payload);

        // 4. Secret-Redacted Run Journal
        const std::string fake_secret = std::string("sk") + "-" + std::string(18, 'X');
        const auto j1 = store.append_run_journal(
            created.id,
            "run-1",
            "provider_error",
            "{\"detail\":\"Upstream header leaked " + fake_secret + "\"}",
            61000
        );
        OMNIA_CHECK(j1.payload_json.find(fake_secret) == std::string::npos);
        OMNIA_CHECK(j1.payload_json.find("[REDACTED_SECRET]") != std::string::npos);
        OMNIA_CHECK(store.list_run_journal(created.id, 0).size() == 1);
    }

    std::cout << "[PASS] test_omnia_storage (winsqlite3 WAL, Leases, Paging, Dedup Blobs, Journal)\n";
    return 0;
}
