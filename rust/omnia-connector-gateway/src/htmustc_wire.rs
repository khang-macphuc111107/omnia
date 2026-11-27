//! Ported `htmustc-proxy` wire, SSE pre-commit failover, conversation affinity,
//! proactive quota-gate, Responses namespace restoration, and Gemini wire hygiene.
//!
//! Zero `serde` derive dependency (matches `omnia-connector-gateway/Cargo.toml` no-derive feature).

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;

/// Default cooldown when a provider reports zero quota without a reset timestamp (`30m`).
pub const DEFAULT_QUOTA_EXHAUSTION_REST_MS: i64 = 30 * 60 * 1_000;
/// OpenAI/Codex and Responses maximum tool-name wire limit (`64` characters).
pub const MAX_WIRE_TOOL_NAME_LEN: usize = 64;
/// OpenAI/Gemini sentinel string bypassing upstream protobuf thought-signature checks on synthetic/foreign calls.
pub const SKIP_THOUGHT_SIGNATURE_VALIDATOR: &str = "skip_thought_signature_validator";

const FNV64_OFFSET: u64 = 14_695_981_039_346_656_037;
const FNV64_PRIME: u64 = 1_099_511_628_211;
const FINGERPRINT_USER_CAP_BYTES: usize = 256;

/// Compute deterministic FNV-64a hash.
#[must_use]
pub fn fnv64a(bytes: &[u8]) -> u64 {
    let mut h = FNV64_OFFSET;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(FNV64_PRIME);
    }
    h
}

/// Derive a deterministic conversation fingerprint (`"fp:<16-hex>"` or explicit session header/key).
/// Mirrors `htmustc-proxy/internal/proxy/conversation_identity.go`:
/// normalizes whitespace in `system_text` + leading `first_user_text` capped at `256` UTF-8 bytes.
#[must_use]
pub fn conversation_fingerprint(
    explicit_session_id: Option<&str>,
    system_text: &str,
    first_user_text: &str,
) -> String {
    if let Some(explicit) = explicit_session_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return explicit.to_string();
    }
    let norm_sys = collapse_ascii_ws(system_text);
    let norm_user_full = collapse_ascii_ws(first_user_text);
    let norm_user = truncate_utf8_at(&norm_user_full, FINGERPRINT_USER_CAP_BYTES);
    let mut material = Vec::with_capacity(norm_sys.len() + norm_user.len() + 2);
    material.extend_from_slice(norm_sys.as_bytes());
    material.push(0x1f);
    material.extend_from_slice(norm_user.as_bytes());
    format!("fp:{:016x}", fnv64a(&material))
}

/// Derive a stable per-(provider, account, session) upstream prompt-cache routing key.
#[must_use]
pub fn upstream_cache_key(provider_id: &str, account_id: &str, session_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider_id.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(account_id.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(session_key.trim().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for b in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    format!("uck_{hex}")
}

/// Pre-commit verdict on buffered SSE / non-SSE upstream response bytes before committing downstream headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseCommitVerdict {
    Ok,
    EmptySse,
    IncompleteSse { reason: String },
    EmptyCompletion,
    SmuggledOverload { status_hint: u16, error_type: String, message: String },
    AuthOrEntitlement { status_hint: u16, message: String },
}

impl SseCommitVerdict {
    #[must_use]
    pub fn should_failover_before_commit(&self) -> bool {
        !matches!(self, Self::Ok)
    }
}

/// Inspect an SSE response buffer before downstream header commit (`empty_sse.go` + `classify.go`).
#[must_use]
pub fn inspect_sse_pre_commit(raw_sse: &[u8]) -> SseCommitVerdict {
    let text = String::from_utf8_lossy(raw_sse);
    if text.trim().is_empty() {
        return SseCommitVerdict::EmptySse;
    }

    let mut data_frame_count = 0usize;
    let mut saw_done = false;
    let mut saw_terminal_event = false;
    let mut saw_content_or_reasoning_or_tool = false;
    let mut output_tokens_gt_zero = false;
    let mut smuggled_error: Option<(String, String)> = None;
    let mut current_event_name = String::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r').trim();
        if line.is_empty() {
            current_event_name.clear();
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        if let Some(ev) = line.strip_prefix("event:") {
            current_event_name = ev.trim().to_ascii_lowercase();
            continue;
        }
        let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if payload.is_empty() {
            continue;
        }
        data_frame_count += 1;
        if payload == "[DONE]" {
            saw_done = true;
            saw_terminal_event = true;
            continue;
        }

        let Ok(val) = serde_json::from_str::<Value>(payload) else {
            return SseCommitVerdict::IncompleteSse {
                reason: "malformed or truncated SSE JSON frame".into(),
            };
        };

        if let Some(err_verdict) = detect_smuggled_error_json(&current_event_name, &val) {
            smuggled_error = Some(err_verdict);
            break;
        }

        if let Some(ev_type) = val.get("type").and_then(|v| v.as_str()) {
            match ev_type {
                "message_stop" | "response.completed" | "response.done" => {
                    saw_terminal_event = true;
                }
                "message_delta" => {
                    if val
                        .pointer("/delta/stop_reason")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                    {
                        saw_terminal_event = true;
                    }
                    if val
                        .pointer("/usage/output_tokens")
                        .and_then(|v| v.as_u64())
                        .is_some_and(|n| n > 0)
                    {
                        output_tokens_gt_zero = true;
                    }
                }
                "response.incomplete" => {
                    saw_terminal_event = true;
                }
                "content_block_start" => {
                    let cb_type = val.pointer("/content_block/type").and_then(|v| v.as_str());
                    if matches!(cb_type, Some("tool_use" | "thinking" | "redacted_thinking")) {
                        saw_content_or_reasoning_or_tool = true;
                    }
                    if val
                        .pointer("/content_block/text")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                    {
                        saw_content_or_reasoning_or_tool = true;
                    }
                }
                "content_block_delta" => {
                    if val
                        .pointer("/delta/text")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                        || val
                            .pointer("/delta/thinking")
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.is_empty())
                        || val
                            .pointer("/delta/partial_json")
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.is_empty())
                    {
                        saw_content_or_reasoning_or_tool = true;
                    }
                }
                "response.output_text.delta"
                | "response.reasoning_text.delta"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning.delta"
                | "response.refusal.delta"
                | "response.function_call_arguments.delta"
                | "response.custom_tool_call_input.delta" => {
                    if val
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                    {
                        saw_content_or_reasoning_or_tool = true;
                    }
                }
                "response.output_item.added" | "response.output_item.done" => {
                    if let Some(item_type) = val.pointer("/item/type").and_then(|v| v.as_str()) {
                        if matches!(
                            item_type,
                            "function_call" | "custom_tool_call" | "tool_search_call"
                        ) {
                            saw_content_or_reasoning_or_tool = true;
                        }
                    }
                }
                _ => {}
            }
        }

        // OpenAI Chat Completions chunk inspection
        if let Some(choices) = val.get("choices").and_then(|v| v.as_array()) {
            for c in choices {
                if c.get("finish_reason").and_then(|v| v.as_str()).is_some() {
                    saw_terminal_event = true;
                }
                if let Some(d) = c.get("delta") {
                    if d.get("content").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
                        || d.get("reasoning_content")
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.is_empty())
                        || d.get("reasoning")
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.is_empty())
                        || d.get("tool_calls")
                            .and_then(|v| v.as_array())
                            .is_some_and(|a| !a.is_empty())
                    {
                        saw_content_or_reasoning_or_tool = true;
                    }
                }
            }
        }

        // Gemini SSE / JSON chunk inspection
        if let Some(cands) = val.get("candidates").and_then(|v| v.as_array()) {
            for cand in cands {
                if cand.get("finishReason").and_then(|v| v.as_str()).is_some() {
                    saw_terminal_event = true;
                }
                if cand
                    .pointer("/content/parts")
                    .and_then(|v| v.as_array())
                    .is_some_and(|parts| {
                        parts.iter().any(|p| {
                            p.get("text").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
                                || p.get("functionCall").is_some()
                        })
                    })
                {
                    saw_content_or_reasoning_or_tool = true;
                }
            }
        }

        if let Some(usage_obj) = val.get("usage").or_else(|| val.pointer("/response/usage")) {
            let out_n = usage_obj
                .get("output_tokens")
                .or_else(|| usage_obj.get("completion_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if out_n > 0 {
                output_tokens_gt_zero = true;
            }
        }
    }

    if let Some((err_type, msg)) = smuggled_error {
        let lower = format!("{err_type} {msg}").to_ascii_lowercase();
        if lower.contains("invalid_api_key")
            || lower.contains("authentication")
            || lower.contains("unauthorized")
            || lower.contains("permission_error")
        {
            return SseCommitVerdict::AuthOrEntitlement {
                status_hint: 401,
                message: msg,
            };
        }
        let status_hint = if lower.contains("rate_limit") || lower.contains("too many requests") {
            429
        } else {
            503
        };
        return SseCommitVerdict::SmuggledOverload {
            status_hint,
            error_type: err_type,
            message: msg,
        };
    }

    if data_frame_count == 0 {
        return SseCommitVerdict::EmptySse;
    }
    if !saw_terminal_event && !saw_done {
        return SseCommitVerdict::IncompleteSse {
            reason: "SSE ended without terminal stop frame".into(),
        };
    }
    if !saw_content_or_reasoning_or_tool && !output_tokens_gt_zero {
        return SseCommitVerdict::EmptyCompletion;
    }
    SseCommitVerdict::Ok
}

/// Inspect a non-streaming JSON HTTP body (including HTTP 200 smuggled errors).
#[must_use]
pub fn inspect_json_completion(status: u16, raw_json: &[u8]) -> SseCommitVerdict {
    if raw_json.is_empty() {
        return SseCommitVerdict::EmptyCompletion;
    }
    let Ok(val) = serde_json::from_slice::<Value>(raw_json) else {
        if status >= 400 {
            return SseCommitVerdict::SmuggledOverload {
                status_hint: status,
                error_type: "http_error".into(),
                message: String::from_utf8_lossy(raw_json).chars().take(240).collect(),
            };
        }
        return SseCommitVerdict::IncompleteSse {
            reason: "invalid JSON completion body".into(),
        };
    };

    if let Some((err_type, msg)) = detect_smuggled_error_json("", &val) {
        let lower = format!("{err_type} {msg}").to_ascii_lowercase();
        if status == 401 || status == 403 || lower.contains("invalid_api_key") {
            return SseCommitVerdict::AuthOrEntitlement {
                status_hint: if status >= 400 { status } else { 401 },
                message: msg,
            };
        }
        return SseCommitVerdict::SmuggledOverload {
            status_hint: if status >= 400 { status } else { 503 },
            error_type: err_type,
            message: msg,
        };
    }

    let has_openai = val
        .get("choices")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());
    let has_resp = val
        .get("output")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());
    let has_ant = val
        .get("content")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());
    let has_gem = val
        .get("candidates")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());

    if !has_openai && !has_resp && !has_ant && !has_gem {
        return SseCommitVerdict::EmptyCompletion;
    }
    SseCommitVerdict::Ok
}

fn detect_smuggled_error_json(event_name: &str, val: &Value) -> Option<(String, String)> {
    let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_name == "error" || ev_type == "error" || ev_type == "response.failed" {
        let err_obj = val
            .get("error")
            .or_else(|| val.pointer("/response/error"))
            .unwrap_or(val);
        let etype = err_obj
            .get("type")
            .or_else(|| err_obj.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("upstream_error")
            .to_string();
        let msg = err_obj
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("smuggled SSE error frame")
            .to_string();
        return Some((etype, msg));
    }
    if let Some(err_obj) = val.get("error").filter(|v| !v.is_null()) {
        let etype = err_obj
            .get("type")
            .or_else(|| err_obj.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("error")
            .to_string();
        let msg = err_obj
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| err_obj.as_str().unwrap_or("upstream error"))
            .to_string();
        return Some((etype, msg));
    }
    None
}

/// Routing health failure boundary matching `htmustc-proxy/internal/proxy/account_health.go`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamFailureScope {
    /// Request-scoped client/payload issue (400/413/422 prompt too long, bad schema, safety filter).
    /// MUST NEVER penalize credential/provider circuit breakers.
    RequestScoped,
    /// Temporary credential rate-limit / overload / incomplete SSE -> cooldown or failover.
    TransientQuotaOrOverload,
    /// Hard credential auth failure (401/403 revoked key) -> bench credential.
    CredentialAuthFailure,
    /// Model entitlement lock (account does not support this specific model).
    ModelEntitlementLock,
}

impl UpstreamFailureScope {
    #[must_use]
    pub const fn trips_account_circuit(self) -> bool {
        !matches!(self, Self::RequestScoped)
    }
}

/// Classify HTTP status + body into `RequestScoped` vs credential/provider failure scopes.
#[must_use]
pub fn classify_upstream_failure(status: u16, body: &str) -> UpstreamFailureScope {
    let low = body.to_ascii_lowercase();
    if low.contains("model is not supported")
        || low.contains("does not have access to model")
        || low.contains("model_not_found")
    {
        return UpstreamFailureScope::ModelEntitlementLock;
    }
    if status == 401
        || status == 403
        || low.contains("invalid_api_key")
        || low.contains("account suspended")
        || low.contains("authentication_error")
    {
        return UpstreamFailureScope::CredentialAuthFailure;
    }
    if matches!(status, 400 | 413 | 422)
        && (low.contains("invalid_request")
            || low.contains("context_length_exceeded")
            || low.contains("prompt is too long")
            || low.contains("too many tokens")
            || low.contains("validation")
            || low.contains("malformed")
            || low.contains("unsupported parameter")
            || low.contains("content_filter"))
    {
        return UpstreamFailureScope::RequestScoped;
    }
    if matches!(status, 429 | 500 | 502 | 503 | 504 | 529)
        || low.contains("overloaded")
        || low.contains("rate_limit")
        || low.contains("insufficient_quota")
        || low.contains("empty_sse")
        || low.contains("incomplete_sse")
    {
        return UpstreamFailureScope::TransientQuotaOrOverload;
    }
    if status == 400 {
        UpstreamFailureScope::RequestScoped
    } else {
        UpstreamFailureScope::TransientQuotaOrOverload
    }
}

/// Single countable quota bucket reported by a provider usage probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaBucket {
    pub name: String,
    pub total: i64,
    pub remaining: i64,
    pub unlimited: bool,
    pub reset_at_epoch_ms: Option<i64>,
}

/// Snapshot consumed by `evaluate_proactive_quota_gate`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuotaProbeSnapshot {
    pub limit_reached: bool,
    pub buckets: Vec<QuotaBucket>,
}

/// Proactive quota-gate verdict mirroring `htmustc-proxy/internal/proxy/quota_gate.go`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProactiveQuotaVerdict {
    pub known: bool,
    pub exhausted: bool,
    pub until_epoch_ms: Option<i64>,
    pub reason: String,
}

/// Evaluate whether a credential should be proactively gated before dispatching requests.
#[must_use]
pub fn evaluate_proactive_quota_gate(
    snapshot: &QuotaProbeSnapshot,
    now_epoch_ms: i64,
) -> ProactiveQuotaVerdict {
    let mut countable = 0usize;
    let mut dry = 0usize;
    let mut earliest_reset: Option<i64> = None;
    let mut dry_name = String::new();

    for row in &snapshot.buckets {
        if row.unlimited || row.total <= 0 {
            continue;
        }
        countable += 1;
        if row.remaining > 0 {
            continue;
        }
        dry += 1;
        if dry_name.is_empty() && !row.name.trim().is_empty() {
            dry_name = row.name.trim().to_string();
        }
        if let Some(reset_ms) = row.reset_at_epoch_ms {
            if reset_ms > now_epoch_ms
                && earliest_reset.is_none_or(|cur| reset_ms < cur)
            {
                earliest_reset = Some(reset_ms);
            }
        }
    }

    let known = countable > 0 || snapshot.limit_reached;
    if !known {
        return ProactiveQuotaVerdict {
            known: false,
            exhausted: false,
            until_epoch_ms: None,
            reason: String::new(),
        };
    }

    let exhausted = snapshot.limit_reached || (countable > 0 && dry == countable);
    if !exhausted {
        return ProactiveQuotaVerdict {
            known: true,
            exhausted: false,
            until_epoch_ms: None,
            reason: String::new(),
        };
    }

    let until_ms = earliest_reset.unwrap_or(now_epoch_ms + DEFAULT_QUOTA_EXHAUSTION_REST_MS);
    let reason = if dry_name.is_empty() {
        "provider reports no quota left".to_string()
    } else {
        format!("quota exhausted: {dry_name}")
    };
    ProactiveQuotaVerdict {
        known: true,
        exhausted: true,
        until_epoch_ms: Some(until_ms),
        reason,
    }
}

/// Restore shortened tool names (`>64` char wire limit) and handle `functions.<name>` pseudo-root
/// across OpenAI Responses JSON items, `tool_search_call`, `tool_search_output`, and `additional_tools`
/// (`htmustc-proxy/internal/proxy/responses_namespace.go`).
pub fn restore_responses_namespaces_value(
    val: &mut Value,
    short_to_full: &BTreeMap<String, String>,
    known_full_names: &BTreeMap<String, String>,
) {
    match val {
        Value::Array(arr) => {
            for item in arr {
                restore_responses_namespaces_value(item, short_to_full, known_full_names);
            }
        }
        Value::Object(map) => {
            let item_type = map
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if matches!(
                item_type.as_str(),
                "function_call" | "custom_tool_call" | "function"
            ) {
                if let Some(name_val) = map.get_mut("name") {
                    if let Some(s) = name_val.as_str() {
                        *name_val =
                            Value::String(resolve_restored_name(s, short_to_full, known_full_names));
                    }
                }
            }
            if matches!(item_type.as_str(), "tool_search_call" | "tool_search_output") {
                if let Some(Value::Array(tools)) = map.get_mut("tools") {
                    for tool_obj in tools {
                        if let Some(name_val) = tool_obj.get_mut("name") {
                            if let Some(s) = name_val.as_str() {
                                *name_val = Value::String(resolve_restored_name(
                                    s,
                                    short_to_full,
                                    known_full_names,
                                ));
                            }
                        }
                    }
                }
            }
            if let Some(Value::Array(additional)) = map.get_mut("additional_tools") {
                for t in additional {
                    if let Some(name_val) = t.get_mut("name") {
                        if let Some(s) = name_val.as_str() {
                            *name_val = Value::String(resolve_restored_name(
                                s,
                                short_to_full,
                                known_full_names,
                            ));
                        }
                    }
                }
            }
            for (_k, child) in map.iter_mut() {
                restore_responses_namespaces_value(child, short_to_full, known_full_names);
            }
        }
        _ => {}
    }
}

fn resolve_restored_name(
    raw: &str,
    short_to_full: &BTreeMap<String, String>,
    known_full_names: &BTreeMap<String, String>,
) -> String {
    if let Some(full) = short_to_full.get(raw) {
        return full.clone();
    }
    if let Some(stripped) = raw.strip_prefix("functions.") {
        if let Some(full) = short_to_full.get(stripped).or_else(|| known_full_names.get(stripped)) {
            return full.clone();
        }
        return stripped.to_string();
    }
    raw.to_string()
}

/// Apply Gemini wire fixes (`gemini_wire_fixes.go`) to a Gemini `generateContent` payload:
/// ensures non-empty valid base64/protobuf `thoughtSignature` or injects `skip_thought_signature_validator`
/// on `functionCall` parts missing a valid signature, and normalizes `thinkingConfig`.
pub fn sanitize_gemini_wire_payload(body: &mut Value) {
    let Some(contents) = body.get_mut("contents").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for msg in contents {
        let is_model = msg
            .get("role")
            .and_then(|v| v.as_str())
            .is_some_and(|r| r.eq_ignore_ascii_case("model") || r.eq_ignore_ascii_case("assistant"));
        if !is_model {
            continue;
        }
        let Some(parts) = msg.get_mut("parts").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for part in parts {
            let Some(obj) = part.as_object_mut() else {
                continue;
            };
            if obj.contains_key("functionCall") {
                let valid_sig = obj
                    .get("thoughtSignature")
                    .or_else(|| obj.get("thought_signature"))
                    .and_then(|v| v.as_str())
                    .is_some_and(is_plausible_gemini_signature);
                if !valid_sig {
                    obj.remove("thought_signature");
                    obj.insert(
                        "thoughtSignature".into(),
                        Value::String(SKIP_THOUGHT_SIGNATURE_VALIDATOR.into()),
                    );
                }
            }
        }
    }

    if let Some(gen_cfg) = body.get_mut("generationConfig").and_then(Value::as_object_mut) {
        normalize_gemini_thinking_config(gen_cfg);
    }
}

fn is_plausible_gemini_signature(sig: &str) -> bool {
    let s = sig.trim();
    if s == SKIP_THOUGHT_SIGNATURE_VALIDATOR {
        return true;
    }
    // Real Gemini opaque thought signatures are base64-encoded blobs (or >= 16 safe base64 chars),
    // never short plain tags or whitespace-containing prose.
    s.len() >= 16
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

fn normalize_gemini_thinking_config(gen_cfg: &mut Map<String, Value>) {
    if let Some(snake) = gen_cfg.remove("thinking_config") {
        gen_cfg.entry("thinkingConfig").or_insert(snake);
    }
    if let Some(tc) = gen_cfg.get_mut("thinkingConfig").and_then(Value::as_object_mut) {
        if let Some(tb) = tc.remove("thinking_budget") {
            tc.entry("thinkingBudget").or_insert(tb);
        }
        if let Some(tl) = tc.remove("thinking_level") {
            tc.entry("thinkingLevel").or_insert(tl);
        }
        if let Some(inc) = tc.remove("include_thoughts") {
            tc.entry("includeThoughts").or_insert(inc);
        }
        // Gemini rejects both thinkingBudget and thinkingLevel side-by-side.
        if tc.contains_key("thinkingBudget") && tc.contains_key("thinkingLevel") {
            tc.remove("thinkingLevel");
        }
    }
}

fn collapse_ascii_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.trim().chars() {
        if ch.is_ascii_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

fn truncate_utf8_at(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversation_fingerprint_uses_fnv64a_and_caps_user_prefix_at_256() {
        let fp_explicit = conversation_fingerprint(Some("sess-42"), "sys", "hello");
        assert_eq!(fp_explicit, "sess-42");

        let long_a = format!("{}AAA", "x".repeat(300));
        let long_b = format!("{}BBB", "x".repeat(300));
        let fpa = conversation_fingerprint(None, "You are Omnia\n", &long_a);
        let fpb = conversation_fingerprint(None, "You  are  Omnia", &long_b);
        assert!(fpa.starts_with("fp:"));
        assert_eq!(fpa, fpb, "FNV-64a must cap first user message at 256 bytes");
    }

    #[test]
    fn sse_pre_commit_catches_empty_incomplete_and_smuggled_200_overload() {
        assert_eq!(
            inspect_sse_pre_commit(b": keep-alive\n\n"),
            SseCommitVerdict::EmptySse
        );
        assert!(matches!(
            inspect_sse_pre_commit(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"),
            SseCommitVerdict::IncompleteSse { .. }
        ));
        assert_eq!(
            inspect_sse_pre_commit(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"),
            SseCommitVerdict::EmptyCompletion
        );
        assert!(matches!(
            inspect_sse_pre_commit(
                b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
            ),
            SseCommitVerdict::SmuggledOverload { status_hint: 503, .. }
        ));
        assert_eq!(
            inspect_sse_pre_commit(
                b"event: message_start\ndata: {\"type\":\"message_start\"}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
            ),
            SseCommitVerdict::Ok
        );
    }

    #[test]
    fn proactive_quota_gate_honors_multi_bucket_and_request_scoped_errors() {
        assert!(!classify_upstream_failure(400, "invalid_request_error: context_length_exceeded").trips_account_circuit());
        assert!(classify_upstream_failure(429, "rate_limit_exceeded").trips_account_circuit());

        let partial = QuotaProbeSnapshot {
            limit_reached: false,
            buckets: vec![
                QuotaBucket { name: "flash".into(), total: 100, remaining: 0, unlimited: false, reset_at_epoch_ms: Some(9_000) },
                QuotaBucket { name: "pro".into(), total: 100, remaining: 25, unlimited: false, reset_at_epoch_ms: Some(10_000) },
            ],
        };
        let v_partial = evaluate_proactive_quota_gate(&partial, 1_000);
        assert!(v_partial.known && !v_partial.exhausted);

        let full_dry = QuotaProbeSnapshot {
            limit_reached: false,
            buckets: vec![
                QuotaBucket { name: "flash".into(), total: 100, remaining: 0, unlimited: false, reset_at_epoch_ms: Some(5_000) },
                QuotaBucket { name: "pro".into(), total: 100, remaining: 0, unlimited: false, reset_at_epoch_ms: Some(12_000) },
            ],
        };
        let v_dry = evaluate_proactive_quota_gate(&full_dry, 1_000);
        assert!(v_dry.exhausted);
        assert_eq!(v_dry.until_epoch_ms, Some(5_000));
    }

    #[test]
    fn restores_responses_namespaces_and_sanitizes_gemini_signatures() {
        let mut short_map = BTreeMap::new();
        short_map.insert(
            "mcp_short".into(),
            "mcp_server_very_long_namespace_exceeding_sixty_four_chars_tool".into(),
        );
        let mut known = BTreeMap::new();
        known.insert("read_file".into(), "read_file".into());

        let mut payload = json!({
            "output": [
                { "type": "function_call", "name": "mcp_short", "arguments": "{}" },
                { "type": "function_call", "name": "functions.read_file", "arguments": "{}" },
                { "type": "tool_search_output", "tools": [{ "name": "functions.mcp_short" }] }
            ],
            "additional_tools": [{ "name": "functions.read_file" }]
        });
        restore_responses_namespaces_value(&mut payload, &short_map, &known);
        assert_eq!(
            payload["output"][0]["name"],
            "mcp_server_very_long_namespace_exceeding_sixty_four_chars_tool"
        );
        assert_eq!(payload["output"][1]["name"], "read_file");
        assert_eq!(
            payload["output"][2]["tools"][0]["name"],
            "mcp_server_very_long_namespace_exceeding_sixty_four_chars_tool"
        );
        assert_eq!(payload["additional_tools"][0]["name"], "read_file");

        let mut gem = json!({
            "contents": [{
                "role": "model",
                "parts": [{ "functionCall": { "name": "read_file", "args": {} }, "thoughtSignature": "bad space" }]
            }],
            "generationConfig": { "thinking_config": { "thinking_level": "HIGH", "include_thoughts": true } }
        });
        sanitize_gemini_wire_payload(&mut gem);
        assert_eq!(
            gem["contents"][0]["parts"][0]["thoughtSignature"],
            SKIP_THOUGHT_SIGNATURE_VALIDATOR
        );
        assert_eq!(gem["generationConfig"]["thinkingConfig"]["thinkingLevel"], "HIGH");
    }
}
