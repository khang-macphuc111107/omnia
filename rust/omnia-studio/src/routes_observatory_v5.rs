//! Studio v5 Observatory, Network Diagnostics & Streaming Speedtest, Lab-Grade Telemetry,
//! Host Hardware/WAL/Ports, SQLite Router Lab, CredMan V5, Smart Alerts, Side-by-Side Diffing,
//! One-Click Exports (JSON/CSV/Markdown/Diagnostic), Privacy Mask, and Steer Controls.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
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
    inspect_proxy_tls_and_endpoints, normalize_custom_probe_url, probe_tls_host,
    run_bounded_traceroute, run_global_latency_radar, run_speedtest_streaming,
    validate_custom_dns_ip, DnsBenchOptions, DnsIntelReport, EndpointProbeTarget, NetDiagOptions,
    NetworkIdentityReport, PassiveMonitorState, SpeedtestConfig, SpeedtestProgressEvent,
    SpeedtestResult,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::http::{HttpRequest, HttpResponse};
use crate::mgmt_proxy::build_benchmark_scoreboard;
use crate::ops_store::{RichUsageTraceInput, TraceQueryFilter};
use crate::routes_legacy::StudioState;
use crate::telemetry::inspect_sqlite_wal_files;

const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Editable Smart Alert threshold rules persisted under `studio_data_dir()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertRulesConfig {
    #[serde(default = "default_ttft_p95_warn_ms")]
    pub ttft_p95_warn_ms: f64,
    #[serde(default = "default_cache_hit_min_pct")]
    pub cache_hit_min_pct: f64,
    #[serde(default = "default_bufferbloat_warn_ms")]
    pub bufferbloat_warn_ms: f64,
    #[serde(default = "default_context_warn_pct")]
    pub context_warn_pct: f64,
    #[serde(default = "default_disk_free_warn_pct")]
    pub disk_free_warn_pct: f64,
    #[serde(default = "default_error_rate_warn_pct")]
    pub error_rate_warn_pct: f64,
}

fn default_ttft_p95_warn_ms() -> f64 {
    5_000.0
}
fn default_cache_hit_min_pct() -> f64 {
    70.0
}
fn default_bufferbloat_warn_ms() -> f64 {
    60.0
}
fn default_context_warn_pct() -> f64 {
    80.0
}
fn default_disk_free_warn_pct() -> f64 {
    10.0
}
fn default_error_rate_warn_pct() -> f64 {
    10.0
}

impl Default for AlertRulesConfig {
    fn default() -> Self {
        Self {
            ttft_p95_warn_ms: default_ttft_p95_warn_ms(),
            cache_hit_min_pct: default_cache_hit_min_pct(),
            bufferbloat_warn_ms: default_bufferbloat_warn_ms(),
            context_warn_pct: default_context_warn_pct(),
            disk_free_warn_pct: default_disk_free_warn_pct(),
            error_rate_warn_pct: default_error_rate_warn_pct(),
        }
    }
}

/// Runtime state for live on-demand speedtests, passive monitor, smart alert acks/rules, and cached diagnostics.
pub struct ObservatoryState {
    active_run: Mutex<Option<ActiveSpeedtestRun>>,
    last_identity: Mutex<Option<NetworkIdentityReport>>,
    last_dns: Mutex<Option<DnsIntelReport>>,
    passive_monitor: PassiveMonitorState,
    alert_acks: Mutex<BTreeSet<String>>,
    alert_rules: Mutex<AlertRulesConfig>,
    hydrated_from_disk: Mutex<bool>,
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
            passive_monitor: PassiveMonitorState::new(),
            alert_acks: Mutex::new(BTreeSet::new()),
            alert_rules: Mutex::new(AlertRulesConfig::default()),
            hydrated_from_disk: Mutex::new(false),
        }
    }
}

impl ObservatoryState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_hydrated(&self, data_dir: &Path) {
        let mut flag = self.hydrated_from_disk.lock();
        if *flag {
            return;
        }
        *flag = true;
        drop(flag);

        let rules_path = data_dir.join("alert_rules_v5.json");
        if let Ok(raw) = std::fs::read_to_string(&rules_path) {
            if let Ok(parsed) = serde_json::from_str::<AlertRulesConfig>(&raw) {
                *self.alert_rules.lock() = parsed;
            }
        }
        let acks_path = data_dir.join("alert_acks_v5.json");
        if let Ok(raw) = std::fs::read_to_string(&acks_path) {
            if let Ok(parsed) = serde_json::from_str::<Vec<String>>(&raw) {
                let mut g = self.alert_acks.lock();
                for id in parsed {
                    g.insert(id);
                }
            }
        }
    }

    fn write_json_atomic(path: &Path, val: &Value) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
        if let Ok(bytes) = serde_json::to_vec_pretty(val) {
            if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
                let _ = std::fs::write(path, &bytes);
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    fn current_rules(&self, data_dir: &Path) -> AlertRulesConfig {
        self.ensure_hydrated(data_dir);
        self.alert_rules.lock().clone()
    }

    fn update_rules(&self, data_dir: &Path, next: AlertRulesConfig) -> AlertRulesConfig {
        self.ensure_hydrated(data_dir);
        let clamped = AlertRulesConfig {
            ttft_p95_warn_ms: next.ttft_p95_warn_ms.clamp(200.0, 120_000.0),
            cache_hit_min_pct: next.cache_hit_min_pct.clamp(0.0, 100.0),
            bufferbloat_warn_ms: next.bufferbloat_warn_ms.clamp(5.0, 5_000.0),
            context_warn_pct: next.context_warn_pct.clamp(10.0, 99.0),
            disk_free_warn_pct: next.disk_free_warn_pct.clamp(1.0, 50.0),
            error_rate_warn_pct: next.error_rate_warn_pct.clamp(0.5, 100.0),
        };
        *self.alert_rules.lock() = clamped.clone();
        if let Ok(v) = serde_json::to_value(&clamped) {
            Self::write_json_atomic(&data_dir.join("alert_rules_v5.json"), &v);
        }
        clamped
    }

    fn set_alert_ack(&self, data_dir: &Path, alert_id: &str, acked: bool) -> Vec<String> {
        self.ensure_hydrated(data_dir);
        let list: Vec<String> = {
            let mut g = self.alert_acks.lock();
            if acked {
                g.insert(alert_id.to_string());
            } else {
                g.remove(alert_id);
            }
            g.iter().cloned().collect()
        };
        Self::write_json_atomic(&data_dir.join("alert_acks_v5.json"), &json!(list));
        list
    }

    fn is_alert_acked(&self, data_dir: &Path, alert_id: &str) -> bool {
        self.ensure_hydrated(data_dir);
        self.alert_acks.lock().contains(alert_id)
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
            | "/api/v5/network/snapshot"
            | "/api/v5/network/identity"
            | "/api/network/identity"
            | "/api/v5/network/dns"
            | "/api/v5/network/dns/benchmark"
            | "/api/v5/network/proxy-tls"
            | "/api/v5/network/tls-probe"
            | "/api/v5/network/radar"
            | "/api/v5/network/traceroute"
            | "/api/v5/network/monitor"
            | "/api/v5/network/speedtest"
            | "/api/v5/network/speedtest/start"
            | "/api/v5/network/speedtest/cancel"
            | "/api/v5/network/speedtest/stream"
            | "/api/v5/network/speedtest/history"
            | "/api/v5/observatory/summary"
            | "/api/v5/telemetry/summary"
            | "/api/v5/telemetry/requests"
            | "/api/v5/telemetry/record"
            | "/api/v5/system/snapshot"
            | "/api/v5/hardware/host"
            | "/api/v5/router/state"
            | "/api/v5/router/decide"
            | "/api/v5/router/trip"
            | "/api/v5/router/reset"
            | "/api/v5/router/cancel"
            | "/api/router/cancel"
            | "/api/v5/router/receipt"
            | "/api/router/breaker"
            | "/api/v5/creds"
            | "/api/v5/creds/delete"
            | "/api/v5/alerts"
            | "/api/v5/alerts/ack"
            | "/api/v5/alerts/rules"
            | "/api/v5/diff/sessions"
            | "/api/v5/diff/speedtests"
            | "/api/v5/diff/models"
            | "/api/v5/diff/benchmarks"
            | "/api/v5/export"
            | "/api/v5/steer/status"
            | "/api/v5/steer/reconcile"
    )
}

/// Dispatches all `/api/v5/{network,observatory,telemetry,system,hardware,router,creds,alerts,diff,export,steer}/*` routes.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    let resp = match (req.method.as_str(), req.path.as_str()) {
        // 1. Network Observatory, Pro Speedtest, Radar, Traceroute, Monitor & TLS Probe
        ("GET", "/api/v5/network/overview")
        | ("GET", "/api/v5/network/snapshot")
        | ("POST", "/api/v5/network/snapshot") => handle_network_overview(state, req).await,
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
        ("POST", "/api/v5/network/tls-probe") => handle_network_tls_probe(req).await,
        ("GET", "/api/v5/network/radar") => handle_network_radar(req).await,
        ("POST", "/api/v5/network/traceroute") => handle_network_traceroute(req).await,
        ("GET", "/api/v5/network/monitor") => handle_network_monitor_get(state, req),
        ("POST", "/api/v5/network/monitor") => handle_network_monitor_post(state, req).await,
        ("POST", "/api/v5/network/speedtest/start") | ("POST", "/api/v5/network/speedtest") => {
            handle_speedtest_start(state, req)
        }
        ("POST", "/api/v5/network/speedtest/cancel") => handle_speedtest_cancel(state, req),
        ("GET", "/api/v5/network/speedtest/stream") => handle_speedtest_stream(state, req),
        ("GET", "/api/v5/network/speedtest/history") => handle_speedtest_history(state, req),

        // 2. Lab-Grade AI Telemetry, Observatory Summary & Statistical Forensics
        ("GET", "/api/v5/observatory/summary") => handle_observatory_summary(state, req).await,
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
        ("POST", "/api/router/cancel") | ("POST", "/api/v5/router/cancel") => {
            handle_router_cancel(state, req)
        }
        ("POST", "/api/router/breaker") => handle_router_breaker(state, req, None),
        ("GET", "/api/v5/router/receipt") => handle_router_receipt(state, req),

        // 5. CredMan V5 (Masked CRUD)
        ("GET", "/api/v5/creds") => handle_creds_list(req),
        ("POST", "/api/v5/creds") => handle_creds_set(req),
        ("POST", "/api/v5/creds/delete") => handle_creds_delete(req),

        // 6. Smart Alerts Engine, Ack & Editable Threshold Rules
        ("GET", "/api/v5/alerts") | ("POST", "/api/v5/alerts") => {
            handle_smart_alerts(state, req).await
        }
        ("POST", "/api/v5/alerts/ack") => handle_smart_alerts_ack(state, req),
        ("GET", "/api/v5/alerts/rules") => handle_smart_alerts_rules_get(state, req),
        ("POST", "/api/v5/alerts/rules") => handle_smart_alerts_rules_post(state, req),

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
    let body = parse_body(req).unwrap_or_else(|_| json!({}));
    let probe_public = req
        .query_param("probePublic")
        .or_else(|| req.query_param("probe_public"))
        .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false"))
        .or_else(|| body.get("probePublic").and_then(Value::as_bool))
        .unwrap_or(true);
    let force = req
        .query_param("force")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"))
        || body.get("force").and_then(Value::as_bool) == Some(true);

    let custom_dns_raw = req
        .query_param("customDns")
        .or_else(|| req.query_param("custom_dns"))
        .or_else(|| req.query_param("custom_dns_ip"))
        .or_else(|| pick_str(&body, &["customDns", "custom_dns", "custom_dns_ip"]).map(ToString::to_string));
    let custom_dns_ip = if let Some(ref raw) = custom_dns_raw {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            match validate_custom_dns_ip(trimmed) {
                Ok(valid) => Some(valid),
                Err(msg) => return HttpResponse::error(400, "invalid_dns_ip", &msg),
            }
        }
    } else {
        None
    };

    let custom_host_raw = req
        .query_param("customHost")
        .or_else(|| req.query_param("custom_host"))
        .or_else(|| pick_str(&body, &["customHost", "custom_host"]).map(ToString::to_string));
    let mut targets = configured_upstream_targets();
    if let Some(ref raw) = custom_host_raw {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            match normalize_custom_probe_url(trimmed) {
                Ok(tgt) => {
                    if !targets.iter().any(|t| t.url == tgt.url) {
                        targets.push(tgt);
                    }
                }
                Err(msg) => {
                    let code = if msg.to_ascii_lowercase().contains("forbidden") {
                        403
                    } else {
                        400
                    };
                    return HttpResponse::error(code, "invalid_custom_host", &msg);
                }
            }
        }
    }

    let state_c = Arc::clone(state);
    let res = tokio::task::spawn_blocking(move || {
        let identity = inspect_network_identity(&NetDiagOptions {
            probe_public_ip: probe_public,
            timeout_ms: 2_500,
            force_refresh: force,
        });
        *state_c.observatory.last_identity.lock() = Some(identity.clone());
        let run_custom_dns = custom_dns_ip.is_some();
        let dns_probe = inspect_dns_and_benchmark(&DnsBenchOptions {
            run_benchmark: run_custom_dns,
            public_ipv4_hint: identity.public_ipv4.clone(),
            custom_dns_ip,
            ..DnsBenchOptions::default()
        });
        if run_custom_dns {
            *state_c.observatory.last_dns.lock() = Some(dns_probe.clone());
        }
        let proxy_tls = inspect_proxy_tls_and_endpoints(&targets, force || custom_host_raw.is_some());
        (identity, dns_probe, proxy_tls, run_custom_dns)
    })
    .await;

    match res {
        Ok((identity, dns_probe, proxy_tls, used_custom_dns)) => {
            let last_dns = if used_custom_dns {
                dns_probe
            } else {
                state
                    .observatory
                    .last_dns
                    .lock()
                    .clone()
                    .unwrap_or(dns_probe)
            };
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
            let monitor = state.observatory.passive_monitor.snapshot();
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
                    "monitor": monitor,
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
        .or_else(|| req.query_param("queryDomain"))
        .or_else(|| pick_str(&body, &["domain", "queryDomain", "query_domain"]).map(ToString::to_string))
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
    let custom_dns_raw = req
        .query_param("customDns")
        .or_else(|| req.query_param("custom_dns"))
        .or_else(|| req.query_param("custom_dns_ip"))
        .or_else(|| pick_str(&body, &["customDns", "custom_dns", "custom_dns_ip"]).map(ToString::to_string));
    let custom_dns_ip = if let Some(ref raw) = custom_dns_raw {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            match validate_custom_dns_ip(trimmed) {
                Ok(valid) => Some(valid),
                Err(msg) => return HttpResponse::error(400, "invalid_dns_ip", &msg),
            }
        }
    } else {
        None
    };

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
            custom_dns_ip,
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
                        "severity": "warning",
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
    let custom_host_raw = req
        .query_param("customHost")
        .or_else(|| req.query_param("custom_host"))
        .or_else(|| pick_str(&body, &["customHost", "custom_host"]).map(ToString::to_string));

    let mut targets = configured_upstream_targets();
    let has_custom = if let Some(ref raw) = custom_host_raw {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            false
        } else {
            match normalize_custom_probe_url(trimmed) {
                Ok(tgt) => {
                    if !targets.iter().any(|t| t.url == tgt.url) {
                        targets.push(tgt);
                    }
                    true
                }
                Err(msg) => {
                    let code = if msg.to_ascii_lowercase().contains("forbidden") {
                        403
                    } else {
                        400
                    };
                    return HttpResponse::error(code, "invalid_custom_host", &msg);
                }
            }
        }
    } else {
        false
    };

    match tokio::task::spawn_blocking(move || {
        inspect_proxy_tls_and_endpoints(&targets, force || has_custom)
    })
    .await
    {
        Ok(rep) => json_ok_masked(req, json!({ "ok": true, "proxyTls": rep })),
        Err(e) => HttpResponse::error(500, "network_proxy_tls_failed", &e.to_string()),
    }
}

async fn handle_network_tls_probe(req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(host) = req
        .query_param("host")
        .or_else(|| req.query_param("target"))
        .or_else(|| pick_str(&body, &["host", "target"]).map(ToString::to_string))
    else {
        return HttpResponse::error(400, "missing_host", "Field 'host' is required.");
    };
    match tokio::task::spawn_blocking(move || probe_tls_host(&host)).await {
        Ok(Ok(rep)) => {
            let mut val = serde_json::to_value(&rep).unwrap_or_else(|_| json!({}));
            if let Some(obj) = val.as_object_mut() {
                obj.insert("ok".to_string(), json!(true));
                obj.insert("tls".to_string(), serde_json::to_value(&rep).unwrap_or(Value::Null));
            }
            json_ok_masked(req, val)
        }
        Ok(Err(msg)) => {
            let code = if msg.to_ascii_lowercase().contains("forbidden")
                || msg.to_ascii_lowercase().contains("ssrf")
            {
                403
            } else {
                400
            };
            HttpResponse::error(code, "invalid_tls_host", &msg)
        }
        Err(e) => HttpResponse::error(500, "tls_probe_failed", &e.to_string()),
    }
}

async fn handle_network_radar(req: &HttpRequest) -> HttpResponse {
    match tokio::task::spawn_blocking(run_global_latency_radar).await {
        Ok(rep) => {
            let regions_val = serde_json::to_value(&rep.regions).unwrap_or_else(|_| json!([]));
            let mut val = serde_json::to_value(&rep).unwrap_or_else(|_| json!({}));
            if let Some(obj) = val.as_object_mut() {
                obj.insert("ok".to_string(), json!(true));
                obj.insert("probes".to_string(), regions_val);
            }
            json_ok_masked(req, val)
        }
        Err(e) => HttpResponse::error(500, "radar_probe_failed", &e.to_string()),
    }
}

async fn handle_network_traceroute(req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = req
        .query_param("target")
        .or_else(|| req.query_param("host"))
        .or_else(|| pick_str(&body, &["target", "host"]).map(ToString::to_string))
    else {
        return HttpResponse::error(400, "missing_target", "Field 'target' is required.");
    };
    let max_hops = req
        .query_param("maxHops")
        .or_else(|| req.query_param("max_hops"))
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| {
            body.get("maxHops")
                .or_else(|| body.get("max_hops"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(12)
        .clamp(1, 12) as u8;

    match tokio::task::spawn_blocking(move || run_bounded_traceroute(&target, max_hops)).await {
        Ok(Ok(rep)) => {
            let mut val = serde_json::to_value(&rep).unwrap_or_else(|_| json!({}));
            if let Some(obj) = val.as_object_mut() {
                obj.insert("ok".to_string(), json!(true));
            }
            json_ok_masked(req, val)
        }
        Ok(Err(msg)) => {
            let code = if msg.to_ascii_lowercase().contains("forbidden")
                || msg.to_ascii_lowercase().contains("ssrf")
            {
                403
            } else {
                400
            };
            HttpResponse::error(code, "traceroute_rejected", &msg)
        }
        Err(e) => HttpResponse::error(500, "traceroute_failed", &e.to_string()),
    }
}

fn handle_network_monitor_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let snap = state.observatory.passive_monitor.snapshot();
    let mut val = serde_json::to_value(&snap).unwrap_or_else(|_| json!({}));
    if let Some(obj) = val.as_object_mut() {
        obj.insert("ok".to_string(), json!(true));
    }
    json_ok_masked(req, val)
}

async fn handle_network_monitor_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let action = pick_str(&body, &["action"])
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| {
            if body.get("enabled").and_then(Value::as_bool) == Some(false) {
                "stop".to_string()
            } else {
                "start".to_string()
            }
        });
    let interval_ms = body
        .get("intervalMs")
        .or_else(|| body.get("interval_ms"))
        .and_then(Value::as_u64);
    let target = pick_str(&body, &["target", "host"]).map(ToString::to_string);

    match action.as_str() {
        "stop" => state.observatory.passive_monitor.stop(),
        "reset" => state.observatory.passive_monitor.reset(),
        "sample" => {
            let st = Arc::clone(state);
            let _ = tokio::task::spawn_blocking(move || st.observatory.passive_monitor.sample_once()).await;
        }
        _ => {
            if let Err(msg) = state
                .observatory
                .passive_monitor
                .start(interval_ms, target.as_deref())
            {
                let code = if msg.to_ascii_lowercase().contains("forbidden")
                    || msg.to_ascii_lowercase().contains("ssrf")
                {
                    403
                } else {
                    400
                };
                return HttpResponse::error(code, "monitor_start_failed", &msg);
            }
        }
    }

    handle_network_monitor_get(state, req)
}

fn handle_speedtest_start(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let profile_str = req
        .query_param("profile")
        .or_else(|| pick_str(&body, &["profile"]).map(ToString::to_string))
        .unwrap_or_else(|| "standard".to_string());
    let stream_mode_str = req
        .query_param("streamMode")
        .or_else(|| req.query_param("stream_mode"))
        .or_else(|| pick_str(&body, &["streamMode", "stream_mode"]).map(ToString::to_string))
        .unwrap_or_else(|| "multi".to_string());

    let mut cfg = SpeedtestConfig::for_profile(&profile_str).with_stream_mode(&stream_mode_str);

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
        cfg.multi_streams = if cfg.stream_mode == "single" { 1 } else { 2 };
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
    let mode_label = cfg.stream_mode.clone();
    state.event_feed.publish(
        "network",
        "speedtest_started",
        None,
        json!({
            "runId": run_id,
            "profile": profile_label,
            "streamMode": mode_label,
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
                    "severity": if result.bufferbloat_grade == "C" { "warning" } else { "critical" },
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
        "streamMode": mode_label,
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
// 2. Lab-Grade AI Telemetry, Observatory Summary & Statistical Forensics
// =========================================================================

async fn handle_observatory_summary(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    use chrono::{DateTime, Datelike, Local, Timelike};

    let filter = parse_trace_filter(req);
    let summary = state
        .ops
        .telemetry_summary(&filter)
        .unwrap_or_else(|_| json!({}));
    let all_rows = state
        .ops
        .list_rich_traces(&TraceQueryFilter {
            window_ms: None,
            model: filter.model.clone(),
            role: filter.role.clone(),
            session_id: filter.session_id.clone(),
            limit: 5_000,
        })
        .unwrap_or_default();

    let now_ms = now_epoch_ms();
    let mut heatmap = vec![vec![0u64; 24]; 7];

    type TelemetryBucket = (String, i64, i64, i64, i64, f64, u64, u64);

    // 24h hourly buckets (oldest -> newest)
    const HOUR_MS: i64 = 3_600_000;
    const DAY_MS: i64 = 86_400_000;
    let cur_hour_start = (now_ms / HOUR_MS) * HOUR_MS;
    let first_hour_start = cur_hour_start - 23 * HOUR_MS;
    let mut h_buckets: Vec<TelemetryBucket> = (0..24)
        .map(|i| {
            let ts = first_hour_start + i * HOUR_MS;
            let lbl = DateTime::from_timestamp_millis(ts)
                .map(|dt| dt.with_timezone(&Local).format("%H:00").to_string())
                .unwrap_or_else(|| format!("{i:02}:00"));
            (lbl, ts, 0, 0, 0, 0.0, 0, 0)
        })
        .collect();

    // 30d daily buckets (oldest -> newest)
    let cur_day_start = (now_ms / DAY_MS) * DAY_MS;
    let first_day_start = cur_day_start - 29 * DAY_MS;
    let mut d_buckets: Vec<TelemetryBucket> = (0..30)
        .map(|i| {
            let ts = first_day_start + i * DAY_MS;
            let lbl = DateTime::from_timestamp_millis(ts)
                .map(|dt| dt.with_timezone(&Local).format("%m-%d").to_string())
                .unwrap_or_else(|| format!("D{i}"));
            (lbl, ts, 0, 0, 0, 0.0, 0, 0)
        })
        .collect();

    struct McpAgg {
        tool: String,
        server: String,
        calls: u64,
        durations: Vec<f64>,
        tokens_saved: i64,
        cost_saved_usd: f64,
        errors: u64,
    }
    let mut mcp_map: BTreeMap<String, McpAgg> = BTreeMap::new();

    for r in &all_rows {
        let ts = r.get("recordedAtMs").and_then(Value::as_i64).unwrap_or(0);
        let in_t = r.get("inputTokens").and_then(Value::as_i64).unwrap_or(0);
        let out_t = r.get("outputTokens").and_then(Value::as_i64).unwrap_or(0);
        let reas_t = r.get("reasoningTokens").and_then(Value::as_i64).unwrap_or(0);
        let tot_t = in_t + out_t + reas_t;
        let cost = r.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
        let is_err = r.get("isError").and_then(Value::as_bool).unwrap_or(false);

        if ts > 0 {
            if let Some(utc) = DateTime::from_timestamp_millis(ts) {
                let dt = utc.with_timezone(&Local);
                let dow = dt.weekday().num_days_from_monday() as usize;
                let hr = dt.hour() as usize;
                if dow < 7 && hr < 24 {
                    heatmap[dow][hr] += 1;
                }
            }
            if ts >= first_hour_start && ts < cur_hour_start + HOUR_MS {
                let idx = ((ts - first_hour_start) / HOUR_MS) as usize;
                if let Some(b) = h_buckets.get_mut(idx) {
                    b.2 += tot_t;
                    b.3 += in_t;
                    b.4 += out_t;
                    b.5 += cost;
                    b.6 += 1;
                    if is_err {
                        b.7 += 1;
                    }
                }
            }
            if ts >= first_day_start && ts < cur_day_start + DAY_MS {
                let idx = ((ts - first_day_start) / DAY_MS) as usize;
                if let Some(b) = d_buckets.get_mut(idx) {
                    b.2 += tot_t;
                    b.3 += in_t;
                    b.4 += out_t;
                    b.5 += cost;
                    b.6 += 1;
                    if is_err {
                        b.7 += 1;
                    }
                }
            }
        }

        let role = r.get("role").and_then(Value::as_str).unwrap_or("");
        let surface = r.get("surface").and_then(Value::as_str).unwrap_or("");
        let model = r.get("modelId").and_then(Value::as_str).unwrap_or("unknown");
        let saved_t = r.get("savedTokens").and_then(Value::as_i64).unwrap_or(0);
        let kv_usd = r.get("kvSavingsUsd").and_then(Value::as_f64).unwrap_or(0.0);
        let dur_ms = r.get("durationMs").and_then(Value::as_f64).unwrap_or(0.0);
        let is_mcp_or_tool = surface.to_ascii_lowercase().starts_with("mcp")
            || role.to_ascii_lowercase().starts_with("mcp")
            || role.to_ascii_lowercase().starts_with("tool")
            || saved_t > 0;
        if is_mcp_or_tool {
            let key = if surface.to_ascii_lowercase().starts_with("mcp") {
                format!("{surface}::{role}")
            } else {
                format!("{}::{}", if surface.is_empty() { "agent" } else { surface }, if role.is_empty() { model } else { role })
            };
            let entry = mcp_map.entry(key).or_insert_with(|| McpAgg {
                tool: if role.is_empty() { model.to_string() } else { role.to_string() },
                server: if surface.is_empty() { "omnia-mcp".to_string() } else { surface.to_string() },
                calls: 0,
                durations: Vec::new(),
                tokens_saved: 0,
                cost_saved_usd: 0.0,
                errors: 0,
            });
            entry.calls += 1;
            if dur_ms > 0.0 {
                entry.durations.push(dur_ms);
            }
            entry.tokens_saved += saved_t;
            entry.cost_saved_usd += kv_usd;
            if is_err {
                entry.errors += 1;
            }
        }
    }

    // Merge connected MCP server/tool inventory cleanly (truthful 0 counts until called)
    for t in state.mcp.search_tools("", 100) {
        let srv = t.get("server").and_then(Value::as_str).unwrap_or("mcp").to_string();
        let name = t
            .get("tool")
            .or_else(|| t.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let key = format!("{srv}::{name}");
        mcp_map.entry(key).or_insert(McpAgg {
            tool: name,
            server: srv,
            calls: 0,
            durations: Vec::new(),
            tokens_saved: 0,
            cost_saved_usd: 0.0,
            errors: 0,
        });
    }

    let bucket_json = |b: &(String, i64, i64, i64, i64, f64, u64, u64)| -> Value {
        json!({
            "label": b.0,
            "tsMs": b.1,
            "tokens": b.2,
            "totalTokens": b.2,
            "inputTokens": b.3,
            "outputTokens": b.4,
            "costUsd": ((b.5 * 1_000_000.0).round() / 1_000_000.0),
            "requests": b.6,
            "errors": b.7,
        })
    };
    let trends_24h: Vec<Value> = h_buckets.iter().map(bucket_json).collect();
    let trends_30d: Vec<Value> = d_buckets.iter().map(bucket_json).collect();

    let mcp_rows: Vec<Value> = mcp_map
        .into_values()
        .map(|mut a| {
            a.durations.sort_by(|x, y| x.total_cmp(y));
            let avg_ms = if a.durations.is_empty() {
                0.0
            } else {
                ((a.durations.iter().sum::<f64>() / a.durations.len() as f64) * 100.0).round() / 100.0
            };
            let p95_ms = if a.durations.is_empty() {
                0.0
            } else {
                let idx = ((a.durations.len() - 1) as f64 * 0.95).round() as usize;
                ((a.durations[idx.min(a.durations.len() - 1)]) * 100.0).round() / 100.0
            };
            let err_rate = if a.calls > 0 {
                ((a.errors as f64 / a.calls as f64) * 10_000.0).round() / 10_000.0
            } else {
                0.0
            };
            json!({
                "tool": a.tool,
                "toolName": a.tool,
                "name": a.tool,
                "server": a.server,
                "calls": a.calls,
                "count": a.calls,
                "avgLatencyMs": avg_ms,
                "p95LatencyMs": p95_ms,
                "tokensSaved": a.tokens_saved,
                "costSavedUsd": ((a.cost_saved_usd * 1_000_000.0).round() / 1_000_000.0),
                "errorCount": a.errors,
                "errorRate": err_rate,
            })
        })
        .collect();

    // Context Window Fill & Compaction ETA derived from latest traces
    const WARN_THRESHOLD: i64 = 160_000;
    const HARD_CAP: i64 = 200_000;
    let latest_fill_pct = all_rows
        .iter()
        .find_map(|r| r.get("contextWindowFillPct").and_then(Value::as_f64));
    let latest_input_span = all_rows.first().map(|r| {
        r.get("inputTokens").and_then(Value::as_i64).unwrap_or(0)
            + r.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0)
            + r.get("cacheWriteTokens").and_then(Value::as_i64).unwrap_or(0)
    });
    let current_tokens = if let Some(pct) = latest_fill_pct {
        ((pct / 100.0) * (HARD_CAP as f64)).round() as i64
    } else {
        latest_input_span.unwrap_or(0)
    };
    let fill_pct = latest_fill_pct.unwrap_or_else(|| {
        if current_tokens > 0 {
            ((current_tokens as f64 / HARD_CAP as f64) * 10000.0).round() / 100.0
        } else {
            0.0
        }
    });

    let recent_slice: Vec<&Value> = all_rows.iter().take(12).collect();
    let recent_tok_sum: i64 = recent_slice
        .iter()
        .map(|r| {
            r.get("inputTokens").and_then(Value::as_i64).unwrap_or(0)
                + r.get("outputTokens").and_then(Value::as_i64).unwrap_or(0)
                + r.get("reasoningTokens").and_then(Value::as_i64).unwrap_or(0)
        })
        .sum();
    let tokens_per_turn = if recent_slice.is_empty() {
        0.0
    } else {
        ((recent_tok_sum as f64 / recent_slice.len() as f64) * 10.0).round() / 10.0
    };
    let newest_ts = recent_slice
        .first()
        .and_then(|r| r.get("recordedAtMs").and_then(Value::as_i64))
        .unwrap_or(0);
    let oldest_ts = recent_slice
        .last()
        .and_then(|r| r.get("recordedAtMs").and_then(Value::as_i64))
        .unwrap_or(0);
    let span_mins = ((newest_ts.saturating_sub(oldest_ts) as f64) / 60_000.0).max(1.0);
    let tokens_per_min = if recent_slice.is_empty() {
        0.0
    } else {
        ((recent_tok_sum as f64 / span_mins) * 10.0).round() / 10.0
    };
    let est_secs_to_200k = if all_rows.is_empty() || tokens_per_min <= 0.0 {
        None
    } else if current_tokens >= HARD_CAP {
        Some(0i64)
    } else {
        Some((((HARD_CAP - current_tokens) as f64 / tokens_per_min) * 60.0).round() as i64)
    };
    let compaction_eta_turns = all_rows
        .iter()
        .find_map(|r| r.get("compactionEtaTurns").and_then(Value::as_i64))
        .or_else(|| {
            if all_rows.is_empty() || tokens_per_turn <= 0.0 {
                None
            } else if current_tokens >= WARN_THRESHOLD {
                Some(0i64)
            } else {
                Some(((WARN_THRESHOLD - current_tokens) as f64 / tokens_per_turn).ceil() as i64)
            }
        });

    let host = tokio::task::spawn_blocking(collect_host_system_snapshot)
        .await
        .ok();
    let alerts = evaluate_alerts_sync(state, host.as_ref());
    let rules = state
        .observatory
        .current_rules(&state.config.studio_data_dir());

    json_ok_masked(
        req,
        json!({
            "ok": true,
            "window": req.query_param("window").unwrap_or_else(|| "24h".to_string()),
            "activityHeatmap7x24": heatmap,
            "trends24h": trends_24h,
            "trends30d": trends_30d,
            "contextEta": {
                "tokensPerTurn": tokens_per_turn,
                "tokensPerMin": tokens_per_min,
                "estSecsTo200k": est_secs_to_200k,
                "warnThreshold": WARN_THRESHOLD,
                "hardCap": HARD_CAP,
                "currentTokens": current_tokens,
                "fillPct": fill_pct,
                "compactionEtaTurns": compaction_eta_turns,
            },
            "mcpToolTelemetry": mcp_rows,
            "mcpServers": state.mcp.list_servers(),
            "alerts": alerts,
            "rules": rules,
            "summary": summary,
        }),
    )
}

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

fn handle_router_cancel(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let reservation_id = pick_str(&body, &["reservationId", "reservation_id"]);
    let session_id = pick_str(&body, &["sessionId", "session_id", "runId", "run_id"]);
    let explicit_token = body
        .get("fencingToken")
        .or_else(|| body.get("fencing_token"))
        .and_then(Value::as_u64);
    let note = pick_str(&body, &["note", "reason"]).unwrap_or("operator_cancelled_aud24");
    let now = now_epoch_ms();

    if let Some(res_id) = reservation_id {
        let token = explicit_token.unwrap_or_else(|| state.lookup_reservation_fencing_token(res_id));
        return match state.router.cancel_reservation(res_id, token, note, now) {
            Ok(receipt) => {
                state.remove_tracked_reservation(res_id);
                state.event_feed.publish(
                    "router",
                    "reservation_cancelled",
                    session_id,
                    json!({
                        "reservationId": res_id,
                        "fencingToken": token,
                        "note": note,
                    }),
                );
                json_ok_masked(
                    req,
                    json!({
                        "ok": true,
                        "cancelled": true,
                        "interrupted": true,
                        "status": "cancelled",
                        "cancelledCount": 1,
                        "reservationId": res_id,
                        "receipt": receipt.to_json(),
                        "receipts": [receipt.to_json()],
                    }),
                )
            }
            Err(err) => {
                let status = if err.to_string().to_ascii_lowercase().contains("fencing") {
                    409
                } else {
                    404
                };
                HttpResponse::error(status, "router_cancel_failed", &err.to_string())
            }
        };
    }

    let receipts = state.cancel_tracked_reservations(session_id, note);
    let cancelled_count = receipts.len();
    if cancelled_count > 0 {
        state.event_feed.publish(
            "router",
            "reservation_cancelled",
            session_id,
            json!({
                "cancelledCount": cancelled_count,
                "note": note,
            }),
        );
    }
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "cancelled": cancelled_count > 0,
            "interrupted": true,
            "status": if cancelled_count > 0 { "cancelled" } else { "no_active_reservations" },
            "cancelledCount": cancelled_count,
            "sessionId": session_id,
            "receipt": receipts.first().cloned().unwrap_or(Value::Null),
            "receipts": receipts,
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
    let data_dir = state.config.studio_data_dir();
    let rules = state.observatory.current_rules(&data_dir);

    let mut push_alert = |id: String, kind: &str, severity: &str, target_tab: &str, title: String, detail: String, observed_at_ms: i64| {
        let acked = state.observatory.is_alert_acked(&data_dir, &id);
        alerts.push(json!({
            "id": id,
            "kind": kind,
            "severity": severity,
            "targetTab": target_tab,
            "title": title,
            "detail": detail,
            "acked": acked,
            "observedAtMs": observed_at_ms,
        }));
    };

    // 1..4. Telemetry TTFT spike, Cache Hit < min%, Error Rate > threshold, Context Window fill
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
            if p95 > rules.ttft_p95_warn_ms {
                let sev = if p95 > (rules.ttft_p95_warn_ms * 2.2) {
                    "critical"
                } else {
                    "warning"
                };
                push_alert(
                    "alert_ttft_spike".to_string(),
                    "ttft_spike",
                    sev,
                    "telemetry",
                    "Elevated Time-to-First-Token (p95)".to_string(),
                    format!(
                        "24h TTFT p95 is {:.0} ms (threshold {:.0} ms).",
                        p95, rules.ttft_p95_warn_ms
                    ),
                    now,
                );
            }
        }
        let cache_pct = summary.get("cacheHitPct").and_then(Value::as_f64).unwrap_or(100.0);
        if total_req >= 3 && cache_pct < rules.cache_hit_min_pct {
            push_alert(
                "alert_cache_low".to_string(),
                "cache_hit_low",
                "warning",
                "telemetry",
                format!("Prefix-0 KV Cache Hit Rate Below {:.0}%", rules.cache_hit_min_pct),
                format!(
                    "Observed 24h KV cache hit rate is {:.1}% across {total_req} requests.",
                    cache_pct
                ),
                now,
            );
        }
        let err_pct = summary.get("errorRate").and_then(Value::as_f64).unwrap_or(0.0) * 100.0;
        if total_req >= 3 && err_pct > rules.error_rate_warn_pct {
            push_alert(
                "alert_error_rate".to_string(),
                "error_rate_spike",
                if err_pct > (rules.error_rate_warn_pct * 2.0) { "critical" } else { "warning" },
                "telemetry",
                "Elevated AI Request Error Rate".to_string(),
                format!(
                    "24h error rate is {:.1}% (threshold {:.1}%).",
                    err_pct, rules.error_rate_warn_pct
                ),
                now,
            );
        }
        if let Some(fill) = summary
            .get("contextWindow")
            .and_then(|c| c.get("latestFillPct"))
            .and_then(Value::as_f64)
        {
            if fill >= rules.context_warn_pct {
                push_alert(
                    "alert_context_fill".to_string(),
                    "context_window_high",
                    if fill >= 92.0 { "critical" } else { "warning" },
                    "telemetry",
                    format!("Context Window at {:.0}%", fill),
                    format!(
                        "Latest session context fill is {:.1}% (warn threshold {:.0}%).",
                        fill, rules.context_warn_pct
                    ),
                    now,
                );
            }
        }
    }

    // 5. Router Circuit Open
    if let Ok(snaps) = state.router.snapshots(now) {
        for s in snaps {
            if !matches!(s.state.circuit, CircuitState::Closed) {
                let st_str = match s.state.circuit {
                    CircuitState::Open { .. } => "Open",
                    CircuitState::HalfOpen { .. } => "HalfOpen",
                    CircuitState::Closed => "Closed",
                };
                push_alert(
                    format!("alert_circuit_{}", s.candidate.candidate_id),
                    "circuit_tripped",
                    "warning",
                    "router",
                    format!("Circuit {st_str}: {}", s.candidate.candidate_id),
                    format!("Candidate '{}' is currently in {st_str} circuit state.", s.candidate.candidate_id),
                    now,
                );
            }
        }
    }

    // 6. Bufferbloat spike (latest persisted speedtest)
    if let Ok(runs) = state.ops.list_speedtests(1) {
        if let Some(latest) = runs.first() {
            if !latest.cancelled && latest.worst_bufferbloat_delta_ms > rules.bufferbloat_warn_ms {
                push_alert(
                    format!("alert_bloat_{}", latest.run_id),
                    "bufferbloat_spike",
                    if latest.worst_bufferbloat_delta_ms >= 200.0 || matches!(latest.bufferbloat_grade.as_str(), "D" | "F") {
                        "critical"
                    } else {
                        "warning"
                    },
                    "network",
                    format!("Bufferbloat Grade {} (+{:.0} ms)", latest.bufferbloat_grade, latest.worst_bufferbloat_delta_ms),
                    format!(
                        "Latest speedtest showed DL +{:.1} ms / UL +{:.1} ms loaded latency inflation (threshold +{:.0} ms).",
                        latest.dl_bufferbloat_delta_ms, latest.ul_bufferbloat_delta_ms, rules.bufferbloat_warn_ms
                    ),
                    latest.finished_at_ms,
                );
            }
        }
    }

    // 7. DNS Leak warning (from last DNS diagnostic)
    if let Some(ref dns) = *state.observatory.last_dns.lock() {
        if dns.leak_status == "possible_dns_leak" {
            push_alert(
                "alert_dns_leak".to_string(),
                "dns_leak",
                "warning",
                "network",
                "Potential VPN DNS Leak Detected".to_string(),
                dns.leak_warning.clone().unwrap_or_else(|| "System DNS may bypass VPN tunnel.".into()),
                dns.observed_at_ms,
            );
        }
    }

    // 8. Low Disk Space
    if let Some(host) = host_opt {
        for disk in &host.disks {
            let free_pct = 100.0 - disk.used_pct;
            if free_pct < rules.disk_free_warn_pct {
                push_alert(
                    format!("alert_disk_{}", disk.drive),
                    "low_disk",
                    if free_pct < (rules.disk_free_warn_pct * 0.5) { "critical" } else { "warning" },
                    "system",
                    format!("Low Free Disk Space on {}", disk.drive),
                    format!(
                        "Drive {} has {:.1}% free ({:.1} GiB remaining; threshold {:.0}%).",
                        disk.drive,
                        free_pct,
                        (disk.free_bytes as f64) / 1_073_741_824.0,
                        rules.disk_free_warn_pct
                    ),
                    now,
                );
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
    let rules = state
        .observatory
        .current_rules(&state.config.studio_data_dir());
    json_ok_masked(
        req,
        json!({
            "ok": true,
            "count": alerts.len(),
            "alerts": alerts,
            "rules": rules,
            "evaluatedAtMs": now_epoch_ms(),
        }),
    )
}

fn handle_smart_alerts_ack(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(alert_id) = pick_str(&body, &["alertId", "alert_id", "id"]) else {
        return HttpResponse::error(400, "missing_alert_id", "Field 'alertId' is required.");
    };
    let acked = body
        .get("acked")
        .or_else(|| body.get("acknowledged"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let data_dir = state.config.studio_data_dir();
    let acked_ids = state.observatory.set_alert_ack(&data_dir, alert_id, acked);
    state.event_feed.publish(
        "alerts",
        "alert_acknowledged",
        None,
        json!({ "alertId": alert_id, "acked": acked }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "alertId": alert_id,
        "acked": acked,
        "ackedIds": acked_ids,
    }))
}

fn handle_smart_alerts_rules_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let rules = state
        .observatory
        .current_rules(&state.config.studio_data_dir());
    let mut val = serde_json::to_value(&rules).unwrap_or_else(|_| json!({}));
    if let Some(obj) = val.as_object_mut() {
        obj.insert("ok".to_string(), json!(true));
        obj.insert("rules".to_string(), serde_json::to_value(&rules).unwrap_or(Value::Null));
    }
    json_ok_masked(req, val)
}

fn handle_smart_alerts_rules_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let src = body.get("rules").filter(|v| v.is_object()).unwrap_or(&body);
    let mut next = state
        .observatory
        .current_rules(&state.config.studio_data_dir());
    if let Some(v) = pick_f64(src, &["ttftP95WarnMs", "ttft_p95_warn_ms"]) {
        next.ttft_p95_warn_ms = v;
    }
    if let Some(v) = pick_f64(src, &["cacheHitMinPct", "cache_hit_min_pct"]) {
        next.cache_hit_min_pct = v;
    }
    if let Some(v) = pick_f64(src, &["bufferbloatWarnMs", "bufferbloat_warn_ms"]) {
        next.bufferbloat_warn_ms = v;
    }
    if let Some(v) = pick_f64(src, &["contextWarnPct", "context_warn_pct"]) {
        next.context_warn_pct = v;
    }
    if let Some(v) = pick_f64(src, &["diskFreeWarnPct", "disk_free_warn_pct"]) {
        next.disk_free_warn_pct = v;
    }
    if let Some(v) = pick_f64(src, &["errorRateWarnPct", "error_rate_warn_pct"]) {
        next.error_rate_warn_pct = v;
    }

    let saved = state
        .observatory
        .update_rules(&state.config.studio_data_dir(), next);
    let mut val = serde_json::to_value(&saved).unwrap_or_else(|_| json!({}));
    if let Some(obj) = val.as_object_mut() {
        obj.insert("ok".to_string(), json!(true));
        obj.insert("rules".to_string(), serde_json::to_value(&saved).unwrap_or(Value::Null));
    }
    json_ok_masked(req, val)
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
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-obs-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let rb = tmp.join("rb");
        let _ = std::fs::create_dir_all(&rb);
        let cfg = StudioConfig {
            rollback_root: rb,
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

        // 6. AUD-24 POST /api/router/cancel releases active tracked reservation cleanly
        {
            let now_ms = omnia_core::now_epoch_ms();
            let cand = omnia_routing::RouteCandidate {
                candidate_id: "cancel-fixture:model-a".to_string(),
                provider_id: "cancel-fixture".to_string(),
                model_id: "model-a".to_string(),
                auth_boundary: "workspace:default".to_string(),
                region: "local".to_string(),
                privacy_tier: omnia_routing::PrivacyTier::ZeroDataRetention,
                capabilities: omnia_routing::ModelCapabilities::standard_candidate(),
                context_limit_tokens: 128_000,
                max_output_tokens: 8_192,
                quality_tier: 3,
                pricing_version: "fixture".to_string(),
                input_cost_per_million_microunits: Some(1_000),
                output_cost_per_million_microunits: Some(2_000),
                credential_present: true,
                enabled: true,
                route_priority: 10,
                supported_roles: Vec::new(),
            };
            let st = omnia_routing::CandidateResourceState {
                quota: omnia_routing::QuotaState::Known {
                    remaining_tokens: 500_000,
                    remaining_requests: 100,
                    window_capacity_tokens: 500_000,
                    window_duration_ms: 60_000,
                    window_reset_at_ms: Some(now_ms + 60_000),
                    freshness_timestamp_ms: Some(now_ms),
                    max_staleness_ms: 600_000,
                },
                ..omnia_routing::CandidateResourceState::default()
            };
            state.router.upsert_candidate(cand, st).expect("upsert cancel fixture");
        }
        let dec = dispatch_request(
            Arc::clone(&state),
            make_req(
                "POST",
                "/api/router/decide",
                br#"{"sessionId":"sess_cancel_1","estimatedTokens":1000}"#,
            ),
        )
        .await;
        assert_eq!(dec.status, 200);
        let dj: Value = serde_json::from_slice(&dec.body).expect("decide json");
        let res_id = dj["receipt"]["reservationId"]
            .as_str()
            .or_else(|| dj["reservation"]["reservation_id"].as_str())
            .or_else(|| dj["reservation"]["reservationId"].as_str())
            .expect("reservationId")
            .to_string();
        let cancel_res = dispatch_request(
            Arc::clone(&state),
            make_req(
                "POST",
                "/api/router/cancel",
                json!({ "reservationId": res_id, "reason": "aud24_unit_test" })
                    .to_string()
                    .as_bytes(),
            ),
        )
        .await;
        assert_eq!(cancel_res.status, 200);
        let crj: Value = serde_json::from_slice(&cancel_res.body).expect("cancel json");
        assert_eq!(crj["cancelled"], true);
        assert_eq!(crj["status"], "cancelled");
        assert_eq!(crj["cancelledCount"], 1);
    }

    #[tokio::test]
    async fn steer28b_network_guards_monitor_summary_alerts_ack_and_rules_work() {
        let state = make_test_state();

        // 1. Snapshot offline + monitor schema
        let snap = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/network/snapshot?probePublic=false&privacy_mask=true", b""),
        )
        .await;
        assert_eq!(snap.status, 200);
        let sj: Value = serde_json::from_slice(&snap.body).expect("snap json");
        assert_eq!(sj["ok"], true);
        assert_eq!(sj["autoSpeedtestDisabled"], true);
        assert_eq!(sj["monitor"]["capacity"], 120);
        assert!(
            sj["proxyTls"]["endpoints"]
                .as_array()
                .is_some_and(|v| v.len() >= 9)
        );

        // 2. SSRF & injection guards across dns, tls-probe, proxy-tls, traceroute, monitor
        let bad_dns = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/network/dns/benchmark?customDns=not-an-ip", b""),
        )
        .await;
        assert_eq!(bad_dns.status, 400);

        let bad_tls = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/v5/network/tls-probe", br#"{"host":"169.254.169.254"}"#),
        )
        .await;
        assert_eq!(bad_tls.status, 403);

        let bad_agy = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/v5/network/proxy-tls", br#"{"customHost":"agy.example.test"}"#),
        )
        .await;
        assert_eq!(bad_agy.status, 403);

        let bad_trace = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/v5/network/traceroute", br#"{"target":"-bad;calc","maxHops":8}"#),
        )
        .await;
        assert_eq!(bad_trace.status, 400);

        let mon_get = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/network/monitor", b""),
        )
        .await;
        assert_eq!(mon_get.status, 200);
        let mj: Value = serde_json::from_slice(&mon_get.body).expect("mon json");
        assert_eq!(mj["capacity"], 120);
        assert_eq!(mj["running"], false);

        // 3. Record traces -> verify GET /api/v5/observatory/summary heatmap, 24h/30d trends, contextEta, mcpToolTelemetry
        for idx in 0..3 {
            let rec_body = json!({
                "reqId": format!("req_obs_{idx}"),
                "sessionId": "sess_obs_1",
                "role": "mcp_search",
                "surface": "mcp",
                "modelId": "claude-sonnet-5-5",
                "inputTokens": 4000,
                "outputTokens": 600,
                "savedTokens": 1200,
                "kvSavingsUsd": 0.0036,
                "costUsd": 0.012,
                "durationMs": 420,
                "ttftMs": 180,
                "contextWindowFillPct": 85.0,
            });
            let r = dispatch_request(
                Arc::clone(&state),
                make_req("POST", "/api/v5/telemetry/record", rec_body.to_string().as_bytes()),
            )
            .await;
            assert_eq!(r.status, 200);
        }

        let obs = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/observatory/summary?window=24h", b""),
        )
        .await;
        assert_eq!(obs.status, 200);
        let oj: Value = serde_json::from_slice(&obs.body).expect("obs json");
        assert_eq!(oj["ok"], true);
        let hm = oj["activityHeatmap7x24"].as_array().expect("heatmap");
        assert_eq!(hm.len(), 7);
        assert_eq!(hm[0].as_array().map(|r| r.len()), Some(24));
        assert_eq!(oj["trends24h"].as_array().map(|v| v.len()), Some(24));
        assert_eq!(oj["trends30d"].as_array().map(|v| v.len()), Some(30));
        assert_eq!(oj["contextEta"]["warnThreshold"], 160_000);
        assert_eq!(oj["contextEta"]["hardCap"], 200_000);
        assert!(oj["contextEta"]["tokensPerTurn"].as_f64().unwrap_or(0.0) > 0.0);
        assert!(oj["mcpToolTelemetry"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["tokensSaved"].as_i64().unwrap_or(0) == 3600));

        // 4. Alert rules update + alert ack persistence roundtrip
        let rules_post = dispatch_request(
            Arc::clone(&state),
            make_req(
                "POST",
                "/api/v5/alerts/rules",
                br#"{"ttftP95WarnMs":3500,"cacheHitMinPct":65,"contextWarnPct":75}"#,
            ),
        )
        .await;
        assert_eq!(rules_post.status, 200);
        let rpj: Value = serde_json::from_slice(&rules_post.body).expect("rules post");
        assert_eq!(rpj["rules"]["ttftP95WarnMs"], 3500.0);
        assert_eq!(rpj["rules"]["contextWarnPct"], 75.0);

        let ack_resp = dispatch_request(
            Arc::clone(&state),
            make_req("POST", "/api/v5/alerts/ack", br#"{"alertId":"alert_context_fill","acked":true}"#),
        )
        .await;
        assert_eq!(ack_resp.status, 200);
        let alerts_after = dispatch_request(
            Arc::clone(&state),
            make_req("GET", "/api/v5/alerts", b""),
        )
        .await;
        assert_eq!(alerts_after.status, 200);
        let aaj: Value = serde_json::from_slice(&alerts_after.body).expect("alerts after");
        assert!(aaj["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "alert_context_fill" && a["acked"] == true));
    }
}
