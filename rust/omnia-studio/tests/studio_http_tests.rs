//! End-to-end integration tests for `omnia-studio` covering HTTP/1.1 AdGuard tolerances,
//! loopback CORS/Origin/Host guards, path-traversal protection, 3,000ms stalled proxy
//! timeout, legacy `/api/*` parity, immutable history rollback, and capability crates.

use base64::Engine as _;
use omnia_connector_gateway::artifact_intake::HttpValidatorStrength;
use omnia_downloader::{
    ChunkRange, DownloadJobSnapshot, DownloadStatus, DownloadStore, PacingMode,
};
use omnia_remote_control::crypto::sha256_hex;
use omnia_studio::{start_studio_server, CliAction, StudioConfig};
use serde_json::{json, Value};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

struct TempTestDir {
    path: PathBuf,
}

impl TempTestDir {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "omnia-studio-it-{label}-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp test dir");
        Self { path }
    }

    fn join(&self, child: &str) -> PathBuf {
        self.path.join(child)
    }
}

impl Drop for TempTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn repo_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root from CARGO_MANIFEST_DIR")
        .to_path_buf()
}

fn build_isolated_config(sandbox: &TempTestDir) -> StudioConfig {
    let ws = sandbox.join("workspace");
    let ui = sandbox.join("ui");
    let skills = ws.join(".agents").join("skills");
    let rollback = sandbox.join("rollback");
    fs::create_dir_all(&ws).expect("create temp workspace");
    fs::create_dir_all(ui.join("styles")).expect("create ui/styles");
    fs::create_dir_all(ui.join("app")).expect("create ui/app");
    fs::create_dir_all(&skills).expect("create skills");
    fs::create_dir_all(&rollback).expect("create rollback");

    fs::write(
        ui.join("index.html"),
        "<!doctype html><html><body>Omnia Studio Test</body></html>\n",
    )
    .expect("seed index.html");
    fs::write(
        ui.join("styles").join("main.css"),
        "body { color: #fff; }\n",
    )
    .expect("seed main.css");
    fs::write(ws.join("sample.txt"), "alpha\nbeta\ngamma\n").expect("seed sample.txt");

    let skill_dir = skills.join("test-skill");
    fs::create_dir_all(&skill_dir).expect("create sample skill");
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: test-skill\ndescription: Test fixture skill for Studio integration.\n---\n# Test Skill\nDeterministic skill fixture content.\n",
    )
    .expect("seed SKILL.md");

    StudioConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        workspace_root: ws,
        ui_root: ui,
        skills_root: skills,
        db_path: None,
        runtime_url: None,
        runtime_timeout: Duration::from_millis(3_000),
        history_root: None,
        history_pointer: None,
        history_manifest: None,
        rollback_root: rollback,
        open_window: false,
        smoke: false,
    }
}

struct RawHttpReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RawHttpReply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|err| {
            panic!(
                "invalid JSON body (status={}): {err}; raw={}",
                self.status,
                String::from_utf8_lossy(&self.body)
            )
        })
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn send_raw_http(addr: SocketAddr, raw_request: &str) -> RawHttpReply {
    let mut stream = TcpStream::connect(addr).await.expect("connect test server");
    stream
        .write_all(raw_request.as_bytes())
        .await
        .expect("write raw request");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read raw reply");

    let head_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP header terminator");
    let head_str = String::from_utf8_lossy(&buf[..head_end]);
    let mut lines = head_str.split("\r\n");
    let status_line = lines.next().expect("status line");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .expect("numeric status code");

    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    RawHttpReply {
        status,
        headers,
        body: buf[head_end + 4..].to_vec(),
    }
}

async fn http_request(
    addr: SocketAddr,
    method: &str,
    path_and_query: &str,
    extra_headers: &[(&str, &str)],
    json_body: Option<Value>,
) -> RawHttpReply {
    let host_hdr = if addr.is_ipv6() {
        format!("[{}]:{}", addr.ip(), addr.port())
    } else {
        format!("{}:{}", addr.ip(), addr.port())
    };
    let body_str = json_body.map(|v| v.to_string()).unwrap_or_default();
    let mut req = format!("{method} {path_and_query} HTTP/1.1\r\nHost: {host_hdr}\r\n");
    for (k, v) in extra_headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body_str.is_empty() || matches!(method, "POST" | "PUT" | "PATCH") {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", body_str.len()));
    }
    req.push_str("Connection: close\r\n\r\n");
    req.push_str(&body_str);

    send_raw_http(addr, &req).await
}

#[test]
fn cli_parsing_enforces_loopback_and_supports_smoke_help_flags() {
    let help = StudioConfig::parse_args(["--help"]).expect("help action");
    assert!(matches!(help, CliAction::Help(text) if text.contains("--smoke")));

    let parsed = StudioConfig::parse_args([
        "--port",
        "8789",
        "--runtime-url",
        "http://127.0.0.1:8791",
        "--history-pointer",
        r"D:\OmniaData\history\history-active.json",
        "--open-window",
        "--smoke",
    ])
    .expect("valid cli flags");
    match parsed {
        CliAction::Smoke(cfg) => {
            assert_eq!(cfg.port, 8789);
            assert_eq!(cfg.runtime_url.as_deref(), Some("http://127.0.0.1:8791"));
            assert!(cfg.open_window);
            assert!(cfg.smoke);
            assert_eq!(cfg.runtime_timeout, Duration::from_millis(3_000));
        }
        other => panic!("expected Smoke action, got {other:?}"),
    }

    let remote_host = StudioConfig::parse_args(["--host", "example.com"]);
    assert!(
        remote_host.is_err(),
        "non-loopback bind host must be rejected"
    );

    let remote_rt = StudioConfig::parse_args(["--runtime-url", "https://example.com"]);
    assert!(
        remote_rt.is_err(),
        "non-loopback runtime url must be rejected"
    );

    let rt_off = StudioConfig::parse_args(["--runtime-url", "off"]).expect("runtime off");
    match rt_off {
        CliAction::Run(cfg) => assert!(cfg.runtime_url.is_none()),
        other => panic!("expected Run action, got {other:?}"),
    }
}

#[tokio::test]
async fn server_tolerates_adguard_18_cookies_multispace_request_line_and_blocks_bad_origins() {
    let sandbox = TempTestDir::new("adguard-cors");
    let mut cfg = build_isolated_config(&sandbox);
    // Point workspace_root at real repository root for live rustFiles/crateCount telemetry,
    // while keeping ui_root & skills_root & rollback_root sandboxed cleanly.
    cfg.workspace_root = repo_workspace_root();
    let srv = start_studio_server(cfg).await.expect("start studio server");
    let addr = srv.local_addr();

    // 1. Multi-space request line + 18 repeated AdGuard Cookie headers
    let mut raw = format!(
        "GET  /api/health  HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n",
        addr.port()
    );
    for idx in 0..18 {
        raw.push_str(&format!("Cookie: ag_cookie_{idx}=dummy-session-{idx}\r\n"));
    }
    let expected_origin = format!("http://localhost:{}", addr.port());
    raw.push_str(&format!("Origin: {expected_origin}\r\nConnection: close\r\n\r\n"));

    let reply = send_raw_http(addr, &raw).await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("Access-Control-Allow-Origin"),
        Some(expected_origin.as_str())
    );
    let json = reply.json();
    assert_eq!(json["ok"], true);
    assert_eq!(json["state"], "online");
    assert_eq!(json["engine"], "Omnia Full Native Rust");
    assert!(
        json["compiler"]
            .as_str()
            .unwrap_or("")
            .starts_with("rustc 1."),
        "expected live rustc version string, got {:?}",
        json["compiler"]
    );
    assert!(json["crateCount"].as_u64().unwrap_or(0) >= 13);
    assert!(json["rustFiles"].as_u64().unwrap_or(0) > 10);
    assert_eq!(json["httpStack"], "tokio+rust-http");
    assert_eq!(json["sqliteBackend"], "winsqlite3.dll");
    assert!(json["workingSetBytes"].as_u64().is_some());
    assert!(json["tokenBudget"].is_null());

    // 2. Host & Origin validation + OPTIONS CORS preflight
    let bad_host = send_raw_http(
        addr,
        "GET /api/health HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(bad_host.status, 403);

    let bad_origin = http_request(
        addr,
        "GET",
        "/api/health",
        &[("Origin", "https://example.com")],
        None,
    )
    .await;
    assert_eq!(bad_origin.status, 403);

    let null_origin = http_request(addr, "GET", "/api/health", &[("Origin", "null")], None).await;
    assert_eq!(null_origin.status, 403);

    let bound_origin = format!("http://127.0.0.1:{}", addr.port());
    let preflight = http_request(
        addr,
        "OPTIONS",
        "/api/health",
        &[("Origin", bound_origin.as_str())],
        None,
    )
    .await;
    assert_eq!(preflight.status, 204);
    assert_eq!(
        preflight.header("Access-Control-Allow-Origin"),
        Some(bound_origin.as_str())
    );

    // AUD-02: Wrong-port loopback Host & Origin must be rejected with 403.
    let wrong_port = if addr.port() == 19999 { 19998 } else { 19999 };
    let wrong_host_req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{wrong_port}\r\nConnection: close\r\n\r\n"
    );
    let wrong_host = send_raw_http(addr, &wrong_host_req).await;
    assert_eq!(wrong_host.status, 403);
    assert_eq!(wrong_host.json()["code"], "forbidden_host");

    let bare_host = send_raw_http(
        addr,
        "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(bare_host.status, 403);
    assert_eq!(bare_host.json()["code"], "forbidden_host");

    let wrong_origin_hdr = format!("http://localhost:{wrong_port}");
    let wrong_origin = http_request(
        addr,
        "GET",
        "/api/health",
        &[("Origin", wrong_origin_hdr.as_str())],
        None,
    )
    .await;
    assert_eq!(wrong_origin.status, 403);
    assert_eq!(wrong_origin.json()["code"], "forbidden_origin");

    // AUD-02 WebSocket parity: wrong-port Origin on `/ws` upgrade must be rejected with 403.
    let ws_wrong_origin_req = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {wrong_origin_hdr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        addr.port()
    );
    let ws_wrong_origin = send_raw_http(addr, &ws_wrong_origin_req).await;
    assert_eq!(ws_wrong_origin.status, 403);
    assert_eq!(ws_wrong_origin.json()["code"], "forbidden_origin");

    // 3. Static asset serving & path traversal rejection
    let index_resp = http_request(addr, "GET", "/", &[], None).await;
    assert_eq!(index_resp.status, 200);
    assert!(String::from_utf8_lossy(&index_resp.body).contains("Omnia Studio Test"));

    let css_resp = http_request(addr, "GET", "/styles/main.css", &[], None).await;
    assert_eq!(css_resp.status, 200);
    assert_eq!(
        css_resp.header("Content-Type"),
        Some("text/css; charset=utf-8")
    );

    let traversal_resp = http_request(addr, "GET", "/%2e%2e/workspace/sample.txt", &[], None).await;
    assert_eq!(traversal_resp.status, 403);

    // 4. Method/Not-Found parity
    let not_found = http_request(addr, "GET", "/api/nonexistent-endpoint", &[], None).await;
    assert_eq!(not_found.status, 404);
    let wrong_method = http_request(addr, "DELETE", "/api/health", &[], None).await;
    assert_eq!(wrong_method.status, 405);

    srv.shutdown().await;
}

#[tokio::test]
async fn runtime_proxy_forwards_mock_and_times_out_cleanly_at_3000ms_on_stalled_upstream() {
    // Part A: Working mock upstream listener
    let mock_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock upstream");
    let mock_port = mock_listener.local_addr().expect("mock addr").port();
    let mock_task = tokio::spawn(async move {
        for _ in 0..8 {
            let Ok((mut sock, _)) = mock_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut req_buf = [0u8; 4096];
                let n = sock.read(&mut req_buf).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&req_buf[..n]);
                let path = text
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let body = if path.starts_with("/api/health") || path.starts_with("/api/status") {
                    json!({ "ok": true, "engine": "omnia-runtime", "state": "online" })
                } else if path.starts_with("/api/providers") {
                    json!({ "ok": true, "providers": [{ "id": "local-mock", "enabled": true }] })
                } else if path.starts_with("/api/models") {
                    json!({ "ok": true, "models": [{ "id": "mock-model-1" }] })
                } else if path.starts_with("/api/chat") {
                    json!({ "ok": true, "reply": "hello from mock runtime" })
                } else if path.starts_with("/api/hardware/nvidia") {
                    json!({ "ok": true, "gpus": [{ "index": 0, "name": "Mock GPU" }] })
                } else {
                    json!({ "ok": false, "error": "not_found" })
                };
                let body_s = body.to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body_s.len(),
                    body_s
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });

    let sandbox = TempTestDir::new("runtime-proxy");
    let mut cfg = build_isolated_config(&sandbox);
    cfg.runtime_url = Some(format!("http://127.0.0.1:{mock_port}"));
    let srv = start_studio_server(cfg)
        .await
        .expect("start studio with mock");
    let addr = srv.local_addr();

    let status_reply = http_request(addr, "GET", "/api/runtime/status", &[], None).await;
    assert_eq!(status_reply.status, 200);
    assert_eq!(status_reply.json()["ok"], true);

    let providers_reply = http_request(addr, "GET", "/api/providers", &[], None).await;
    assert_eq!(providers_reply.status, 200);
    assert_eq!(providers_reply.json()["providers"][0]["id"], "local-mock");

    let models_reply = http_request(addr, "GET", "/api/models", &[], None).await;
    assert_eq!(models_reply.status, 200);

    let chat_reply = http_request(
        addr,
        "POST",
        "/api/chat",
        &[],
        Some(json!({ "prompt": "ping" })),
    )
    .await;
    assert_eq!(chat_reply.status, 200);
    assert_eq!(chat_reply.json()["reply"], "hello from mock runtime");

    let bad_gpu = http_request(addr, "GET", "/api/hardware/nvidia?device=0", &[], None).await;
    assert_eq!(bad_gpu.status, 400);

    let ok_gpu = http_request(addr, "GET", "/api/hardware/nvidia", &[], None).await;
    assert_eq!(ok_gpu.status, 200);

    srv.shutdown().await;
    mock_task.abort();

    // Part B: Stalled upstream socket holding open without sending bytes -> hard 3,000ms timeout
    let stalled_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind stalled listener");
    let stalled_port = stalled_listener.local_addr().expect("stalled addr").port();
    let stalled_task = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = stalled_listener.accept().await {
            held.push(sock);
            tokio::time::sleep(Duration::from_secs(6)).await;
        }
    });

    let mut cfg_stalled = build_isolated_config(&sandbox);
    cfg_stalled.runtime_url = Some(format!("http://127.0.0.1:{stalled_port}"));
    assert_eq!(cfg_stalled.runtime_timeout, Duration::from_millis(3_000));
    let srv_stalled = start_studio_server(cfg_stalled)
        .await
        .expect("start studio with stalled runtime");
    let stalled_addr = srv_stalled.local_addr();

    let started = Instant::now();
    let timeout_reply = http_request(stalled_addr, "GET", "/api/runtime/status", &[], None).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= Duration::from_millis(2_800) && elapsed < Duration::from_millis(4_500),
        "expected ~3,000ms bounded runtime timeout, observed {elapsed:?}"
    );
    let tj = timeout_reply.json();
    assert_eq!(tj["ok"], false);
    assert_eq!(tj["state"], "unavailable");
    assert_eq!(tj["code"], "runtime_timeout");
    assert_eq!(tj["timeoutMs"], 3_000);

    srv_stalled.shutdown().await;
    stalled_task.abort();
}

#[tokio::test]
async fn legacy_routes_cover_graph_graphify_router_memory_rag_skills_composer_steer_and_sessions() {
    let sandbox = TempTestDir::new("legacy-routes");
    let mut cfg = build_isolated_config(&sandbox);
    cfg.db_path = Some(sandbox.join("studio_wal.sqlite3"));
    let srv = start_studio_server(cfg).await.expect("start legacy server");
    let addr = srv.local_addr();

    let caps = http_request(addr, "GET", "/api/capabilities", &[], None).await;
    assert_eq!(caps.status, 200);
    assert_eq!(caps.json()["schema"], "omnia.capabilities.v1");

    let overview = http_request(addr, "GET", "/api/overview", &[], None).await;
    assert_eq!(overview.status, 200);
    assert!(overview.json()["tokenBudget"].is_null());

    // PeerMeshGraph & Graphify (starts empty with zero fake RAM peers)
    let graph = http_request(addr, "GET", "/api/graph", &[], None).await;
    assert_eq!(graph.status, 200);
    assert!(graph.json()["nodes"].as_array().expect("nodes").is_empty());

    let peers = http_request(addr, "GET", "/api/graph/peers", &[], None).await;
    assert_eq!(peers.status, 200);
    assert_eq!(peers.json()["peerCount"].as_u64().unwrap_or(99), 0);

    let bad_wildcard_peers = http_request(
        addr,
        "POST",
        "/api/graph/peers",
        &[],
        Some(json!({
            "peers": [
                { "id": "verifier", "role": "verifier", "ownedPaths": ["rust/*/tests/**"], "excludedPaths": ["docs/**"] }
            ]
        })),
    )
    .await;
    assert_eq!(bad_wildcard_peers.status, 400);

    let reg_peers = http_request(
        addr,
        "POST",
        "/api/graph/peers",
        &[],
        Some(json!({
            "peers": [
                { "id": "coordinator", "role": "coordinator", "ownedPaths": ["docs/**"], "excludedPaths": ["rust/**"] },
                { "id": "verifier", "role": "verifier", "ownedPaths": ["rust/omnia-studio/tests/**"], "excludedPaths": ["docs/**"] }
            ]
        })),
    )
    .await;
    assert_eq!(reg_peers.status, 200);
    assert_eq!(reg_peers.json()["peerCount"].as_u64().unwrap_or(0), 2);

    let graph_after = http_request(addr, "GET", "/api/graph", &[], None).await;
    assert_eq!(graph_after.status, 200);
    assert_eq!(graph_after.json()["nodes"].as_array().expect("nodes").len(), 2);

    let send_msg = http_request(
        addr,
        "POST",
        "/api/graph/send",
        &[],
        Some(json!({
            "from": "coordinator",
            "to": "verifier",
            "subject": "audit_request",
            "body": "Verify studio legacy endpoints."
        })),
    )
    .await;
    assert_eq!(send_msg.status, 200);

    let traverse_bad_dir = http_request(
        addr,
        "GET",
        "/api/graph/traverse?direction=sideways",
        &[],
        None,
    )
    .await;
    assert_eq!(traverse_bad_dir.status, 400);

    let code_graph = http_request(
        addr,
        "GET",
        "/api/graph/code?entity=sample.txt&direction=both&max_depth=2",
        &[],
        None,
    )
    .await;
    assert_eq!(code_graph.status, 200);
    assert_eq!(code_graph.json()["direction"], "both");

    // DynamicProviderRouter (`tokenBudget: null` invariant; cold start has no fake router seeds)
    let upsert_cand = http_request(
        addr,
        "POST",
        "/api/router/candidates",
        &[],
        Some(json!({
            "candidateId": "test-local-cand",
            "providerId": "ollama",
            "modelId": "qwen3-coder",
            "privacyTier": "local_only",
            "qualityTier": 90,
            "credentialPresent": true
        })),
    )
    .await;
    assert_eq!(upsert_cand.status, 200);

    let router_state = http_request(addr, "GET", "/api/router/state", &[], None).await;
    assert_eq!(router_state.status, 200);
    assert!(router_state.json()["tokenBudget"].is_null());

    let decide = http_request(
        addr,
        "POST",
        "/api/route",
        &[],
        Some(json!({
            "requestId": "dummy-session-req-1",
            "privacyTier": "local_only",
            "taskRisk": "standard"
        })),
    )
    .await;
    assert_eq!(decide.status, 200);
    let dj = decide.json();
    assert_eq!(dj["ok"], true);
    assert!(dj["tokenBudget"].is_null());
    assert!(dj["receipt"].is_object());

    // MemoryGraph upsert + cryptographic erasure receipt
    let mem_up = http_request(
        addr,
        "POST",
        "/api/memory/upsert",
        &[],
        Some(json!({
            "namespace": "workspace/test",
            "key": "transient-note",
            "tier": "working",
            "content": "Fixture observation linking [[workspace/architecture]]."
        })),
    )
    .await;
    assert_eq!(mem_up.status, 200);

    let mem_list = http_request(addr, "GET", "/api/memory", &[], None).await;
    assert_eq!(mem_list.status, 200);
    assert!(!mem_list.json()["entries"]
        .as_array()
        .expect("entries")
        .is_empty());

    let mem_erase = http_request(
        addr,
        "POST",
        "/api/memory/erase",
        &[],
        Some(json!({
            "namespace": "workspace/test",
            "key": "transient-note"
        })),
    )
    .await;
    assert_eq!(mem_erase.status, 200);
    let ej = mem_erase.json();
    assert_eq!(ej["receipt"]["verifiedPlaintextFree"], true);
    assert!(ej["receipt"]["previousDigestSha256"].as_str().is_some());

    // ProactiveRag
    let rag_q = http_request(
        addr,
        "POST",
        "/api/rag/query",
        &[],
        Some(json!({ "query": "How does Omnia Studio persist sessions on Windows?" })),
    )
    .await;
    assert_eq!(rag_q.status, 200);
    let rj = rag_q.json();
    assert_eq!(rj["ok"], true);
    assert!(rj["uncertainty"].as_f64().is_some());
    assert!(rj["subQueries"].is_array());
    assert!(rj["citedSources"].is_array());
    assert!(rj["unusedSources"].is_array());
    assert!(rj["answer"].as_str().is_some());

    // SkillRegistry
    let skills = http_request(addr, "GET", "/api/skills?q=fixture", &[], None).await;
    assert_eq!(skills.status, 200);
    assert_eq!(skills.json()["skills"][0]["name"], "test-skill");

    let skill_md = http_request(
        addr,
        "GET",
        "/api/skills/content?name=test-skill",
        &[],
        None,
    )
    .await;
    assert_eq!(skill_md.status, 200);
    assert!(skill_md.json()["content"]
        .as_str()
        .unwrap_or_default()
        .contains("Deterministic skill fixture content"));

    // ComposerModel + RichComposer
    let tpl = http_request(addr, "GET", "/api/composer/templates", &[], None).await;
    assert_eq!(tpl.status, 200);
    assert!(!tpl.json()["templates"]
        .as_array()
        .expect("templates")
        .is_empty());

    let preview = http_request(
        addr,
        "POST",
        "/api/composer/preview",
        &[],
        Some(json!({ "text": "Compute $\\alpha + \\beta$", "inlineMath": true })),
    )
    .await;
    assert_eq!(preview.status, 200);
    assert_eq!(preview.json()["ready"], true);

    // SteerQueue (`tokenBudget: null` ALWAYS invariant!)
    let steer_enq = http_request(
        addr,
        "POST",
        "/api/steer/enqueue",
        &[],
        Some(json!({
            "prompt": "Verify additive intake preserves existing backlog.",
            "mode": "additive_intake",
            "tokenBudget": 999
        })),
    )
    .await;
    assert_eq!(steer_enq.status, 200);
    assert!(steer_enq.json()["tokenBudget"].is_null());

    let steer_list = http_request(addr, "GET", "/api/steer", &[], None).await;
    assert_eq!(steer_list.status, 200);
    assert!(steer_list.json()["tokenBudget"].is_null());

    // SessionStore SQLite WAL CRUD
    let sess_create = http_request(
        addr,
        "POST",
        "/api/sessions/create",
        &[],
        Some(json!({
            "id": "dummy-session",
            "title": "Integration Fixture Session",
            "modelId": "mock-model"
        })),
    )
    .await;
    assert_eq!(sess_create.status, 200);

    let msg_post = http_request(
        addr,
        "POST",
        "/api/sessions/messages",
        &[],
        Some(json!({
            "sessionId": "dummy-session",
            "role": "user",
            "content": "Validate WAL message persistence for dummy-session."
        })),
    )
    .await;
    assert_eq!(msg_post.status, 200);

    let msg_get = http_request(
        addr,
        "GET",
        "/api/sessions/messages?sessionId=dummy-session",
        &[],
        None,
    )
    .await;
    assert_eq!(msg_get.status, 200);
    assert_eq!(
        msg_get.json()["messages"].as_array().expect("msgs").len(),
        1
    );

    srv.shutdown().await;
}

fn write_verified_history_generation(
    gen_dir: &Path,
    record_id: &str,
    jsonl_line: &str,
) -> (PathBuf, String) {
    fs::create_dir_all(gen_dir).expect("create gen dir");

    let body_bytes = format!("{jsonl_line}\n").into_bytes();
    let body_sha = sha256_hex(&body_bytes);
    let body_path = gen_dir.join("body.jsonl");
    fs::write(&body_path, &body_bytes).expect("write body.jsonl");

    let body_index_val = json!({
        "schema": "omnia.history-body-index.v1",
        "bodyPath": "body.jsonl",
        "bodySha256": body_sha,
        "spans": [
            {
                "recordId": record_id,
                "offset": 0,
                "byteLength": body_bytes.len(),
                "sha256": body_sha
            }
        ]
    });
    let body_index_bytes =
        serde_json::to_vec_pretty(&body_index_val).expect("serialize body index");
    let body_index_sha = sha256_hex(&body_index_bytes);
    let body_index_path = gen_dir.join("body-index.json");
    fs::write(&body_index_path, &body_index_bytes).expect("write body-index.json");

    let receipt_val = json!({
        "schema": "omnia.history-import-receipt.v1",
        "counts": {
            "records": 1,
            "verified": 1,
            "blocked": 0
        },
        "artifacts": [
            { "path": "body.jsonl", "sha256": body_sha },
            { "path": "body-index.json", "sha256": body_index_sha }
        ],
        "records": [
            {
                "recordId": record_id,
                "title": "Fixture Session History",
                "state": "verified",
                "messageCount": 1
            }
        ]
    });
    let receipt_bytes = serde_json::to_vec_pretty(&receipt_val).expect("serialize receipt");
    let receipt_sha = sha256_hex(&receipt_bytes);
    let receipt_path = gen_dir.join("receipt.json");
    fs::write(&receipt_path, &receipt_bytes).expect("write receipt.json");

    let manifest_val = json!({
        "schema": "omnia.history-manifest.v2",
        "generation": record_id,
        "receipt": { "path": "receipt.json", "sha256": receipt_sha },
        "bodyIndex": { "path": "body-index.json", "sha256": body_index_sha },
        "body": { "path": "body.jsonl", "sha256": body_sha },
        "records": [
            {
                "recordId": record_id,
                "title": "Fixture Session History",
                "source": "agy",
                "messageCount": 1,
                "state": "verified"
            }
        ]
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest_val).expect("serialize manifest");
    let manifest_sha = sha256_hex(&manifest_bytes);
    let manifest_path = gen_dir.join("manifest.json");
    fs::write(&manifest_path, &manifest_bytes).expect("write manifest.json");

    (manifest_path, manifest_sha)
}

#[tokio::test]
async fn history_pointer_verification_redaction_and_tamper_rollback_work_end_to_end() {
    let sandbox = TempTestDir::new("history-verify");
    let history_root = sandbox.join("external-history");
    let gen1_dir = history_root.join("gen1");
    let gen2_dir = history_root.join("gen2");

    let line_gen1 = json!({
        "seq": 1,
        "role": "assistant",
        "text": "Gen1 recovered note"
    })
    .to_string();
    let (m1_path, m1_sha) = write_verified_history_generation(&gen1_dir, "rec-gen1", &line_gen1);

    let line_gen2 = json!({
        "seq": 1,
        "role": "user",
        "text": r"Read C:\Users\fixture\docs and mail fixture@example.com or https://example.com/path with fixture-token"
    })
    .to_string();
    let (m2_path, m2_sha) = write_verified_history_generation(&gen2_dir, "rec-gen2", &line_gen2);

    let active_ptr = history_root.join("history-active.json");
    let prev_ptr = history_root.join("history-active.previous.json");

    fs::write(
        &prev_ptr,
        serde_json::to_vec_pretty(&json!({
            "schema": "omnia.history-active.v1",
            "generation": "gen1",
            "manifestPath": m1_path.display().to_string(),
            "manifestSha256": m1_sha,
        }))
        .expect("serialize prev"),
    )
    .expect("write prev pointer");

    fs::write(
        &active_ptr,
        serde_json::to_vec_pretty(&json!({
            "schema": "omnia.history-active.v1",
            "generation": "gen2",
            "manifestPath": m2_path.display().to_string(),
            "manifestSha256": m2_sha,
        }))
        .expect("serialize active"),
    )
    .expect("write active pointer");

    let mut cfg = build_isolated_config(&sandbox);
    cfg.history_root = Some(history_root.clone());
    cfg.history_pointer = Some(active_ptr.clone());

    let srv = start_studio_server(cfg)
        .await
        .expect("start history server");
    let addr = srv.local_addr();

    // 1. Verified generation 2 + search + privacy redaction
    let hist = http_request(addr, "GET", "/api/history", &[], None).await;
    assert_eq!(hist.status, 200);
    let hj = hist.json();
    assert_eq!(hj["state"], "verified");
    assert_eq!(hj["rollbackUsed"], false);

    let msgs = http_request(
        addr,
        "GET",
        "/api/history/messages?record_id=rec-gen2&limit=10&offset=0&q=fixture",
        &[],
        None,
    )
    .await;
    assert_eq!(msgs.status, 200);
    let mj = msgs.json();
    let msg_text = mj["messages"][0]["text"].as_str().unwrap_or_default();
    assert!(!msg_text.contains(r"C:\Users\fixture"));
    assert!(!msg_text.contains("fixture@example.com"));
    assert!(!msg_text.contains("https://example.com"));
    assert!(msg_text.contains("[REDACTED_EMAIL]"));
    assert!(msg_text.contains("[REDACTED_URL]"));

    // 2. Corrupt active manifest SHA -> clean automatic fallback to `history-active.previous.json`
    fs::write(
        &active_ptr,
        serde_json::to_vec_pretty(&json!({
            "schema": "omnia.history-active.v1",
            "generation": "gen2",
            "manifestPath": m2_path.display().to_string(),
            "manifestSha256": "0".repeat(64),
        }))
        .expect("corrupt active"),
    )
    .expect("overwrite corrupted active pointer");

    let rolled = http_request(addr, "GET", "/api/history", &[], None).await;
    assert_eq!(rolled.status, 200);
    let rj = rolled.json();
    assert_eq!(rj["state"], "verified");
    assert_eq!(rj["rollbackUsed"], true);
    assert_eq!(rj["records"][0]["recordId"], "rec-gen1");

    // 3. Corrupt BOTH pointers -> fails closed (`409` blocked)
    fs::write(
        &prev_ptr,
        serde_json::to_vec_pretty(&json!({
            "schema": "omnia.history-active.v1",
            "generation": "gen1",
            "manifestPath": m1_path.display().to_string(),
            "manifestSha256": "f".repeat(64),
        }))
        .expect("corrupt prev"),
    )
    .expect("overwrite corrupted prev pointer");

    let blocked = http_request(addr, "GET", "/api/history", &[], None).await;
    assert_eq!(blocked.status, 409);
    assert_eq!(blocked.json()["state"], "blocked");

    srv.shutdown().await;
}

#[tokio::test]
async fn capability_routes_workspace_connectors_media_and_remote_enforce_contracts() {
    let sandbox = TempTestDir::new("capabilities");
    let cfg = build_isolated_config(&sandbox);
    let rollback_dir = cfg.rollback_root.clone();
    let srv = start_studio_server(cfg)
        .await
        .expect("start capabilities server");
    let addr = srv.local_addr();

    // --- 1. Workspace Ops ---
    let tree = http_request(addr, "GET", "/api/workspace/tree?max_depth=2", &[], None).await;
    assert_eq!(tree.status, 200);
    assert!(tree.json()["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .any(|e| e["relativePath"] == "sample.txt"));

    let file_snip = http_request(
        addr,
        "GET",
        "/api/workspace/file?path=sample.txt&start_line=2&end_line=3",
        &[],
        None,
    )
    .await;
    assert_eq!(file_snip.status, 200);
    assert_eq!(file_snip.json()["lineCount"], 2);
    assert_eq!(file_snip.json()["lines"][0]["text"], "beta");

    let ws_traversal = http_request(
        addr,
        "GET",
        "/api/workspace/file?path=../outside.txt",
        &[],
        None,
    )
    .await;
    assert_eq!(ws_traversal.status, 403);

    let diff_dry = http_request(
        addr,
        "POST",
        "/api/workspace/diff",
        &[],
        Some(json!({
            "path": "sample.txt",
            "content": "alpha\nbeta-updated\ngamma\n",
            "apply": false
        })),
    )
    .await;
    assert_eq!(diff_dry.status, 200);
    assert_eq!(diff_dry.json()["applied"], false);
    assert_eq!(diff_dry.json()["changed"], true);

    let diff_apply = http_request(
        addr,
        "POST",
        "/api/workspace/diff",
        &[],
        Some(json!({
            "path": "sample.txt",
            "content": "alpha\nbeta-applied\ngamma\n",
            "apply": true
        })),
    )
    .await;
    assert_eq!(diff_apply.status, 200);
    let aj = diff_apply.json();
    assert_eq!(aj["applied"], true);
    let receipt_path = aj["rollbackReceipt"]["receiptPath"]
        .as_str()
        .expect("external rollback receipt path");
    let canonical_receipt =
        std::fs::canonicalize(receipt_path).unwrap_or_else(|_| PathBuf::from(receipt_path));
    let canonical_rollback =
        std::fs::canonicalize(&rollback_dir).unwrap_or_else(|_| rollback_dir.clone());
    assert!(canonical_receipt.starts_with(&canonical_rollback));

    let diff_rb = http_request(
        addr,
        "POST",
        "/api/workspace/diff",
        &[],
        Some(json!({
            "rollback": true,
            "rollbackReceiptPath": receipt_path
        })),
    )
    .await;
    assert_eq!(diff_rb.status, 200);
    assert_eq!(diff_rb.json()["rolledBack"], true);

    let file_after_rb = http_request(
        addr,
        "GET",
        "/api/workspace/file?path=sample.txt",
        &[],
        None,
    )
    .await;
    assert_eq!(file_after_rb.status, 200);
    assert_eq!(file_after_rb.json()["content"], "alpha\nbeta\ngamma\n");

    #[cfg(windows)]
    let (prog, prog_args) = ("cmd", vec!["/C", "echo omnia-exec-ok"]);
    #[cfg(not(windows))]
    let (prog, prog_args) = ("sh", vec!["-c", "echo omnia-exec-ok"]);

    let exec_ok = http_request(
        addr,
        "POST",
        "/api/workspace/exec",
        &[],
        Some(json!({ "program": prog, "args": prog_args, "timeoutMs": 3000 })),
    )
    .await;
    assert_eq!(exec_ok.status, 200);
    assert_eq!(exec_ok.json()["success"], true);
    assert!(exec_ok.json()["stdout"]
        .as_str()
        .unwrap_or_default()
        .contains("omnia-exec-ok"));

    let exec_bad_cwd = http_request(
        addr,
        "POST",
        "/api/workspace/exec",
        &[],
        Some(json!({ "program": prog, "args": prog_args, "cwd": "../outside" })),
    )
    .await;
    assert_eq!(exec_bad_cwd.status, 403);

    // --- 2. Connectors Gateway (truthful statuses, NEVER synthetic "connected") ---
    let conn_status = http_request(addr, "GET", "/api/connectors/status", &[], None).await;
    assert_eq!(conn_status.status, 200);
    let cs = conn_status.json();
    for item in cs["connectors"].as_array().expect("connectors") {
        let st = item["status"].as_str().unwrap_or_default();
        assert_ne!(st, "connected", "synthetic 'connected' status forbidden");
        assert!(matches!(st, "configured" | "offline" | "blocked" | "error"));
    }

    let proto_reject = http_request(
        addr,
        "POST",
        "/api/connectors/validate",
        &[],
        Some(json!({ "__proto__": { "admin": true }, "baseUrl": "http://127.0.0.1:9999" })),
    )
    .await;
    assert_eq!(proto_reject.status, 403);

    let remote_url_block = http_request(
        addr,
        "POST",
        "/api/connectors/validate",
        &[],
        Some(json!({ "baseUrl": "https://example.com" })),
    )
    .await;
    assert_eq!(remote_url_block.status, 200);
    assert_eq!(remote_url_block.json()["status"], "blocked");

    let loopback_ok = http_request(
        addr,
        "POST",
        "/api/connectors/validate",
        &[],
        Some(json!({ "baseUrl": "http://127.0.0.1:19999", "probe": false })),
    )
    .await;
    assert_eq!(loopback_ok.status, 200);
    assert_eq!(loopback_ok.json()["status"], "configured");

    // --- 3. Media Capture ---
    let media_caps = http_request(addr, "GET", "/api/media/capabilities", &[], None).await;
    assert_eq!(media_caps.status, 200);
    assert_eq!(
        media_caps.json()["capabilities"]
            .as_array()
            .expect("caps")
            .len(),
        3
    );

    let cdp_non_loopback = http_request(
        addr,
        "GET",
        "/api/media/browser/cdp?url=http://example.com:9222",
        &[],
        None,
    )
    .await;
    assert_eq!(cdp_non_loopback.status, 200);
    assert_eq!(cdp_non_loopback.json()["capability"]["status"], "blocked");

    let obs_unconf = http_request(addr, "GET", "/api/media/obs/status", &[], None).await;
    assert_eq!(obs_unconf.status, 200);
    assert_eq!(
        obs_unconf.json()["capability"]["reasonCode"],
        "UNCONFIGURED"
    );

    let frame_pixels = vec![
        10, 20, 30, 255, // pixel 0
        40, 50, 60, 255, // pixel 1 (distinct, non-blank)
        70, 80, 90, 255, // pixel 2
        100, 110, 120, 255, // pixel 3
    ];
    let frame_sha = sha256_hex(&frame_pixels);
    let target_obj = json!({
        "hwnd": 4242,
        "pid": 9001,
        "process_create_time_100ns": 133700000000u64,
        "title": "Omnia Studio Target",
        "width": 2,
        "height": 2,
        "minimized": false
    });
    let unconfigured_capture = http_request(
        addr,
        "POST",
        "/api/media/capture/window",
        &[],
        Some(json!({})),
    )
    .await;
    assert_eq!(unconfigured_capture.status, 200);
    assert_eq!(unconfigured_capture.json()["verified"], false);
    assert_eq!(
        unconfigured_capture.json()["capability"]["reasonCode"],
        "UNCONFIGURED"
    );

    let missing_receipt = http_request(
        addr,
        "POST",
        "/api/media/capture/window",
        &[],
        Some(json!({ "window": target_obj })),
    )
    .await;
    assert_eq!(missing_receipt.status, 200);
    assert_eq!(missing_receipt.json()["verified"], false);
    assert_eq!(
        missing_receipt.json()["capability"]["reasonCode"],
        "CAPTURE_RECEIPT_REQUIRED"
    );
    let valid_capture = http_request(
        addr,
        "POST",
        "/api/media/capture/window",
        &[],
        Some(json!({
            "expectedTarget": target_obj,
            "observedTarget": target_obj,
            "frameWidth": 2,
            "frameHeight": 2,
            "pixelFormat": "bgra8",
            "byteLen": frame_pixels.len(),
            "sha256Hex": frame_sha,
            "frameBytes": frame_pixels,
            "nonBlankVerified": true
        })),
    )
    .await;
    assert_eq!(valid_capture.status, 200);
    assert_eq!(valid_capture.json()["verified"], true);
    assert_eq!(valid_capture.json()["capability"]["status"], "available");

    let blank_pixels = vec![0u8; 16];
    let blank_sha = sha256_hex(&blank_pixels);
    let blank_capture = http_request(
        addr,
        "POST",
        "/api/media/capture/window",
        &[],
        Some(json!({
            "expectedTarget": target_obj,
            "observedTarget": target_obj,
            "frameWidth": 2,
            "frameHeight": 2,
            "pixelFormat": "bgra8",
            "byteLen": blank_pixels.len(),
            "sha256Hex": blank_sha,
            "frameBytes": blank_pixels,
            "nonBlankVerified": false
        })),
    )
    .await;
    assert_eq!(blank_capture.status, 422);
    assert_eq!(blank_capture.json()["verified"], false);

    // --- 4. Remote Control (fail-closed pairing, signed envelope, replay, revocation) ---
    let remote_init = http_request(addr, "GET", "/api/remote/status", &[], None).await;
    assert_eq!(remote_init.status, 200);
    assert_eq!(remote_init.json()["status"], "unpaired_fail_closed");

    let unpaired_input = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({
            "sessionId": "dummy-session-unpaired",
            "kind": "mouse_move",
            "x": 0.5,
            "y": 0.5
        })),
    )
    .await;
    assert_eq!(unpaired_input.status, 403);

    let paired = http_request(
        addr,
        "POST",
        "/api/remote/pair",
        &[],
        Some(json!({ "sessionId": "dummy-session-remote" })),
    )
    .await;
    assert_eq!(paired.status, 200);
    assert_eq!(paired.json()["status"], "paired");

    let input_ok = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "kind": "mouse_move",
            "x": 0.25,
            "y": 0.75
        })),
    )
    .await;
    assert_eq!(input_ok.status, 200);
    let input_json = input_ok.json();
    assert_eq!(input_json["accepted"], true);
    let sealed_env = input_json["envelope"].clone();

    // Replaying exact sealed envelope (`seq=1`) MUST fail closed (403)
    let replay_fail = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({ "envelope": sealed_env })),
    )
    .await;
    assert_eq!(replay_fail.status, 403);

    // Tampered MAC MUST fail closed (403)
    let mut forged_env = sealed_env;
    forged_env["seq"] = json!(99);
    forged_env["mac_hex"] = json!("0".repeat(64));
    let forged_fail = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({ "envelope": forged_env })),
    )
    .await;
    assert_eq!(forged_fail.status, 403);

    // Out-of-bounds coordinate MUST fail validation (400)
    let bad_coord = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "kind": "mouse_move",
            "x": 1.5,
            "y": 0.5
        })),
    )
    .await;
    assert_eq!(bad_coord.status, 400);

    // Signed screen frame header succeeds while active
    // Omitting real frame bytes and sha256Hex must fail honestly (no synthetic hash fabrication)
    let missing_digest = http_request(
        addr,
        "POST",
        "/api/remote/frame",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "frameId": 6,
            "width": 1280,
            "height": 720
        })),
    )
    .await;
    assert_eq!(missing_digest.status, 400);

    let frame_ok = http_request(
        addr,
        "POST",
        "/api/remote/frame",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "frameId": 7,
            "width": 1280,
            "height": 720,
            "previewBase64": omnia_core::base64_encode(b"PNG_SYNTHETIC_FRAME_BYTES")
        })),
    )
    .await;
    assert_eq!(frame_ok.status, 200);
    assert_eq!(frame_ok.json()["accepted"], true);

    // Revoking lease enforces immediate fail-closed rejection on subsequent input/frames
    let revoked = http_request(
        addr,
        "POST",
        "/api/remote/session",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "action": "revoke",
            "reason": "test_revocation"
        })),
    )
    .await;
    assert_eq!(revoked.status, 200);
    assert_eq!(revoked.json()["revoked"], true);

    let after_revoke = http_request(
        addr,
        "POST",
        "/api/remote/input",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "kind": "heartbeat",
            "pingNonce": 123
        })),
    )
    .await;
    assert_eq!(after_revoke.status, 403);

    srv.shutdown().await;
}

#[tokio::test]
async fn studio_chat_streams_sse_beyond_3000ms_without_buffering_or_timeout_clamp() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock streaming runtime");
    let upstream_addr = upstream_listener.local_addr().expect("upstream addr");

    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.expect("accept studio");
        let mut req_buf = [0_u8; 4096];
        let _ = stream.read(&mut req_buf).await;

        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write sse head");
        stream.flush().await.expect("flush sse head");

        for (idx, chunk) in [
            "data: {\"delta\":\"chunk-1\"}\n\n",
            "data: {\"delta\":\"chunk-2\"}\n\n",
            "data: {\"delta\":\"chunk-3\"}\n\n",
            "data: [DONE]\n\n",
        ]
        .iter()
        .enumerate()
        {
            if idx > 0 {
                tokio::time::sleep(Duration::from_millis(1_100)).await;
            }
            let frame = format!("{:X}\r\n{chunk}\r\n", chunk.len());
            stream
                .write_all(frame.as_bytes())
                .await
                .expect("write sse chunk");
            stream.flush().await.expect("flush sse chunk");
        }
        stream
            .write_all(b"0\r\n\r\n")
            .await
            .expect("write final chunk");
        stream.flush().await.expect("flush final chunk");
    });

    let sandbox = TempTestDir::new("sse-passthrough");
    let mut cfg = build_isolated_config(&sandbox);
    cfg.runtime_url = Some(format!("http://{upstream_addr}"));
    cfg.runtime_timeout = Duration::from_millis(3_000);
    let srv = start_studio_server(cfg).await.expect("start studio");
    let addr = srv.local_addr();

    let payload = json!({
        "model": "gpt-5.4",
        "stream": true,
        "messages": [{"role": "user", "content": "long stream"}]
    })
    .to_string();
    let raw_req = format!(
        "POST /api/chat HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );

    let start = Instant::now();
    let mut client = TcpStream::connect(addr).await.expect("connect studio");
    client
        .write_all(raw_req.as_bytes())
        .await
        .expect("send chat stream request");

    let mut received = Vec::new();
    let mut buf = [0_u8; 1024];
    let mut first_chunk_elapsed: Option<Duration> = None;
    loop {
        let n = client.read(&mut buf).await.expect("read streamed bytes");
        if n == 0 {
            break;
        }
        received.extend_from_slice(&buf[..n]);
        if first_chunk_elapsed.is_none()
            && String::from_utf8_lossy(&received).contains("chunk-1")
        {
            first_chunk_elapsed = Some(start.elapsed());
        }
    }
    let total_elapsed = start.elapsed();

    let first = first_chunk_elapsed.expect("chunk-1 must arrive");
    assert!(
        first < Duration::from_millis(2_000),
        "first SSE chunk should stream immediately without buffering (took {first:?})"
    );
    assert!(
        total_elapsed >= Duration::from_millis(3_100),
        "SSE stream must survive past the old 3000ms probe timeout (total {total_elapsed:?})"
    );

    let text = String::from_utf8(received).expect("valid utf8 sse");
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains("Transfer-Encoding: chunked\r\n"));
    assert!(text.contains("Content-Type: text/event-stream\r\n"));
    assert!(text.contains("chunk-1"));
    assert!(text.contains("chunk-2"));
    assert!(text.contains("chunk-3"));
    assert!(text.contains("data: [DONE]"));
    assert!(text.ends_with("0\r\n\r\n"));

    upstream_task.await.expect("upstream task finishes");
    srv.shutdown().await;
}

#[tokio::test]
async fn studio_enforces_sec_fetch_site_host_origin_unc_block_and_300s_exec_ceiling() {
    let sandbox = TempTestDir::new("security-and-exec");
    let cfg = build_isolated_config(&sandbox);
    let srv = start_studio_server(cfg).await.expect("start studio");
    let addr = srv.local_addr();

    // 1. Universal Host / Origin / Sec-Fetch-Site guards -> 403
    let bad_host = send_raw_http(
        addr,
        "GET /api/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(bad_host.status, 403);
    assert_eq!(bad_host.json()["code"], "forbidden_host");

    let bad_origin = http_request(
        addr,
        "GET",
        "/api/health",
        &[("Origin", "https://evil.example")],
        None,
    )
    .await;
    assert_eq!(bad_origin.status, 403);
    assert_eq!(bad_origin.json()["code"], "forbidden_origin");

    let cross_site = http_request(
        addr,
        "GET",
        "/api/health",
        &[("Sec-Fetch-Site", "cross-site")],
        None,
    )
    .await;
    assert_eq!(cross_site.status, 403);
    assert_eq!(cross_site.json()["code"], "forbidden_cross_site");

    let same_origin = http_request(
        addr,
        "GET",
        "/api/health",
        &[("Sec-Fetch-Site", "same-origin")],
        None,
    )
    .await;
    assert_eq!(same_origin.status, 200);

    // 2. UNC/SMB network paths -> 400 unc_path_blocked
    let unc_file = http_request(
        addr,
        "GET",
        "/api/workspace/file?path=%5C%5Cevil-server%5Cshare%5Csecret.txt",
        &[],
        None,
    )
    .await;
    assert_eq!(unc_file.status, 400);
    assert_eq!(unc_file.json()["code"], "unc_path_blocked");

    #[cfg(windows)]
    let (prog, prog_args) = ("cmd", vec!["/C", "echo exec-timeout-ok"]);
    #[cfg(not(windows))]
    let (prog, prog_args) = ("sh", vec!["-c", "echo exec-timeout-ok"]);

    let unc_exec = http_request(
        addr,
        "POST",
        "/api/workspace/exec",
        &[],
        Some(json!({
            "program": prog,
            "args": prog_args,
            "cwd": "\\\\evil-server\\share"
        })),
    )
    .await;
    assert_eq!(unc_exec.status, 400);
    assert_eq!(unc_exec.json()["code"], "unc_path_blocked");

    // 3. /api/workspace/exec timeout raised to default 120s / max 300s
    let exec_120s = http_request(
        addr,
        "POST",
        "/api/workspace/exec",
        &[],
        Some(json!({
            "program": prog,
            "args": prog_args,
            "timeoutMs": 120_000
        })),
    )
    .await;
    assert_eq!(exec_120s.status, 200);
    assert_eq!(exec_120s.json()["success"], true);

    let exec_over_300s = http_request(
        addr,
        "POST",
        "/api/workspace/exec",
        &[],
        Some(json!({
            "program": prog,
            "args": prog_args,
            "timeoutMs": 300_001
        })),
    )
    .await;
    assert_eq!(exec_over_300s.status, 400);
    assert_eq!(exec_over_300s.json()["code"], "invalid_timeout");

    srv.shutdown().await;
}

#[tokio::test]
async fn studio_downloader_and_omnidrive_routes_enforce_ssrf_unc_wal_segments_and_sse() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    // 1. Live loopback mock HTTP server verifying SecurityPolicy::strict() blocks loopback SSRF.
    let mock_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback mock server");
    let mock_addr = mock_listener.local_addr().expect("mock addr");
    let mock_hits = Arc::new(AtomicUsize::new(0));
    let mock_hits_bg = Arc::clone(&mock_hits);
    let mock_task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = mock_listener.accept().await else {
                break;
            };
            mock_hits_bg.fetch_add(1, Ordering::Relaxed);
            let mut buf = [0_u8; 512];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest")
                .await;
        }
    });

    let sandbox = TempTestDir::new("wave3-downloads");
    let cfg = build_isolated_config(&sandbox);
    let dl_db = cfg.downloads_db_path();
    let ws_root = cfg.workspace_root.clone();
    let staging_dir = cfg.downloads_staging_dir();
    let srv = start_studio_server(cfg).await.expect("start studio");
    let addr = srv.local_addr();

    // 2. Host/Origin/Sec-Fetch-Site 403 guards apply to downloader and omni-drive routes.
    let bad_host = send_raw_http(
        addr,
        "GET /api/downloads/list HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(bad_host.status, 403);
    assert_eq!(bad_host.json()["code"], "forbidden_host");

    let bad_origin = http_request(
        addr,
        "GET",
        "/api/omni-drive/providers",
        &[("Origin", "https://evil.example")],
        None,
    )
    .await;
    assert_eq!(bad_origin.status, 403);
    assert_eq!(bad_origin.json()["code"], "forbidden_origin");

    let cross_site = http_request(
        addr,
        "GET",
        "/api/downloads/list",
        &[("Sec-Fetch-Site", "cross-site")],
        None,
    )
    .await;
    assert_eq!(cross_site.status, 403);
    assert_eq!(cross_site.json()["code"], "forbidden_cross_site");

    // 3. Loopback mock URL MUST be blocked with HTTP 403 and zero hits leaking to the loopback server.
    let loopback_url = format!("http://{mock_addr}/fixture.bin");
    let probe_ssrf = http_request(
        addr,
        "POST",
        "/api/downloads/probe",
        &[],
        Some(json!({ "url": loopback_url })),
    )
    .await;
    assert_eq!(probe_ssrf.status, 403);
    assert_eq!(probe_ssrf.json()["code"], "SSRF_OR_RANGE_POLICY_BLOCKED");

    let start_ssrf = http_request(
        addr,
        "POST",
        "/api/downloads/start",
        &[],
        Some(json!({ "url": loopback_url })),
    )
    .await;
    assert_eq!(start_ssrf.status, 403);
    assert_eq!(start_ssrf.json()["code"], "SSRF_OR_RANGE_POLICY_BLOCKED");
    assert_eq!(
        mock_hits.load(Ordering::Relaxed),
        0,
        "SSRF guard must never leak a TCP hit to loopback mock server"
    );

    // 4. UNC/SMB staging_dir -> 400 unc_path_blocked; inside-workspace staging_dir -> 403 FORBIDDEN_PATH.
    let start_unc = http_request(
        addr,
        "POST",
        "/api/downloads/start",
        &[],
        Some(json!({
            "url": "https://cdn.example.org/file.bin",
            "staging_dir": "\\\\evil-server\\share\\drop"
        })),
    )
    .await;
    assert_eq!(start_unc.status, 400);
    assert_eq!(start_unc.json()["code"], "unc_path_blocked");

    let start_nt_obj = http_request(
        addr,
        "POST",
        "/api/downloads/start",
        &[],
        Some(json!({
            "url": "https://cdn.example.org/file.bin",
            "staging_dir": "\\??\\C:\\Windows\\Temp\\drop"
        })),
    )
    .await;
    assert_eq!(start_nt_obj.status, 400);
    assert_eq!(start_nt_obj.json()["code"], "unc_path_blocked");

    let start_inside_ws = http_request(
        addr,
        "POST",
        "/api/downloads/start",
        &[],
        Some(json!({
            "url": "https://cdn.example.org/file.bin",
            "staging_dir": ws_root.join("inside-dl").display().to_string()
        })),
    )
    .await;
    assert_eq!(start_inside_ws.status, 403);
    assert_eq!(start_inside_ws.json()["code"], "FORBIDDEN_PATH");

    // 5. Seed a real persisted job + 128 segments in WAL SQLite and verify list/get/segments/SSE.
    let store = DownloadStore::open(&dl_db, Some(&ws_root)).expect("open wal store");
    let now_ms = 1_700_000_000_000u64;
    store
        .upsert_job(&DownloadJobSnapshot {
            job_id: "job-wave3-128".to_string(),
            sanitized_url: "https://cdn.example.org/archive.tar.zst".to_string(),
            provider_id: "generic_http".to_string(),
            destination_path: staging_dir.join("archive.tar.zst"),
            part_path: staging_dir.join("archive.tar.zst.part"),
            total_bytes: 128 * 1024,
            downloaded_bytes: 64 * 1024,
            status: DownloadStatus::Paused,
            pacing_mode: PacingMode::Adaptive,
            streams: 128,
            etag: Some("\"wave3-v1\"".to_string()),
            last_modified: None,
            validator_strength: HttpValidatorStrength::StrongEtag,
            sha256_expected: None,
            sha256_actual: None,
            crc32c_expected: None,
            crc32c_actual: None,
            error_code: None,
            error_message: None,
            drm_supported: false,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        })
        .expect("seed job");
    let segs: Vec<ChunkRange> = (0..128usize)
        .map(|i| ChunkRange {
            chunk_id: i,
            start: (i as u64) * 1024,
            end: ((i as u64) + 1) * 1024 - 1,
            downloaded: if i < 64 { 1024 } else { 0 },
            is_completed: i < 64,
        })
        .collect();
    store
        .replace_segments("job-wave3-128", &segs)
        .expect("seed 128 segments");
    drop(store);

    let list_resp = http_request(addr, "GET", "/api/downloads/list", &[], None).await;
    assert_eq!(list_resp.status, 200);
    assert_eq!(list_resp.json()["count"], 1);
    assert_eq!(list_resp.json()["drm_supported"], false);
    assert_eq!(list_resp.json()["jobs"][0]["job_id"], "job-wave3-128");

    let get_resp = http_request(
        addr,
        "GET",
        "/api/downloads/get?id=job-wave3-128",
        &[],
        None,
    )
    .await;
    assert_eq!(get_resp.status, 200);
    assert_eq!(get_resp.json()["job"]["streams"], 128);

    let segs_resp = http_request(
        addr,
        "GET",
        "/api/downloads/segments?id=job-wave3-128",
        &[],
        None,
    )
    .await;
    assert_eq!(segs_resp.status, 200);
    assert_eq!(segs_resp.json()["count"], 128);
    assert_eq!(segs_resp.json()["segments"][0]["is_completed"], true);
    assert_eq!(segs_resp.json()["segments"][127]["is_completed"], false);

    // Pause/cancel on non-running persisted job return clean 404 JOB_NOT_FOUND.
    let pause_resp = http_request(
        addr,
        "POST",
        "/api/downloads/pause",
        &[],
        Some(json!({ "job_id": "job-wave3-128" })),
    )
    .await;
    assert_eq!(pause_resp.status, 404);
    assert_eq!(pause_resp.json()["code"], "JOB_NOT_FOUND");

    let cancel_resp = http_request(
        addr,
        "POST",
        "/api/downloads/cancel",
        &[],
        Some(json!({ "job_id": "job-wave3-128" })),
    )
    .await;
    assert_eq!(cancel_resp.status, 404);
    assert_eq!(cancel_resp.json()["code"], "JOB_NOT_FOUND");

    // 6. Verify /api/downloads/events live SSE stream emits snapshot event immediately.
    let mut sse_client = TcpStream::connect(addr).await.expect("connect sse");
    let sse_req = format!(
        "GET /api/downloads/events HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n"
    );
    sse_client
        .write_all(sse_req.as_bytes())
        .await
        .expect("write sse req");
    let mut sse_buf = Vec::new();
    let mut tmp = [0_u8; 2048];
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let n = tokio::time::timeout(Duration::from_secs(2), sse_client.read(&mut tmp))
            .await
            .expect("sse read timeout")
            .expect("sse read ok");
        if n == 0 {
            break;
        }
        sse_buf.extend_from_slice(&tmp[..n]);
        let so_far = String::from_utf8_lossy(&sse_buf);
        if so_far.contains("event: snapshot") && so_far.contains("job-wave3-128") {
            break;
        }
    }
    let sse_text = String::from_utf8_lossy(&sse_buf);
    assert!(sse_text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(sse_text.contains("Content-Type: text/event-stream"));
    assert!(sse_text.contains("Transfer-Encoding: chunked"));
    assert!(sse_text.contains("event: snapshot"));
    assert!(sse_text.contains("job-wave3-128"));
    drop(sse_client);

    // 7. Verify all /api/omni-drive/* routes.
    let resolved = http_request(
        addr,
        "POST",
        "/api/omni-drive/resolve",
        &[],
        Some(json!({
            "url": "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
            "export_format": "pdf"
        })),
    )
    .await;
    assert_eq!(resolved.status, 200);
    assert_eq!(resolved.json()["resource"]["kind"], "google_doc");
    assert_eq!(resolved.json()["export_target"]["extension"], "pdf");

    let batch = http_request(
        addr,
        "POST",
        "/api/omni-drive/batch-expand",
        &[],
        Some(json!({
            "pattern": "https://cdn.example.org/dataset-[01-03].bin"
        })),
    )
    .await;
    assert_eq!(batch.status, 200);
    assert_eq!(batch.json()["count"], 3);

    // Minimal ISO-BMFF `ftyp` + `pssh` (Widevine UUID) bytes to prove read-only DRM detection.
    let mut mp4_bytes: Vec<u8> = Vec::new();
    mp4_bytes.extend_from_slice(&20u32.to_be_bytes());
    mp4_bytes.extend_from_slice(b"ftypisom\x00\x00\x02\x00isom");
    // pssh box: 8 header + 4 version/flags + 16 Widevine system_id + 4 data_size = 32 bytes
    mp4_bytes.extend_from_slice(&32u32.to_be_bytes());
    mp4_bytes.extend_from_slice(b"pssh");
    mp4_bytes.extend_from_slice(&[0, 0, 0, 0]);
    mp4_bytes.extend_from_slice(&[
        0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21,
        0xed,
    ]);
    mp4_bytes.extend_from_slice(&0u32.to_be_bytes());
    let mp4_b64 = base64::engine::general_purpose::STANDARD.encode(&mp4_bytes);

    let media = http_request(
        addr,
        "POST",
        "/api/omni-drive/inspect-media",
        &[],
        Some(json!({ "bytes_base64": mp4_b64 })),
    )
    .await;
    assert_eq!(media.status, 200);
    assert_eq!(media.json()["drm_supported"], false);
    assert_eq!(media.json()["report"]["has_pssh"], true);
    assert_eq!(media.json()["report"]["drm_detected"], true);

    let providers = http_request(addr, "GET", "/api/omni-drive/providers", &[], None).await;
    assert_eq!(providers.status, 200);
    assert_eq!(providers.json()["count"], 23);

    let handoffs = http_request(addr, "GET", "/api/omni-drive/handoffs", &[], None).await;
    assert_eq!(handoffs.status, 200);
    assert_eq!(
        handoffs.json()["execution_mode"],
        "MANUAL_VISIBLE_BROWSER_ONLY"
    );
    assert_eq!(handoffs.json()["auto_solve_permitted"], false);

    mock_task.abort();
    srv.shutdown().await;
}

#[tokio::test]
async fn studio_notebook_crud_ingest_grounding_btw_bridge_and_artifacts_roundtrip() {
    let sandbox = TempTestDir::new("wave3-notebooks");
    let cfg = build_isolated_config(&sandbox);
    let srv = start_studio_server(cfg).await.expect("start studio");
    let addr = srv.local_addr();

    // 1. Status & CRUD
    let status = http_request(addr, "GET", "/api/notebooks/status", &[], None).await;
    assert_eq!(status.status, 200);
    assert_eq!(status.json()["status"]["crate_name"], "omnia-notebook");

    let created = http_request(
        addr,
        "POST",
        "/api/notebooks",
        &[],
        Some(json!({
            "title": "Wave 3 Research Notebook",
            "description": "Studio integration test notebook"
        })),
    )
    .await;
    assert_eq!(created.status, 200);
    let nb_id = created.json()["notebook"]["notebook_id"]
        .as_str()
        .expect("notebook_id")
        .to_string();

    let listed = http_request(addr, "GET", "/api/notebooks", &[], None).await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.json()["count"], 1);

    let fetched = http_request(
        addr,
        "GET",
        &format!("/api/notebooks/get?id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(fetched.status, 200);
    assert_eq!(fetched.json()["notebook"]["title"], "Wave 3 Research Notebook");

    let updated_model = http_request(
        addr,
        "POST",
        "/api/notebooks/model",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "model_id": "gemini-3.8-flash",
            "effort": "high"
        })),
    )
    .await;
    assert_eq!(updated_model.status, 200);
    assert_eq!(updated_model.json()["notebook"]["effort_level"], "high");

    // 2. Source ingest (+ UNC guard) + list + preview
    let unc_ingest = http_request(
        addr,
        "POST",
        "/api/notebooks/sources/ingest",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "filename": "\\\\evil-server\\share\\doc.md",
            "text": "blocked"
        })),
    )
    .await;
    assert_eq!(unc_ingest.status, 400);
    assert_eq!(unc_ingest.json()["code"], "unc_path_blocked");

    let ingested = http_request(
        addr,
        "POST",
        "/api/notebooks/sources/ingest",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "title": "Rust Architecture Notes",
            "filename": "architecture.md",
            "text": "# Omnia Studio\nOmnia uses winsqlite WAL mode and Win32 Job Objects for zero-orphan subprocess supervision.\n"
        })),
    )
    .await;
    assert_eq!(ingested.status, 200);
    let source_id = ingested.json()["outcome"]["source"]["source_id"]
        .as_str()
        .expect("source_id")
        .to_string();

    let sources = http_request(
        addr,
        "GET",
        &format!("/api/notebooks/sources?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(sources.status, 200);
    assert_eq!(sources.json()["count"], 1);

    let preview = http_request(
        addr,
        "POST",
        "/api/notebooks/preview",
        &[],
        Some(json!({
            "filename": "sample.html",
            "text": "<html><body><h1>Preview</h1></body></html>"
        })),
    )
    .await;
    assert_eq!(preview.status, 200);
    assert_eq!(
        preview.header("X-Content-Type-Options"),
        Some("nosniff")
    );
    assert!(
        preview
            .header("Content-Disposition")
            .unwrap_or_default()
            .starts_with("attachment"),
        "HTML preview HTTP header must force Content-Disposition: attachment"
    );
    assert!(
        preview
            .header("Content-Security-Policy")
            .unwrap_or_default()
            .contains("sandbox"),
        "HTML preview HTTP header must emit sandbox CSP"
    );
    assert_eq!(
        preview.json()["preview"]["headers"]["x_content_type_options"],
        "nosniff"
    );
    assert!(preview.json()["preview"]["headers"]["content_disposition"]
        .as_str()
        .unwrap_or_default()
        .starts_with("attachment"));

    // 3. Grounded prompt, citation verification & main turns
    let grounded = http_request(
        addr,
        "POST",
        "/api/notebooks/grounded-prompt",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "query": "How does Omnia supervise subprocesses?",
            "max_chunks": 4
        })),
    )
    .await;
    assert_eq!(grounded.status, 200);
    assert!(
        !grounded.json()["pack"]["evidence"]
            .as_array()
            .expect("evidence array")
            .is_empty()
    );

    let verify_ok = http_request(
        addr,
        "POST",
        "/api/notebooks/verify-citations",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "response_markdown": format!("Omnia uses Win32 Job Objects [{source_id}:0].")
        })),
    )
    .await;
    assert_eq!(verify_ok.status, 200);
    assert_eq!(verify_ok.json()["report"]["valid"], true);

    let turn = http_request(
        addr,
        "POST",
        "/api/notebooks/turns",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "surface": "notebook",
            "prompt_text": "How does Omnia supervise subprocesses?",
            "response_markdown": format!("Omnia uses Win32 Job Objects [{source_id}:0]."),
            "model_id": "gemini-3.8-flash",
            "effort": "medium",
            "citations": [format!("{source_id}:0")]
        })),
    )
    .await;
    assert_eq!(turn.status, 200);
    let turn_id = turn.json()["turn"]["turn_id"]
        .as_str()
        .expect("turn_id")
        .to_string();

    // 4. Unified Quote + BTW (zero pollution on main turns!) + promote + Cross-Bridge
    let quote_card = http_request(
        addr,
        "POST",
        "/api/btw/quote-card",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "surface": "notebook",
            "anchor_turn_id": turn_id,
            "source_id": source_id,
            "excerpt": "Win32 Job Objects",
            "char_start": 11,
            "char_end": 28
        })),
    )
    .await;
    assert_eq!(quote_card.status, 200);
    let quote_ref = quote_card.json()["card"]["quote"].clone();

    let btw_created = http_request(
        addr,
        "POST",
        "/api/btw/create",
        &[],
        Some(json!({
            "quote": quote_ref,
            "question": "Does KILL_ON_JOB_CLOSE handle grandchildren too?"
        })),
    )
    .await;
    assert_eq!(btw_created.status, 200);
    let btw_id = btw_created.json()["thread"]["btw_id"]
        .as_str()
        .expect("btw_id")
        .to_string();

    let btw_appended = http_request(
        addr,
        "POST",
        "/api/btw/append",
        &[],
        Some(json!({
            "btw_id": btw_id,
            "role": "assistant",
            "content": "Yes, closing the Job handle kills all descendant processes synchronously."
        })),
    )
    .await;
    assert_eq!(btw_appended.status, 200);
    assert_eq!(
        btw_appended.json()["thread"]["messages"]
            .as_array()
            .expect("messages")
            .len(),
        2
    );

    // Zero-pollution invariant: main turns count must still be 1!
    let turns_after_btw = http_request(
        addr,
        "GET",
        &format!("/api/notebooks/turns?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(turns_after_btw.status, 200);
    assert_eq!(turns_after_btw.json()["count"], 1);

    let btw_list = http_request(
        addr,
        "GET",
        &format!("/api/btw/list?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(btw_list.status, 200);
    assert_eq!(btw_list.json()["count"], 1);

    let promoted = http_request(
        addr,
        "POST",
        "/api/btw/promote",
        &[],
        Some(json!({
            "btw_id": btw_id,
            "title": "Promoted BTW Note"
        })),
    )
    .await;
    assert_eq!(promoted.status, 200);
    assert_eq!(promoted.json()["outcome"]["source"]["title"], "Promoted BTW Note");

    let bridged = http_request(
        addr,
        "POST",
        "/api/bridge",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "direction": "gemini_to_notebook",
            "title": "Gemini Insight",
            "content": "Captured insight from Gemini side panel."
        })),
    )
    .await;
    assert_eq!(bridged.status, 200);

    let bridge_events = http_request(
        addr,
        "GET",
        &format!("/api/bridge?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(bridge_events.status, 200);
    assert_eq!(bridge_events.json()["count"], 1);

    // 5. Artifacts generate/list/rename/delete + heal/clear + delete notebook
    // Real LLM Notebook Artifacts (no fake chunk-0 templates: unconfigured fails honestly, mock HTTP LLM succeeds)
    let unconf_art = http_request(
        addr,
        "POST",
        "/api/notebooks/artifacts",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "kind": "briefing",
            "title": "Unconfigured Probe",
            "provider": "openai",
            "model": "gpt-5.4"
        })),
    )
    .await;
    assert_ne!(unconf_art.status, 200);

    let llm_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_addr = llm_listener.local_addr().unwrap();
    let llm_task = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for _ in 0..3 {
            let Ok((mut s, _)) = llm_listener.accept().await else {
                break;
            };
            let mut buf = [0u8; 8192];
            let _ = s.read(&mut buf).await;
            let body = serde_json::json!({
                "id": "chatcmpl-test",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "## Architecture Briefing\nGrounded architecture overview based on ingested source chunks."
                    }
                }],
                "usage": { "prompt_tokens": 32, "completion_tokens": 18 }
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        }
    });

    let artifact = http_request(
        addr,
        "POST",
        "/api/notebooks/artifacts",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "kind": "briefing",
            "title": "Architecture Briefing",
            "baseUrl": format!("http://{llm_addr}/v1"),
            "apiKey": "dummy_test_api_key_example",
            "model": "dummy-model",
            "wireApi": "openai-completions",
            "allowLoopback": true
        })),
    )
    .await;
    llm_task.abort();
    assert_eq!(artifact.status, 200);
    assert_eq!(
        artifact.json()["artifact"]["structured_json"]["generated_by"],
        "real_llm"
    );
    let art_id = artifact.json()["artifact"]["artifact_id"]
        .as_str()
        .expect("artifact_id")
        .to_string();

    let renamed = http_request(
        addr,
        "POST",
        "/api/notebooks/artifacts/rename",
        &[],
        Some(json!({
            "artifact_id": art_id,
            "title": "Updated Briefing"
        })),
    )
    .await;
    assert_eq!(renamed.status, 200);
    assert_eq!(renamed.json()["artifact"]["title"], "Updated Briefing");

    let art_list = http_request(
        addr,
        "GET",
        &format!("/api/notebooks/artifacts?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(art_list.status, 200);
    assert_eq!(art_list.json()["count"], 1);

    let healed = http_request(
        addr,
        "POST",
        "/api/notebooks/sources/heal",
        &[],
        Some(json!({ "notebook_id": nb_id })),
    )
    .await;
    assert_eq!(healed.status, 200);

    let cleared = http_request(
        addr,
        "POST",
        "/api/notebooks/sources/clear",
        &[],
        Some(json!({ "notebook_id": nb_id })),
    )
    .await;
    assert_eq!(cleared.status, 200);
    // Clear sources MUST preserve turns and artifacts!
    let turns_after_clear = http_request(
        addr,
        "GET",
        &format!("/api/notebooks/turns?notebook_id={nb_id}"),
        &[],
        None,
    )
    .await;
    assert_eq!(turns_after_clear.json()["count"], 1);

    let art_deleted = http_request(
        addr,
        "POST",
        "/api/notebooks/artifacts/delete",
        &[],
        Some(json!({ "artifact_id": art_id })),
    )
    .await;
    assert_eq!(art_deleted.status, 200);
    assert_eq!(art_deleted.json()["deleted"], true);

    let nb_deleted = http_request(
        addr,
        "POST",
        "/api/notebooks/delete",
        &[],
        Some(json!({ "notebook_id": nb_id })),
    )
    .await;
    assert_eq!(nb_deleted.status, 200);
    assert_eq!(nb_deleted.json()["deleted"], true);

    srv.shutdown().await;
}

#[tokio::test]
async fn studio_v5_routes_ws_events_ide_browser_kb_atelier_and_omnidrive_work_end_to_end() {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let temp_dir = TempTestDir::new("studio-v5-e2e");
    let cfg = build_isolated_config(&temp_dir);
    let ws_root = cfg.workspace_root.clone();
    fs::write(ws_root.join("hello.rs"), "pub fn greet() -> i32 { 42 }\n").unwrap();

    let server = start_studio_server(cfg)
        .await
        .expect("bind studio server");
    let addr = server.local_addr();

    // 1. WebSocket /ws multiplexed handshake & ping/pong + live EventFeed broadcast
    let (mut ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("connect /ws");
    let hello_msg = ws_stream.next().await.expect("ws hello").expect("ws text");
    assert!(hello_msg.to_text().unwrap().contains("ws_connected"));
    ws_stream
        .send(WsMessage::Text(r#"{"type":"ping"}"#.into()))
        .await
        .unwrap();
    let pong_msg = ws_stream.next().await.expect("ws pong").expect("ws text");
    assert!(pong_msg.to_text().unwrap().contains("pong"));

    // 2. Attachments SHA-256 roundtrip
    let up = http_request(
        addr,
        "POST",
        "/api/attachments/upload",
        &[],
        Some(json!({
            "sessionId": "sess-v5-1",
            "placement": "inline",
            "filename": "note.txt",
            "mimeType": "text/plain",
            "dataBase64": omnia_core::base64_encode(b"Multimodal payload fixture")
        })),
    )
    .await;
    assert_eq!(up.status, 200);
    let sha = up.json()["attachment"]["sha256"].as_str().unwrap().to_string();
    let att_get = http_request(
        addr,
        "GET",
        &format!("/api/attachments/get?sha256={sha}"),
        &[],
        None,
    )
    .await;
    assert_eq!(att_get.status, 200);

    // 3. EventFeed recent + SSE replay check
    let recent = http_request(addr, "GET", "/api/events/recent?since=0", &[], None).await;
    assert_eq!(recent.status, 200);
    assert!(!recent.json()["events"].as_array().unwrap().is_empty());

    // 4. Dual-Scope Models & Agent Modes + Chat BTW
    let set_role = http_request(
        addr,
        "POST",
        "/api/models/config",
        &[],
        Some(json!({
            "scope": "main",
            "providerId": "openai",
            "modelId": "gpt-6.2-sol",
            "effort": "high"
        })),
    )
    .await;
    assert_eq!(set_role.status, 200);
    let get_roles = http_request(addr, "GET", "/api/models/config", &[], None).await;
    assert_eq!(get_roles.status, 200);
    assert_eq!(get_roles.json()["roles"][0]["modelId"], "gpt-6.2-sol");

    let mode_set = http_request(
        addr,
        "POST",
        "/api/agent/mode",
        &[],
        Some(json!({ "sessionId": "sess-v5-1", "mode": "solo" })),
    )
    .await;
    assert_eq!(mode_set.status, 200);
    assert_eq!(mode_set.json()["mode"], "solo");

    let cbtw = http_request(
        addr,
        "POST",
        "/api/sessions/btw/create",
        &[],
        Some(json!({
            "sessionId": "sess-v5-1",
            "quoteText": "pub fn greet",
            "question": "What does greet return?"
        })),
    )
    .await;
    assert_eq!(cbtw.status, 200);

    // 5. IDE Workspace tree/read/write + ConPTY Terminal create/list/resize/kill
    let fw = http_request(
        addr,
        "POST",
        "/api/files/write",
        &[],
        Some(json!({ "path": "notes.md", "content": "Hello Studio v5\n" })),
    )
    .await;
    assert_eq!(fw.status, 200);
    let fr = http_request(addr, "GET", "/api/files/read?path=notes.md", &[], None).await;
    assert_eq!(fr.status, 200);
    assert_eq!(fr.json()["content"], "Hello Studio v5\n");

    let pty = http_request(
        addr,
        "POST",
        "/api/terminal/create",
        &[],
        Some(json!({ "cols": 100, "rows": 30 })),
    )
    .await;
    assert_eq!(pty.status, 200);
    let pty_id = pty.json()["terminal"]["ptyId"].as_str().unwrap().to_string();
    let pty_resize = http_request(
        addr,
        "POST",
        "/api/pty/resize",
        &[],
        Some(json!({ "ptyId": pty_id, "cols": 132, "rows": 40 })),
    )
    .await;
    assert_eq!(pty_resize.status, 200);
    let pty_kill = http_request(
        addr,
        "POST",
        "/api/terminal/kill",
        &[],
        Some(json!({ "ptyId": pty_id })),
    )
    .await;
    assert_eq!(pty_kill.status, 200);

    // 6. Isolated Browser CDP strictly blocks live Thorium paths
    let thorium_block = http_request(
        addr,
        "POST",
        "/api/browser/launch",
        &[],
        Some(json!({ "executablePath": r"C:\Apps\Thorium\Application\thorium.exe" })),
    )
    .await;
    assert_eq!(thorium_block.status, 403);

    // 7. `omp-omni` KB/Pastes/Kanban/Inbox/Routines/Stats/Scoreboard/Management
    assert_eq!(
        http_request(
            addr,
            "POST",
            "/api/kb/notes",
            &[],
            Some(json!({ "title": "Studio v5", "content": "Full Native Rust notes" })),
        )
        .await
        .status,
        200
    );
    assert_eq!(
        http_request(
            addr,
            "POST",
            "/api/pastes",
            &[],
            Some(json!({ "title": "snippet", "language": "rust", "content": "fn ok() {}" })),
        )
        .await
        .status,
        200
    );
    assert_eq!(
        http_request(
            addr,
            "POST",
            "/api/kanban/tasks",
            &[],
            Some(json!({ "title": "Verify UI v5", "status": "doing" })),
        )
        .await
        .status,
        200
    );
    assert_eq!(
        http_request(
            addr,
            "POST",
            "/api/inbox",
            &[],
            Some(json!({ "content": "Check live CDP smoke" })),
        )
        .await
        .status,
        200
    );
    assert_eq!(
        http_request(
            addr,
            "POST",
            "/api/routines",
            &[],
            Some(json!({ "name": "nightly", "prompt": "run audit" })),
        )
        .await
        .status,
        200
    );
    assert_eq!(
        http_request(addr, "GET", "/api/stats/overview", &[], None)
            .await
            .status,
        200
    );
    assert_eq!(
        http_request(addr, "GET", "/api/benchmarks/scoreboard", &[], None)
            .await
            .status,
        200
    );
    let mgmt = http_request(addr, "GET", "/api/management/status", &[], None).await;
    assert_eq!(mgmt.status, 200);
    assert_eq!(mgmt.json()["state"], "unconfigured");

    // 8. OmniDrive CAS CaptureBundle seal+verify & 3-gram SchemaDrift
    let sealed = http_request(
        addr,
        "POST",
        "/api/downloads/capture-bundles",
        &[],
        Some(json!({
            "sourceUrl": "https://example.com/course",
            "parts": [{ "name": "meta", "mediaType": "text/plain", "text": "hello cas" }]
        })),
    )
    .await;
    assert_eq!(sealed.status, 200);
    let bundle_val = sealed.json()["bundle"].clone();
    let verified = http_request(
        addr,
        "POST",
        "/api/downloads/capture-bundles/verify",
        &[],
        Some(json!({ "bundle": bundle_val })),
    )
    .await;
    assert_eq!(verified.status, 200);
    assert_eq!(verified.json()["verified"], true);

    let drift = http_request(
        addr,
        "POST",
        "/api/downloads/schema-drift",
        &[],
        Some(json!({
            "before": "{\"a\":1,\"b\":\"x\"}",
            "after": "{\"a\":1,\"c\":\"x\"}"
        })),
    )
    .await;
    assert_eq!(drift.status, 200);
    assert_eq!(drift.json()["drift"]["drift_detected"], true);

    // 9. Atelier ask with loopback mock LLM + tombstone sync
    let nb = http_request(
        addr,
        "POST",
        "/api/atelier",
        &[],
        Some(json!({ "title": "Atelier v5", "description": "Real LLM test" })),
    )
    .await;
    assert_eq!(nb.status, 200);
    let nb_id = nb.json()["notebook"]["notebook_id"].as_str().unwrap().to_string();
    let ing = http_request(
        addr,
        "POST",
        "/api/atelier/sources/ingest",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "remote_id": "rem_a1",
            "title": "Core Note",
            "filename": "core-note.md",
            "media_type": "text/markdown",
            "text": "Omnia uses winsqlite3 WAL and real ConPTY sessions."
        })),
    )
    .await;
    assert_eq!(ing.status, 200);
    let src_id = ing.json()["outcome"]["source"]["source_id"]
        .as_str()
        .expect("ingested source_id")
        .to_string();

    let llm_srv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_addr = llm_srv.local_addr().unwrap();
    let cited_marker = format!("[{src_id}:0]");
    let llm_handle = tokio::spawn(async move {
        if let Ok((mut s, _)) = llm_srv.accept().await {
            let mut buf = [0u8; 8192];
            let _ = s.read(&mut buf).await;
            let body = serde_json::json!({
                "id": "chatcmpl-atelier",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": format!("Omnia runs on winsqlite3 WAL {cited_marker}.")
                    }
                }],
                "usage": { "prompt_tokens": 20, "completion_tokens": 12 }
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        }
    });
    let ask = http_request(
        addr,
        "POST",
        "/api/atelier/ask",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "query": "What SQLite backend does Omnia use?",
            "baseUrl": format!("http://{llm_addr}/v1"),
            "apiKey": "dummy_test_api_key_example",
            "model": "dummy-model",
            "wireApi": "openai-completions",
            "allowLoopback": true
        })),
    )
    .await;
    llm_handle.abort();
    assert_eq!(ask.status, 200);

    let del_src = http_request(
        addr,
        "POST",
        "/api/atelier/sources/delete",
        &[],
        Some(json!({ "notebook_id": nb_id, "source_id": src_id, "reason": "user_deleted" })),
    )
    .await;
    assert_eq!(del_src.status, 200);
    let rec = http_request(
        addr,
        "POST",
        "/api/atelier/sync/reconcile",
        &[],
        Some(json!({
            "notebook_id": nb_id,
            "remoteItems": [{ "remote_id": "rem_a1", "title": "Core Note" }],
            "remoteSnapshotComplete": true
        })),
    )
    .await;
    assert_eq!(rec.status, 200);
    assert!(rec.json()["report"]["active_sources"].as_array().unwrap().is_empty());

    let _ = ws_stream.close(None).await;
    server.shutdown().await;
}
