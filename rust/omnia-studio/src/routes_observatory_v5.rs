//! Studio v5 Observatory, Network Diagnostics & Streaming Speedtest, Lab-Grade Telemetry,
//! Host Hardware/WAL/Ports, SQLite Router Lab, CredMan V5, Smart Alerts, Side-by-Side Diffing,
//! One-Click Exports (JSON/CSV/Markdown/Diagnostic), Privacy Mask, and Steer Controls.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use omnia_agent::read_models_config;
use omnia_core::credentials::CredentialStore;
use omnia_core::{now_epoch_ms, uuid_v4, PrivacyMask, SecretRedactor};
use omnia_harness::steer_queue::SteerStatus;
use omnia_routing::{CircuitState, QuotaState};
use omnia_workspace_ops::hardware::collect_host_system_snapshot;
use omnia_workspace_ops::net_diag::{
    default_upstream_targets, inspect_dns_and_benchmark, inspect_network_identity,
    inspect_proxy_tls_and_endpoints, run_speedtest_streaming, DnsBenchOptions, DnsIntelReport,
    EndpointProbeTarget, NetDiagOptions, NetworkIdentityReport, SpeedtestConfig,
    SpeedtestProgressEvent, SpeedtestResult,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::http::{HttpRequest, HttpResponse};
use crate::mgmt_proxy::build_benchmark_scoreboard;
use crate::ops_store::{RichUsageTraceInput, TraceQueryFilter};
use crate::routes_legacy::StudioState;
use crate::telemetry::inspect_sqlite_wal_files;

const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Runtime state for live on-demand speedtests and cached observatory diagnostics.
pub struct ObservatoryState {
    active_run: Mutex<Option<ActiveSpeedtestRun>>,
    last_identity: Mutex<Option<NetworkIdentityReport>>,
    last_dns: Mutex<Option<DnsIntelReport>>,
}

struct ActiveSpeedtestRun {
    run_id: String,
    profile: String,
    cancel: Arc<AtomicBool>,
    progress_tx: broadcast::Sender<SpeedtestProgressEvent>,
    started_at_ms: i64,
    finished: Arc<AtomicBool>,
    final_result: Arc<Mutex<Option<SpeedtestResult>>>,
}

impl Default for ObservatoryState {
    fn default() -> Self {
        Self {
            active_run: Mutex::new(None),
            last_identity: Mutex::new(None),
            last_dns: Mutex::new(None),
        }
    }
}

impl ObservatoryState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn active_run_summary(&self) -> Option<Value> {
        let g = self.active_run.lock();
        g.as_ref().and_then(|r| {
            if r.finished.load(Ordering::Relaxed) {
                None
            } else {
                Some(json!({
                    "runId": r.run_id,
                    "profile": r.profile,
                    "startedAtMs": r.started_at_ms,
                    "status": "running",
                }))
            }
        })
    }
}

/// Returns `true` when `path` belongs to the Observatory v5 route family (used for `405` dispatch).
#[must_use]
pub fn is_known_route(path: &str) -> bool {
    matches!(
        path,
        "/api/v5/network/overview"
            | "/api/v5/network/identity"
            | "/api/network/identity"
            | "/api/v5/network/dns"
            | "/api/v5/network/dns/benchmark"
            | "/api/v5/network/proxy-tls"
            | "/api/v5/network/speedtest/start"
            | "/api/v5/network/speedtest/cancel"
            | "/api/v5/network/speedtest/stream"
            | "/api/v5/network/speedtest/history"
            | "/api/v5/telemetry/summary"
            | "/api/v5/telemetry/requests"
            | "/api/v5/telemetry/record"
            | "/api/v5/system/snapshot"
            | "/api/v5/hardware/host"
            | "/api/v5/router/state"
            | "/api/v5/router/decide"
            | "/api/v5/router/trip"
            | "/api/v5/router/reset"
            | "/api/v5/router/receipt"
            | "/api/router/breaker"
            | "/api/v5/creds"
            | "/api/v5/creds/delete"
            | "/api/v5/alerts"
            | "/api/v5/diff/sessions"
            | "/api/v5/diff/speedtests"
            | "/api/v5/diff/models"
            | "/api/v5/diff/benchmarks"
            | "/api/v5/export"
            | "/api/v5/steer/status"
            | "/api/v5/steer/reconcile"
    )
}

/// Dispatches all `/api/v5/{network,telemetry,system,hardware,router,creds,alerts,diff,export,steer}/*` routes.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    let resp = match (req.method.as_str(), req.path.as_str()) {
        // 1. Network Observatory & On-Demand Streaming Speedtest
        ("GET", "/api/v5/network/overview") => handle_network_overview(state, req).await,
        ("GET", "/api/v5/network/identity")
        | ("POST", "/api/v5/network/identity")
        | ("GET", "/api/network/identity") => handle_network_identity(state, req).await,
        ("GET", "/api/v5/network/dns")
        | ("POST", "/api/v5/network/dns")
        | ("GET", "/api/v5/network/dns/benchmark")
        | ("POST", "/api/v5/network/dns/benchmark") => handle_network_dns(state, req).await,
        ("GET", "/api/v5/network/proxy-tls") | ("POST", "/api/v5/network/proxy-tls") => {
            handle_network_proxy_tls(state, req).await
        }
        ("POST", "/api/v5/network/speedtest/start") => handle_speedtest_start(state, req),
        ("POST", "/api/v5/network/speedtest/cancel") => handle_speedtest_cancel(state, req),
        ("GET", "/api/v5/network/speedtest/stream") => handle_speedtest_stream(state, req),
        ("GET", "/api/v5/network/speedtest/history") => handle_speedtest_history(state, req),

        // 2. Lab-Grade AI Telemetry & Statistical Forensics
        ("GET", "/api/v5/telemetry/summary") => handle_telemetry_summary(state, req),
        ("GET", "/api/v5/telemetry/requests") => handle_telemetry_requests(state, req),
        ("POST", "/api/v5/telemetry/record") => handle_telemetry_record(state, req),

        // 3. Host Hardware, Storage, SQLite WAL, Listening Dev Ports
        ("GET", "/api/v5/system/snapshot") | ("GET", "/api/v5/hardware/host") => {
            handle_system_snapshot(state, req).await
        }

        // 4. Router Lab V5 (Persistent SQLite Breakers, Waterfalls, Runway, Timeline, Receipts)
        ("GET", "/api/v5/router/state") => handle_router_v5_state(state, req),
        ("POST", "/api/v5/router/decide") => handle_router_v5_decide(state, req),
        ("POST", "/api/v5/router/trip") => handle_router_breaker(state, req, Some("trip")),
        ("POST", "/api/v5/router/reset") => handle_router_breaker(state, req, Some("reset")),
        ("POST", "/api/router/breaker") => handle_router_breaker(state, req, None),
        ("GET", "/api/v5/router/receipt") => handle_router_receipt(state, req),

        // 5. CredMan V5 (Masked CRUD)
        ("GET", "/api/v5/creds") => handle_creds_list(req),
        ("POST", "/api/v5/creds") => handle_creds_set(req),
        ("POST", "/api/v5/creds/delete") => handle_creds_delete(req),

        // 6. Smart Alerts Engine
        ("GET", "/api/v5/alerts") => handle_smart_alerts(state, req).await,

        // 7. Side-by-Side Comparison / Diff Endpoints
        ("GET", "/api/v5/diff/sessions") => handle_diff_sessions(state, req),
        ("GET", "/api/v5/diff/speedtests") => handle_diff_speedtests(state, req),
        ("GET", "/api/v5/diff/models") => handle_diff_models(state, req),
        ("GET", "/api/v5/diff/benchmarks") => handle_diff_benchmarks(state, req),

        // 8. One-Click Exports (JSON / CSV / Markdown Executive Report / Redacted Diagnostic)
        ("GET", "/api/v5/export") => handle_export(state, req).await,

        // 9. Steer Queue Status & Reconcile
        ("POST", "/api/v5/steer/status") => handle_steer_status(state, req),
        ("POST", "/api/v5/steer/reconcile") => handle_steer_reconcile(state, req),

        _ => return None,
    };
    Some(resp)
}

fn wants_privacy_mask(req: &HttpRequest) -> bool {
    req.query_param("privacy_mask")
        .or_else(|| req.query_param("privacyMask"))
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

fn json_ok_masked(req: &HttpRequest, value: Value) -> HttpResponse {
    let out = if wants_privacy_mask(req) {
        PrivacyMask::mask_json(&value)
    } else {
        SecretRedactor::redact_json(&value)
    };
    HttpResponse::ok(out)
}

fn parse_body(req: &HttpRequest) -> Result<Value, HttpResponse> {
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice::<Value>(&req.body)
        .map_err(|e| HttpResponse::error(400, "invalid_json", &format!("Invalid JSON body: {e}")))
}

fn pick_str<'a>(val: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| val.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn pick_i64(val: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| {
        val.get(*k).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))
        })
    })
}

fn pick_f64(val: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|k| val.get(*k).and_then(Value::as_f64).filter(|f| f.is_finite()))
}

fn configured_upstream_targets() -> Vec<EndpointProbeTarget> {
    let mut targets = default_upstream_targets();
    if let Ok(cfg) = read_models_config(None) {
        for p in cfg.providers {
            let url = p.base_url.trim();
            let lower = url.to_ascii_lowercase();
            if url.is_empty()
                || lower.contains("agy")
                || lower.contains("antigravity")
                || lower.contains("127.0.0.1")
                || lower.contains("localhost")
                || targets.iter().any(|t| t.url.contains(url) || t.id == p.id)
            {
                continue;
            }
            targets.push(EndpointProbeTarget {
                id: p.id.clone(),
                label: format!("Provider: {}", p.id),
                url: url.to_string(),
            });
        }
    }
    targets
}

// =========================================================================
// 1. Network Observatory & Streaming Speedtest
// =========================================================================

async fn handle_network_overview(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let probe_public = req
        .query_param("probePublic")
        .or_else(|| req.query_param("probe_public"))
        .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false"))
        .unwrap_or(true);
    let force = req
        .query_param("force")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"));
    let targets = configured_upstream_targets();
    let state_c = Arc::clone(state);

    let res = tokio::task::spawn_blocking(move || {
        let identity = inspect_network_identity(&NetDiagOptions {
            probe_public_ip: probe_public,
            timeout_ms: 2_500,
            force_refresh: force,
        });
        *state_c.observatory.last_identity.lock() = Some(identity.clone());
        let dns_passive = inspect_dns_and_benchmark(&DnsBenchOptions {
            run_benchmark: false,
            public_ipv4_hint: identity.public_ipv4.clone(),
            ..DnsBenchOptions::default()
        });
        let proxy_tls = inspect_proxy_tls_and_endpoints(&targets, force);
        (identity, dns_passive, proxy_tls)
    })
    .await;

    match res {
        Ok((identity, dns_passive, proxy_tls)) => {
            let last_dns = state
                .observatory
                .last_dns
                .lock()
                .clone()
                .unwrap_or(dns_passive);
            let mut dns_val = serde_json::to_value(&last_dns).unwrap_or_else(|_| json!({}));
            if let Some(obj) = dns_val.as_object_mut() {
                obj.insert("provenance".to_string(), json!("LIVE"));
            }
            let mut proxy_val = serde_json::to_value(&proxy_tls).unwrap_or_else(|_| json!({}));
            if let Some(obj) = proxy_val.as_object_mut() {
                obj.insert("provenance".to_string(), json!("LIVE"));
            }
            let history = state.ops.list_speedtests(10).unwrap_or_default();
            let latest_speedtest = history.first().cloned();
            let active_speedtest = state.observatory.active_run_summary();
            json_ok_masked(
                req,
                json!({
                    "ok": true,
                    "identity": identity,
                    "dns": dns_val,
                    "proxyTls": proxy_val,
                    "latestSpeedtest": latest_speedtest,
                    "lastSpeedtest": latest_speedtest,
                    "recentSpeedtests": history,
                    "activeSpeedtest": active_speedtest,
                    "autoSpeedtestDisabled": true,
                }),
            )
        }
        Err(e) => HttpResponse::error(500, "network_overview_failed", &e.to_string()),
    }
}

async fn handle_network_identity(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = parse_body(req).unwrap_or_else(|_| json!({}));
    let force = req
        .query_param("force")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"))
        || body.get("force").and_then(Value::as_bool) == Some(true);
    let probe_public = req
        .query_param("probe_public")
        .or_else(|| req.query_param("probePublic"))
        .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false"))
        .or_else(|| body.get("probePublic").and_then(Value::as_bool))
        .unwrap_or(true);
    let state_c = Arc::clone(state);
    match tokio::task::spawn_blocking(move || {
        let rep = inspect_network_identity(&NetDiagOptions {
            probe_public_ip: probe_public,
            timeout_ms: 2_500,
            force_refresh: force,
        });
        *state_c.observatory.last_identity.lock() = Some(rep.clone());
        rep
    })
    .await
    {
        Ok(rep) => json_ok_masked(req, json!({ "ok": true, "identity": rep })),
        Err(e) => HttpResponse::error(500, "network_identity_failed", &e.to_string()),
    }
}

async fn handle_network_dns(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = parse_body(req).unwrap_or_else(|_| json!({}));
    let domain = req
        .query_param("domain")
        .or_else(|| pick_str(&body, &["domain", "queryDomain"]).map(ToString::to_string))
        .unwrap_or_else(|| "example.com".to_string());
    let trials = req
        .query_param("trials")
        .and_then(|s| s.parse::<usize>().ok())
        .or_else(|| body.get("trials").and_then(Value::as_u64).map(|n| n as usize))
        .unwrap_or(4)
        .clamp(1, 8);
    let run_bench = req
        .query_param("benchmark")
        .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false"))
        .or_else(|| body.get("runBenchmark").and_then(Value::as_bool))
        .unwrap_or(true);
    let pub_hint = state
        .observatory
        .last_identity
        .lock()
        .as_ref()
        .and_then(|id| id.public_ipv4.clone());
    let state_c = Arc::clone(state);

    match tokio::task::spawn_blocking(move || {
        let rep = inspect_dns_and_benchmark(&DnsBenchOptions {
            query_domain: domain,
            trials,
            timeout_ms: 1_000,
            run_benchmark: run_bench,
            public_ipv4_hint: pub_hint,
        });
        *state_c.observatory.last_dns.lock() = Some(rep.clone());
        rep
    })
    .await
    {
        Ok(rep) => {
            if rep.leak_status == "possible_dns_leak" {
                state.event_feed.publish(
                    "alerts",
                    "dns_leak_detected",
                    None,
                    json!({
                        "severity": "warn",
                        "kind": "dns_leak",
                        "message": rep.leak_warning,
                    }),
                );
            }
            json_ok_masked(req, json!({ "ok": true, "dns": rep }))
        }
        Err(e) => HttpResponse::error(500, "network_dns_failed", &e.to_string()),
    }
}

async fn handle_network_proxy_tls(_state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = parse_body(req).unwrap_or_else(|_| json!({}));
    let force = req
        .query_param("force")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"))
        || body.get("force").and_then(Value::as_bool) == Some(true);
    let targets = configured_upstream_targets();
    match tokio::task::spawn_blocking(move || inspect_proxy_tls_and_endpoints(&targets, force))
        .await
    {
        Ok(rep) => json_ok_masked(req, json!({ "ok": true, "proxyTls": rep })),
        Err(e) => HttpResponse::error(500, "network_proxy_tls_failed", &e.to_string()),
    }
}

fn handle_speedtest_start(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let profile = pick_str(&body, &["profile"]).unwrap_or("standard");
    let mut cfg = SpeedtestConfig::for_profile(profile);

    // Allow loopback baseUrlOverride strictly for isolated offline E2E/unit verification.
    if let Some(override_url) = pick_str(&body, &["baseUrlOverride", "base_url_override"]) {
        if !(override_url.starts_with("http://127.0.0.1:")
            || override_url.starts_with("http://localhost:"))
        {
            return HttpResponse::error(
                403,
                "forbidden_speedtest_override",
                "Custom speedtest baseUrlOverride is restricted to loopback addresses.",
            );
        }
        cfg.base_url_override = Some(override_url.to_string());
        cfg.unloaded_samples = 4;
        cfg.multi_streams = 2;
        cfg.phase_duration_ms = 900;
    }

    // Cancel any prior active run before starting a fresh one.
    {
        let active = state.observatory.active_run.lock();
        if let Some(ref prev) = *active {
            if !prev.finished.load(Ordering::Relaxed) {
                prev.cancel.store(true, Ordering::Relaxed);
            }
        }
    }

    let run_id = format!("spd_{}", uuid_v4());
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let final_result = Arc::new(Mutex::new(None));
    let (progress_tx, _) = broadcast::channel::<SpeedtestProgressEvent>(256);
    let started_at_ms = now_epoch_ms();

    {
        let mut active = state.observatory.active_run.lock();
        *active = Some(ActiveSpeedtestRun {
            run_id: run_id.clone(),
            profile: cfg.profile.clone(),
            cancel: Arc::clone(&cancel),
            progress_tx: progress_tx.clone(),
            started_at_ms,
            finished: Arc::clone(&finished),
            final_result: Arc::clone(&final_result),
        });
    }

    let state_bg = Arc::clone(state);
    let run_id_bg = run_id.clone();
    let cancel_bg = Arc::clone(&cancel);
    let finished_bg = Arc::clone(&finished);
    let final_res_bg = Arc::clone(&final_result);
    let tx_bg = progress_tx.clone();

    let profile_label = cfg.profile.clone();
    state.event_feed.publish(
        "network",
        "speedtest_started",
        None,
        json!({
            "runId": run_id,
            "profile": profile_label,
            "startedAtMs": started_at_ms,
        }),
    );

    tokio::task::spawn_blocking(move || {
        let result = run_speedtest_streaming(&run_id_bg, &cfg, cancel_bg, |ev| {
            let _ = tx_bg.send(ev.clone());
            if let Ok(val) = serde_json::to_value(&ev) {
                state_bg
                    .event_feed
                    .publish("network", "speedtest_sample", None, val);
            }
        });
        let _ = state_bg.ops.save_speedtest(&result);
        *final_res_bg.lock() = Some(result.clone());
        finished_bg.store(true, Ordering::Relaxed);
        if let Ok(val) = serde_json::to_value(&result) {
            state_bg
                .event_feed
                .publish("network", "speedtest_complete", None, val);
        }
        if matches!(result.bufferbloat_grade.as_str(), "C" | "D" | "F") && !result.cancelled {
            state_bg.event_feed.publish(
                "alerts",
                "bufferbloat_spike",
                None,
                json!({
                    "severity": if result.bufferbloat_grade == "C" { "warn" } else { "critical" },
                    "kind": "bufferbloat_spike",
                    "runId": result.run_id,
                    "grade": result.bufferbloat_grade,
                    "worstDeltaMs": result.worst_bufferbloat_delta_ms,
                }),
            );
        }
    });

    HttpResponse::ok(json!({
        "ok": true,
        "runId": run_id,
        "profile": profile_label,
        "status": "running",
        "streamUrl": format!("/api/v5/network/speedtest/stream?runId={run_id}"),
        "wsChannel": "network",
    }))
}

fn handle_speedtest_cancel(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = parse_body(req).unwrap_or_else(|_| json!({}));
    let target_id = pick_str(&body, &["runId", "run_id"]);
    let g = state.observatory.active_run.lock();
    if let Some(ref run) = *g {
        if target_id.is_none() || target_id == Some(run.run_id.as_str()) {
            run.cancel.store(true, Ordering::Relaxed);
            state.event_feed.publish(
                "network",
                "speedtest_cancelled",
                None,
                json!({ "runId": run.run_id }),
            );
            return HttpResponse::ok(json!({
                "ok": true,
                "runId": run.run_id,
                "cancelled": true,
            }));
        }
    }
    HttpResponse::ok(json!({
        "ok": true,
        "cancelled": false,
        "detail": "No matching active speedtest run.",
    }))
}

fn handle_speedtest_stream(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let req_run_id = req.query_param("runId").or_else(|| req.query_param("run_id"));
    let (tx, rx) = mpsc::channel::<Vec<u8>>(128);

    let active_snapshot = {
        let g = state.observatory.active_run.lock();
        g.as_ref().and_then(|r| {
            if req_run_id.as_deref().is_none() || req_run_id.as_deref() == Some(r.run_id.as_str()) {
                Some((
                    r.run_id.clone(),
                    r.progress_tx.subscribe(),
                    Arc::clone(&r.finished),
                    Arc::clone(&r.final_result),
                ))
            } else {
                None
            }
        })
    };

    tokio::spawn(async move {
        let Some((run_id, mut brx, finished, final_res)) = active_snapshot else {
            let frame = b"event: error\ndata: {\"code\":\"no_active_speedtest\"}\n\n".to_vec();
            let _ = tx.send(frame).await;
            return;
        };
        if finished.load(Ordering::Relaxed) {
            let res_opt = final_res.lock().clone();
            if let Some(res) = res_opt {
                if let Ok(raw) = serde_json::to_string(&res) {
                    let frame = format!("event: speedtest_complete\ndata: {raw}\n\n");
                    let _ = tx.send(frame.into_bytes()).await;
                }
            }
            return;
        }
        loop {
            match tokio::time::timeout(Duration::from_millis(400), brx.recv()).await {
                Ok(Ok(ev)) => {
                    if let Ok(raw) = serde_json::to_string(&ev) {
                        let frame = format!("event: speedtest_sample\ndata: {raw}\n\n");
                        if tx.send(frame.into_bytes()).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {
                    if finished.load(Ordering::Relaxed) {
                        let res_opt = final_res.lock().clone();
                        if let Some(res) = res_opt {
                            if let Ok(raw) = serde_json::to_string(&res) {
                                let frame = format!("event: speedtest_complete\ndata: {raw}\n\n");
                                let _ = tx.send(frame.into_bytes()).await;
                            }
                        } else {
                            let frame = format!(
                                "event: speedtest_complete\ndata: {{\"runId\":\"{run_id}\"}}\n\n"
                            );
                            let _ = tx.send(frame.into_bytes()).await;
                        }
                        break;
                    }
                }
            }
        }
    });

    HttpResponse::sse_channel(rx, SSE_KEEPALIVE_INTERVAL)
}

fn handle_speedtest_history(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let limit = req
        .query_param("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(30)
        .clamp(1, 100);
    match state.ops.list_speedtests(limit) {
        Ok(runs) => json_ok_masked(
            req,
            json!({
                "ok": true,
                "count": runs.len(),
                "runs": runs,
                "active": state.observatory.active_run_summary(),
            }),
        ),
        Err(e) => HttpResponse::error(500, "speedtest_history_failed", &e),
    }
}

// =========================================================================
// 2. Lab-Grade AI Telemetry & Statistical Forensics
// =========================================================================

fn parse_trace_filter(req: &HttpRequest) -> TraceQueryFilter {
    TraceQueryFilter {
        window_ms: TraceQueryFilter::parse_window_ms(req.query_param("window").as_deref()),
        model: req.query_param("model").filter(|s| !s.trim().is_empty()),
        role: req.query_param("role").filter(|s| !s.trim().is_empty()),
        session_id: req
            .query_param("sessionId")
            .or_else(|| req.query_param("session"))
            .filter(|s| !s.trim().is_empty()),
        limit: req
            .query_param("limit")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(100)
            .clamp(1, 500),
    }
}

fn handle_telemetry_summary(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let filter = parse_trace_filter(req);
    match state.ops.telemetry_summary(&filter) {
        Ok(summary) => {
            let alerts = evaluate_alerts_sync(state, None);
            json_ok_masked(
                req,
                json!({
                    "ok": true,
                    "window": req.query_param("window").unwrap_or_else(|| "all".to_string()),
                    "summary": summary,
                    "alerts": alerts,
                }),
            )
        }
        Err(e) => HttpResponse::error(500, "telemetry_summary_failed", &e),
    }
}

fn handle_telemetry_requests(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let filter = parse_trace_filter(req);
    match state.ops.list_rich_traces(&filter) {
        Ok(requests) => json_ok_masked(
            req,
            json!({
                "ok": true,
                "count": requests.len(),
                "requests": requests,
            }),
        ),
        Err(e) => HttpResponse::error(500, "telemetry_requests_failed", &e),
    }
}

fn handle_telemetry_record(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let input = RichUsageTraceInput {
        req_id: pick_str(&body, &["reqId", "req_id"]).unwrap_or("").to_string(),
        session_id: pick_str(&body, &["sessionId", "session_id"])
            .unwrap_or("default")
            .to_string(),
        workspace: pick_str(&body, &["workspace"]).unwrap_or("").to_string(),
        git_branch: pick_str(&body, &["gitBranch", "git_branch"])
            .unwrap_or("")
            .to_string(),
        role: pick_str(&body, &["role"]).unwrap_or("main").to_string(),
        provider_id: pick_str(&body, &["providerId", "provider"])
            .unwrap_or("omnia")
            .to_string(),
        model_id: pick_str(&body, &["modelId", "model"])
            .unwrap_or("unknown")
            .to_string(),
        surface: pick_str(&body, &["surface"]).unwrap_or("studio").to_string(),
        wire_dialect: pick_str(&body, &["wireDialect", "wire_dialect"])
            .unwrap_or("auto")
            .to_string(),
        reasoning_effort: pick_str(&body, &["reasoningEffort", "effort"])
            .unwrap_or("max")
            .to_string(),
        status: pick_str(&body, &["status"]).unwrap_or("ok").to_string(),
        input_tokens: pick_i64(&body, &["inputTokens", "input_tokens"]).unwrap_or(0),
        output_tokens: pick_i64(&body, &["outputTokens", "output_tokens"]).unwrap_or(0),
        reasoning_tokens: pick_i64(&body, &["reasoningTokens", "reasoning_tokens"]).unwrap_or(0),
        cache_read_tokens: pick_i64(&body, &["cacheReadTokens", "cache_read_tokens"]).unwrap_or(0),
        cache_write_tokens: pick_i64(&body, &["cacheWriteTokens", "cache_write_tokens"]).unwrap_or(0),
        cost_usd: pick_f64(&body, &["costUsd", "cost_usd"]).unwrap_or(0.0),
        kv_savings_usd: pick_f64(&body, &["kvSavingsUsd", "kv_savings_usd"]),
        duration_ms: pick_i64(&body, &["durationMs", "duration_ms"]).unwrap_or(0),
        ttft_ms: pick_i64(&body, &["ttftMs", "ttft_ms"]),
        tpot_ms: pick_f64(&body, &["tpotMs", "tpot_ms"]),
        active_decode_tps: pick_f64(&body, &["activeDecodeTps", "active_decode_tps", "tokensPerSecond"])
            .unwrap_or(0.0),
        e2e_tps: pick_f64(&body, &["e2eTps", "e2e_tps"]).unwrap_or(0.0),
        stall_retries: pick_i64(&body, &["stallRetries", "stall_retries"]).unwrap_or(0),
        hedge_wins: pick_i64(&body, &["hedgeWins", "hedge_wins"]).unwrap_or(0),
        prefix_hash: pick_str(&body, &["prefixHash", "prefix_hash"])
            .unwrap_or("")
            .to_string(),
        cache_bust_reason: pick_str(&body, &["cacheBustReason", "cache_bust_reason"])
            .map(ToString::to_string),
        context_window_fill_pct: pick_f64(&body, &["contextWindowFillPct", "context_window_fill_pct"]),
        compaction_eta_turns: pick_i64(&body, &["compactionEtaTurns", "compaction_eta_turns"]),
        is_error: body.get("isError").or_else(|| body.get("is_error")).and_then(Value::as_bool).unwrap_or(false),
        error_note: pick_str(&body, &["errorNote", "error_note", "error"]).map(ToString::to_string),
        saved_tokens: pick_i64(&body, &["savedTokens", "saved_tokens"]).unwrap_or(0),
        recorded_at_ms: pick_i64(&body, &["recordedAtMs", "recorded_at_ms"]),
    };
    match state.ops.record_rich_trace(&input) {
        Ok(trace_id) => {
            state.event_feed.publish(
                "telemetry",
                "trace_recorded",
                Some(&input.session_id),
                json!({
                    "traceId": trace_id,
                    "modelId": input.model_id,
                    "role": input.role,
                    "ttftMs": input.ttft_ms,
                    "costUsd": input.cost_usd,
                }),
            );
            HttpResponse::ok(json!({ "ok": true, "traceId": trace_id }))
        }
        Err(e) => HttpResponse::error(500, "telemetry_record_failed", &e),
    }
}

// =========================================================================
// 3. Host Hardware, Storage, SQLite WAL, Listening Dev Ports
// =========================================================================

async fn handle_system_snapshot(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let data_dir = state.config.studio_data_dir();
    let snap_res = tokio::task::spawn_blocking(move || {
        let host = collect_host_system_snapshot();
        let wal_files = inspect_sqlite_wal_files(&data_dir);
        (host, wal_files)
    })
    .await;

    let nvidia = if state.config.runtime_url.is_some() {
        let resp = state
            .runtime_proxy
            .handle_nvidia_hardware(state.config.runtime_url.as_deref(), req)
            .await;
        serde_json::from_slice::<Value>(&resp.body).ok()
    } else {
        None
    };

    match snap_res {
        Ok((host, wal_files)) => {
            let total_wal_bytes: u64 = wal_files.iter().map(|w| w.wal_bytes).sum();
            let total_db_bytes: u64 = wal_files.iter().map(|w| w.total_bytes).sum();
            json_ok_masked(
                req,
                json!({
                    "ok": true,
                    "host": host,
                    "nvidia": nvidia,
                    "sqlite": {
                        "dataDir": state.config.studio_data_dir().to_string_lossy(),
                        "totalBytes": total_db_bytes,
                        "totalWalBytes": total_wal_bytes,
                        "files": &wal_files,
                    },
                    "sqliteWal": wal_files,
                    "observedAtMs": now_epoch_ms(),
                }),
            )
        }
        Err(e) => HttpResponse::error(500, "system_snapshot_failed", &e.to_string()),
    }
}

// =========================================================================
// 4. Router Lab V5 (Persistent SQLite Breakers, Waterfalls, Burn-Rate/Runway, Timeline)
// =========================================================================

fn handle_router_v5_state(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let now = now_epoch_ms();
    let snapshots = state.router.snapshots(now).unwrap_or_default();
    let receipts = state.router.decision_receipts().unwrap_or_default();
    let outcomes = state.router.outcome_receipts().unwrap_or_default();
    let timeline = state.ops.list_router_events(40).unwrap_or_default();

    // Estimate rolling token burn rate per hour over the last 60 minutes per model/provider.
    let hour_traces = state
        .ops
        .list_rich_traces(&TraceQueryFilter {
            window_ms: Some(3_600_000),
            limit: 500,
            ..TraceQueryFilter::default()
        })
        .unwrap_or_default();
    let mut burn_by_provider: HashMap<String, u64> = HashMap::new();
    for t in &hour_traces {
        let p = t.get("providerId").and_then(Value::as_str).unwrap_or("");
        let toks = t.get("inputTokens").and_then(Value::as_i64).unwrap_or(0)
            + t.get("outputTokens").and_then(Value::as_i64).unwrap_or(0);
        *burn_by_provider.entry(p.to_string()).or_insert(0) += toks.max(0) as u64;
    }

    let candidates: Vec<Value> = snapshots
        .iter()
        .map(|snap| {
            let (quota_state, remaining_tokens) = match snap.state.quota {
                QuotaState::Known { remaining_tokens, .. } => ("Known", Some(remaining_tokens)),
                QuotaState::Stale { last_known_remaining_tokens, .. } => {
                    ("Stale", Some(last_known_remaining_tokens))
                }
                QuotaState::Contradictory { .. } => ("Contradictory", None),
                QuotaState::Unknown { .. } => ("Unknown", None),
            };
            let circuit = match snap.state.circuit {
                CircuitState::Closed => "Closed",
                CircuitState::Open { .. } => "Open",
                CircuitState::HalfOpen { .. } => "HalfOpen",
            };
            let burn_per_hour = burn_by_provider
                .get(&snap.candidate.provider_id)
                .copied()
                .unwrap_or(0);
            let runway_hours = match (remaining_tokens, burn_per_hour) {
                (Some(rem), burn) if burn > 0 => {
                    Some(((rem as f64 / burn as f64) * 10.0).round() / 10.0)
                }
                _ => None,
            };
            json!({
                "id": snap.candidate.candidate_id,
                "candidateId": snap.candidate.candidate_id,
                "providerId": snap.candidate.provider_id,
                "modelId": snap.candidate.model_id,
                "privacyTier": snap.candidate.privacy_tier.as_str(),
                "circuit": circuit,
                "quotaState": quota_state,
                "remainingTokens": remaining_tokens,
                "reservedTokens": snap.state.reserved_tokens,
                "burnRateTokensPerHour": burn_per_hour,
                "runwayHours": runway_hours,
                "ewmaMs": snap.state.ewma_latency_ms.map(|v| v.round() as u64),
                "p95Ms": snap.state.latency_percentile(95).map(|v| v.round() as u64),
                "totalCalls": snap.state.total_calls,
                "successCount": snap.state.success_count,
                "credentialPresent": snap.candidate.credential_present,
                "enabled": snap.candidate.enabled,
            })
        })
        .collect();

    let waterfalls: Vec<Value> = receipts
        .last()
        .map(|r| {
            r.candidate_scores
                .iter()
                .map(|s| {
                    json!({
                        "candidateId": s.candidate_id,
                        "eligible": s.eligible,
                        "totalScore": ((s.total_score_bps.max(0) as u64) / 100).min(100),
                        "segments": {
                            "capability": if s.eligible { ((s.capability_fit_bps.max(0) as u64) / 100).min(100) } else { 0 },
                            "privacy": if s.eligible { ((s.privacy_fit_bps.max(0) as u64) / 100).min(100) } else { 0 },
                            "quota": if s.eligible { ((s.budget_headroom_bps.max(0) as u64) / 100).min(100) } else { 0 },
                            "latency": if s.eligible { ((s.latency_health_bps.max(0) as u64) / 100).min(100) } else { 0 },
                            "reliability": if s.eligible { ((s.reliability_bps.max(0) as u64) / 100).min(100) } else { 0 },
                        },
                        "rejectedReason": if s.eligible { Value::Null } else { json!(s.rejection_reason) },
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let recent_receipts: Vec<Value> = receipts
        .iter()
        .rev()
        .take(25)
        .map(|r| SecretRedactor::redact_json(&r.to_json()))
        .collect();

    json_ok_masked(
        req,
        json!({
            "ok": true,
            "persistent": true,
            "tokenBudget": Value::Null,
            "candidates": candidates,
            "scoreWaterfalls": waterfalls,
            "failoverTimeline": timeline,
            "recentReceipts": recent_receipts,
            "outcomeCount": outcomes.len(),
        }),
    )
}

fn handle_router_v5_decide(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    crate::routes_legacy::handle_router_decide_public(state, req)
}

fn handle_router_breaker(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    forced_action: Option<&str>,
) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(candidate_id) = pick_str(
        &body,
        &["candidateId", "candidate_id", "tripCandidate", "trip_provider", "resetCandidate", "reset_provider", "id"],
    ) else {
        return HttpResponse::error(
            400,
            "missing_candidate_id",
            "Field 'candidateId' is required.",
        );
    };
    let action = forced_action
        .or_else(|| pick_str(&body, &["action"]))
        .unwrap_or("trip")
        .to_ascii_lowercase();
    let cooldown_ms = body
        .get("cooldownMs")
        .or_else(|| body.get("cooldown_ms"))
        .and_then(Value::as_i64)
        .unwrap_or(60_000)
        .clamp(1_000, 3_600_000);
    let reason = pick_str(&body, &["reason"]).unwrap_or(if action == "reset" {
        "manual_operator_reset"
    } else {
        "manual_operator_trip"
    });
    let now = now_epoch_ms();

    let provider_id = candidate_id
        .split(':')
        .next()
        .unwrap_or(candidate_id)
        .to_string();

    let (circuit_state, op_res) = if action == "reset" || action == "close" {
        ("Closed", state.router.reset_circuit(candidate_id))
    } else {
        ("Open", state.router.trip_circuit(candidate_id, now, Some(cooldown_ms)))
    };

    if let Err(err) = op_res {
        return HttpResponse::error(404, "unknown_candidate", &err.to_string());
    }

    let event = state
        .ops
        .record_router_event(candidate_id, &provider_id, &action, reason, circuit_state)
        .unwrap_or_else(|_| json!({}));

    state.event_feed.publish(
        "router",
        if circuit_state == "Open" { "circuit_tripped" } else { "circuit_reset" },
        None,
        json!({
            "candidateId": candidate_id,
            "circuit": circuit_state,
            "reason": reason,
        }),
    );
    if circuit_state == "Open" {
        state.event_feed.publish(
            "alerts",
            "circuit_open",
            None,
            json!({
                "severity": "warn",
                "kind": "circuit_open",
                "candidateId": candidate_id,
                "reason": reason,
            }),
        );
    }

    json_ok_masked(
        req,
        json!({
            "ok": true,
            "candidateId": candidate_id,
            "action": action,
            "circuit": circuit_state,
            "event": event,
        }),
    )
}

fn handle_router_receipt(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let want_id = req.query_param("id").or_else(|| req.query_param("decisionId"));
    let receipts = state.router.decision_receipts().unwrap_or_default();
    let selected = if let Some(id) = want_id {
        receipts.into_iter().find(|r| r.decision_id == id)
    } else {
        receipts.into_iter().last()
    };
    let Some(receipt) = selected else {
        return HttpResponse::error(404, "receipt_not_found", "No RouteDecisionReceipt recorded yet.");
    };
    let mut payload = SecretRedactor::redact_json(&receipt.to_json());
    if wants_privacy_mask(req) {
        payload = PrivacyMask::mask_json(&payload);
    }
    let mut resp = HttpResponse::ok(json!({ "ok": true, "receipt": payload }));
    if req
        .query_param("download")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"))
    {
        let fname = format!("omnia-route-receipt-{}.json", receipt.decision_id);
        resp.headers.push((
            "Content-Disposition".to_string(),
            format!("attachment; filename=\"{fname}\""),
        ));
    }
    resp
}

// =========================================================================
// 5. CredMan V5 (Masked CRUD)
// =========================================================================

fn handle_creds_list(req: &HttpRequest) -> HttpResponse {
    match CredentialStore::list_masked() {
        Ok(items) => {
            let list: Vec<Value> = items
                .into_iter()
                .map(|c| {
                    json!({
                        "target": c.target,
                        "kind": c.kind,
                        "label": c.label,
                        "maskedHint": c.masked_hint,
                        "masked_hint": c.masked_hint,
                        "updatedAtMs": c.updated_at_ms,
                    })
                })
                .collect();
            json_ok_masked(req, json!({ "ok": true, "credentials": list }))
        }
        Err(e) => HttpResponse::error(500, "credentials_list_failed", &e.to_string()),
    }
}

fn handle_creds_set(req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = pick_str(&body, &["target", "provider", "keyName"]) else {
        return HttpResponse::error(400, "missing_target", "Field 'target' is required.");
    };
    let Some(secret) = pick_str(&body, &["secret", "apiKey", "value"]) else {
        return HttpResponse::error(400, "missing_secret", "Field 'secret' is required.");
    };
    let kind = pick_str(&body, &["kind"]).unwrap_or("api_key");
    let label = pick_str(&body, &["label"]).unwrap_or(target);
    match CredentialStore::set_secret(target, kind, label, secret) {
        Ok(masked) => json_ok_masked(
            req,
            json!({
                "ok": true,
                "credential": {
                    "target": masked.target,
                    "kind": masked.kind,
                    "label": masked.label,
                    "maskedHint": masked.masked_hint,
                    "masked_hint": masked.masked_hint,
                    "updatedAtMs": masked.updated_at_ms,
                }
            }),
        ),
        Err(e) => HttpResponse::error(400, "credential_store_failed", &e.to_string()),
    }
}

fn handle_creds_delete(req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = pick_str(&body, &["target", "provider", "keyName"]) else {
        return HttpResponse::error(400, "missing_target", "Field 'target' is required.");
    };
    match CredentialStore::delete_secret(target) {
        Ok(deleted) => HttpResponse::ok(json!({ "ok": true, "target": target, "deleted": deleted })),
        Err(e) => HttpResponse::error(400, "credential_delete_failed", &e.to_string()),
    }
}

// =========================================================================
// 6. Smart Alerts Engine
// =========================================================================

fn evaluate_alerts_sync(
    state: &StudioState,
    host_opt: Option<&omnia_workspace_ops::hardware::HostSystemSnapshot>,
) -> Vec<Value> {
    let mut alerts = Vec::new();
    let now = now_epoch_ms();

    // 1 & 2. Telemetry TTFT spike & Cache Hit < 70%
    if let Ok(summary) = state.ops.telemetry_summary(&TraceQueryFilter {
        window_ms: Some(86_400_000),
        ..TraceQueryFilter::default()
    }) {
        let total_req = summary.get("totalRequests").and_then(Value::as_i64).unwrap_or(0);
        if let Some(p95) = summary
            .get("distributions")
            .and_then(|d| d.get("ttftMs"))
            .and_then(|t| t.get("p95"))
            .and_then(Value::as_f64)
        {
            if p95 > 5_000.0 {
                alerts.push(json!({
                    "id": "alert_ttft_spike",
                    "kind": "ttft_spike",
                    "severity": if p95 > 12_000.0 { "critical" } else { "warn" },
                    "title": "Elevated Time-to-First-Token (p95)",
                    "detail": format!("24h TTFT p95 is {:.0} ms (threshold 5,000 ms).", p95),
                    "observedAtMs": now,
                }));
            }
        }
        let cache_pct = summary.get("cacheHitPct").and_then(Value::as_f64).unwrap_or(100.0);
        if total_req >= 3 && cache_pct < 70.0 {
            alerts.push(json!({
                "id": "alert_cache_low",
                "kind": "cache_hit_low",
                "severity": "warn",
                "title": "Prefix-0 KV Cache Hit Rate Below 70%",
                "detail": format!("Observed 24h KV cache hit rate is {:.1}% across {total_req} requests.", cache_pct),
                "observedAtMs": now,
            }));
        }
    }

    // 3. Router Circuit Open
    if let Ok(snaps) = state.router.snapshots(now) {
        for s in snaps {
            if !matches!(s.state.circuit, CircuitState::Closed) {
                let st_str = match s.state.circuit {
                    CircuitState::Open { .. } => "Open",
                    CircuitState::HalfOpen { .. } => "HalfOpen",
                    CircuitState::Closed => "Closed",
                };
                alerts.push(json!({
                    "id": format!("alert_circuit_{}", s.candidate.candidate_id),
                    "kind": "circuit_tripped",
                    "severity": "warn",
                    "title": format!("Circuit {st_str}: {}", s.candidate.candidate_id),
                    "detail": format!("Candidate '{}' is currently in {st_str} circuit state.", s.candidate.candidate_id),
                    "observedAtMs": now,
                }));
            }
        }
    }

    // 4. Bufferbloat spike (latest persisted speedtest)
    if let Ok(runs) = state.ops.list_speedtests(1) {
        if let Some(latest) = runs.first() {
            if !latest.cancelled && matches!(latest.bufferbloat_grade.as_str(), "C" | "D" | "F") {
                alerts.push(json!({
                    "id": format!("alert_bloat_{}", latest.run_id),
                    "kind": "bufferbloat_spike",
                    "severity": if latest.bufferbloat_grade == "C" { "warn" } else { "critical" },
                    "title": format!("Bufferbloat Grade {} (+{:.0} ms)", latest.bufferbloat_grade, latest.worst_bufferbloat_delta_ms),
                    "detail": format!("Latest speedtest showed DL +{:.1} ms / UL +{:.1} ms loaded latency inflation.", latest.dl_bufferbloat_delta_ms, latest.ul_bufferbloat_delta_ms),
                    "observedAtMs": latest.finished_at_ms,
                }));
            }
        }
    }

    // 5. DNS Leak warning (from last DNS diagnostic)
    if let Some(ref dns) = *state.observatory.last_dns.lock() {
        if dns.leak_status == "possible_dns_leak" {
            alerts.push(json!({
                "id": "alert_dns_leak",
                "kind": "dns_leak",
                "severity": "warn",
                "title": "Potential VPN DNS Leak Detected",
                "detail": dns.leak_warning.clone().unwrap_or_else(|| "System DNS may bypass VPN tunnel.".into()),
                "observedAtMs": dns.observed_at_ms,
            }));
        }
    }

    // 6. Low Disk Space
    if let Some(host) = host_opt {
        for disk in &host.disks {
            let free_pct = 100.0 - disk.used_pct;
            if free_pct < 10.0 {
                alerts.push(json!({
                    "id": format!("alert_disk_{}", disk.drive),
                    "kind": "low_disk",
                    "severity": if free_pct < 5.0 { "critical" } else { "warn" },
                    "title": format!("Low Free Disk Space on {}", disk.drive),
                    "detail": format!("Drive {} has {:.1}% free ({:.1} GiB remaining).", disk.drive, free_pct, (disk.free_bytes as f64) / 1_073_741_824.0),
                    "observedAtMs": now,
                }));
            }
        }
    }

    alerts
}

async fn handle_smart_alerts(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let host = tokio::task::spawn_blocking(collect_host_system_snapshot)
        .await
        .ok();
    let alerts = evaluate_alerts_sync(state, host.as_ref());
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "count": alerts.len(),
            "alerts": alerts,
            "evaluatedAtMs": now_epoch_ms(),
        }),
    )
}

// =========================================================================
// 7. Side-by-Side Comparison / Diff Endpoints
// =========================================================================

fn handle_diff_sessions(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(a_id) = req.query_param("a").filter(|s| !s.trim().is_empty()) else {
        return HttpResponse::error(400, "missing_a", "Query parameter 'a' is required.");
    };
    let Some(b_id) = req.query_param("b").filter(|s| !s.trim().is_empty()) else {
        return HttpResponse::error(400, "missing_b", "Query parameter 'b' is required.");
    };
    let summarize = |sid: &str| -> Value {
        let rec = state.sessions.get_session(sid).ok().flatten();
        let msgs = state.sessions.list_messages(sid, 0).unwrap_or_default();
        let tel = state
            .ops
            .telemetry_summary(&TraceQueryFilter {
                session_id: Some(sid.to_string()),
                ..TraceQueryFilter::default()
            })
            .unwrap_or_else(|_| json!({}));
        json!({
            "sessionId": sid,
            "exists": rec.is_some(),
            "title": rec.as_ref().map(|r| r.title.clone()),
            "modelId": rec.as_ref().map(|r| r.model_id.clone()),
            "effort": rec.as_ref().map(|r| r.effort.clone()),
            "messageCount": msgs.len(),
            "telemetry": tel,
        })
    };
    let left = summarize(&a_id);
    let right = summarize(&b_id);
    let delta_msgs = right["messageCount"].as_i64().unwrap_or(0)
        - left["messageCount"].as_i64().unwrap_or(0);
    let delta_cost = ((right["telemetry"]["totalCostUsd"].as_f64().unwrap_or(0.0)
        - left["telemetry"]["totalCostUsd"].as_f64().unwrap_or(0.0))
        * 1_000_000.0)
        .round()
        / 1_000_000.0;

    json_ok_masked(
        req,
        json!({
            "ok": true,
            "kind": "sessions",
            "a": left,
            "b": right,
            "deltas": {
                "messageCountDelta": delta_msgs,
                "costUsdDelta": delta_cost,
            },
        }),
    )
}

fn handle_diff_speedtests(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let history = state.ops.list_speedtests(30).unwrap_or_default();
    let a = match req.query_param("a") {
        Some(id) => state.ops.get_speedtest(&id).ok().flatten(),
        None => history.get(1).cloned(),
    };
    let b = match req.query_param("b") {
        Some(id) => state.ops.get_speedtest(&id).ok().flatten(),
        None => history.first().cloned(),
    };
    let (Some(left), Some(right)) = (a, b) else {
        return HttpResponse::error(
            404,
            "speedtest_not_found",
            "Two persisted speedtest runs are required to diff (pass ?a=<runId>&b=<runId>).",
        );
    };
    let r2 = |v: f64| (v * 100.0).round() / 100.0;
    let p50_delta = match (left.unloaded.p50_ms, right.unloaded.p50_ms) {
        (Some(la), Some(rb)) => Some(r2(rb - la)),
        _ => None,
    };
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "kind": "speedtests",
            "a": left,
            "b": right,
            "deltas": {
                "downloadMbpsDelta": r2(right.download_mbps - left.download_mbps),
                "uploadMbpsDelta": r2(right.upload_mbps - left.upload_mbps),
                "unloadedP50MsDelta": p50_delta,
                "worstBufferbloatDeltaMs": r2(right.worst_bufferbloat_delta_ms - left.worst_bufferbloat_delta_ms),
                "gradeTransition": format!("{} -> {}", left.bufferbloat_grade, right.bufferbloat_grade),
                "aiStreamingScoreDelta": i16::from(right.workload_readiness.ai_sse_streaming.score) - i16::from(left.workload_readiness.ai_sse_streaming.score),
            },
        }),
    )
}

fn handle_diff_models(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(a_model) = req.query_param("a").filter(|s| !s.trim().is_empty()) else {
        return HttpResponse::error(400, "missing_a", "Query parameter 'a' (model id) is required.");
    };
    let Some(b_model) = req.query_param("b").filter(|s| !s.trim().is_empty()) else {
        return HttpResponse::error(400, "missing_b", "Query parameter 'b' (model id) is required.");
    };
    let window_ms = TraceQueryFilter::parse_window_ms(req.query_param("window").as_deref());
    let left = state
        .ops
        .telemetry_summary(&TraceQueryFilter {
            window_ms,
            model: Some(a_model.clone()),
            ..TraceQueryFilter::default()
        })
        .unwrap_or_else(|_| json!({}));
    let right = state
        .ops
        .telemetry_summary(&TraceQueryFilter {
            window_ms,
            model: Some(b_model.clone()),
            ..TraceQueryFilter::default()
        })
        .unwrap_or_else(|_| json!({}));
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "kind": "models",
            "a": { "model": a_model, "summary": left },
            "b": { "model": b_model, "summary": right },
        }),
    )
}

fn handle_diff_benchmarks(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let sb = build_benchmark_scoreboard(&state.config.workspace_root, &state.ops);
    let a_key = req.query_param("a").unwrap_or_else(|| "omnia".to_string());
    let b_key = req.query_param("b").unwrap_or_else(|| "codex".to_string());
    let runs = sb
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let find_match = |needle: &str| -> Value {
        let lower = needle.to_ascii_lowercase();
        if let Some(found) = runs.iter().find(|r| {
            r.get("file")
                .and_then(Value::as_str)
                .is_some_and(|f| f.to_ascii_lowercase().contains(&lower))
        }) {
            return found.clone();
        }
        if let Some(sv5) = sb.get("suiteV5") {
            if let Some(entry) = sv5.get(needle) {
                return entry.clone();
            }
        }
        json!({ "notFound": needle })
    };
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "kind": "benchmarks",
            "aKey": a_key,
            "bKey": b_key,
            "a": find_match(&a_key),
            "b": find_match(&b_key),
        }),
    )
}

// =========================================================================
// 8. One-Click Exports (`JSON` / `CSV` / `Markdown` / `Diagnostic`)
// =========================================================================

async fn handle_export(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let fmt = req
        .query_param("format")
        .unwrap_or_else(|| "json".to_string())
        .to_ascii_lowercase();
    let mask = wants_privacy_mask(req) || fmt == "diagnostic";
    let download = req
        .query_param("download")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"));
    let filter = parse_trace_filter(req);

    let summary = state
        .ops
        .telemetry_summary(&filter)
        .unwrap_or_else(|_| json!({}));
    let traces = state
        .ops
        .list_rich_traces(&filter)
        .unwrap_or_default();
    let speedtests = state.ops.list_speedtests(10).unwrap_or_default();
    let router_events = state.ops.list_router_events(25).unwrap_or_default();
    let host = tokio::task::spawn_blocking(collect_host_system_snapshot)
        .await
        .ok();
    let wal_files = inspect_sqlite_wal_files(&state.config.studio_data_dir());
    let alerts = evaluate_alerts_sync(state, host.as_ref());
    let identity = state.observatory.last_identity.lock().clone();
    let dns = state.observatory.last_dns.lock().clone();

    match fmt.as_str() {
        "csv" => {
            let mut csv = String::from(
                "trace_id,req_id,session_id,role,provider,model,wire_dialect,effort,status,ttft_ms,tpot_ms,duration_ms,active_decode_tps,e2e_tps,input_tokens,output_tokens,cache_read_tokens,cost_usd,kv_savings_usd,recorded_at_ms\n",
            );
            for t in traces {
                let row_val = if mask {
                    PrivacyMask::mask_json(&t)
                } else {
                    SecretRedactor::redact_json(&t)
                };
                let s = |k: &str| csv_escape(row_val.get(k).and_then(Value::as_str).unwrap_or(""));
                let n = |k: &str| {
                    row_val
                        .get(k)
                        .filter(|v| !v.is_null())
                        .map(ToString::to_string)
                        .unwrap_or_default()
                };
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                    s("traceId"),
                    s("reqId"),
                    s("sessionId"),
                    s("role"),
                    s("providerId"),
                    s("modelId"),
                    s("wireDialect"),
                    s("reasoningEffort"),
                    s("status"),
                    n("ttftMs"),
                    n("tpotMs"),
                    n("durationMs"),
                    n("activeDecodeTps"),
                    n("e2eTps"),
                    n("inputTokens"),
                    n("outputTokens"),
                    n("cacheReadTokens"),
                    n("costUsd"),
                    n("kvSavingsUsd"),
                    n("recordedAtMs"),
                ));
            }
            let mut resp = HttpResponse::bytes(200, "text/csv; charset=utf-8", csv.into_bytes());
            if download {
                resp.headers.push((
                    "Content-Disposition".to_string(),
                    "attachment; filename=\"omnia-telemetry.csv\"".to_string(),
                ));
            }
            resp
        }
        "markdown" | "md" => {
            let mut md = String::new();
            md.push_str("# Omnia Studio Executive Telemetry & Observatory Report\n\n");
            md.push_str(&format!(
                "- Generated at (epoch ms): `{}`\n- Privacy Mask Applied: `{mask}`\n- Total Requests: `{}` (Errors: `{}`)\n- Total Cost (USD): `${:.6}` | KV-Cache Savings: `${:.6}`\n- Cache Hit Rate: `{:.1}%`\n\n",
                now_epoch_ms(),
                summary["totalRequests"].as_i64().unwrap_or(0),
                summary["failedRequests"].as_i64().unwrap_or(0),
                summary["totalCostUsd"].as_f64().unwrap_or(0.0),
                summary["kvSavingsUsd"].as_f64().unwrap_or(0.0),
                summary["cacheHitPct"].as_f64().unwrap_or(0.0),
            ));
            md.push_str("## Latency & Throughput Distributions\n\n");
            md.push_str("| Metric | Count | p50 | p90 | p95 | p99 | Mean | StdDev | IQR | Outliers |\n");
            md.push_str("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
            for (label, key) in [
                ("TTFT (ms)", "ttftMs"),
                ("TPOT (ms)", "tpotMs"),
                ("Duration (ms)", "durationMs"),
                ("Active Decode (tok/s)", "activeDecodeTps"),
                ("E2E (tok/s)", "e2eTps"),
            ] {
                let d = &summary["distributions"][key];
                let f = |k: &str| {
                    d.get(k)
                        .and_then(Value::as_f64)
                        .map(|v| format!("{v:.2}"))
                        .unwrap_or_else(|| "—".to_string())
                };
                md.push_str(&format!(
                    "| {label} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
                    d.get("count").and_then(Value::as_u64).unwrap_or(0),
                    f("p50"),
                    f("p90"),
                    f("p95"),
                    f("p99"),
                    f("mean"),
                    f("stdDev"),
                    f("iqr"),
                    d.get("outlierCount").and_then(Value::as_u64).unwrap_or(0),
                ));
            }
            if let Some(latest) = speedtests.first() {
                md.push_str("\n## Latest Network Speedtest & Bufferbloat\n\n");
                md.push_str(&format!(
                    "- Download: `{:.1} Mbps` (1-stream `{:.1}` / multi `{:.1}`)\n- Upload: `{:.1} Mbps` (1-stream `{:.1}` / multi `{:.1}`)\n- Unloaded p50 RTT: `{}` ms | Bufferbloat Grade: **`{}`** (worst `+{:.1} ms`)\n",
                    latest.download_mbps,
                    latest.single_stream_dl_mbps,
                    latest.multi_stream_dl_mbps,
                    latest.upload_mbps,
                    latest.single_stream_ul_mbps,
                    latest.multi_stream_ul_mbps,
                    latest.unloaded.p50_ms.map(|v| format!("{v:.1}")).unwrap_or_else(|| "—".into()),
                    latest.bufferbloat_grade,
                    latest.worst_bufferbloat_delta_ms,
                ));
            }
            md.push_str(&format!("\n## Active Smart Alerts ({})\n\n", alerts.len()));
            if alerts.is_empty() {
                md.push_str("- None (all telemetry, router, network, and storage thresholds nominal).\n");
            } else {
                for a in &alerts {
                    md.push_str(&format!(
                        "- **[{}]** {}: {}\n",
                        a["severity"].as_str().unwrap_or("info").to_uppercase(),
                        a["title"].as_str().unwrap_or("Alert"),
                        a["detail"].as_str().unwrap_or(""),
                    ));
                }
            }
            let final_md = if mask {
                PrivacyMask::mask_text(&md)
            } else {
                SecretRedactor::redact(&md)
            };
            let mut resp = HttpResponse::bytes(200, "text/markdown; charset=utf-8", final_md.into_bytes());
            if download {
                resp.headers.push((
                    "Content-Disposition".to_string(),
                    "attachment; filename=\"omnia-executive-report.md\"".to_string(),
                ));
            }
            resp
        }
        _ => {
            let bundle = json!({
                "ok": true,
                "schema": if fmt == "diagnostic" {
                    "omnia.diagnostic.snapshot.v5"
                } else {
                    "omnia.observatory.export.v5"
                },
                "exportedAtMs": now_epoch_ms(),
                "privacyMasked": mask,
                "telemetrySummary": summary,
                "recentRequests": traces,
                "networkIdentity": identity,
                "dns": dns,
                "speedtests": speedtests,
                "routerFailoverTimeline": router_events,
                "host": host,
                "sqliteWal": wal_files,
                "alerts": alerts,
            });
            let safe = if mask {
                PrivacyMask::mask_json(&bundle)
            } else {
                SecretRedactor::redact_json(&bundle)
            };
            let mut resp = HttpResponse::ok(safe);
            if download {
                let fname = if fmt == "diagnostic" {
                    "omnia-diagnostic-snapshot-redacted.json"
                } else {
                    "omnia-observatory-export.json"
                };
                resp.headers.push((
                    "Content-Disposition".to_string(),
                    format!("attachment; filename=\"{fname}\""),
                ));
            }
            resp
        }
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// =========================================================================
// 9. Steer Queue Status & Reconcile
// =========================================================================

fn handle_steer_status(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = pick_str(&body, &["id", "itemId"]) else {
        return HttpResponse::error(400, "missing_id", "Field 'id' is required.");
    };
    let Some(raw_status) = pick_str(&body, &["status"]) else {
        return HttpResponse::error(400, "missing_status", "Field 'status' is required.");
    };
    let status = match raw_status.to_ascii_lowercase().as_str() {
        "queued" => SteerStatus::Queued,
        "in_progress" | "inprogress" => SteerStatus::InProgress,
        "completed" | "done" => SteerStatus::Completed,
        "cancelled" | "canceled" => SteerStatus::Cancelled,
        "superseded" => SteerStatus::Superseded,
        _ => {
            return HttpResponse::error(
                400,
                "invalid_status",
                "Status must be queued|in_progress|completed|cancelled|superseded.",
            )
        }
    };
    let updated = state.steer.mark_status(id, status);
    if updated {
        if let Some(found) = state.steer.items().into_iter().find(|it| it.id == id) {
            let _ = state.ops.upsert_steer_item(
                &found.id,
                &found.text,
                found.mode.as_str(),
                found.status.as_str(),
                found.created_at_ms,
            );
        }
    }
    let items: Vec<Value> = state
        .steer
        .items()
        .iter()
        .map(omnia_harness::steer_queue::SteerItem::to_json)
        .collect();
    HttpResponse::ok(json!({
        "ok": true,
        "updated": updated,
        "tokenBudget": state.steer.token_budget(),
        "items": items,
    }))
}

fn handle_steer_reconcile(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = pick_str(&body, &["id", "targetId"]) else {
        return HttpResponse::error(400, "missing_id", "Field 'id' is required.");
    };
    let replacement_id = pick_str(&body, &["replacementId", "replacement_id", "supersededBy"]);
    let reason = pick_str(&body, &["reason"]).unwrap_or("explicit_operator_reconcile");
    let updated = state
        .steer
        .reconcile_cancel_or_supersede(id, replacement_id, reason);
    if updated {
        if let Some(found) = state.steer.items().into_iter().find(|it| it.id == id) {
            let _ = state.ops.upsert_steer_item(
                &found.id,
                &found.text,
                found.mode.as_str(),
                found.status.as_str(),
                found.created_at_ms,
            );
        }
    }
    let items: Vec<Value> = state
        .steer
        .items()
        .iter()
        .map(omnia_harness::steer_queue::SteerItem::to_json)
        .collect();
    HttpResponse::ok(json!({
        "ok": true,
        "updated": updated,
        "tokenBudget": state.steer.token_budget(),
        "items": items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;
    use crate::routes_legacy::dispatch_request;
    use std::collections::BTreeMap;

    fn make_req(method: &str, target: &str, body: &[u8]) -> HttpRequest {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        HttpRequest {
            method: method.to_string(),
            target: target.to_string(),
            path: path.to_string(),
            query: query.to_string(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: body.to_vec(),
        }
    }

    fn make_test_state() -> Arc<StudioState> {
        let cfg = StudioConfig {
            db_path: None,
            runtime_url: None,
            ..StudioConfig::default()
        };
        Arc::new(StudioState::new(cfg).expect("in-memory StudioState"))
    }

    #[tokio::test]
    async fn observatory_v5_telemetry_router_alerts_diff_exports_and_privacy_mask_work() {
        let state = make_test_state();

        // 1. Network identity offline mode + Privacy Mask
        let net_resp = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/network/identity?probe_public=false&privacy_mask=true", b""),
        )
        .await;
        assert_eq!(net_resp.status, 200);
        let net_json: Value = serde_json::from_slice(&net_resp.body).expect("json");
        assert_eq!(net_json["ok"], true);
        assert_eq!(net_json["identity"]["provenance"], "UNAVAILABLE");

        // 2. Record rich telemetry (including JSON floats for ttftMs & durationMs) + verify summary percentiles & filters
        for (idx, ttft) in [200.5f64, 240.0, 220.4, 260.0, 1800.6].iter().enumerate() {
            let rec_body = json!({
                "reqId": format!("req_synthetic_{idx}"),
                "sessionId": if idx < 3 { "sess_a" } else { "sess_b" },
                "role": "main",
                "providerId": "htmustc",
                "modelId": if idx < 3 { "claude-sonnet-5-5" } else { "gpt-6.2-sol" },
                "wireDialect": "anthropic-messages",
                "reasoningEffort": "max",
                "inputTokens": 2000,
                "outputTokens": 500,
                "cacheReadTokens": 1000,
                "costUsd": 0.015,
                "durationMs": ttft + 1000.0,
                "ttftMs": ttft,
                "activeDecodeTps": 75.0,
                "e2eTps": 58.0,
            });
            let r = dispatch_request(
                Arc::clone(&state),
                make_req("POST", "/api/v5/telemetry/record", rec_body.to_string().as_bytes()),
            )
            .await;
            assert_eq!(r.status, 200);
        }

        let sum_resp = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/telemetry/summary?window=24h", b""),
        )
        .await;
        assert_eq!(sum_resp.status, 200);
        let sum_json: Value = serde_json::from_slice(&sum_resp.body).expect("sum json");
        assert_eq!(sum_json["summary"]["totalRequests"], 5);
        assert!(sum_json["summary"]["distributions"]["ttftMs"]["p95"].as_f64().is_some());
        assert_eq!(sum_json["summary"]["distributions"]["ttftMs"]["outlierCount"], 1);

        // 3. Upsert candidate, trip via /api/v5/router/trip, verify alert fires, reset via /api/router/decide snake_case
        let up = dispatch_request(
            Arc::clone(&state),
            make_req(
                "POST",
                "/api/router/candidates",
                br#"{"candidateId":"dummy-prov:dummy-model","providerId":"dummy-prov","modelId":"dummy-model"}"#,
            ),
        )
        .await;
        assert_eq!(up.status, 200);

        let trip = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/v5/router/trip", br#"{"candidateId":"dummy-prov:dummy-model","reason":"synthetic_trip"}"#),
        )
        .await;
        assert_eq!(trip.status, 200);

        let alerts_resp = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/alerts", b""),
        )
        .await;
        assert_eq!(alerts_resp.status, 200);
        let alerts_json: Value = serde_json::from_slice(&alerts_resp.body).expect("alerts");
        assert!(alerts_json["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["kind"] == "circuit_tripped"));

        let reset = dispatch_request(
            Arc::clone(&state),
            make_req(
                "POST",
                "/api/route",
                br#"{"reset_provider":"dummy-prov:dummy-model","token_estimate":4000,"privacy_boundary":"standard","streaming":true}"#,
            ),
        )
        .await;
        assert_eq!(reset.status, 200);

        // 4. Diff models + Exports (CSV, Markdown, Diagnostic Masked)
        let diff_m = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/diff/models?a=claude-sonnet-5-5&b=gpt-6.2-sol", b""),
        )
        .await;
        assert_eq!(diff_m.status, 200);

        let csv = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/export?format=csv&privacy_mask=true", b""),
        )
        .await;
        assert_eq!(csv.status, 200);
        assert!(String::from_utf8_lossy(&csv.body).contains("trace_id,req_id"));

        let md = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/export?format=markdown&privacy_mask=true", b""),
        )
        .await;
        assert_eq!(md.status, 200);
        assert!(String::from_utf8_lossy(&md.body).contains("Executive Telemetry"));

        let diag = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/export?format=diagnostic", b""),
        )
        .await;
        assert_eq!(diag.status, 200);
        let diag_json: Value = serde_json::from_slice(&diag.body).expect("diag");
        assert_eq!(diag_json["privacyMasked"], true);

        // 5. Rewind preview + Media isolation + System snapshot + Scoreboard
        let prev = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/sessions/rewind/preview", br#"{"sessionId":"sess_a","turn":0}"#),
        )
        .await;
        assert_eq!(prev.status, 200);

        let iso = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/media/isolation", b""),
        )
        .await;
        assert_eq!(iso.status, 200);

        let sys = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/hardware/host", b""),
        )
        .await;
        assert_eq!(sys.status, 200);
        let sys_json: Value = serde_json::from_slice(&sys.body).expect("sys");
        assert!(sys_json["host"]["hardware"]["logical_cpus"].as_u64().unwrap_or(0) >= 1);
    }
}
