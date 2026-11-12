#include "omnia_native/sessions.hpp"
#include "omnia_native/store.hpp"
#include "omnia_native/types.hpp"

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <string>

int wmain(int argc, wchar_t* argv[]) {
    if (argc != 2 || !argv[1]) {
        std::cerr << "supply a new absolute fixture directory\n";
        return 1;
    }

    const std::filesystem::path directory(argv[1]);
    if (!directory.is_absolute()) {
        std::cerr << "fixture directory must be absolute\n";
        return 1;
    }

    std::error_code ec;
    if (std::filesystem::exists(directory, ec)) {
        std::cerr << "fixture directory must not already exist\n";
        return 1;
    }
    if (!std::filesystem::create_directory(directory, ec) || ec) {
        std::cerr << "failed to create fixture directory: " << ec.message() << "\n";
        return 1;
    }

    const std::filesystem::path database = directory / L"sessions.sqlite3";
    std::string active_id;
    omnia::native::AgentSessionSummary active;

    {
        auto opened = omnia::native::Sessions::open(database);
        if (opened.is_err()) {
            std::cerr << opened.error().to_string() << "\n";
            return 1;
        }
        auto created = opened.value().create("Off-page active");
        if (created.is_err()) {
            std::cerr << created.error().to_string() << "\n";
            return 1;
        }
        active = std::move(created.value());
        active_id = active.id;
        auto selected = opened.value().select(active_id, 0);
        if (selected.is_err() || selected.value().is_conflict()) {
            std::cerr << "failed to select initial active session\n";
            return 1;
        }
    }

    {
        auto store = omnia::native::HarnessStore::open(database);
        if (store.is_err()) {
            std::cerr << store.error().to_string() << "\n";
            return 1;
        }
        active.updated_at_ms = 1;
        auto saved_active = store.value()->save_summary(active);
        if (saved_active.is_err()) {
            std::cerr << saved_active.error().to_string() << "\n";
            return 1;
        }

        char id_buf[32]{};
        char title_buf[48]{};
        for (int index = 0; index < 124; ++index) {
            std::snprintf(id_buf, sizeof(id_buf), "paging-fixture-%04d", index);
            std::snprintf(title_buf, sizeof(title_buf), "Synthetic session %04d", index);
            omnia::native::AgentSessionSummary row = active;
            row.id = id_buf;
            row.title = title_buf;
            row.updated_at_ms = 100;
            auto saved = store.value()->save_summary(row);
            if (saved.is_err()) {
                std::cerr << saved.error().to_string() << "\n";
                return 1;
            }
        }
    }

    std::cout << omnia::native::wide_to_utf8(database.wstring()) << "\n";
    return 0;
}
