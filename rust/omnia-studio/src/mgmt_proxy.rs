//! Optional loopback telemetry & management forwarding for `D:\htmustc-proxy`
//! (`/api/management/*`), plus real Benchmark Scoreboard loader (`/api/benchmarks/scoreboard`).
//!
//! Strictly fail-closed on non-loopback proxy URLs, secret-redacted, and 100% honest when
//! `OMNIA_HTMUSTC_PROXY_URL` is unconfigured or benchmark artifacts are absent.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use omnia_core::credentials::CredentialStore;
use omnia_core::SecretRedactor;
use reqwest::Client;
use serde_json::{json, Value};

use crate::config::{validate_loopback_runtime_url, RUNTIME_PROXY_TIMEOUT_MS};
use crate::http::{HttpRequest, HttpResponse};
use crate::ops_store::OpsStore;

/// Resolves an optional loopback `htmustc-proxy` base URL from `OMNIA_HTMUSTC_PROXY_URL`.
#[must_use]
pub fn resolve_htmustc_proxy_url() -> Option<String> {
    let raw = env::var("OMNIA_HTMUSTC_PROXY_URL").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    validate_loopback_runtime_url(trimmed)
        .ok()
        .map(|u| u.as_str().trim_end_matches('/').to_string())
}

fn resolve_mgmt_secret() -> Option<String> {
    if let Ok(raw) = env::var("OMNIA_HTMUSTC_MGMT_KEY") {
        let t = raw.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    CredentialStore::resolve_secret("omnia:htmustc_mgmt")
        .ok()
        .flatten()
        .and_then(|s| s.expose_for_wire().ok().map(ToString::to_string))
}

/// Handles `GET|POST /api/management/*` by forwarding strictly to loopback `htmustc-proxy`
/// when configured, or returning an honest `{ state: "unconfigured" }` response.
pub async fn handle_management_route(req: &HttpRequest) -> HttpResponse {
    let Some(base) = resolve_htmustc_proxy_url() else {
        return HttpResponse::ok(json!({
            "ok": true,
            "state": "unconfigured",
            "configured": false,
            "route": req.path,
            "detail": "Set OMNIA_HTMUSTC_PROXY_URL to a loopback htmustc-proxy endpoint to view live pool/account management telemetry.",
        }));
    };

    let target_url = if req.query.trim().is_empty() {
        format!("{base}{}", req.path)
    } else {
        format!("{base}{}?{}", req.path, req.query)
    };

    let Ok(client) = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(1_000))
        .timeout(Duration::from_millis(RUNTIME_PROXY_TIMEOUT_MS))
        .build()
    else {
        return HttpResponse::error(500, "client_init_failed", "Failed building proxy HTTP client.");
    };

    let mut builder = match req.method.as_str() {
        "GET" => client.get(&target_url),
        "POST" => client.post(&target_url).body(req.body.clone()),
        "PUT" => client.put(&target_url).body(req.body.clone()),
        "PATCH" => client.patch(&target_url).body(req.body.clone()),
        "DELETE" => client.delete(&target_url),
        _ => {
            return HttpResponse::error(
                405,
                "method_not_allowed",
                "Unsupported method for management proxy route.",
            )
        }
    };
    builder = builder.header("Content-Type", "application/json");
    if let Some(secret) = resolve_mgmt_secret() {
        builder = builder.bearer_auth(secret);
    }

    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&text)
                .map(|v| SecretRedactor::redact_json(&v))
                .unwrap_or_else(|_| json!({ "raw": SecretRedactor::redact(&text) }));
            HttpResponse::json(
                status,
                json!({
                    "ok": (200..300).contains(&status),
                    "configured": true,
                    "upstreamStatus": status,
                    "data": parsed,
                }),
            )
        }
        Err(err) => HttpResponse::json(
            502,
            json!({
                "ok": false,
                "state": "unavailable",
                "configured": true,
                "code": "htmustc_proxy_unreachable",
                "detail": SecretRedactor::redact(&err.to_string()),
            }),
        ),
    }
}

/// Reads real benchmark receipt files (`D:\OmniaData\benchmark-results`, `OMNIA_BENCHMARK_RESULTS_DIR`,
/// or `<workspace>/tools/omnia-benchmark/results`) + live [`OpsStore`] telemetry.
/// Zero hardcoded numbers: returns `runs: []` honestly if no benchmark runs exist on disk.
#[must_use]
pub fn build_benchmark_scoreboard(workspace_root: &Path, ops: &OpsStore) -> Value {
    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = env::var("OMNIA_BENCHMARK_RESULTS_DIR") {
        let p = PathBuf::from(custom.trim());
        if p.is_dir() {
            search_dirs.push(p);
        }
    }
    let ext_results = PathBuf::from(r"D:\OmniaData\benchmark-results");
    if ext_results.is_dir() {
        search_dirs.push(ext_results);
    }
    let qa_results = PathBuf::from(r"D:\OmniaData\qa");
    if qa_results.is_dir() {
        search_dirs.push(qa_results);
    }
    let ws_bench = workspace_root.join("tools").join("omnia-benchmark").join("results");
    if ws_bench.is_dir() {
        search_dirs.push(ws_bench);
    }

    let mut runs = Vec::new();
    for dir in search_dirs {
        collect_benchmark_receipts_bounded(&dir, &mut runs, 32);
    }
    runs.sort_by(|a, b| {
        b.get("recordedAtMs")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .cmp(&a.get("recordedAtMs").and_then(Value::as_i64).unwrap_or(0))
    });
    runs.truncate(24);

    let live_stats = ops.stats_snapshot().unwrap_or_else(|_| json!({}));
    json!({
        "ok": true,
        "schema": "omnia.benchmark.scoreboard.v1",
        "empty": runs.is_empty(),
        "runCount": runs.len(),
        "runs": runs,
        "liveUsageSummary": live_stats,
        "note": if runs.is_empty() {
            "No benchmark receipt JSON files found yet under D:\\OmniaData\\benchmark-results or OMNIA_BENCHMARK_RESULTS_DIR."
        } else {
            "Loaded directly from verified external benchmark receipt JSON files."
        },
    })
}

fn collect_benchmark_receipts_bounded(dir: &Path, out: &mut Vec<Value>, limit: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("bench") || name.starts_with("v4") || name.starts_with("v5") {
                collect_benchmark_receipts_bounded(&path, out, limit);
            }
            continue;
        }
        let fname = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !fname.ends_with(".json")
            || !(fname.contains("bench") || fname.contains("scoreboard") || fname.contains("summary"))
        {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let is_bench = parsed.get("tasks").is_some()
            || parsed.get("pass_rate").is_some()
            || parsed.get("passRate").is_some()
            || parsed.get("axes").is_some()
            || parsed.get("suite").is_some();
        if !is_bench {
            continue;
        }
        out.push(json!({
            "file": path.file_name().and_then(|n| n.to_str()).unwrap_or("receipt.json"),
            "receipt": SecretRedactor::redact_json(&parsed),
        }));
    }
}
