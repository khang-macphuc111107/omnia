//! Bounded 3,000 ms upstream `omnia-runtime` HTTP proxy & NVIDIA probe normalization.

use crate::config::validate_loopback_runtime_url;
use crate::http::{HttpRequest, HttpResponse};
use omnia_core::{now_epoch_ms, SecretRedactor};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time;

const MAX_UPSTREAM_BODY_BYTES: usize = 4 * 1024 * 1024;
const ALLOWED_CHAT_MODEL_MAX_LEN: usize = 256;

/// Stateless upstream HTTP proxy targeting `omnia-runtime` with a hard 3,000 ms timeout.
#[derive(Clone, Debug)]
pub struct RuntimeProxy {
    client: Client,
    timeout: Duration,
}

#[derive(Debug)]
enum ProxyFailure {
    Unconfigured(&'static str),
    Timeout(String),
    Unreachable(String),
    InvalidConfig(String),
}

impl RuntimeProxy {
    /// Creates a loopback-only HTTP proxy enforcing `timeout` per upstream call.
    pub fn new(timeout: Duration) -> Result<Self, String> {
        let clamped = if timeout.is_zero() {
            Duration::from_millis(3_000)
        } else {
            timeout.min(Duration::from_millis(3_000))
        };
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(clamped)
            .timeout(clamped)
            .build()
            .map_err(|err| format!("Failed to construct RuntimeProxy HTTP client: {err}"))?;
        Ok(Self {
            client,
            timeout: clamped,
        })
    }

    /// Probes `<runtime_url>/api/health` within the 3,000 ms budget for `/api/health` and `/api/overview`.
    pub async fn probe_overview_runtime(&self, runtime_url: Option<&str>) -> Value {
        match self
            .send_bounded(
                runtime_url,
                Method::GET,
                "/api/health",
                None,
                "application/json",
            )
            .await
        {
            Ok((status, _ct, body)) => {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
                let is_ok = (200..300).contains(&status)
                    && parsed.get("ok").and_then(Value::as_bool) != Some(false);
                json!({
                    "ok": is_ok,
                    "state": if is_ok { "online" } else { "degraded" },
                    "httpStatus": status,
                    "runtimeUrl": runtime_url,
                    "details": SecretRedactor::redact_json(&parsed),
                })
            }
            Err(failure) => {
                let (code, detail, _http) = failure_fields(&failure);
                json!({
                    "ok": false,
                    "state": "unavailable",
                    "code": code,
                    "error": code,
                    "message": detail,
                    "runtimeUrl": runtime_url,
                })
            }
        }
    }

    /// `GET /api/runtime/status`
    pub async fn handle_runtime_status(&self, runtime_url: Option<&str>) -> HttpResponse {
        match self
            .send_bounded(
                runtime_url,
                Method::GET,
                "/api/health",
                None,
                "application/json",
            )
            .await
        {
            Ok((status, _ct, body)) => {
                let health_json: Value =
                    serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
                let upstream_ok = (200..300).contains(&status)
                    && health_json.get("ok").and_then(Value::as_bool) != Some(false);
                if upstream_ok {
                    HttpResponse::json(
                        200,
                        json!({
                            "ok": true,
                            "state": "online",
                            "service": "omnia-runtime",
                            "runtimeUrl": runtime_url,
                            "timeoutMs": self.timeout.as_millis() as u64,
                            "health": SecretRedactor::redact_json(&health_json),
                        }),
                    )
                } else {
                    HttpResponse::json(
                        503,
                        json!({
                            "ok": false,
                            "state": "unavailable",
                            "code": "runtime_unhealthy",
                            "error": "runtime_unhealthy",
                            "message": format!("omnia-runtime returned HTTP {status}"),
                            "runtimeUrl": runtime_url,
                            "health": SecretRedactor::redact_json(&health_json),
                        }),
                    )
                }
            }
            Err(failure) => {
                unavailable_runtime_response(&failure, runtime_url, self.timeout.as_millis() as u64)
            }
        }
    }

    /// `GET /api/providers`
    pub async fn handle_providers(&self, runtime_url: Option<&str>) -> HttpResponse {
        match self
            .send_bounded(
                runtime_url,
                Method::GET,
                "/api/providers",
                None,
                "application/json",
            )
            .await
        {
            Ok((status, _ct, body)) => {
                if let Ok(mut parsed) = serde_json::from_slice::<Value>(&body) {
                    if let Some(obj) = parsed.as_object_mut() {
                        obj.entry("ok")
                            .or_insert(json!((200..300).contains(&status)));
                        obj.entry("state")
                            .or_insert(json!(if (200..300).contains(&status) {
                                "online"
                            } else {
                                "unavailable"
                            }));
                        obj.insert("upstreamReachable".to_string(), json!(true));
                    }
                    return HttpResponse::json(status, SecretRedactor::redact_json(&parsed));
                }
                HttpResponse::json(
                    502,
                    json!({
                        "ok": false,
                        "state": "unavailable",
                        "code": "runtime_invalid_json",
                        "error": "runtime_invalid_json",
                        "message": "Upstream runtime /api/providers returned non-JSON payload.",
                        "providers": [],
                        "upstreamReachable": true,
                    }),
                )
            }
            Err(failure) => {
                let (code, detail, http_status) = failure_fields(&failure);
                HttpResponse::json(
                    http_status,
                    json!({
                        "ok": false,
                        "state": "unavailable",
                        "code": code,
                        "error": code,
                        "message": detail,
                        "upstreamReachable": false,
                        "providers": default_offline_providers(),
                    }),
                )
            }
        }
    }

    /// `GET /api/models`
    pub async fn handle_models(&self, runtime_url: Option<&str>) -> HttpResponse {
        match self
            .send_bounded(
                runtime_url,
                Method::GET,
                "/api/models",
                None,
                "application/json",
            )
            .await
        {
            Ok((status, content_type, body)) => {
                if let Ok(parsed) = serde_json::from_slice::<Value>(&body) {
                    return HttpResponse::json(status, SecretRedactor::redact_json(&parsed));
                }
                HttpResponse::bytes(status, &content_type, body)
            }
            Err(failure) => {
                let (code, detail, http_status) = failure_fields(&failure);
                HttpResponse::json(
                    http_status,
                    json!({
                        "ok": false,
                        "state": "unavailable",
                        "code": code,
                        "error": code,
                        "message": detail,
                        "data": [],
                        "models": [],
                    }),
                )
            }
        }
    }

    /// `POST /api/chat` and `POST /api/chat/completions`
    pub async fn handle_chat(&self, runtime_url: Option<&str>, req: &HttpRequest) -> HttpResponse {
        let Ok(mut payload) = serde_json::from_slice::<Value>(&req.body) else {
            return HttpResponse::error(400, "invalid_json", "Request body must be valid JSON.");
        };
        let Some(obj) = payload.as_object_mut() else {
            return HttpResponse::error(
                400,
                "invalid_json_object",
                "Chat payload must be a JSON object.",
            );
        };
        if let Some(model) = obj.get("model").and_then(Value::as_str) {
            if model.len() > ALLOWED_CHAT_MODEL_MAX_LEN {
                return HttpResponse::error(
                    400,
                    "invalid_model",
                    "Requested model exceeds max length.",
                );
            }
        }
        // Strip accidental client-supplied raw secrets before forwarding upstream.
        for key in ["apiKey", "api_key", "authorization", "token", "secret"] {
            obj.remove(key);
        }
        let Ok(serialized) = serde_json::to_vec(&payload) else {
            return HttpResponse::error(400, "invalid_json", "Failed to serialize chat payload.");
        };

        match self
            .send_bounded(
                runtime_url,
                Method::POST,
                "/api/chat",
                Some(&serialized),
                "application/json",
            )
            .await
        {
            Ok((status, content_type, body)) => {
                if content_type.contains("application/json") {
                    if let Ok(parsed) = serde_json::from_slice::<Value>(&body) {
                        return HttpResponse::json(status, SecretRedactor::redact_json(&parsed));
                    }
                }
                HttpResponse::bytes(status, &content_type, body)
            }
            Err(failure) => {
                let (code, detail, http_status) = failure_fields(&failure);
                HttpResponse::json(
                    http_status,
                    json!({
                        "ok": false,
                        "state": "unavailable",
                        "status": "UNAVAILABLE",
                        "code": code,
                        "error": code,
                        "message": detail,
                        "detail": detail,
                    }),
                )
            }
        }
    }

    /// `GET /api/hardware/nvidia`
    pub async fn handle_nvidia_hardware(
        &self,
        runtime_url: Option<&str>,
        req: &HttpRequest,
    ) -> HttpResponse {
        if !req.query.trim().is_empty() {
            return HttpResponse::json(
                400,
                nvidia_error_payload(
                    "error",
                    "nvidia_query_invalid",
                    "NVIDIA hardware probe does not accept query parameters.",
                ),
            );
        }

        match self
            .send_bounded(
                runtime_url,
                Method::GET,
                "/api/hardware/nvidia",
                None,
                "application/json",
            )
            .await
        {
            Ok((status, _ct, body)) => {
                if let Ok(parsed) = serde_json::from_slice::<Value>(&body) {
                    let normalized = normalize_nvidia_payload(&parsed);
                    return HttpResponse::json(status, normalized);
                }
                HttpResponse::json(
                    503,
                    nvidia_error_payload(
                        "error",
                        "nvidia_runtime_invalid_response",
                        "Upstream runtime returned malformed NVIDIA telemetry JSON.",
                    ),
                )
            }
            Err(failure) => {
                let (code, detail, http_status) = failure_fields(&failure);
                let error_code = if matches!(failure, ProxyFailure::Timeout(_)) {
                    "nvidia_runtime_timeout"
                } else if matches!(failure, ProxyFailure::Unconfigured(_)) {
                    "nvidia_runtime_unavailable"
                } else {
                    code
                };
                HttpResponse::json(
                    http_status,
                    nvidia_error_payload("unavailable", error_code, &detail),
                )
            }
        }
    }

    async fn send_bounded(
        &self,
        runtime_url: Option<&str>,
        method: Method,
        path: &str,
        body: Option<&[u8]>,
        accept: &str,
    ) -> Result<(u16, String, Vec<u8>), ProxyFailure> {
        let Some(raw_base) = runtime_url.map(str::trim).filter(|s| !s.is_empty()) else {
            return Err(ProxyFailure::Unconfigured(
                "omnia-runtime URL is not configured",
            ));
        };
        let base = validate_loopback_runtime_url(raw_base).map_err(ProxyFailure::InvalidConfig)?;
        let target = base
            .join(path.trim_start_matches('/'))
            .map_err(|err| ProxyFailure::InvalidConfig(err.to_string()))?;

        let timeout = self.timeout;
        let client = &self.client;

        let fut = async move {
            let mut req_builder = client.request(method, target).header("Accept", accept);
            if let Some(bytes) = body {
                req_builder = req_builder
                    .header("Content-Type", "application/json")
                    .body(bytes.to_vec());
            }
            let resp = req_builder
                .send()
                .await
                .map_err(|err| classify_reqwest_error(&err, timeout))?;

            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json; charset=utf-8")
                .to_string();

            let raw_bytes = resp
                .bytes()
                .await
                .map_err(|err| classify_reqwest_error(&err, timeout))?;
            if raw_bytes.len() > MAX_UPSTREAM_BODY_BYTES {
                return Err(ProxyFailure::Unreachable(format!(
                    "Upstream response exceeded {} byte limit.",
                    MAX_UPSTREAM_BODY_BYTES
                )));
            }
            Ok((status, content_type, raw_bytes.to_vec()))
        };

        match time::timeout(timeout, fut).await {
            Ok(inner) => inner,
            Err(_) => Err(ProxyFailure::Timeout(format!(
                "Upstream runtime request timed out after {} ms.",
                timeout.as_millis()
            ))),
        }
    }
}

fn classify_reqwest_error(err: &reqwest::Error, timeout: Duration) -> ProxyFailure {
    if err.is_timeout() {
        ProxyFailure::Timeout(format!(
            "Upstream runtime request timed out after {} ms.",
            timeout.as_millis()
        ))
    } else {
        ProxyFailure::Unreachable(format!("Upstream runtime request failed: {err}"))
    }
}

fn failure_fields(failure: &ProxyFailure) -> (&'static str, String, u16) {
    match failure {
        ProxyFailure::Unconfigured(msg) => ("runtime_not_configured", (*msg).to_string(), 503),
        ProxyFailure::Timeout(msg) => ("runtime_timeout", msg.clone(), 504),
        ProxyFailure::Unreachable(msg) => ("runtime_unreachable", msg.clone(), 503),
        ProxyFailure::InvalidConfig(msg) => ("runtime_invalid_config", msg.clone(), 503),
    }
}

fn unavailable_runtime_response(
    failure: &ProxyFailure,
    runtime_url: Option<&str>,
    timeout_ms: u64,
) -> HttpResponse {
    let (code, detail, http_status) = failure_fields(failure);
    HttpResponse::json(
        http_status,
        json!({
            "ok": false,
            "state": "unavailable",
            "code": code,
            "error": code,
            "message": detail,
            "runtimeUrl": runtime_url,
            "timeoutMs": timeout_ms,
        }),
    )
}

fn nvidia_error_payload(state: &str, code: &str, detail: &str) -> Value {
    json!({
        "ok": false,
        "schema": "omnia.hardware.nvidia.v1",
        "state": state,
        "backend": "nvidia-smi",
        "observedAtUnixMs": now_epoch_ms().max(0),
        "evidenceScope": "device_query_only",
        "workloads": {
            "cuda": "unverified",
            "tensorrt": "unverified",
            "nvenc": "unverified",
        },
        "error": code,
        "detail": detail,
        "gpus": [],
    })
}

fn normalize_nvidia_payload(raw: &Value) -> Value {
    let raw_state = raw
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    let state = match raw_state {
        "ready" | "unavailable" | "error" => raw_state,
        _ => "error",
    };
    let gpus = raw
        .get("gpus")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let observed = raw
        .get("observedAtUnixMs")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| now_epoch_ms().max(0));
    let mut obj = serde_json::Map::new();
    obj.insert("ok".to_string(), json!(state == "ready"));
    obj.insert("schema".to_string(), json!("omnia.hardware.nvidia.v1"));
    obj.insert("state".to_string(), json!(state));
    obj.insert("backend".to_string(), json!("nvidia-smi"));
    obj.insert("observedAtUnixMs".to_string(), json!(observed));
    obj.insert("evidenceScope".to_string(), json!("device_query_only"));
    obj.insert(
        "workloads".to_string(),
        json!({
            "cuda": raw.get("workloads").and_then(|w| w.get("cuda")).and_then(Value::as_str).unwrap_or("unverified"),
            "tensorrt": raw.get("workloads").and_then(|w| w.get("tensorrt")).and_then(Value::as_str).unwrap_or("unverified"),
            "nvenc": raw.get("workloads").and_then(|w| w.get("nvenc")).and_then(Value::as_str).unwrap_or("unverified"),
        }),
    );
    if let Some(err) = raw.get("error").and_then(Value::as_str) {
        obj.insert("error".to_string(), json!(err));
    }
    if let Some(detail) = raw.get("detail").and_then(Value::as_str) {
        obj.insert("detail".to_string(), json!(detail));
    }
    obj.insert("gpus".to_string(), Value::Array(gpus));
    Value::Object(obj)
}

fn default_offline_providers() -> Value {
    json!([
        {
            "id": "htmustc",
            "classification": "remote_proxy",
            "configured": false,
            "available": false,
        },
        {
            "id": "nvidia_nim",
            "classification": "remote_cloud",
            "configured": false,
            "available": false,
        },
        {
            "id": "ollama_local",
            "classification": "local_daemon",
            "configured": false,
            "available": false,
        },
    ])
}
