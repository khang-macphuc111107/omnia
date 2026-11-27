#include "test_support.hpp"

#include "omnia/core/json.hpp"
#include "omnia/studio/studio_server.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#endif

#include <chrono>
#include <algorithm>
#include <filesystem>
#include <iostream>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

struct RawHttpReply {
    int status = 0;
    std::string headers;
    std::string body;
};

RawHttpReply send_raw_loopback_http(std::uint16_t port, std::string_view req) {
    WSADATA wsa{};
    (void)WSAStartup(MAKEWORD(2, 2), &wsa);

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    OMNIA_CHECK(s != INVALID_SOCKET);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    OMNIA_CHECK(connect(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0);

    const DWORD timeout_ms = 10000;
    OMNIA_CHECK(setsockopt(s, SOL_SOCKET, SO_RCVTIMEO,
        reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms)) == 0);
    OMNIA_CHECK(setsockopt(s, SOL_SOCKET, SO_SNDTIMEO,
        reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms)) == 0);
    for (std::size_t sent = 0; sent < req.size();) {
        const int n = send(s, req.data() + sent,
            static_cast<int>(std::min<std::size_t>(req.size() - sent, 4096)), 0);
        OMNIA_CHECK(n > 0);
        sent += static_cast<std::size_t>(n);
    }
    // Half-close lets the server distinguish an incomplete body from a slow
    // client without waiting for the receive timeout in each negative case.
    (void)shutdown(s, SD_SEND);

    std::string raw;
    char buf[4096];
    while (true) {
        const int n = recv(s, buf, static_cast<int>(sizeof(buf)), 0);
        if (n <= 0) break;
        raw.append(buf, static_cast<std::size_t>(n));
    }
    closesocket(s);
    WSACleanup();

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

RawHttpReply send_loopback_http(
    std::uint16_t port,
    std::string_view method,
    std::string_view target,
    std::string_view body = "",
    std::string_view origin_hdr = "",
    std::string_view custom_host = "",
    bool omit_host = false
) {
    const std::string host = custom_host.empty()
        ? ("127.0.0.1:" + std::to_string(port)) : std::string(custom_host);
    std::string req;
    req.append(method).append(" ").append(target).append(" HTTP/1.1\r\n");
    if (!omit_host) req.append("Host: ").append(host).append("\r\n");
    if (!origin_hdr.empty()) req.append("Origin: ").append(origin_hdr).append("\r\n");
    if (!body.empty() || method == "POST") {
        req.append("Content-Type: application/json\r\n");
        req.append("Content-Length: ").append(std::to_string(body.size())).append("\r\n");
    }
    req.append("Connection: close\r\n\r\n").append(body);
    return send_raw_loopback_http(port, req);
}

void verify_http_framing(std::uint16_t port) {
    using omnia::core::JsonValue;
    const auto authority = "127.0.0.1:" + std::to_string(port);
    const auto health_prefix = "GET /api/health HTTP/1.1\r\nHost: " + authority + "\r\n";
    const auto before = JsonValue::parse(send_loopback_http(port, "GET", "/api/steer").body);
    const std::string body = R"({"text":"framing must reject before mutation"})";
    const auto mutation_prefix = "POST /api/steer/enqueue HTTP/1.1\r\nHost: " + authority + "\r\n";
    // A complete JSON prefix is still an incomplete HTTP request.
    const auto incomplete = send_raw_loopback_http(port, mutation_prefix + "Content-Length: " +
        std::to_string(body.size() + 1) + "\r\n\r\n" + body);
    OMNIA_CHECK(incomplete.status == 400);
    for (const auto value : {"", "garbage", "+0", "-1", "0junk", "0, 0", "1.5",
                             "18446744073709551616"}) {
        OMNIA_CHECK(send_raw_loopback_http(port,
            health_prefix + "Content-Length: " + value + "\r\n\r\n").status == 400);
    }
    for (const auto headers : {
        "Content-Length: 0\r\ncontent-length: 0",
        "Content-Length: 1\r\nContent-Length: 0",
        "Transfer-Encoding: chunked", "Transfer-Encoding: identity\r\nContent-Length: 0",
        "Content-Length : 0", " Host: ignored", "X-Missing-Colon", "X-Control: a\nb"
    }) {
        OMNIA_CHECK(send_raw_loopback_http(port, health_prefix + headers + "\r\n\r\n").status == 400);
    }
    OMNIA_CHECK(send_raw_loopback_http(port,
        mutation_prefix + "Content-Length: 1048577\r\n\r\n" + body).status == 413);
    OMNIA_CHECK(JsonValue::parse(send_loopback_http(port, "GET", "/api/steer").body) == before);
    OMNIA_CHECK(send_raw_loopback_http(port,
        health_prefix + "cOnTeNt-LeNgTh:\t0 \t\r\n\r\n").status == 200);
    OMNIA_CHECK(send_raw_loopback_http(port, health_prefix + "Content-Length: 1048576\r\n\r\n" +
        std::string(1024 * 1024, ' ')).status == 200);
    const std::string padding_prefix = health_prefix + "X-Padding: ";
    const auto padding_size = 16 * 1024 - padding_prefix.size() - 4;
    OMNIA_CHECK(send_raw_loopback_http(port,
        padding_prefix + std::string(padding_size, 'a') + "\r\n\r\n").status == 200);
    OMNIA_CHECK(send_raw_loopback_http(port,
        padding_prefix + std::string(padding_size + 1, 'a') + "\r\n\r\n").status == 431);
    for (const auto line : {"GET /api/health HTTP/9.9", "GET  /api/health HTTP/1.1",
                            "GET /api/health HTTP/1.1 extra", "GET\t /api/health HTTP/1.1",
                            "GET http://127.0.0.1/api/health HTTP/1.1"}) {
        OMNIA_CHECK(send_raw_loopback_http(port,
            std::string(line) + "\r\nHost: " + authority + "\r\n\r\n").status == 400);
    }
    OMNIA_CHECK(send_raw_loopback_http(port, "GET /" + std::string(4096, 'a') +
        " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n").status == 414);
    OMNIA_CHECK(send_raw_loopback_http(port, health_prefix + "X-Unfinished: ").status == 400);
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
    OMNIA_CHECK(health.prop_bool("demoMode"));
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

    // Only the authority actually served by this listener may access the API.
    const auto alternate_port = port == 65535 ? 65534 : port + 1;
    const auto steer_before = JsonValue::parse(send_loopback_http(port, "GET", "/api/steer").body);
    for (const auto& origin : std::vector<std::string>{
        "http://127.0.0.1:" + std::to_string(alternate_port),
        "http://localhost:" + std::to_string(port),
        "http://[::1]:" + std::to_string(port),
        "https://127.0.0.1:" + std::to_string(port),
        "http://127.0.0.1:0", "http://127.0.0.1:65536", "null",
        valid_origin + "/", valid_origin + "@evil.example", valid_origin + ", " + valid_origin
    }) {
        for (const auto method : {"POST", "OPTIONS", "GET"}) {
            const auto denied = send_loopback_http(port, method, "/api/steer/enqueue",
                R"({"text":"must not be enqueued"})", origin);
            OMNIA_CHECK(denied.status == 403);
            OMNIA_CHECK(denied.headers.find("Access-Control-Allow-Origin:") == std::string::npos);
        }
    }
    for (const auto& host : std::vector<std::string>{
        "127.0.0.1:" + std::to_string(alternate_port), "localhost:" + std::to_string(port),
        "[::1]:" + std::to_string(port), "127.0.0.1:0", "127.0.0.1:65536",
        "127.0.0.1:" + std::to_string(port) + "/", "127.0.0.1:abc"
    }) {
        OMNIA_CHECK(send_loopback_http(port, "GET", "/api/health", "", "", host).status == 403);
    }
    OMNIA_CHECK(JsonValue::parse(send_loopback_http(port, "GET", "/api/steer").body) == steer_before);
    const auto preflight = send_loopback_http(port, "OPTIONS", "/api/steer/enqueue", "", valid_origin);
    OMNIA_CHECK(preflight.status == 204);
    OMNIA_CHECK(preflight.headers.find("Access-Control-Allow-Origin: " + valid_origin) != std::string::npos);
    OMNIA_CHECK(send_loopback_http(port, "GET", "/api/health", "", "", "", true).status == 403);
    const auto valid_host = "127.0.0.1:" + std::to_string(port);
    for (const auto& extra : std::vector<std::string>{
        "\r\nHost: " + valid_host, "\r\nOrigin: ",
        "\r\nOrigin: http://127.0.0.1:1\r\nOrigin: " + valid_origin
    }) {
        OMNIA_CHECK(send_loopback_http(port, "GET", "/api/health", "", "", valid_host + extra).status == 400);
    }

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

    // Invalid budgets must be rejected before circuit changes or reservations.
    for (const auto token : {"1e100", "-1e100", "9223372036854775808", "64.9", "-1",
                            "0", "63", "1000001", "null", "true", "\"4096\"", "[]", "{}"}) {
        const std::string invalid = std::string("{\"estimatedTokens\":") + token +
            ",\"tripCandidate\":\"google-gemini-3-1-pro\"}";
        const auto rejected = send_loopback_http(port, "POST", "/api/router/decide", invalid, valid_origin);
        OMNIA_CHECK(rejected.status == 400);
        const auto error = JsonValue::parse(rejected.body);
        OMNIA_CHECK(error.prop_string("error") == "invalid_estimated_tokens");
        OMNIA_CHECK(error.prop_string("field") == "estimatedTokens");
        const auto after = JsonValue::parse(send_loopback_http(port, "GET", "/api/router/state").body);
        OMNIA_CHECK(*after.find("candidates") == *rstate.find("candidates"));
        OMNIA_CHECK(*after.find("recentReceipts") == *rstate.find("recentReceipts"));
    }

    // Simulation must be repeatable and side-effect free: it reports a
    // deterministic preview receipt without creating a reservation, consuming
    // quota/concurrency, or appending a durable recent receipt.
    const auto simulation_before = JsonValue::parse(
        send_loopback_http(port, "GET", "/api/router/state").body
    );
    for (int repeat = 0; repeat < 3; ++repeat) {
        const auto simulation_res = send_loopback_http(
            port,
            "POST",
            "/api/router/decide",
            R"({"taskClass":"code_generation","estimatedTokens":4096,"privacyTier":"enterprise_zdr","requireStreaming":true,"simulate":true,"idempotencyKey":"http-simulation-regression"})",
            valid_origin
        );
        OMNIA_CHECK(simulation_res.status == 200);
        const auto simulation = JsonValue::parse(simulation_res.body);
        OMNIA_CHECK(simulation.prop_bool("ok"));
        OMNIA_CHECK(simulation.prop_string("status") == "SIMULATED_DETERMINISTIC");
        const auto& simulation_receipt = *simulation.find("receipt");
        OMNIA_CHECK(simulation_receipt.prop_bool("simulated"));
        OMNIA_CHECK(simulation_receipt.prop_int64("sequenceId") == 0);
        OMNIA_CHECK(simulation_receipt.find("reservationId")->is_null());
        OMNIA_CHECK(simulation_receipt.prop_int64("reservedTokens") == 0);
    }
    const auto invalid_simulation = send_loopback_http(
        port,
        "POST",
        "/api/router/decide",
        R"({"estimatedTokens":4096,"simulate":true,"tripCandidate":"google-gemini-3-1-pro"})",
        valid_origin
    );
    OMNIA_CHECK(invalid_simulation.status == 400);
    OMNIA_CHECK(JsonValue::parse(invalid_simulation.body).prop_string("error") ==
        "simulation_cannot_change_circuit");
    const auto simulation_after = JsonValue::parse(
        send_loopback_http(port, "GET", "/api/router/state").body
    );
    OMNIA_CHECK(*simulation_after.find("candidates") == *simulation_before.find("candidates"));
    OMNIA_CHECK(*simulation_after.find("recentReceipts") == *simulation_before.find("recentReceipts"));

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
    verify_http_framing(port);
}

void test_session_paging_and_detail() {
    using omnia::core::JsonValue;
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto directory = std::filesystem::temp_directory_path() /
        ("omnia-http-paging-" + std::to_string(stamp));
    std::filesystem::create_directories(directory);
    const auto database = (directory / "sessions.sqlite3").generic_string();
    std::set<std::string> expected;
    {
        omnia::storage::SessionStore store(database);
        for (int i = 0; i < 53; ++i) {
            const auto id = "paging-" + std::to_string(i);
            store.create_session("Paging fixture", "test-model", "high", 1000, id);
            expected.insert(id); // every fixture shares a timestamp
        }
    }
    {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        cfg.db_path = database;
        cfg.demo_mode = true;
        omnia::studio::StudioServer server(std::move(cfg));
        server.start();
        const auto port = server.bound_port();
        const auto first = JsonValue::parse(send_loopback_http(port, "GET", "/api/sessions").body);
        OMNIA_CHECK(first.find("sessions")->as_array().size() == 50);
        OMNIA_CHECK(first.prop_int64("totalCount") == 56); // 53 fixture + 3 bootstrap
        std::set<std::string> seen;
        std::string cursor;
        std::string oldest;
        std::int64_t previous_time = INT64_MAX;
        std::string previous_id;
        std::size_t pages = 0;
        do {
            const auto response = send_loopback_http(port, "GET", "/api/sessions?limit=7" +
                (cursor.empty() ? "" : "&cursor=" + cursor));
            OMNIA_CHECK(response.status == 200);
            const auto payload = JsonValue::parse(response.body);
            OMNIA_CHECK(payload.prop_int64("totalCount") == 56);
            const auto& rows = payload.find("sessions")->as_array();
            OMNIA_CHECK(!rows.empty() && rows.size() <= 7);
            for (const auto& row : rows) {
                const auto id = row.prop_string("id");
                const auto time = row.prop_int64("updatedAt");
                OMNIA_CHECK(seen.insert(id).second);
                OMNIA_CHECK(time < previous_time || (time == previous_time && id < previous_id));
                previous_time = time;
                previous_id = id;
                oldest = id;
            }
            cursor = payload.prop_string("nextCursor");
            OMNIA_CHECK(++pages <= 8);
        } while (!cursor.empty());
        OMNIA_CHECK(seen.size() == 56 && pages == 8);
        for (const auto& id : expected) OMNIA_CHECK(seen.contains(id));
        for (const auto& row : first.find("sessions")->as_array()) {
            OMNIA_CHECK(row.prop_string("id") != oldest);
        }
        for (int refresh = 0; refresh < 2; ++refresh) {
            const auto detail = send_loopback_http(port, "GET", "/api/sessions/" + oldest);
            OMNIA_CHECK(detail.status == 200);
            const auto record = JsonValue::parse(detail.body);
            OMNIA_CHECK(record.find("session")->prop_string("id") == oldest);
        }
        OMNIA_CHECK(send_loopback_http(port, "GET", "/api/sessions/no-such-session").status == 404);
        for (const auto query : {"limit=", "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=999999999999",
                                  "cursor=", "cursor=x", "cursor=31.ff", "cursor=31.00", "cursor=31.2f", "cursor=31.61.62"}) {
            OMNIA_CHECK(send_loopback_http(port, "GET", std::string("/api/sessions?") + query).status == 400);
        }
        for (const auto id : {"%00", "%ff", "%2f", "%5c", ".."}) {
            OMNIA_CHECK(send_loopback_http(port, "GET", std::string("/api/sessions/") + id).status == 400);
        }
        server.stop();
    }
    // Reopening the same persistent database must not replay fixed bootstrap
    // IDs as duplicate INSERTs. This is the restart regression for AUD-01.
    {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        cfg.db_path = database;
        cfg.demo_mode = true;
        omnia::studio::StudioServer restarted(std::move(cfg));
        restarted.start();
        const auto reopened = JsonValue::parse(
            send_loopback_http(restarted.bound_port(), "GET", "/api/sessions").body
        );
        OMNIA_CHECK(reopened.prop_int64("totalCount") == 56);
        restarted.stop();
    }
    std::error_code ec;
    std::filesystem::remove_all(directory, ec); // only this test's unique external directory
}

void test_default_state_and_session_preservation() {
    using omnia::core::JsonValue;
    const auto directory = std::filesystem::temp_directory_path() /
        ("omnia-http-restart-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    OMNIA_CHECK(std::filesystem::create_directory(directory));
    const auto database = (directory / "sessions.sqlite3").generic_string();
    std::string created_id;
    JsonValue expected_session;
    for (int launch = 0; launch < 2; ++launch) {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        cfg.db_path = database;
        omnia::studio::StudioServer server(std::move(cfg));
        server.start();
        const auto port = server.bound_port();
        const auto sessions = JsonValue::parse(send_loopback_http(port, "GET", "/api/sessions").body);
        OMNIA_CHECK(sessions.prop_int64("totalCount") == launch);
        const auto health = JsonValue::parse(send_loopback_http(port, "GET", "/api/health").body);
        OMNIA_CHECK(health.prop_int64("peerCount") == 0);
        OMNIA_CHECK(!health.prop_bool("demoMode", true));
        const auto graph = JsonValue::parse(send_loopback_http(port, "GET", "/api/graph").body);
        OMNIA_CHECK(graph.find("nodes")->as_array().empty());
        const auto routing = JsonValue::parse(send_loopback_http(port, "GET", "/api/router/state").body);
        OMNIA_CHECK(routing.find("candidates")->as_array().empty());
        if (launch == 0) {
            const auto response = send_loopback_http(port, "POST", "/api/sessions/create",
                R"({"title":"Persistent user session","modelId":"user-model","effort":"medium"})");
            OMNIA_CHECK(response.status == 200);
            expected_session = *JsonValue::parse(response.body).find("session");
            created_id = expected_session.prop_string("id");
            const auto detail = send_loopback_http(port, "GET", "/api/sessions/" + created_id);
            OMNIA_CHECK(detail.status == 200);
            expected_session = *JsonValue::parse(detail.body).find("session");
        } else {
            const auto response = send_loopback_http(port, "GET", "/api/sessions/" + created_id);
            OMNIA_CHECK(response.status == 200);
            OMNIA_CHECK(*JsonValue::parse(response.body).find("session") == expected_session);
        }
        server.stop();
    }
    // Preserve an edited ID originally used by legacy demo bootstrap, too.
    {
        omnia::storage::SessionStore store(database);
        store.create_session("User-owned legacy ID", "custom-model", "low", 100, "sess-cpp20-atelier");
        OMNIA_CHECK(store.update_session_settings(
            "sess-cpp20-atelier", "Edited title", "edited-model", "max", 200, 1));
    }
    for (const bool demo : {false, true, true}) {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        cfg.db_path = database;
        cfg.demo_mode = demo;
        omnia::studio::StudioServer server(std::move(cfg));
        server.start();
        const auto payload = JsonValue::parse(
            send_loopback_http(server.bound_port(), "GET", "/api/sessions").body);
        OMNIA_CHECK(payload.prop_int64("totalCount") == (demo ? 4 : 2));
        const auto detail = JsonValue::parse(send_loopback_http(
            server.bound_port(), "GET", "/api/sessions/sess-cpp20-atelier").body);
        const auto& session = *detail.find("session");
        OMNIA_CHECK(session.prop_string("title") == "Edited title");
        OMNIA_CHECK(session.prop_string("modelId") == "edited-model");
        OMNIA_CHECK(session.prop_string("effort") == "max");
        OMNIA_CHECK(session.prop_int64("createdAt") == 100);
        OMNIA_CHECK(session.prop_int64("updatedAt") == 200);
        OMNIA_CHECK(session.prop_int64("revision") == 2);
        server.stop();
    }
    for (const auto name : {"sessions.sqlite3", "sessions.sqlite3-wal", "sessions.sqlite3-shm"}) {
        std::filesystem::remove(directory / name);
    }
    OMNIA_CHECK(std::filesystem::remove(directory));
}

void test_studio_lease_and_lifecycle_guards() {
    const auto directory = std::filesystem::temp_directory_path() /
        ("omnia-http-lease-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    OMNIA_CHECK(std::filesystem::create_directory(directory));
    const auto database = (directory / "sessions.sqlite3").generic_string();

    omnia::studio::StudioConfig cfg{};
    cfg.port = 0;
    cfg.db_path = database;
    omnia::studio::StudioServer first(cfg);
    bool rejected = false;
    try {
        omnia::studio::StudioServer competing(cfg);
    } catch (const std::exception&) {
        rejected = true;
    }
    OMNIA_CHECK(rejected);

    first.start();
    bool duplicate_loop_rejected = false;
    try {
        first.run_blocking();
    } catch (const std::logic_error&) {
        duplicate_loop_rejected = true;
    }
    OMNIA_CHECK(duplicate_loop_rejected);

    // Revoke the lease from a separate connection. Mutating API routes must
    // fail closed at the SQLite transaction boundary.
    {
        omnia::storage::SessionStore auditor(database);
        const auto lease = auditor.active_lease(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        OMNIA_CHECK(lease.has_value());
        OMNIA_CHECK(auditor.release_lease(
            lease->owner_id, lease->pid, lease->lease_epoch));
    }
    const auto denied_create = send_loopback_http(
        first.bound_port(), "POST", "/api/sessions/create",
        R"({"title":"must not persist after lease loss","modelId":"test-model","effort":"low"})");
    OMNIA_CHECK(denied_create.status == 503);
    const auto denied_body = omnia::core::JsonValue::parse(denied_create.body);
    OMNIA_CHECK(denied_body.prop_string("error") == "studio_lease_lost");
    omnia::storage::SessionStore verify_no_insert(database);
    OMNIA_CHECK(verify_no_insert.list_sessions_page(50).total_count == 0);

    first.stop();

    omnia::studio::StudioServer successor(cfg);
    successor.start();
    OMNIA_CHECK(successor.bound_port() > 0);
    successor.stop();

    std::error_code ec;
    std::filesystem::remove_all(directory, ec);
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

void test_server_shutdown_closes_slow_client() {
    omnia::studio::StudioConfig cfg{};
    cfg.port = 0;
    omnia::studio::StudioServer server(std::move(cfg));
    server.start();

    WSADATA wsa{};
    OMNIA_CHECK(WSAStartup(MAKEWORD(2, 2), &wsa) == 0);
    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    OMNIA_CHECK(client != INVALID_SOCKET);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(server.bound_port());
    OMNIA_CHECK(connect(client, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0);

    const std::string partial =
        "GET /api/health HTTP/1.1\r\n"
        "Host: 127.0.0.1:" + std::to_string(server.bound_port()) + "\r\n"
        "X-Slow: ";
    OMNIA_CHECK(send(client, partial.data(), static_cast<int>(partial.size()), 0) ==
        static_cast<int>(partial.size()));

    // Allow accept_loop to register the socket in the owned worker set.
    std::this_thread::sleep_for(std::chrono::milliseconds(75));
    const auto started = std::chrono::steady_clock::now();
    server.stop();
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
    OMNIA_CHECK(elapsed < 2000);

    const DWORD timeout_ms = 500;
    OMNIA_CHECK(setsockopt(client, SOL_SOCKET, SO_RCVTIMEO,
        reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms)) == 0);
    char response[16]{};
    const int received = recv(client, response, static_cast<int>(sizeof(response)), 0);
    OMNIA_CHECK(received <= 0);
    closesocket(client);
    WSACleanup();
}
#endif

} // namespace

int main(int argc, char* argv[]) {
    using omnia::studio::StudioServer;
    OMNIA_CHECK(StudioServer::is_allowed_loopback_host("127.0.0.1", 80));
    OMNIA_CHECK(StudioServer::is_allowed_loopback_origin("http://127.0.0.1", 80));
    OMNIA_CHECK(StudioServer::is_allowed_loopback_origin("http://127.0.0.1:80", 80));
    OMNIA_CHECK(!StudioServer::is_allowed_loopback_host("127.0.0.1", 8787));
    OMNIA_CHECK(!StudioServer::is_allowed_loopback_host("127.0.0.1:0", 0));
    OMNIA_CHECK(!StudioServer::is_allowed_loopback_origin("http://127.0.0.1:65536", 8787));
    OMNIA_CHECK(StudioServer::is_allowed_loopback_origin("", 8787));
    test_default_state_and_session_preservation();
    test_session_paging_and_detail();
    test_studio_lease_and_lifecycle_guards();
#ifdef _WIN32
    test_server_shutdown_closes_slow_client();
#endif
    std::filesystem::path studio_exe;
    std::filesystem::path repo_root;
    if (argc >= 2) studio_exe = std::filesystem::path(argv[1]);
    if (argc >= 3) repo_root = std::filesystem::path(argv[2]);

    const bool has_ui = !repo_root.empty() && std::filesystem::exists(repo_root / "ui" / "index.html");

    // Phase A: In-process StudioServer on OS-assigned ephemeral loopback port
    {
        omnia::studio::StudioConfig cfg{};
        cfg.port = 0;
        cfg.demo_mode = true;
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
        std::wstring cmd = L"\"" + studio_exe.wstring() + L"\" --port " + std::to_wstring(child_port) + L" --demo";
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
