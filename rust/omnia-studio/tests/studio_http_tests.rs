//! End-to-end integration tests for `omnia-studio` covering HTTP/1.1 AdGuard tolerances,
//! loopback CORS/Origin/Host guards, path-traversal protection, 3,000ms stalled proxy
//! timeout, legacy `/api/*` parity, immutable history rollback, and capability crates.

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
    raw.push_str("Origin: http://localhost:3000\r\nConnection: close\r\n\r\n");

    let reply = send_raw_http(addr, &raw).await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("Access-Control-Allow-Origin"),
        Some("http://localhost:3000")
    );
    let json = reply.json();
    assert_eq!(json["ok"], true);
    assert_eq!(json["state"], "online");
    assert_eq!(json["engine"], "Omnia Full Native Rust");
    assert_eq!(json["compiler"], "rustc 1.99.1");
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

    let preflight = http_request(
        addr,
        "OPTIONS",
        "/api/health",
        &[("Origin", "http://127.0.0.1:8787")],
        None,
    )
    .await;
    assert_eq!(preflight.status, 204);
    assert_eq!(
        preflight.header("Access-Control-Allow-Origin"),
        Some("http://127.0.0.1:8787")
    );

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

    // PeerMeshGraph & Graphify
    let graph = http_request(addr, "GET", "/api/graph", &[], None).await;
    assert_eq!(graph.status, 200);
    assert!(!graph.json()["nodes"].as_array().expect("nodes").is_empty());

    let peers = http_request(addr, "GET", "/api/graph/peers", &[], None).await;
    assert_eq!(peers.status, 200);
    assert!(peers.json()["peerCount"].as_u64().unwrap_or(0) >= 2);

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

    // DynamicProviderRouter (`tokenBudget: null` invariant)
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
    assert!(Path::new(receipt_path).starts_with(&rollback_dir));

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
    let frame_ok = http_request(
        addr,
        "POST",
        "/api/remote/frame",
        &[],
        Some(json!({
            "sessionId": "dummy-session-remote",
            "frameId": 7,
            "width": 1280,
            "height": 720
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
