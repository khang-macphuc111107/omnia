//! Steer #23 Studio v5 routes: Parallel Multi-Model AI Studio & Arena (`/api/v5/arena/*`),
//! Omnia Gems/Personas CRUD & Pre-Send Estimator (`/api/v5/studio/*`), ChatGPT-style Session
//! Branches & Fork (`/api/v5/sessions/{id}/{branches,fork}`), and Perplexity-Pro Answer Engine
//! (`/api/v5/research/answer`).
//!
//! Zero-4xx Mount Invariant: `GET /api/v5/arena/leaderboard`, `GET /api/v5/studio/personas`,
//! and `GET /api/v5/sessions/{id}/branches` always return HTTP `200 OK` (with `[]` when empty).
//! Honest Provider Invariant: missing provider API keys return an explicit `unconfigured_provider`
//! diagnostic card — NEVER fabricated model completions.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use omnia_agent::web_tools::{web_search_multi, WebSearchOptions, WebSearchScope};
use omnia_agent::{read_models_config, resolve_model_endpoint, ResolvedModelEndpoint, WireApiMode};
use omnia_core::{now_epoch_ms, uuid_v4, SecretRedactor};
use omnia_harness::research_vault::{ResearchSourceRecord, VaultTier};
use omnia_storage::is_valid_studio_session_id;
use reqwest::Client;
use serde_json::{json, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::ops_store::{
    ArenaRunInput, ArenaVoteInput, ChatBranchInput, StudioPersonaInput,
};
use crate::routes_legacy::StudioState;

const ARENA_MODEL_TIMEOUT: Duration = Duration::from_secs(45);
const RESEARCH_WEB_TIMEOUT: Duration = Duration::from_secs(8);
const RESEARCH_FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_ARENA_MODELS: usize = 4;

/// Returns `true` if `path` belongs to the Steer #23 Arena / Studio / Branches / Research Answer surface.
#[must_use]
pub fn is_known_route(path: &str) -> bool {
    if matches!(
        path,
        "/api/v5/arena/compare"
            | "/api/v5/arena/vote"
            | "/api/v5/arena/leaderboard"
            | "/api/v5/arena/runs"
            | "/api/v5/studio/personas"
            | "/api/v5/studio/personas/delete"
            | "/api/v5/studio/estimate"
            | "/api/v5/research/answer"
    ) {
        return true;
    }
    if parse_persona_delete_id(path).is_some() {
        return true;
    }
    parse_session_v5_subroute(path).is_some()
}

/// Dispatches all Steer #23 endpoints.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if !is_known_route(req.path.as_str()) {
        return None;
    }

    if let Some(persona_id) = parse_persona_delete_id(req.path.as_str()) {
        return match req.method.as_str() {
            "DELETE" => Some(handle_personas_delete_by_id(state, &persona_id)),
            "GET" => Some(handle_persona_get(state, &persona_id)),
            _ => Some(HttpResponse::error(
                405,
                "method_not_allowed",
                "HTTP method not allowed for persona route.",
            )),
        };
    }

    if let Some((session_id, action)) = parse_session_v5_subroute(req.path.as_str()) {
        return match (req.method.as_str(), action) {
            ("GET", "branches") => Some(handle_session_branches_get(state, &session_id, req)),
            ("POST", "branches") => Some(handle_session_branches_post(state, &session_id, req)),
            ("POST", "fork") => Some(handle_session_fork_post(state, &session_id, req)),
            _ => Some(HttpResponse::error(
                405,
                "method_not_allowed",
                "HTTP method not allowed for session branch/fork route.",
            )),
        };
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/v5/arena/compare") => Some(handle_arena_compare(state, req).await),
        ("POST", "/api/v5/arena/vote") => Some(handle_arena_vote(state, req)),
        ("GET", "/api/v5/arena/leaderboard") => Some(handle_arena_leaderboard(state)),
        ("GET", "/api/v5/arena/runs") => Some(handle_arena_runs(state, req)),

        ("GET", "/api/v5/studio/personas") => Some(handle_personas_list(state)),
        ("POST", "/api/v5/studio/personas") => Some(handle_personas_upsert(state, req)),
        ("DELETE", "/api/v5/studio/personas") | ("POST", "/api/v5/studio/personas/delete") => {
            Some(handle_personas_delete(state, req))
        }
        ("POST", "/api/v5/studio/estimate") => Some(handle_studio_estimate(req)),

        ("POST", "/api/v5/research/answer") => Some(handle_research_answer(state, req).await),

        _ => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for Steer #23 Studio/Arena route.",
        )),
    }
}

fn parse_persona_delete_id(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/v5/studio/personas/")?;
    if rest.is_empty() || rest == "delete" || rest.contains('/') {
        return None;
    }
    Some(percent_decode_lossy(rest))
}

fn parse_session_v5_subroute(path: &str) -> Option<(String, &'static str)> {
    let rest = path.strip_prefix("/api/v5/sessions/")?;
    let (raw_id, tail) = rest.split_once('/')?;
    if raw_id.is_empty() || tail.contains('/') {
        return None;
    }
    let action = match tail {
        "branches" => "branches",
        "fork" => "fork",
        _ => return None,
    };
    Some((percent_decode_lossy(raw_id), action))
}

fn percent_decode_lossy(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_obj(req: &HttpRequest) -> Result<serde_json::Map<String, Value>, HttpResponse> {
    if req.body.is_empty() {
        return Ok(serde_json::Map::new());
    }
    req.json_object()
}

fn str_field<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = obj
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(s);
        }
    }
    None
}

fn str_vec_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = obj.get(*k).and_then(Value::as_array) {
            return arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect();
        }
    }
    Vec::new()
}

fn round_usd_6(v: f64) -> f64 {
    if !v.is_finite() || v <= 0.0 {
        0.0
    } else {
        (v * 1_000_000.0).round() / 1_000_000.0
    }
}

fn round_2(v: f64) -> f64 {
    if !v.is_finite() {
        0.0
    } else {
        (v * 100.0).round() / 100.0
    }
}

fn estimate_tokens_from_text(text: &str) -> u64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let char_est = (trimmed.chars().count() as u64).div_ceil(4);
    let word_est = ((trimmed.split_whitespace().count() as u64) * 4).div_ceil(3);
    char_est.max(word_est).max(1)
}

/// Reference pricing ($ per 1M input / output tokens) when `models.yml` omits cost fields.
fn fallback_model_pricing_per_m(model_id: &str) -> (f64, f64) {
    let lower = model_id.to_ascii_lowercase();
    if lower.contains("opus") {
        (15.0, 75.0)
    } else if lower.contains("sonnet") || lower.contains("fable") {
        (3.0, 15.0)
    } else if lower.contains("haiku") {
        (0.8, 4.0)
    } else if lower.contains("gpt-6") || lower.contains("gpt-5") || lower.contains("codex") {
        (2.5, 10.0)
    } else if lower.contains("o3") || lower.contains("o1") || lower.contains("o4") {
        (10.0, 40.0)
    } else if lower.contains("gemini") && lower.contains("flash") {
        (0.35, 1.05)
    } else if lower.contains("gemini") {
        (1.25, 5.0)
    } else if lower.contains("deepseek")
        || lower.contains("qwen")
        || lower.contains("glm")
        || lower.contains("kimi")
    {
        (0.55, 2.2)
    } else {
        (2.0, 8.0)
    }
}

fn effective_model_pricing_per_m(model_spec: &str, ep: Option<&ResolvedModelEndpoint>) -> (f64, f64) {
    if let Some(e) = ep {
        if e.cost_input_per_m > 0.0 || e.cost_output_per_m > 0.0 {
            return (e.cost_input_per_m.max(0.0), e.cost_output_per_m.max(0.0));
        }
    }
    fallback_model_pricing_per_m(model_spec)
}

fn compute_cost_usd_6(
    input_tokens: u64,
    output_tokens: u64,
    in_per_m: f64,
    out_per_m: f64,
) -> f64 {
    let in_cost = (input_tokens as f64 / 1_000_000.0) * in_per_m;
    let out_cost = (output_tokens as f64 / 1_000_000.0) * out_per_m;
    round_usd_6(in_cost + out_cost)
}

/// Parses an optional JSON Schema supplied either as a JSON object or a JSON string.
fn parse_optional_json_schema(
    obj: &serde_json::Map<String, Value>,
) -> (bool, Option<Value>, Option<String>) {
    let Some(raw) = obj
        .get("jsonSchema")
        .or_else(|| obj.get("json_schema"))
        .filter(|v| !v.is_null())
    else {
        return (false, None, None);
    };
    let parsed = match raw {
        Value::Object(_) => raw.clone(),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return (false, None, None);
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(v) if v.is_object() => v,
                Ok(_) => {
                    return (
                        true,
                        None,
                        Some("JSON Schema root must be a JSON object.".to_string()),
                    );
                }
                Err(e) => {
                    return (true, None, Some(format!("Invalid JSON Schema syntax: {e}")));
                }
            }
        }
        _ => {
            return (
                true,
                None,
                Some("Field 'jsonSchema' must be a JSON object or JSON string.".to_string()),
            );
        }
    };

    if let Some(t) = parsed.get("type").and_then(Value::as_str) {
        if !matches!(
            t,
            "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
        ) {
            return (
                true,
                None,
                Some(format!("Unsupported JSON Schema root type '{t}'.")),
            );
        }
    }
    (true, Some(parsed), None)
}

/// Strips optional ```json ... ``` markdown fences and validates a model output against a JSON Schema.
fn validate_output_against_schema(text: &str, schema: &Value) -> Value {
    let candidate = extract_json_payload(text);
    let parsed = match serde_json::from_str::<Value>(candidate) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "valid": false,
                "errors": [format!("Output is not valid JSON: {e}")],
            });
        }
    };

    let mut errors = Vec::new();
    if let Some(expected_type) = schema.get("type").and_then(Value::as_str) {
        let type_ok = match expected_type {
            "object" => parsed.is_object(),
            "array" => parsed.is_array(),
            "string" => parsed.is_string(),
            "number" => parsed.is_number(),
            "integer" => parsed.is_i64() || parsed.is_u64(),
            "boolean" => parsed.is_boolean(),
            "null" => parsed.is_null(),
            _ => true,
        };
        if !type_ok {
            errors.push(format!("Expected root JSON type '{expected_type}'."));
        }
    }

    if let (Some(obj), Some(req_arr)) = (
        parsed.as_object(),
        schema.get("required").and_then(Value::as_array),
    ) {
        for req_key in req_arr.iter().filter_map(Value::as_str) {
            if !obj.contains_key(req_key) {
                errors.push(format!("Missing required property '{req_key}'."));
            }
        }
    }

    if let (Some(obj), Some(props)) = (
        parsed.as_object(),
        schema.get("properties").and_then(Value::as_object),
    ) {
        for (prop_name, prop_schema) in props {
            if let Some(val) = obj.get(prop_name) {
                if let Some(pt) = prop_schema.get("type").and_then(Value::as_str) {
                    let ok = match pt {
                        "object" => val.is_object(),
                        "array" => val.is_array(),
                        "string" => val.is_string(),
                        "number" => val.is_number(),
                        "integer" => val.is_i64() || val.is_u64(),
                        "boolean" => val.is_boolean(),
                        "null" => val.is_null(),
                        _ => true,
                    };
                    if !ok {
                        errors.push(format!("Property '{prop_name}' expected type '{pt}'."));
                    }
                }
            }
        }
    }

    json!({
        "valid": errors.is_empty(),
        "errors": errors,
    })
}

fn extract_json_payload(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let after_lang = rest.find('\n').map_or(rest, |idx| &rest[idx + 1..]);
        if let Some(end) = after_lang.rfind("```") {
            return after_lang[..end].trim();
        }
    }
    trimmed
}

// =========================================================================
// 1. Live Multi-Model Parallel Arena (`/api/v5/arena/{compare,vote,leaderboard,runs}`)
// =========================================================================

#[derive(Clone)]
struct ArenaCallParams {
    prompt: String,
    system_prompt: String,
    effort: String,
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: u64,
    stop_sequences: Vec<String>,
    json_schema: Option<Value>,
    live: bool,
}

fn is_loopback_endpoint(base_url: &str) -> bool {
    let low = base_url.trim().to_ascii_lowercase();
    low.starts_with("http://127.0.0.1")
        || low.starts_with("http://localhost")
        || low.starts_with("http://[::1]")
}

fn normalize_api_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn join_endpoint_path(base: &str, suffix: &str) -> String {
    let clean = normalize_api_base(base);
    let suf = suffix.trim_start_matches('/');
    if let Some(rest) = suf.strip_prefix("v1/").filter(|_| clean.ends_with("/v1")) {
        return format!("{clean}/{rest}");
    }
    if let Some(rest) = suf
        .strip_prefix("v1beta/")
        .filter(|_| clean.ends_with("/v1beta"))
    {
        return format!("{clean}/{rest}");
    }
    format!("{clean}/{suf}")
}

async fn run_single_arena_model(
    client: Client,
    model_spec: String,
    params: ArenaCallParams,
) -> Value {
    let est_in = estimate_tokens_from_text(&params.prompt)
        .saturating_add(estimate_tokens_from_text(&params.system_prompt));

    let ep_opt = resolve_model_endpoint(&model_spec, None, None, None).ok();
    let (in_per_m, out_per_m) = effective_model_pricing_per_m(&model_spec, ep_opt.as_ref());

    let Some(ep) = ep_opt else {
        let est_cost = compute_cost_usd_6(est_in, 512, in_per_m, out_per_m);
        return json!({
            "model": model_spec,
            "modelId": model_spec,
            "providerId": "unconfigured",
            "wireApi": "none",
            "status": "unconfigured_provider",
            "ok": false,
            "text": "",
            "error": format!(
                "Model '{model_spec}' is not configured in models.yml and has no provider API key. Configure a provider credential to run live parallel comparisons."
            ),
            "ttftMs": 0,
            "totalMs": 0,
            "tokensPerSecond": 0.0,
            "tps": 0.0,
            "inputTokens": est_in,
            "outputTokens": 0,
            "cachedTokens": 0,
            "costUsd": 0.0,
            "estimatedCostUsd": est_cost,
        });
    };

    let wire_api = WireApiMode::Auto
        .resolve_api_kind(&ep.model_id, &ep.api)
        .to_string();
    let has_key = !ep.api_key.trim().is_empty();
    let can_call_without_key = !ep.auth_header || is_loopback_endpoint(&ep.base_url);

    if !params.live {
        let est_out = params.max_tokens.min(1024);
        let est_cost = compute_cost_usd_6(est_in, est_out, in_per_m, out_per_m);
        return json!({
            "model": model_spec,
            "modelId": ep.model_id,
            "providerId": ep.provider_id,
            "wireApi": wire_api,
            "status": "offline_estimate",
            "ok": false,
            "text": "",
            "error": "Dry-run estimate mode (`live: false`); no remote inference request was sent.",
            "ttftMs": 0,
            "totalMs": 0,
            "tokensPerSecond": 0.0,
            "tps": 0.0,
            "inputTokens": est_in,
            "outputTokens": 0,
            "cachedTokens": 0,
            "costUsd": 0.0,
            "estimatedCostUsd": est_cost,
        });
    }

    if ep.base_url.trim().is_empty() || (!has_key && !can_call_without_key) {
        let est_cost = compute_cost_usd_6(est_in, 512, in_per_m, out_per_m);
        return json!({
            "model": model_spec,
            "modelId": ep.model_id,
            "providerId": ep.provider_id,
            "wireApi": wire_api,
            "status": "unconfigured_provider",
            "ok": false,
            "text": "",
            "error": format!(
                "Provider '{}' has no API key configured for '{}'. Add a credential in Settings -> Credentials or environment variables.",
                ep.provider_id, ep.model_id
            ),
            "ttftMs": 0,
            "totalMs": 0,
            "tokensPerSecond": 0.0,
            "tps": 0.0,
            "inputTokens": est_in,
            "outputTokens": 0,
            "cachedTokens": 0,
            "costUsd": 0.0,
            "estimatedCostUsd": est_cost,
        });
    }

    let started = Instant::now();
    let call_res = execute_live_arena_call(&client, &ep, &wire_api, &params).await;
    let total_ms = started.elapsed().as_millis() as u64;

    match call_res {
        Ok(outcome) => {
            let safe_text = SecretRedactor::redact(&outcome.text);
            let safe_thinking = outcome
                .thinking_text
                .as_deref()
                .map(SecretRedactor::redact);
            let in_tok = if outcome.input_tokens > 0 {
                outcome.input_tokens
            } else {
                est_in
            };
            let out_tok = if outcome.output_tokens > 0 {
                outcome.output_tokens
            } else {
                estimate_tokens_from_text(&safe_text)
            };
            let secs = (total_ms as f64 / 1000.0).max(0.001);
            let tps = round_2(out_tok as f64 / secs);
            let cost_usd = compute_cost_usd_6(in_tok, out_tok, in_per_m, out_per_m);
            let schema_validation = params
                .json_schema
                .as_ref()
                .map(|s| validate_output_against_schema(&safe_text, s));

            json!({
                "model": model_spec,
                "modelId": ep.model_id,
                "providerId": ep.provider_id,
                "wireApi": wire_api,
                "status": "ok",
                "ok": true,
                "text": safe_text,
                "thinkingText": safe_thinking,
                "error": Value::Null,
                "ttftMs": outcome.ttft_ms,
                "totalMs": total_ms,
                "tokensPerSecond": tps,
                "tps": tps,
                "inputTokens": in_tok,
                "outputTokens": out_tok,
                "cachedTokens": outcome.cached_tokens,
                "costUsd": cost_usd,
                "schemaValidation": schema_validation,
            })
        }
        Err(err) => {
            let safe_err = SecretRedactor::redact(&err);
            json!({
                "model": model_spec,
                "modelId": ep.model_id,
                "providerId": ep.provider_id,
                "wireApi": wire_api,
                "status": "error",
                "ok": false,
                "text": "",
                "error": safe_err,
                "ttftMs": total_ms,
                "totalMs": total_ms,
                "tokensPerSecond": 0.0,
                "tps": 0.0,
                "inputTokens": est_in,
                "outputTokens": 0,
                "cachedTokens": 0,
                "costUsd": 0.0,
            })
        }
    }
}

struct LiveCallOutcome {
    text: String,
    thinking_text: Option<String>,
    ttft_ms: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
}

async fn execute_live_arena_call(
    client: &Client,
    ep: &ResolvedModelEndpoint,
    wire_api: &str,
    params: &ArenaCallParams,
) -> Result<LiveCallOutcome, String> {
    let started = Instant::now();
    let max_tokens = params.max_tokens.clamp(64, 65_536);
    let schema_instruction = params.json_schema.as_ref().map(|schema| {
        format!(
            "\n\nRespond strictly with valid JSON matching this JSON Schema:\n{}",
            serde_json::to_string_pretty(schema).unwrap_or_else(|_| "{}".to_string())
        )
    });
    let effective_system = match (params.system_prompt.trim().is_empty(), schema_instruction) {
        (true, None) => String::new(),
        (false, None) => params.system_prompt.trim().to_string(),
        (true, Some(s)) => s.trim().to_string(),
        (false, Some(s)) => format!("{}{s}", params.system_prompt.trim()),
    };

    let (req_builder, dialect) = match wire_api {
        "anthropic-messages" => {
            let url = join_endpoint_path(&ep.base_url, "v1/messages");
            let mut body = json!({
                "model": ep.model_id,
                "max_tokens": max_tokens,
                "messages": [{ "role": "user", "content": params.prompt }],
            });
            if !effective_system.is_empty() {
                body["system"] = json!(effective_system);
            }
            if let Some(t) = params.temperature {
                body["temperature"] = json!(t.clamp(0.0, 1.0));
            }
            if let Some(tp) = params.top_p {
                body["top_p"] = json!(tp.clamp(0.0, 1.0));
            }
            if !params.stop_sequences.is_empty() {
                body["stop_sequences"] = json!(params.stop_sequences);
            }
            let mut rb = client
                .post(url)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body);
            if !ep.api_key.trim().is_empty() {
                rb = rb.header("x-api-key", ep.api_key.trim());
            }
            (rb, "anthropic")
        }
        "openai-responses" => {
            let url = join_endpoint_path(&ep.base_url, "v1/responses");
            let mut body = json!({
                "model": ep.model_id,
                "input": params.prompt,
                "max_output_tokens": max_tokens,
                "store": false,
            });
            if !effective_system.is_empty() {
                body["instructions"] = json!(effective_system);
            }
            if let Some(t) = params.temperature {
                body["temperature"] = json!(t.clamp(0.0, 2.0));
            }
            if let Some(tp) = params.top_p {
                body["top_p"] = json!(tp.clamp(0.0, 1.0));
            }
            if matches!(
                params.effort.as_str(),
                "low" | "medium" | "high" | "xhigh" | "max"
            ) {
                let eff = if params.effort == "max" {
                    "xhigh"
                } else {
                    params.effort.as_str()
                };
                body["reasoning"] = json!({ "effort": eff });
            }
            let mut rb = client
                .post(url)
                .header("content-type", "application/json")
                .json(&body);
            if ep.auth_header && !ep.api_key.trim().is_empty() {
                rb = rb.bearer_auth(ep.api_key.trim());
            }
            (rb, "responses")
        }
        "google-gemini" => {
            let base = normalize_api_base(&ep.base_url);
            let url = format!(
                "{}/models/{}:generateContent",
                base,
                ep.model_id.trim()
            );
            let mut gen_cfg = json!({
                "maxOutputTokens": max_tokens,
            });
            if let Some(t) = params.temperature {
                gen_cfg["temperature"] = json!(t.clamp(0.0, 2.0));
            }
            if let Some(tp) = params.top_p {
                gen_cfg["topP"] = json!(tp.clamp(0.0, 1.0));
            }
            if !params.stop_sequences.is_empty() {
                gen_cfg["stopSequences"] = json!(params.stop_sequences);
            }
            if params.json_schema.is_some() {
                gen_cfg["responseMimeType"] = json!("application/json");
            }
            let mut body = json!({
                "contents": [{ "role": "user", "parts": [{ "text": params.prompt }] }],
                "generationConfig": gen_cfg,
            });
            if !effective_system.is_empty() {
                body["systemInstruction"] =
                    json!({ "parts": [{ "text": effective_system }] });
            }
            let mut rb = client
                .post(url)
                .header("content-type", "application/json")
                .json(&body);
            if !ep.api_key.trim().is_empty() {
                rb = rb.header("x-goog-api-key", ep.api_key.trim());
            }
            (rb, "gemini")
        }
        _ => {
            let url = join_endpoint_path(&ep.base_url, "v1/chat/completions");
            let mut messages = Vec::new();
            if !effective_system.is_empty() {
                messages.push(json!({ "role": "system", "content": effective_system }));
            }
            messages.push(json!({ "role": "user", "content": params.prompt }));
            let mut body = json!({
                "model": ep.model_id,
                "messages": messages,
                "max_tokens": max_tokens,
            });
            if let Some(t) = params.temperature {
                body["temperature"] = json!(t.clamp(0.0, 2.0));
            }
            if let Some(tp) = params.top_p {
                body["top_p"] = json!(tp.clamp(0.0, 1.0));
            }
            if !params.stop_sequences.is_empty() {
                body["stop"] = json!(params.stop_sequences);
            }
            if params.json_schema.is_some() {
                body["response_format"] = json!({ "type": "json_object" });
            }
            let mut rb = client
                .post(url)
                .header("content-type", "application/json")
                .json(&body);
            if ep.auth_header && !ep.api_key.trim().is_empty() {
                rb = rb.bearer_auth(ep.api_key.trim());
            }
            (rb, "chat")
        }
    };

    let resp = tokio::time::timeout(ARENA_MODEL_TIMEOUT, req_builder.send())
        .await
        .map_err(|_| format!("Request timed out after {}s", ARENA_MODEL_TIMEOUT.as_secs()))?
        .map_err(|e| format!("HTTP transport error: {e}"))?;

    let ttft_ms = started.elapsed().as_millis() as u64;
    let status = resp.status();
    let bytes = tokio::time::timeout(ARENA_MODEL_TIMEOUT, resp.bytes())
        .await
        .map_err(|_| "Response body read timed out".to_string())?
        .map_err(|e| format!("Response read error: {e}"))?;

    if !status.is_success() {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(320)]);
        return Err(format!("Upstream HTTP {}: {}", status.as_u16(), preview));
    }

    let parsed: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Upstream returned non-JSON body: {e}"))?;

    Ok(extract_dialect_outcome(dialect, &parsed, ttft_ms))
}

fn extract_dialect_outcome(dialect: &str, parsed: &Value, ttft_ms: u64) -> LiveCallOutcome {
    match dialect {
        "anthropic" => {
            let mut text_parts = Vec::new();
            let mut think_parts = Vec::new();
            if let Some(blocks) = parsed.get("content").and_then(Value::as_array) {
                for blk in blocks {
                    match blk.get("type").and_then(Value::as_str) {
                        Some("thinking") => {
                            if let Some(t) = blk.get("thinking").and_then(Value::as_str) {
                                think_parts.push(t.to_string());
                            }
                        }
                        Some("text") => {
                            if let Some(t) = blk.get("text").and_then(Value::as_str) {
                                text_parts.push(t.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            let usage = parsed.get("usage");
            LiveCallOutcome {
                text: text_parts.join("\n"),
                thinking_text: if think_parts.is_empty() {
                    None
                } else {
                    Some(think_parts.join("\n"))
                },
                ttft_ms,
                input_tokens: usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cached_tokens: usage
                    .and_then(|u| u.get("cache_read_input_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            }
        }
        "responses" => {
            let mut text = parsed
                .get("output_text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut think_parts = Vec::new();
            if let Some(outputs) = parsed.get("output").and_then(Value::as_array) {
                for item in outputs {
                    if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                        if let Some(summaries) = item.get("summary").and_then(Value::as_array) {
                            for s in summaries {
                                if let Some(t) = s.get("text").and_then(Value::as_str) {
                                    think_parts.push(t.to_string());
                                }
                            }
                        }
                    } else if text.is_empty() {
                        if let Some(content) = item.get("content").and_then(Value::as_array) {
                            for c in content {
                                if let Some(t) = c.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(t);
                                }
                            }
                        }
                    }
                }
            }
            let usage = parsed.get("usage");
            LiveCallOutcome {
                text,
                thinking_text: if think_parts.is_empty() {
                    None
                } else {
                    Some(think_parts.join("\n"))
                },
                ttft_ms,
                input_tokens: usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cached_tokens: usage
                    .and_then(|u| u.get("input_tokens_details"))
                    .and_then(|d| d.get("cached_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            }
        }
        "gemini" => {
            let mut text_parts = Vec::new();
            if let Some(cands) = parsed.get("candidates").and_then(Value::as_array) {
                if let Some(parts) = cands
                    .first()
                    .and_then(|c| c.get("content"))
                    .and_then(|c| c.get("parts"))
                    .and_then(Value::as_array)
                {
                    for p in parts {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            text_parts.push(t.to_string());
                        }
                    }
                }
            }
            let usage = parsed.get("usageMetadata");
            LiveCallOutcome {
                text: text_parts.join("\n"),
                thinking_text: None,
                ttft_ms,
                input_tokens: usage
                    .and_then(|u| u.get("promptTokenCount"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .and_then(|u| u.get("candidatesTokenCount"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cached_tokens: usage
                    .and_then(|u| u.get("cachedContentTokenCount"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            }
        }
        _ => {
            let msg = parsed
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("message"));
            let text = msg
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let thinking = msg
                .and_then(|m| {
                    m.get("reasoning_content")
                        .or_else(|| m.get("reasoning"))
                        .and_then(Value::as_str)
                })
                .filter(|s| !s.trim().is_empty())
                .map(ToString::to_string);
            let usage = parsed.get("usage");
            LiveCallOutcome {
                text,
                thinking_text: thinking,
                ttft_ms,
                input_tokens: usage
                    .and_then(|u| u.get("prompt_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .and_then(|u| u.get("completion_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cached_tokens: usage
                    .and_then(|u| u.get("prompt_tokens_details"))
                    .and_then(|d| d.get("cached_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            }
        }
    }
}

async fn handle_arena_compare(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(prompt) = str_field(&obj, &["prompt", "query", "input"]) else {
        return HttpResponse::error(400, "missing_prompt", "Field 'prompt' is required.");
    };
    let system_prompt = str_field(&obj, &["systemPrompt", "system_prompt", "system"])
        .unwrap_or("")
        .to_string();

    let mut models = str_vec_field(&obj, &["models"]);
    if models.is_empty() {
        models = vec![
            "claude-sonnet-5-5".to_string(),
            "gpt-6.2-sol".to_string(),
        ];
    }
    let mut dedup_models = Vec::new();
    let mut seen = BTreeSet::new();
    for m in models {
        if seen.insert(m.clone()) {
            dedup_models.push(m);
        }
        if dedup_models.len() >= MAX_ARENA_MODELS {
            break;
        }
    }

    let (schema_provided, json_schema, schema_err) = parse_optional_json_schema(&obj);
    if schema_provided {
        if let Some(err) = schema_err {
            return HttpResponse::error(400, "invalid_json_schema", &err);
        }
    }

    let effort = str_field(&obj, &["effort", "reasoningEffort"])
        .unwrap_or("max")
        .to_ascii_lowercase();
    let temperature = obj.get("temperature").and_then(Value::as_f64);
    let top_p = obj
        .get("topP")
        .or_else(|| obj.get("top_p"))
        .and_then(Value::as_f64);
    let max_tokens = obj
        .get("maxTokens")
        .or_else(|| obj.get("max_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(2048)
        .clamp(64, 65_536);
    let stop_sequences = str_vec_field(&obj, &["stopSequences", "stop_sequences", "stop"]);
    let live = obj.get("live").and_then(Value::as_bool).unwrap_or(true);

    let call_params = ArenaCallParams {
        prompt: prompt.to_string(),
        system_prompt: system_prompt.clone(),
        effort: effort.clone(),
        temperature,
        top_p,
        max_tokens,
        stop_sequences: stop_sequences.clone(),
        json_schema: json_schema.clone(),
        live,
    };

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(ARENA_MODEL_TIMEOUT)
        .build()
        .unwrap_or_else(|_| Client::new());

    let futs = dedup_models
        .iter()
        .map(|m| run_single_arena_model(client.clone(), m.clone(), call_params.clone()));
    let results: Vec<Value> = join_all(futs).await;

    let params_json = json!({
        "effort": effort,
        "temperature": temperature,
        "topP": top_p,
        "maxTokens": max_tokens,
        "stopSequences": stop_sequences,
        "hasJsonSchema": json_schema.is_some(),
        "live": live,
    });

    let run_id = format!("arn_{}", uuid_v4());
    let saved = state.ops.save_arena_run(&ArenaRunInput {
        run_id: Some(run_id.clone()),
        prompt: prompt.to_string(),
        system_prompt,
        models: dedup_models.clone(),
        params: params_json.clone(),
        outputs: Value::Array(results.clone()),
    });
    let effective_run_id = saved.map(|r| r.run_id).unwrap_or(run_id);
    let leaderboard = state.ops.list_arena_leaderboard().unwrap_or_default();

    state.event_feed.publish(
        "arena",
        "arena_compare_completed",
        Some(&effective_run_id),
        json!({
            "runId": effective_run_id,
            "models": dedup_models,
            "count": results.len(),
        }),
    );

    HttpResponse::ok(SecretRedactor::redact_json(&json!({
        "ok": true,
        "state": "online",
        "runId": effective_run_id,
        "prompt": SecretRedactor::redact(prompt),
        "models": dedup_models,
        "params": params_json,
        "results": results,
        "outputs": results,
        "leaderboard": leaderboard,
    })))
}

fn handle_arena_vote(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let run_id = str_field(&obj, &["runId", "run_id"]).unwrap_or("").to_string();
    let note = str_field(&obj, &["note", "notes"]).map(ToString::to_string);
    let model_a = str_field(&obj, &["modelA", "model_a"]).map(ToString::to_string);
    let model_b = str_field(&obj, &["modelB", "model_b"]).map(ToString::to_string);
    let mut is_tie = obj
        .get("isTie")
        .or_else(|| obj.get("is_tie"))
        .or_else(|| obj.get("tie"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let explicit_winner = str_field(&obj, &["winnerModel", "winner_model", "winner"]);
    let mut loser_models = str_vec_field(&obj, &["loserModels", "loser_models"]);
    if loser_models.is_empty() {
        if let Some(lm) = str_field(&obj, &["loserModel", "loser_model"]) {
            loser_models.push(lm.to_string());
        }
    }

    let winner_model = match explicit_winner {
        Some(w) if w.eq_ignore_ascii_case("tie") => {
            is_tie = true;
            if let Some(ref b) = model_b {
                if !loser_models.contains(b) {
                    loser_models.push(b.clone());
                }
            }
            model_a
                .clone()
                .or_else(|| str_vec_field(&obj, &["models"]).into_iter().next())
                .unwrap_or_default()
        }
        Some(w) if w.eq_ignore_ascii_case("a") => {
            if let Some(ref b) = model_b {
                if !loser_models.contains(b) {
                    loser_models.push(b.clone());
                }
            }
            model_a.clone().unwrap_or_default()
        }
        Some(w) if w.eq_ignore_ascii_case("b") => {
            if let Some(ref a) = model_a {
                if !loser_models.contains(a) {
                    loser_models.push(a.clone());
                }
            }
            model_b.clone().unwrap_or_default()
        }
        Some(w) => {
            for candidate in [model_a.as_ref(), model_b.as_ref()].into_iter().flatten() {
                if candidate != w && !loser_models.contains(candidate) {
                    loser_models.push(candidate.clone());
                }
            }
            for m in str_vec_field(&obj, &["models"]) {
                if m != w && !loser_models.contains(&m) {
                    loser_models.push(m);
                }
            }
            w.to_string()
        }
        None => String::new(),
    };

    if loser_models.is_empty() && !run_id.is_empty() {
        if let Ok(Some(run)) = state.ops.get_arena_run(&run_id) {
            for m in run.models {
                if m != winner_model && !loser_models.contains(&m) {
                    loser_models.push(m);
                }
            }
        }
    }

    if winner_model.is_empty() {
        return HttpResponse::error(
            400,
            "missing_winner",
            "Field 'winner' or 'winnerModel' is required.",
        );
    }

    match state.ops.record_arena_vote(&ArenaVoteInput {
        run_id,
        winner_model: winner_model.clone(),
        loser_models,
        is_tie,
        note,
    }) {
        Ok(vote) => {
            let leaderboard = state.ops.list_arena_leaderboard().unwrap_or_default();
            state.event_feed.publish(
                "arena",
                "arena_vote_recorded",
                Some(&vote.vote_id),
                json!({
                    "voteId": vote.vote_id,
                    "winnerModel": vote.winner_model,
                    "isTie": vote.is_tie,
                    "eloDelta": vote.elo_delta,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "voteId": vote.vote_id,
                "winnerModel": vote.winner_model,
                "vote": vote,
                "leaderboard": leaderboard,
            }))
        }
        Err(err) => HttpResponse::error(400, "arena_vote_failed", &err),
    }
}

fn handle_arena_leaderboard(state: &Arc<StudioState>) -> HttpResponse {
    let leaderboard = state.ops.list_arena_leaderboard().unwrap_or_default();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": leaderboard.len(),
        "leaderboard": leaderboard,
    }))
}

fn handle_arena_runs(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let limit = req
        .query_param("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let runs = state.ops.list_arena_runs(limit).unwrap_or_default();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": runs.len(),
        "runs": runs,
    }))
}

// =========================================================================
// 2. Omnia Gems / Personas CRUD & Pre-Send Estimator (`/api/v5/studio/*`)
// =========================================================================

fn handle_personas_list(state: &Arc<StudioState>) -> HttpResponse {
    let personas = state.ops.list_studio_personas().unwrap_or_default();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": personas.len(),
        "personas": personas,
    }))
}

fn handle_persona_get(state: &Arc<StudioState>, id: &str) -> HttpResponse {
    match state.ops.get_studio_persona(id) {
        Ok(Some(persona)) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "persona": persona,
        })),
        Ok(None) => HttpResponse::error(404, "persona_not_found", "Studio persona not found."),
        Err(err) => HttpResponse::error(500, "persona_store_error", &err),
    }
}

fn handle_personas_upsert(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(name) = str_field(&obj, &["name", "title"]) else {
        return HttpResponse::error(400, "missing_persona_name", "Field 'name' is required.");
    };

    let input = StudioPersonaInput {
        id: str_field(&obj, &["id", "personaId", "persona_id"]).map(ToString::to_string),
        name: name.to_string(),
        icon: str_field(&obj, &["icon"]).map(ToString::to_string),
        description: str_field(&obj, &["description"]).map(ToString::to_string),
        model_id: str_field(&obj, &["modelId", "model_id", "model"]).map(ToString::to_string),
        effort: str_field(&obj, &["effort"]).map(ToString::to_string),
        temperature: obj.get("temperature").and_then(Value::as_f64),
        top_p: obj
            .get("topP")
            .or_else(|| obj.get("top_p"))
            .and_then(Value::as_f64),
        system_prompt: obj
            .get("systemPrompt")
            .or_else(|| obj.get("system_prompt"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        focus_mode: str_field(&obj, &["focusMode", "focus_mode", "focus"]).map(ToString::to_string),
        pinned_files: obj
            .get("pinnedFiles")
            .or_else(|| obj.get("pinned_files"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect()
            }),
    };

    match state.ops.upsert_studio_persona(&input) {
        Ok(persona) => {
            let personas = state.ops.list_studio_personas().unwrap_or_default();
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": persona.id,
                "persona": persona,
                "personas": personas,
            }))
        }
        Err(err) => HttpResponse::error(400, "persona_upsert_failed", &err),
    }
}

fn handle_personas_delete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let query_id = req
        .query_param("id")
        .or_else(|| req.query_param("personaId"))
        .or_else(|| req.query_param("persona_id"))
        .filter(|s| !s.trim().is_empty());

    let id = if let Some(qid) = query_id {
        qid
    } else if !req.body.is_empty() {
        let obj = match parse_obj(req) {
            Ok(m) => m,
            Err(resp) => return resp,
        };
        match str_field(&obj, &["id", "personaId", "persona_id"]) {
            Some(s) => s.to_string(),
            None => {
                return HttpResponse::error(
                    400,
                    "missing_persona_id",
                    "Query parameter 'id' or JSON field 'id' is required.",
                );
            }
        }
    } else {
        return HttpResponse::error(
            400,
            "missing_persona_id",
            "Query parameter 'id' or JSON field 'id' is required.",
        );
    };

    handle_personas_delete_by_id(state, &id)
}

fn handle_personas_delete_by_id(state: &Arc<StudioState>, id: &str) -> HttpResponse {
    match state.ops.delete_studio_persona(id) {
        Ok(deleted) => {
            let personas = state.ops.list_studio_personas().unwrap_or_default();
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": id,
                "deleted": deleted,
                "personas": personas,
            }))
        }
        Err(err) => HttpResponse::error(400, "persona_delete_failed", &err),
    }
}

fn handle_studio_estimate(req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let prompt = obj
        .get("prompt")
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let system_prompt = obj
        .get("systemPrompt")
        .or_else(|| obj.get("system_prompt"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let max_tokens = obj
        .get("maxTokens")
        .or_else(|| obj.get("max_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(1024)
        .clamp(64, 65_536);

    let mut models = str_vec_field(&obj, &["models"]);
    if models.is_empty() {
        if let Some(m) = str_field(&obj, &["model", "modelId", "model_id"]) {
            models.push(m.to_string());
        } else {
            models.push("claude-sonnet-5-5".to_string());
        }
    }

    let prompt_tokens = estimate_tokens_from_text(prompt);
    let system_tokens = estimate_tokens_from_text(system_prompt);
    let input_tokens = prompt_tokens.saturating_add(system_tokens);
    let est_output_tokens = max_tokens.clamp(128, 1024);

    let (schema_provided, parsed_schema, schema_err) = parse_optional_json_schema(&obj);
    let schema_check = json!({
        "provided": schema_provided,
        "valid": !schema_provided || parsed_schema.is_some(),
        "error": schema_err,
    });

    let configured_providers = read_models_config(None)
        .ok()
        .map(|c| c.providers)
        .unwrap_or_default();

    let mut per_model = Vec::new();
    let mut total_usd = 0.0_f64;

    for model_spec in &models {
        let ep = resolve_model_endpoint(model_spec, None, None, None).ok();
        let (in_per_m, out_per_m) = effective_model_pricing_per_m(model_spec, ep.as_ref());
        let in_usd = round_usd_6((input_tokens as f64 / 1_000_000.0) * in_per_m);
        let out_usd = round_usd_6((est_output_tokens as f64 / 1_000_000.0) * out_per_m);
        let model_total = round_usd_6(in_usd + out_usd);
        total_usd += model_total;

        let ctx_win = ep
            .as_ref()
            .map(|e| e.context_window)
            .filter(|&w| w > 0)
            .unwrap_or(200_000);
        let fill_pct = round_2((input_tokens as f64 / ctx_win as f64) * 100.0);
        let configured = ep
            .as_ref()
            .is_some_and(|e| !e.api_key.trim().is_empty() || is_loopback_endpoint(&e.base_url));
        let provider_id = ep
            .as_ref()
            .map(|e| e.provider_id.clone())
            .or_else(|| {
                configured_providers
                    .iter()
                    .find(|p| p.models.iter().any(|m| m.id.eq_ignore_ascii_case(model_spec)))
                    .map(|p| p.id.clone())
            })
            .unwrap_or_else(|| "reference".to_string());

        per_model.push(json!({
            "modelId": model_spec,
            "providerId": provider_id,
            "configured": configured,
            "inputPerM": in_per_m,
            "outputPerM": out_per_m,
            "estimatedInputCostUsd": in_usd,
            "estimatedOutputCostUsd": out_usd,
            "estimatedTotalUsd": model_total,
            "contextWindow": ctx_win,
            "contextFillPct": fill_pct,
        }));
    }

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "promptTokens": prompt_tokens,
        "systemTokens": system_tokens,
        "inputTokens": input_tokens,
        "estimatedOutputTokens": est_output_tokens,
        "totalEstimatedUsd": round_usd_6(total_usd),
        "perModel": per_model,
        "schemaCheck": schema_check,
    }))
}

// =========================================================================
// 3. ChatGPT-Style Message Branching & Thread Fork (`/api/v5/sessions/{id}/*`)
// =========================================================================

fn handle_session_branches_get(
    state: &Arc<StudioState>,
    session_id: &str,
    req: &HttpRequest,
) -> HttpResponse {
    if !is_valid_studio_session_id(session_id) {
        return HttpResponse::error(400, "invalid_session_id", "Session ID is invalid.");
    }
    let parent_msg_id = req
        .query_param("parentMsgId")
        .or_else(|| req.query_param("parent_msg_id"))
        .filter(|s| !s.trim().is_empty());

    let branches = state
        .ops
        .list_chat_branches(session_id, parent_msg_id.as_deref())
        .unwrap_or_default();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "sessionId": session_id,
        "count": branches.len(),
        "branches": branches,
    }))
}

fn handle_session_branches_post(
    state: &Arc<StudioState>,
    session_id: &str,
    req: &HttpRequest,
) -> HttpResponse {
    if !is_valid_studio_session_id(session_id) {
        return HttpResponse::error(400, "invalid_session_id", "Session ID is invalid.");
    }
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(content) = str_field(&obj, &["content", "text", "body"]) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    let parent_msg_id = str_field(&obj, &["parentMsgId", "parent_msg_id", "parentId"])
        .unwrap_or("root")
        .to_string();
    let role = str_field(&obj, &["role"]).unwrap_or("assistant").to_string();

    let input = ChatBranchInput {
        id: str_field(&obj, &["id", "branchId", "branch_id"]).map(ToString::to_string),
        session_id: session_id.to_string(),
        parent_msg_id: parent_msg_id.clone(),
        branch_index: obj
            .get("branchIndex")
            .or_else(|| obj.get("branch_index"))
            .and_then(Value::as_i64),
        role,
        content: content.to_string(),
        model_id: str_field(&obj, &["modelId", "model_id", "model"]).map(ToString::to_string),
        effort: str_field(&obj, &["effort"]).map(ToString::to_string),
        thinking_text: obj
            .get("thinkingText")
            .or_else(|| obj.get("thinking_text"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        tool_calls: obj
            .get("toolCalls")
            .or_else(|| obj.get("tool_calls"))
            .cloned(),
    };

    match state.ops.append_chat_branch(&input) {
        Ok(branch) => {
            let siblings = state
                .ops
                .list_chat_branches(session_id, Some(&parent_msg_id))
                .unwrap_or_default();
            state.event_feed.publish(
                "sessions",
                "branch_created",
                Some(session_id),
                json!({
                    "sessionId": session_id,
                    "parentMsgId": parent_msg_id,
                    "branchId": branch.id,
                    "branchIndex": branch.branch_index,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "sessionId": session_id,
                "branch": branch,
                "branches": siblings,
            }))
        }
        Err(err) => HttpResponse::error(400, "branch_create_failed", &err),
    }
}

fn handle_session_fork_post(
    state: &Arc<StudioState>,
    session_id: &str,
    req: &HttpRequest,
) -> HttpResponse {
    if !is_valid_studio_session_id(session_id) {
        return HttpResponse::error(400, "invalid_session_id", "Session ID is invalid.");
    }
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let up_to_seq = obj
        .get("upToSeq")
        .or_else(|| obj.get("up_to_seq"))
        .or_else(|| obj.get("turnIdx"))
        .or_else(|| obj.get("turn_idx"))
        .and_then(Value::as_i64);
    let up_to_branch_id = str_field(&obj, &["branchId", "branch_id", "upToBranchId"]);

    let source_session = state.sessions.get_session(session_id).ok().flatten();
    let existing_branches = state
        .ops
        .list_chat_branches(session_id, None)
        .unwrap_or_default();
    if source_session.is_none() && existing_branches.is_empty() {
        return HttpResponse::error(
            404,
            "session_not_found",
            &format!("Session '{session_id}' not found."),
        );
    }

    let now = now_epoch_ms();
    let base_title = source_session
        .as_ref()
        .map_or(session_id, |s| s.title.as_str());
    let new_title = str_field(&obj, &["title"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{base_title} (Fork)"));
    let model_id = source_session
        .as_ref()
        .map_or("claude-sonnet-5-5", |s| s.model_id.as_str());
    let effort = source_session
        .as_ref()
        .map_or("max", |s| s.effort.as_str());

    let created = match state
        .sessions
        .create_session(&new_title, model_id, effort, now, None)
    {
        Ok(s) => s,
        Err(err) => return HttpResponse::error(500, "session_fork_failed", &err.to_string()),
    };

    let mut copied_messages = 0usize;
    if source_session.is_some() {
        if let Ok(msgs) = state.sessions.list_messages(session_id, 0) {
            for m in msgs {
                if let Some(max_seq) = up_to_seq {
                    if m.seq > max_seq {
                        break;
                    }
                }
                if state
                    .sessions
                    .append_message(&created.id, &m.role, &m.content, &m.metadata_json, now)
                    .is_ok()
                {
                    copied_messages += 1;
                }
            }
        }
    }

    let copied_branches = state
        .ops
        .fork_chat_branches(session_id, &created.id, up_to_branch_id)
        .unwrap_or(0);

    state.event_feed.publish(
        "sessions",
        "session_forked",
        Some(&created.id),
        json!({
            "sourceSessionId": session_id,
            "forkedSessionId": created.id,
            "copiedMessages": copied_messages,
            "copiedBranches": copied_branches,
        }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "sourceSessionId": session_id,
        "forkedSessionId": created.id,
        "copiedMessages": copied_messages,
        "copiedBranches": copied_branches,
        "session": {
            "id": created.id,
            "title": created.title,
            "modelId": created.model_id,
            "effort": created.effort,
            "revision": created.revision,
            "createdAtMs": created.created_at_ms,
            "updatedAtMs": created.updated_at_ms,
        },
    }))
}

// =========================================================================
// 4. Perplexity-Pro Answer Engine (`/api/v5/research/answer`)
// =========================================================================

fn default_plan_steps_for_focus(query: &str, focus: &str, sub_queries: &[String]) -> Vec<String> {
    let mut steps = Vec::new();
    match focus {
        "academic" => {
            steps.push(format!("Search academic literature & preprints (arXiv, OpenAlex, Europe PMC) for: {query}"));
            steps.push("Cross-check persistent Local + Global RAG vault citations and DOIs".to_string());
            steps.push("Synthesize evidence-graded answer with inline [S###]/[G###] citations".to_string());
        }
        "code" => {
            steps.push(format!("Query Graphify CST code graph & workspace docs for: {query}"));
            steps.push("Inspect Local + Global RAG architecture specs and verification invariants".to_string());
            steps.push("Synthesize symbol-grounded engineering summary with exact paths".to_string());
        }
        "rag" => {
            steps.push(format!("Retrieve top hybrid BM25 + RRF chunks from Local & Global RAG for: {query}"));
            steps.push("Verify source provenance digests (SHA-256) and synthesize grounded answer".to_string());
        }
        "deep" => {
            steps.push(format!("Multi-backend web + academic fan-out for: {query}"));
            for sq in sub_queries.iter().take(2) {
                steps.push(format!("Targeted sub-query: {sq}"));
            }
            steps.push("Ingest top sources into ResearchVault and synthesize verified brief".to_string());
        }
        _ => {
            steps.push(format!("Search live web + persistent RAG vault for: {query}"));
            steps.push("Extract & deduplicate primary sources into ResearchVault".to_string());
            steps.push("Synthesize concise cited answer with follow-up exploration paths".to_string());
        }
    }
    steps
}

fn generate_related_questions(query: &str, focus: &str, titles: &[String]) -> Vec<String> {
    let clean = query.trim().trim_end_matches(['?', '.', '!']);
    let mut qs = Vec::new();
    match focus {
        "academic" => {
            qs.push(format!("What are the primary methodological limitations and benchmarks for {clean}?"));
            qs.push(format!("Which peer-reviewed baselines outperform or contradict {clean}?"));
            qs.push(format!("What reproducible datasets or code artifacts accompany {clean}?"));
        }
        "code" => {
            qs.push(format!("Which modules and tests in this repository own {clean}?"));
            qs.push(format!("What concurrency, error-handling, or security edge cases affect {clean}?"));
            qs.push(format!("How can we benchmark and verify regressions for {clean}?"));
        }
        _ => {
            qs.push(format!("What are the key architectural trade-offs and failure modes of {clean}?"));
            qs.push(format!("How does {clean} compare against current SOTA alternatives in latency and cost?"));
            qs.push(format!("What concrete verification steps prove {clean} works end-to-end?"));
        }
    }
    if let Some(first_title) = titles.first().filter(|t| !t.trim().is_empty()) {
        let short_t: String = first_title.chars().take(72).collect();
        qs.push(format!("Deep-dive into \"{short_t}\" and verify its primary claims"));
    }
    qs
}

fn format_answer_source_card(src: &ResearchSourceRecord) -> Value {
    json!({
        "id": src.citation_id,
        "citationId": src.citation_id,
        "tier": src.tier.as_str(),
        "title": src.title,
        "url": src.canonical_url,
        "domain": src.domain,
        "stage": src.stage.as_str(),
        "snippet": src.markdown_excerpt,
        "sha256": src.sha256_hex,
        "authorityScore": src.authority_score,
        "publishedAt": src.published_at,
        "errorNote": src.error_note,
    })
}

async fn handle_research_answer(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(query) = str_field(&obj, &["query", "q", "prompt"]) else {
        return HttpResponse::error(400, "missing_query", "Field 'query' is required.");
    };
    let focus_raw = str_field(&obj, &["focus", "mode", "scope"]).unwrap_or("web");
    let focus = match focus_raw.to_ascii_lowercase().as_str() {
        "academic" | "papers" | "scholar" => "academic",
        "code" | "repo" | "workspace" => "code",
        "rag" | "local" | "vault" => "rag",
        "deep" | "deep_research" | "all" => "deep",
        _ => "web",
    };
    let max_sources = obj
        .get("maxSources")
        .or_else(|| obj.get("max_sources"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 20))
        .unwrap_or(8);
    let fetch_top = obj
        .get("fetchTop")
        .or_else(|| obj.get("fetch_top"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(0, 4))
        .unwrap_or(if focus == "deep" { 3 } else { 2 });
    let offline = obj.get("offline").and_then(Value::as_bool).unwrap_or(false);

    let rag_plan = state.rag.plan_and_retrieve(query, max_sources.min(10));
    let sub_query_strings: Vec<String> = rag_plan
        .sub_queries
        .iter()
        .map(|sq| sq.text.clone())
        .collect();
    let custom_steps = str_vec_field(&obj, &["planSteps", "plan_steps"]);
    let plan_steps = if custom_steps.is_empty() {
        default_plan_steps_for_focus(query, focus, &sub_query_strings)
    } else {
        custom_steps
    };

    let mut providers_queried: Vec<String> = vec!["research_vault".to_string(), "proactive_rag".to_string()];
    let mut provider_errors: Vec<String> = Vec::new();
    let mut source_cards: Vec<Value> = Vec::new();
    let mut citation_ids: Vec<String> = Vec::new();
    let mut seen_cids: BTreeSet<String> = BTreeSet::new();
    let mut titles: Vec<String> = Vec::new();

    // 1. Live multi-backend web/academic search + bounded fetch/ingest when requested & online.
    let should_search_web = !offline && matches!(focus, "web" | "academic" | "deep");
    if should_search_web {
        let search_scope = match focus {
            "academic" => WebSearchScope::Academic,
            "deep" => WebSearchScope::All,
            _ => WebSearchScope::Web,
        };
        let search_opts = WebSearchOptions {
            query: query.to_string(),
            limit: max_sources,
            scope: search_scope,
            site: None,
            published_after: None,
            published_before: None,
        };
        match tokio::time::timeout(RESEARCH_WEB_TIMEOUT, web_search_multi(&search_opts)).await {
            Ok(Ok(bundle)) => {
                providers_queried.extend(bundle.providers_queried);
                provider_errors.extend(bundle.provider_errors);
                let mut urls_to_fetch = Vec::new();
                for hit in bundle.hits.into_iter().take(max_sources) {
                    let target_url = if hit.canonical_url.is_empty() {
                        hit.url.clone()
                    } else {
                        hit.canonical_url.clone()
                    };
                    if let Ok(rec) = state.research_vault.record_searched_candidate(
                        VaultTier::Local,
                        &target_url,
                        &hit.title,
                        query,
                        &hit.snippet,
                    ) {
                        if urls_to_fetch.len() < fetch_top {
                            urls_to_fetch.push(target_url);
                        }
                        if seen_cids.insert(rec.citation_id.clone()) {
                            citation_ids.push(rec.citation_id.clone());
                            titles.push(rec.title.clone());
                            source_cards.push(format_answer_source_card(&rec));
                        }
                    }
                }
                if !urls_to_fetch.is_empty() {
                    if let Ok(fetched) = tokio::time::timeout(
                        RESEARCH_FETCH_TIMEOUT,
                        state.research_vault.fetch_urls_parallel(
                            VaultTier::Local,
                            &urls_to_fetch,
                            query,
                            2,
                            false,
                        ),
                    )
                    .await
                    {
                        for rec in fetched {
                            let updated = format_answer_source_card(&rec);
                            if let Some(existing) = source_cards
                                .iter_mut()
                                .find(|c| c["citationId"].as_str() == Some(rec.citation_id.as_str()))
                            {
                                *existing = updated;
                            } else if seen_cids.insert(rec.citation_id.clone()) {
                                citation_ids.push(rec.citation_id.clone());
                                titles.push(rec.title.clone());
                                source_cards.push(updated);
                            }
                        }
                    }
                }
            }
            Ok(Err(e)) => provider_errors.push(format!("web_search: {e}")),
            Err(_) => provider_errors.push(format!(
                "web_search timed out after {}s; returned local/global RAG grounding",
                RESEARCH_WEB_TIMEOUT.as_secs()
            )),
        }
    }

    // 2. Hybrid Local + Global ResearchVault RAG retrieval.
    let vault_hits = state
        .research_vault
        .query_rag(query, None, max_sources)
        .unwrap_or_default();
    let ledger_map: BTreeMap<String, ResearchSourceRecord> = state
        .research_vault
        .sources_ledger(None)
        .map(|l| {
            l.sources
                .into_iter()
                .map(|s| (s.citation_id.clone(), s))
                .collect()
        })
        .unwrap_or_default();

    for hit in &vault_hits {
        if seen_cids.insert(hit.citation_id.clone()) {
            citation_ids.push(hit.citation_id.clone());
            titles.push(hit.title.clone());
            if let Some(rec) = ledger_map.get(&hit.citation_id) {
                source_cards.push(format_answer_source_card(rec));
            } else {
                source_cards.push(json!({
                    "id": hit.citation_id,
                    "citationId": hit.citation_id,
                    "tier": hit.tier.as_str(),
                    "title": hit.title,
                    "url": hit.source_url,
                    "domain": "vault",
                    "stage": "extracted",
                    "snippet": hit.snippet,
                    "rrfScore": hit.rrf_score,
                }));
            }
        }
    }

    // 3. Code focus: add Graphify workspace symbols when focus == "code".
    let mut code_lines = Vec::new();
    if focus == "code" {
        providers_queried.push("graphify_cst".to_string());
        let needle = query.to_ascii_lowercase();
        let terms: Vec<&str> = needle
            .split_whitespace()
            .filter(|t| t.len() >= 3)
            .collect();
        if let Ok(entities) = state.graphify.entities() {
            for ent in entities
                .into_iter()
                .filter(|e| {
                    let hay = format!("{} {} {}", e.id, e.label, e.source_path).to_ascii_lowercase();
                    terms.iter().any(|t| hay.contains(t))
                })
                .take(6)
            {
                code_lines.push(format!(
                    "- `{}` ({}) — `{}`",
                    ent.label,
                    ent.kind.as_str(),
                    ent.source_path
                ));
            }
        }
    }

    // 4. Synthesize grounded answer Markdown strictly referencing retrieved sources (zero fabrication).
    let mut md = format!("## Grounded Research Answer ({focus})\n\n");
    md.push_str(&format!("**Query:** {}\n\n", SecretRedactor::redact(query)));

    if !vault_hits.is_empty() {
        md.push_str("### Key Findings from Verified Sources\n\n");
        for hit in vault_hits.iter().take(6) {
            let clean_snip = hit.snippet.replace('\n', " ");
            md.push_str(&format!(
                "- **{}** [{}]: {}\n",
                hit.title, hit.citation_id, clean_snip
            ));
        }
        md.push('\n');
    } else if !source_cards.is_empty() {
        md.push_str("### Retrieved Sources\n\n");
        for card in source_cards.iter().take(6) {
            let cid = card["citationId"].as_str().unwrap_or("S001");
            let title = card["title"].as_str().unwrap_or("Source");
            let snip = card["snippet"].as_str().unwrap_or("").replace('\n', " ");
            md.push_str(&format!("- **{title}** [{cid}]: {snip}\n"));
        }
        md.push('\n');
    } else if !rag_plan.cited_sources.is_empty() {
        md.push_str("### Workspace Grounding\n\n");
        for src in rag_plan.cited_sources.iter().take(5) {
            md.push_str(&format!("- `{}` — {}\n", src.locator, src.excerpt));
        }
        md.push('\n');
    }

    if !code_lines.is_empty() {
        md.push_str("### Graphify Code Entities\n\n");
        for line in &code_lines {
            md.push_str(line);
            md.push('\n');
        }
        md.push('\n');
    }

    if vault_hits.is_empty()
        && source_cards.is_empty()
        && rag_plan.cited_sources.is_empty()
        && code_lines.is_empty()
    {
        md.push_str(
            "_No matching documents were found in the current local/global RAG vault or reachable web backends. Ingest a URL/document or broaden the focus scope to populate grounded citations._\n\n",
        );
    }

    md.push_str("### Research Plan Executed\n\n");
    for (idx, step) in plan_steps.iter().enumerate() {
        md.push_str(&format!("{}. {}\n", idx + 1, SecretRedactor::redact(step)));
    }

    let safe_answer = SecretRedactor::redact(&md);
    let related = generate_related_questions(query, focus, &titles);

    state.event_feed.publish(
        "research",
        "answer_synthesized",
        None,
        json!({
            "query": SecretRedactor::redact(query),
            "focus": focus,
            "sourceCount": source_cards.len(),
            "citationCount": citation_ids.len(),
        }),
    );

    HttpResponse::ok(SecretRedactor::redact_json(&json!({
        "ok": true,
        "state": "online",
        "query": SecretRedactor::redact(query),
        "focus": focus,
        "answer_markdown": safe_answer,
        "answerMarkdown": safe_answer,
        "sources": source_cards,
        "citations": citation_ids,
        "plan_steps": plan_steps,
        "planSteps": plan_steps,
        "related_questions": related,
        "relatedQuestions": related,
        "providers_queried": providers_queried,
        "providersQueried": providers_queried,
        "provider_errors": provider_errors,
        "providerErrors": provider_errors,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;

    fn make_req(method: &str, path: &str, query: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            target: if query.is_empty() {
                path.to_string()
            } else {
                format!("{path}?{query}")
            },
            path: path.to_string(),
            query: query.to_string(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: if method == "GET" {
                Vec::new()
            } else {
                serde_json::to_vec(&body).unwrap_or_default()
            },
        }
    }

    fn make_test_state() -> Arc<StudioState> {
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-arena-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = std::fs::create_dir_all(&ws);
        let _ = std::fs::create_dir_all(&rb);
        let cfg = StudioConfig {
            workspace_root: ws,
            rollback_root: rb,
            db_path: None,
            runtime_url: None,
            ..StudioConfig::default()
        };
        Arc::new(StudioState::new(cfg).expect("build StudioState"))
    }

    #[tokio::test]
    async fn steer23_arena_personas_estimate_branches_fork_and_research_answer_work() {
        let state = make_test_state();

        // 1. Zero-4xx empty GET mount invariants + 4 built-in flagship Personas seeded.
        let lb0 = dispatch(
            &state,
            &make_req("GET", "/api/v5/arena/leaderboard", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(lb0.status, 200);
        let p0 = dispatch(
            &state,
            &make_req("GET", "/api/v5/studio/personas", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(p0.status, 200);
        let p0j: Value = serde_json::from_slice(&p0.body).unwrap();
        assert!(p0j["personas"].as_array().unwrap().len() >= 4);

        // 2. Personas upsert & DELETE roundtrip.
        let p_up = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/studio/personas",
                "",
                json!({
                    "name": "Rust Systems Reviewer",
                    "icon": "RS",
                    "modelId": "claude-sonnet-5-5",
                    "effort": "max",
                    "temperature": 0.2,
                    "systemPrompt": "Audit Rust crates strictly."
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(p_up.status, 200);
        let pid = serde_json::from_slice::<Value>(&p_up.body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let p_del = dispatch(
            &state,
            &make_req(
                "DELETE",
                "/api/v5/studio/personas",
                &format!("id={pid}"),
                Value::Null,
            ),
        )
        .await
        .unwrap();
        assert_eq!(p_del.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&p_del.body).unwrap()["deleted"],
            true
        );

        // 3. Pre-send token + 6-decimal USD estimator & JSON schema check.
        let est = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/studio/estimate",
                "",
                json!({
                    "prompt": "Compare Rust WinSQLite WAL leasing vs memory stores",
                    "systemPrompt": "Be concise and cite files.",
                    "models": ["claude-sonnet-5-5", "gpt-6.2-sol"],
                    "jsonSchema": { "type": "object", "required": ["winner"] }
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(est.status, 200);
        let est_j: Value = serde_json::from_slice(&est.body).unwrap();
        assert!(est_j["inputTokens"].as_u64().unwrap() > 0);
        assert_eq!(est_j["schemaCheck"]["valid"], true);
        assert_eq!(est_j["perModel"].as_array().unwrap().len(), 2);

        // 4. Arena compare (offline_estimate / honest diagnostic, never fabricating answers) + vote -> Elo.
        let cmp = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/arena/compare",
                "",
                json!({
                    "prompt": "Explain Prefix-0 KV cache invariance",
                    "models": ["claude-sonnet-5-5", "gpt-6.2-sol"],
                    "live": false
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(cmp.status, 200);
        let cmp_j: Value = serde_json::from_slice(&cmp.body).unwrap();
        let run_id = cmp_j["runId"].as_str().unwrap().to_string();
        assert_eq!(cmp_j["results"].as_array().unwrap().len(), 2);

        let vote = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/arena/vote",
                "",
                json!({
                    "runId": run_id,
                    "modelA": "claude-sonnet-5-5",
                    "modelB": "gpt-6.2-sol",
                    "winner": "a"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(vote.status, 200);
        let vj: Value = serde_json::from_slice(&vote.body).unwrap();
        assert_eq!(vj["winnerModel"], "claude-sonnet-5-5");
        assert!(!vj["leaderboard"].as_array().unwrap().is_empty());

        // 5. Session branches + fork roundtrip.
        let sess = state
            .sessions
            .create_session("Arena Session", "claude-sonnet-5-5", "max", now_epoch_ms(), Some("s-arena-1"))
            .unwrap();
        let _ = state
            .sessions
            .append_message(&sess.id, "user", "Hello Omnia", "{}", now_epoch_ms());
        let b_empty = dispatch(
            &state,
            &make_req("GET", "/api/v5/sessions/s-arena-1/branches", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(b_empty.status, 200);
        let b1 = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/sessions/s-arena-1/branches",
                "",
                json!({ "parentMsgId": "msg-1", "content": "Branch variant 1", "modelId": "claude-sonnet-5-5" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(b1.status, 200);
        let fork = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/sessions/s-arena-1/fork",
                "",
                json!({ "title": "Forked Arena Thread" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(fork.status, 200);
        let fj: Value = serde_json::from_slice(&fork.body).unwrap();
        assert_eq!(fj["copiedMessages"], 1);
        assert_eq!(fj["copiedBranches"], 1);

        // 6. Perplexity-Pro Research Answer Engine (grounded offline RAG mode).
        let _ = state.research_vault.ingest_document(
            VaultTier::Local,
            "https://example.test/prefix0",
            None,
            Some("Prefix-0 Invariance Note"),
            "# Prefix-0\nKeep the system prompt byte-identical to preserve KV cache hit rates.",
            "text/markdown",
            Some(200),
            "test",
        );
        let ans = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/research/answer",
                "",
                json!({
                    "query": "Prefix-0 KV cache hit rates",
                    "focus": "rag",
                    "offline": true
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(ans.status, 200);
        let aj: Value = serde_json::from_slice(&ans.body).unwrap();
        assert!(aj["answer_markdown"].as_str().unwrap().contains("[S001]"));
        assert!(!aj["related_questions"].as_array().unwrap().is_empty());
        assert!(!aj["plan_steps"].as_array().unwrap().is_empty());
    }
}
