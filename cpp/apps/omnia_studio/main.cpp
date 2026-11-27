#include "omnia/studio/studio_server.hpp"

#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string_view>

namespace {

volatile std::sig_atomic_t g_stop_requested = 0;

void handle_signal(int) noexcept {
    // Signal handlers may only touch lock-free signal state. Lifecycle
    // teardown (Winsock, threads and SQLite) runs on the main thread below.
    g_stop_requested = 1;
}

} // namespace

int main(int argc, char* argv[]) {
    omnia::studio::StudioConfig cfg{};

    for (int i = 1; i < argc; ++i) {
        const std::string_view arg(argv[i]);
        if (arg == "--port" && i + 1 < argc) {
            const unsigned long p = std::strtoul(argv[++i], nullptr, 10);
            cfg.port = static_cast<std::uint16_t>(p <= 65535UL ? p : 8787UL);
        } else if (arg == "--ui-root" && i + 1 < argc) {
            cfg.ui_root = std::filesystem::path(argv[++i]);
        } else if (arg == "--db" && i + 1 < argc) {
            cfg.db_path = argv[++i];
        } else if (arg == "--skills-root" && i + 1 < argc) {
            cfg.skills_root = std::filesystem::path(argv[++i]);
        } else if (arg == "--demo") {
            cfg.demo_mode = true;
        } else if (arg == "--open-window") {
            cfg.open_window = true;
        } else if (arg == "--help" || arg == "-h") {
            std::cout
                << "Omnia Native C++20 Studio Desktop & API Host\n"
                << "Usage: omnia-studio [--port 8787] [--ui-root <path>] "
                << "[--db <sqlite-path>] [--skills-root <path>] [--demo] [--open-window]\n";
            return 0;
        }
    }

    if (cfg.ui_root.empty()) {
        std::error_code ec;
        if (std::filesystem::exists("ui/index.html", ec)) {
            cfg.ui_root = "ui";
        }
    }
    if (cfg.skills_root.empty()) {
        std::error_code ec;
        if (std::filesystem::exists(".agents/skills", ec)) {
            cfg.skills_root = ".agents/skills";
        }
    }

    try {
        omnia::studio::StudioServer server(std::move(cfg));
        std::signal(SIGINT, handle_signal);
        std::signal(SIGTERM, handle_signal);

        server.start();
        std::cout
            << "[omnia-studio] Listening on http://127.0.0.1:"
            << server.bound_port() << "\n"
            << std::flush;

        while (server.is_running() && g_stop_requested == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        server.stop();
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "[omnia-studio] Fatal error: " << ex.what() << "\n";
        return 1;
    }
}
