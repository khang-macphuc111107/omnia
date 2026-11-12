#include "test_support.hpp"

#include "omnia/core/json.hpp"
#include "omnia/studio/studio_server.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#endif

#include <chrono>
#include <filesystem>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {

struct RawHttpReply {
    int status = 0;
    std::string headers;
    std::string body;
};

RawHttpReply send_loopback_http(
    std::uint16_t port,
    std::string_view method,
    std::string_view target,
    std::string_view body = "",
    std::string_view origin_hdr = "",
    std::string_view custom_host = ""
) {
    WSADATA wsa{};
    (void)WSAStartup(MAKEWORD(2, 2), &wsa);

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    OMNIA_CHECK(s != INVALID_SOCKET);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    OMNIA_CHECK(connect(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0);

    const std::string host = custom_host.empty()
        ? ("127.0.0.1:" + std::to_string(port))
        : std::string(custom_host);

    std::string req;
    req.append(method).append(" ").append(target).append(" HTTP/1.1\r\n");
    req.append("Host: ").append(host).append("\r\n");
    if (!origin_hdr.empty()) {
        req.append("Origin: ").append(origin_hdr).append("\r\n");
    }
    if (!body.empty() || method == "POST") {
        req.append("Content-Type: application/json\r\n");
        req.append("Content-Length: ").append(std::to_string(body.size())).append("\r\n");
    }
    req.append("Connection: close\r\n\r\n");
    req.append(body);

    OMNIA_CHECK(send(s, req.data(), static_cast<int>(req.size()), 0) == static_cast<int>(req.size()));

    std::string raw;
    char buf[4096];
    while (true) {
        const int n = recv(s, buf, static_cast<int>(sizeof(buf)), 0);
        if (n <= 0) break;
        raw.append(buf, static_cast<std::size_t>(n));
    }
    closesocket(s);

    const std::size_t split = raw.find("\r\n\r\n");
    OMNIA_CHECK(split != std::string::npos);

    RawHttpReply out{};
    out.headers = raw.substr(0, split);
    out.body = raw.substr(split + 4);

    const std::size_t sp1 = out.headers.find(' ');
    OMNIA_CHECK(sp1 != std::string::npos);
    out.status = std::atoi(out.headers.c_str() + sp1 + 1);
    return out;
}

void verify_all_studio_endpoints(std::uint16_t port, bool has_real_ui_root) {
    using omnia::core::JsonValue;

    // 1. GET / and static UI assets when --ui-root is mounted
    const auto root_html = send_loopback_http(port, "GET", "/");
    OMNIA_CHECK(root_html.status == 200);
    OMNIA_CHECK(!root_html.body.empty());
    if (has_real_ui_root) {
        OMNIA_CHECK(root_html.body.find("Omnia Studio") != std::string::npos);
        const auto css_res = send_loopback_http(port, "GET", "/styles/tokens.css");
        OMNIA_CHECK(css_res.status == 200);
        OMNIA_CHECK(!css_res.body.empty());
        const auto js_res = send_loopback_http(port, "GET", "/app/api.js");
        OMNIA_CHECK(js_res.status == 200);
        OMNIA_CHECK(!js_res.body.empty());
    }

    // Static traversal guard
    const auto trav_attempt = send_loopback_http(port, "GET", "/..%2fCMakeLists.txt");
    OMNIA_CHECK(trav_attempt.status == 403 || trav_attempt.status == 404);

    // 2. GET /api/health
    const auto health_res = send_loopback_http(port, "GET", "/api/health");
    OMNIA_CHECK(health_res.status == 200);
    const auto health = JsonValue::parse(health_res.body);
    OMNIA_CHECK(health.prop_bool("ok"));
    OMNIA_CHECK(health.prop_string("engine") == "Omnia Native C++20");
    OMNIA_CHECK(health.prop_int64("rustFiles", -1) == 0);
    OMNIA_CHECK(health.prop_int64("cplusplus") >= 202002);
    OMNIA_CHECK(health.prop_int64("peerCount") == 6);
    OMNIA_CHECK(health.prop_int64("workingSetBytes") > 0);

    // 3. Cross-Origin & Host Security Guards (`deep-cors-diagnostics`)
    const auto evil_post = send_loopback_http(
        port, "POST", "/api/steer/enqueue", R"({"text":"attack"})", "https://evil.example"
    );
    OMNIA_CHECK(evil_post.status == 403);

    const auto evil_opt = send_loopback_http(
        port, "OPTIONS", "/api/router/decide", "", "https://evil.example"
    );
    OMNIA_CHECK(evil_opt.status == 403);

    const auto evil_host = send_loopback_http(
        port, "GET", "/api/health", "", "", "evil.rebind.example"
    );
    OMNIA_CHECK(evil_host.status == 403);

    const std::string valid_origin = "http://127.0.0.1:" + std::to_string(port);

    // 4. GET /api/graph, POST /api/graph/send, GET /api/graph/traverse
    const auto graph_res = send_loopback_http(port, "GET", "/api/graph");
    OMNIA_CHECK(graph_res.status == 200);
    const auto gjson = JsonValue::parse(graph_res.body);
    OMNIA_CHECK(gjson.find("nodes")->as_array().size() == 6);
    OMNIA_CHECK(!gjson.find("links")->as_array().empty());

    const auto gsend_res = send_loopback_http(
        port,
        "POST",
        "/api/graph/send",
        R"({"from":"ui-atelier","to":"cpp-core","text":"Audit C++20 HTTP host","broadcast":false})",
        valid_origin
    );
    OMNIA_CHECK(gsend_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(gsend_res.body).prop_bool("ok"));

    const auto gtrav_res = send_loopback_http(
        port, "GET", "/api/graph/traverse?entity=omnia-studio&direction=Forward&maxDepth=3"
    );
    OMNIA_CHECK(gtrav_res.status == 200);
    const auto gtrav = JsonValue::parse(gtrav_res.body);
    OMNIA_CHECK(!gtrav.find("visited")->as_array().empty());
    OMNIA_CHECK(gtrav.find("visited")->as_array().front().is_string());
    OMNIA_CHECK(!gtrav.find("quarantinedAmbiguous")->as_array().empty());

    const auto dod_trav_res = send_loopback_http(
        port, "GET", "/api/graph/traverse?entity=DOD-14&direction=Both&maxDepth=3"
    );
    OMNIA_CHECK(dod_trav_res.status == 200);
    OMNIA_CHECK(!JsonValue::parse(dod_trav_res.body).find("quarantinedAmbiguous")->as_array().empty());

    // 5. GET /api/router/state & POST /api/router/decide (incl. tripCandidate / resetCandidate & strict local)
    const auto rstate_res = send_loopback_http(port, "GET", "/api/router/state");
    OMNIA_CHECK(rstate_res.status == 200);
    const auto rstate = JsonValue::parse(rstate_res.body);
    const auto& rcands = rstate.find("candidates")->as_array();
    OMNIA_CHECK(rcands.size() == 5);
    bool verified_unknown_null_quota = false;
    for (const auto& c : rcands) {
        if (c.prop_string("id") == "cloud-fast-unverified") {
            OMNIA_CHECK(c.prop_string("quotaState") == "Unknown");
            OMNIA_CHECK(c.find("remainingTokens")->is_null());
            verified_unknown_null_quota = true;
        }
    }
    OMNIA_CHECK(verified_unknown_null_quota);

    const auto rlocal_res = send_loopback_http(
        port,
        "POST",
        "/api/router/decide",
        R"({"taskClass":"code_generation","estimatedTokens":4096,"privacyTier":"strict_local_zero_retention","requireStreaming":true})",
        valid_origin
    );
    OMNIA_CHECK(rlocal_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(rlocal_res.body).prop_string("selectedCandidateId") == "local-cpp-llama-q8");

    const auto rdec_res = send_loopback_http(
        port,
        "POST",
        "/api/router/decide",
        R"({"taskClass":"code_generation","estimatedTokens":4096,"privacyTier":"enterprise_zdr","requireStreaming":true,"tripCandidate":"google-gemini-3-1-pro"})",
        valid_origin
    );
    OMNIA_CHECK(rdec_res.status == 200);
    const auto rdec = JsonValue::parse(rdec_res.body);
    OMNIA_CHECK(rdec.prop_bool("ok"));
    OMNIA_CHECK(rdec.prop_string("selectedCandidateId") != "google-gemini-3-1-pro");

    const auto rreset_res = send_loopback_http(
        port,
        "POST",
        "/api/router/decide",
        R"({"taskClass":"code_generation","estimatedTokens":2048,"privacyTier":"enterprise_zdr","requireStreaming":true,"resetCandidate":"google-gemini-3-1-pro"})",
        valid_origin
    );
    OMNIA_CHECK(rreset_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(rreset_res.body).prop_bool("ok"));

    // 6. Memory GET / Upsert / Erase
    const auto mup_res = send_loopback_http(
        port,
        "POST",
        "/api/memory/upsert",
        R"({"namespace":"workspace/qa","key":"http-live","content":"Verified over loopback","tier":"Working"})",
        valid_origin
    );
    OMNIA_CHECK(mup_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(mup_res.body).prop_bool("ok"));

    const auto mer_res = send_loopback_http(
        port,
        "POST",
        "/api/memory/erase",
        R"({"id":"workspace/qa/http-live"})",
        valid_origin
    );
    OMNIA_CHECK(mer_res.status == 200);
    const auto mer = JsonValue::parse(mer_res.body);
    OMNIA_CHECK(mer.find("receipt")->prop_bool("verifiedPlaintextFree"));

    // 7. POST /api/rag/plan
    const auto rag_res = send_loopback_http(
        port,
        "POST",
        "/api/rag/plan",
        R"({"query":"Ki\u1ebfn tr\u00fac C++20 router v\u00e0 winsqlite3 WAL ho\u1ea1t \u0111\u1ed9ng nh\u01b0 th\u1ebf n\u00e0o?"})",
        valid_origin
    );
    OMNIA_CHECK(rag_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(rag_res.body).prop_bool("shouldRetrieve"));

    // 8. GET /api/skills?q=cpp & bilingual Vietnamese query
    const auto sk_res = send_loopback_http(port, "GET", "/api/skills?q=cpp");
    OMNIA_CHECK(sk_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(sk_res.body).prop_int64("total") >= 1);

    const auto sk_vn_res = send_loopback_http(port, "GET", "/api/skills?q=ti%E1%BA%BFng+vi%E1%BB%87t");
    OMNIA_CHECK(sk_vn_res.status == 200);
    if (has_real_ui_root) {
        OMNIA_CHECK(JsonValue::parse(sk_vn_res.body).prop_int64("total") >= 1);
    }

    // 9. GET /api/composer/templates & /api/steer & /api/steer/enqueue
    const auto tpl_res = send_loopback_http(port, "GET", "/api/composer/templates");
    OMNIA_CHECK(tpl_res.status == 200);
    OMNIA_CHECK(JsonValue::parse(tpl_res.body).find("templates")->as_array().size() == 15);

    const auto st_enq = send_loopback_http(
        port,
        "POST",
        "/api/steer/enqueue",
        R"({"text":"Verify zero-drop additive steer"})",
        valid_origin
    );
    OMNIA_CHECK(st_enq.status == 200);
    const auto st_json = JsonValue::parse(st_enq.body);
    OMNIA_CHECK(st_json.find("tokenBudget")->is_null());

    // 10. GET /api/sessions & POST /api/sessions/create
    const auto sess_create = send_loopback_http(
        port,
        "POST",
        "/api/sessions/create",
        R"({"title":"HTTP QA Session","modelId":"claude-opus-4-6","effort":"high"})",
        valid_origin
    );
    OMNIA_CHECK(sess_create.status == 200);
    const auto sc_json = JsonValue::parse(sess_create.body);
    OMNIA_CHECK(sc_json.find("sessions")->as_array().size() >= 4);
    OMNIA_CHECK(sc_json.find("session") != nullptr);
}

#ifdef _WIN32
struct ChildProcessGuard {
    PROCESS_INFORMATION pi{};
    bool active = false;
    ~ChildProcessGuard() noexcept {
        if (active) {
            TerminateProcess(pi.hProcess, 0);
            WaitForSingleObject(pi.hProcess, 3000);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }
};

std::uint16_t find_free_loopback_port() {
    WSADATA wsa{};
    (void)WSAStartup(MAKEWORD(2, 2), &wsa);
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    OMNIA_CHECK(s != INVALID_SOCKET);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    OMNIA_CHECK(bind(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0);
    int len = sizeof(addr);
    OMNIA_CHECK(getsockname(s, reinterpret_cast<sockaddr*>(&addr), &len) == 0);
    const std::uint16_t p = ntohs(addr.sin_port);
    closesocket(s);
    return p;
}
#endif

} // namespace

int main(int argc, char* argv[]) {
    std::filesystem::path studio_exe;
    std::filesystem::path repo_root;
    if (argc >= 2) studio_exe = std::filesystem::path(argv[1]);
    if (argc >= 3) repo_root = std::filesystem::path(argv[2]);

    const bool has_ui = !repo_root.empty() && std::filesystem::exists(repo_root / "ui" / "index.html");

    // Phase A: In-process StudioServer on OS-assigned ephemeral loopback port
    {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        if (!repo_root.empty()) {
            cfg.skills_root = repo_root / ".agents" / "skills";
            cfg.ui_root = repo_root / "ui";
        }
        omnia::studio::StudioServer server(std::move(cfg));
        server.start();
        OMNIA_CHECK(server.bound_port() > 0);
        verify_all_studio_endpoints(server.bound_port(), has_ui);
        server.stop();
    }

    // Phase B: Spawned real `omnia-studio.exe` child binary over loopback HTTP + zero-orphan cleanup
#ifdef _WIN32
    if (!studio_exe.empty() && std::filesystem::exists(studio_exe)) {
        const std::uint16_t child_port = find_free_loopback_port();
        std::wstring cmd = L"\"" + studio_exe.wstring() + L"\" --port " + std::to_wstring(child_port);
        if (!repo_root.empty() && std::filesystem::exists(repo_root / "ui")) {
            cmd += L" --ui-root \"" + (repo_root / "ui").wstring() + L"\"";
        }
        if (!repo_root.empty() && std::filesystem::exists(repo_root / ".agents" / "skills")) {
            cmd += L" --skills-root \"" + (repo_root / ".agents" / "skills").wstring() + L"\"";
        }

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        ChildProcessGuard child{};
        std::vector<wchar_t> mutable_cmd(cmd.begin(), cmd.end());
        mutable_cmd.push_back(L'\0');

        const BOOL ok = CreateProcessW(
            nullptr,
            mutable_cmd.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &si,
            &child.pi
        );
        OMNIA_CHECK(ok != 0);
        child.active = true;

        bool ready = false;
        for (int attempt = 0; attempt < 40; ++attempt) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            try {
                WSADATA wsa{};
                (void)WSAStartup(MAKEWORD(2, 2), &wsa);
                SOCKET probe = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
                sockaddr_in addr{};
                addr.sin_family = AF_INET;
                addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                addr.sin_port = htons(child_port);
                if (connect(probe, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0) {
                    closesocket(probe);
                    ready = true;
                    break;
                }
                closesocket(probe);
            } catch (...) {}
        }
        OMNIA_CHECK(ready);
        verify_all_studio_endpoints(child_port, has_ui);
    }
#endif

    std::cout << "[PASS] test_omnia_studio_http (12 /api/* Contracts + 403 Origin/Host Guards + Process Spawn)\n";
    return 0;
}
