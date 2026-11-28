#![forbid(unsafe_code)]

//! Dialect-specific provider wire payload adapters and local VRAM guard.
//!
//! Normalizes requests across Anthropic `/v1/messages`, OpenAI `/v1/responses`,
//! Gemini `/v1/chat/completions`, and local GGUF auxiliary runtimes without
//! dropping cryptographic thinking signatures, dotted MCP tool namespaces, or
//! `thoughtSignature` metadata, while enforcing `token_budget: null` default
//! continuity and local GPU VRAM safety margins.

use std::collections::BTreeSet;
use std::fmt;

use omnia_core::sha256_hex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use thiserror::Error;

/// Reserved Windows DWM and UI compositor VRAM headroom in megabytes.
pub const DEFAULT_DWM_UI_HEADROOM_MB: u64 = 1024;
/// Enforced concurrency limit for local GPU model allocations.
pub const ENFORCED_LOCAL_VRAM_SEMAPHORE: u32 = 1;
/// Conservative maximum VRAM budget for compact local auxiliary GGUF models.
pub const DEFAULT_MAX_AUX_MODEL_VRAM_MB: u64 = 3072;

const GEMINI_TOP_LEVEL_WHITELIST: &[&str] = &[
    "model",
    "messages",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "n",
    "stop",
    "stream",
    "stream_options",
    "response_format",
    "seed",
    "modalities",
    "audio",
    "presence_penalty",
    "frequency_penalty",
    "logprobs",
    "top_logprobs",
    "user",
    "metadata",
    "extra_body",
];

const GEMINI_GOOGLE_EXTRA_WHITELIST: &[&str] = &["thinking_config", "cached_content"];

const ANTHROPIC_FOREIGN_KEYS: &[&str] = &[
    "reasoning",
    "reasoning_effort",
    "thinking_config",
    "thinkingConfig",
    "generation_config",
    "generationConfig",
    "safety_settings",
    "safetySettings",
    "input",
    "instructions",
    "previous_response_id",
    "extra_body",
    "thoughtSignature",
    "thought_signature",
    "token_budget",
    "user_explicit_budget_opt_in",
];

const OPENAI_FOREIGN_KEYS: &[&str] = &[
    "thinking",
    "thinking_config",
    "thinkingConfig",
    "generation_config",
    "generationConfig",
    "safety_settings",
    "safetySettings",
    "anthropic_version",
    "system",
    "extra_body",
    "thoughtSignature",
    "thought_signature",
];

const LOCAL_AUX_FOREIGN_KEYS: &[&str] = &[
    "reasoning",
    "reasoning_effort",
    "thinking",
    "thinking_config",
    "thinkingConfig",
    "previous_response_id",
    "anthropic_version",
    "extra_body",
    "thoughtSignature",
    "thought_signature",
];

/// Supported upstream and local wire dialects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderWireDialect {
    /// OpenAI `/v1/responses`.
    OpenAiResponses,
    /// Anthropic `/v1/messages`.
    AnthropicMessages,
    /// Gemini OpenAI-compatible `/v1/chat/completions`.
    GeminiChatCompletions,
    /// Local auxiliary GGUF runtime behind the VRAM semaphore guard.
    LocalAuxGguf,
}

impl ProviderWireDialect {
    /// Stable identifier string for serialization and telemetry receipts.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openai_responses",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiChatCompletions => "gemini_chat_completions",
            Self::LocalAuxGguf => "local_aux_gguf",
        }
    }

    /// Canonical wire endpoint path or local runtime channel name.
    #[must_use]
    pub const fn endpoint_path(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "/v1/responses",
            Self::AnthropicMessages => "/v1/messages",
            Self::GeminiChatCompletions => "/v1/chat/completions",
            Self::LocalAuxGguf => "local://gguf/aux",
        }
    }
}

impl fmt::Display for ProviderWireDialect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ProviderWireDialect {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Typed validation and normalization errors emitted by wire adapters.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum WireAdapterError {
    /// Top-level wire payload must be a JSON object.
    #[error("wire payload must be a JSON object")]
    ExpectedJsonObject,

    /// Anthropic extended thinking requires `max_tokens > budget_tokens`.
    #[error(
        "anthropic thinking budget invalid: max_tokens ({max_tokens:?}) must exceed budget_tokens ({budget_tokens:?})"
    )]
    AnthropicThinkingBudgetInvalid {
        /// Effective `max_tokens` on the request, if provided.
        max_tokens: Option<u64>,
        /// Effective `thinking.budget_tokens`, if provided.
        budget_tokens: Option<u64>,
    },

    /// Anthropic extended thinking forbids forced tool choice (`any` or `tool`).
    #[error(
        "anthropic thinking forbids forced tool_choice '{tool_choice_type}'; only 'auto' or 'none' is permitted"
    )]
    AnthropicForcedToolChoiceWithThinking {
        /// Rejected `tool_choice` mode.
        tool_choice_type: String,
    },

    /// Anthropic extended thinking forbids trailing manual assistant text prefill.
    #[error("anthropic thinking forbids manual assistant text prefill in trailing message")]
    AnthropicAssistantPrefillDisallowed,

    /// Anthropic extended thinking requires `temperature == 1.0` when specified.
    #[error("anthropic thinking requires temperature == 1.0 when provided (got {temperature})")]
    AnthropicInvalidTemperatureWithThinking {
        /// Rejected temperature value.
        temperature: f64,
    },

    /// Local auxiliary GGUF request rejected by the VRAM guard.
    #[error("local VRAM guard rejected model '{model_id}': {reason}")]
    LocalVramInsufficient {
        /// Candidate local model identifier.
        model_id: String,
        /// Rejection explanation.
        reason: String,
    },

    /// Anthropic prompt-caching permits at most 4 `cache_control` breakpoints total.
    #[error(
        "anthropic prompt caching allows at most {max} cache_control breakpoints across tools->system->messages (got {count})"
    )]
    AnthropicCacheBreakpointsExceeded {
        /// Total observed `cache_control` blocks.
        count: usize,
        /// Maximum supported breakpoint count (`4`).
        max: usize,
    },

    /// Anthropic prompt-caching forbids a longer `1h` TTL breakpoint after an earlier `5m` TTL.
    #[error(
        "anthropic cache_control TTL ordering violation in {section}: '{next_ttl}' cannot follow earlier '{previous_ttl}'"
    )]
    AnthropicInvalidCacheTtlOrder {
        /// Earlier breakpoint TTL observed along `tools -> system -> messages`.
        previous_ttl: String,
        /// Invalid subsequent TTL (`1h`).
        next_ttl: String,
        /// Section where the violation occurred.
        section: String,
    },
}

/// Output produced by [`normalize_provider_wire_payload`].
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedWirePayload {
    /// Target wire dialect.
    pub dialect: ProviderWireDialect,
    /// Normalized wire JSON payload ready for transport serialization.
    pub payload: Value,
    /// Keys or nested conflicting entries stripped from the outbound payload.
    pub stripped_keys: Vec<String>,
    /// Critical provider fields verified and preserved verbatim.
    pub preserved_fields: Vec<String>,
    /// Non-fatal normalization notes.
    pub warnings: Vec<String>,
}

impl NormalizedWirePayload {
    /// Consume into the normalized JSON payload value.
    #[must_use]
    pub fn into_value(self) -> Value {
        self.payload
    }

    /// Serialize metadata and payload as a JSON summary value.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "dialect": self.dialect.as_str(),
            "endpoint": self.dialect.endpoint_path(),
            "payload": self.payload,
            "stripped_keys": self.stripped_keys,
            "preserved_fields": self.preserved_fields,
            "warnings": self.warnings,
        })
    }
}

impl Serialize for NormalizedWirePayload {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Resource policy controlling local GGUF model admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVramPolicy {
    /// Physical GPU VRAM capacity in megabytes.
    pub total_vram_mb: u64,
    /// Reserved DWM + desktop UI VRAM headroom in megabytes (minimum 1024 MB).
    pub dwm_ui_headroom_mb: u64,
    /// Hard upper bound for compact auxiliary models in megabytes (default 3072 MB).
    pub max_aux_model_vram_mb: u64,
    /// Configured semaphore slots (clamped/enforced to 1).
    pub local_vram_semaphore: u32,
    /// Currently active local GPU allocations.
    pub active_local_allocations: u32,
}

impl Default for LocalVramPolicy {
    fn default() -> Self {
        Self::for_gpu_mb(4096)
    }
}

impl LocalVramPolicy {
    /// Construct a policy for a GPU with `total_vram_mb` physical memory.
    #[must_use]
    pub const fn for_gpu_mb(total_vram_mb: u64) -> Self {
        Self {
            total_vram_mb,
            dwm_ui_headroom_mb: DEFAULT_DWM_UI_HEADROOM_MB,
            max_aux_model_vram_mb: DEFAULT_MAX_AUX_MODEL_VRAM_MB,
            local_vram_semaphore: ENFORCED_LOCAL_VRAM_SEMAPHORE,
            active_local_allocations: 0,
        }
    }

    /// Convert into JSON representation.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "total_vram_mb": self.total_vram_mb,
            "dwm_ui_headroom_mb": self.dwm_ui_headroom_mb.max(DEFAULT_DWM_UI_HEADROOM_MB),
            "max_aux_model_vram_mb": self.max_aux_model_vram_mb,
            "local_vram_semaphore": ENFORCED_LOCAL_VRAM_SEMAPHORE,
            "active_local_allocations": self.active_local_allocations,
        })
    }
}

impl Serialize for LocalVramPolicy {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Admission verdict emitted by [`evaluate_local_vram_fit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVramFitDecision {
    /// Whether loading `model_id` is permitted under the VRAM policy.
    pub allowed: bool,
    /// Candidate local model identifier.
    pub model_id: String,
    /// Explicit or conservatively inferred VRAM requirement in megabytes.
    pub estimated_vram_mb: Option<u64>,
    /// Total physical VRAM capacity in megabytes.
    pub total_vram_mb: u64,
    /// Reserved DWM + UI VRAM headroom in megabytes.
    pub dwm_ui_headroom_mb: u64,
    /// Usable VRAM after subtracting reserved DWM + UI headroom.
    pub available_vram_mb: u64,
    /// Enforced auxiliary model ceiling in megabytes.
    pub max_aux_model_vram_mb: u64,
    /// Enforced local concurrency semaphore (always 1).
    pub enforced_semaphore: u32,
    /// Deterministic explanation for admission or rejection.
    pub reason: String,
}

impl LocalVramFitDecision {
    /// Convert into JSON representation.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "allowed": self.allowed,
            "model_id": self.model_id,
            "estimated_vram_mb": self.estimated_vram_mb,
            "total_vram_mb": self.total_vram_mb,
            "dwm_ui_headroom_mb": self.dwm_ui_headroom_mb,
            "available_vram_mb": self.available_vram_mb,
            "max_aux_model_vram_mb": self.max_aux_model_vram_mb,
            "enforced_semaphore": self.enforced_semaphore,
            "reason": self.reason,
        })
    }
}

impl Serialize for LocalVramFitDecision {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Normalize and validate an outbound provider JSON request for `dialect`.
pub fn normalize_provider_wire_payload(
    dialect: ProviderWireDialect,
    payload: &Value,
) -> Result<NormalizedWirePayload, WireAdapterError> {
    let input = payload
        .as_object()
        .ok_or(WireAdapterError::ExpectedJsonObject)?;

    match dialect {
        ProviderWireDialect::AnthropicMessages => normalize_anthropic_messages(input),
        ProviderWireDialect::OpenAiResponses => normalize_openai_responses(input),
        ProviderWireDialect::GeminiChatCompletions => normalize_gemini_chat_completions(input),
        ProviderWireDialect::LocalAuxGguf => normalize_local_aux_gguf(input),
    }
}

/// Evaluate whether a local GGUF model fits safely within GPU VRAM and UI headroom.
#[must_use]
pub fn evaluate_local_vram_fit(
    policy: &LocalVramPolicy,
    model_id: &str,
    estimated_vram_mb: Option<u64>,
) -> LocalVramFitDecision {
    let reserved_headroom = policy.dwm_ui_headroom_mb.max(DEFAULT_DWM_UI_HEADROOM_MB);
    let available_vram_mb = policy.total_vram_mb.saturating_sub(reserved_headroom);
    let resolved_vram = estimated_vram_mb.or_else(|| infer_conservative_vram_mb(model_id));

    let reject = |reason: String, est: Option<u64>| LocalVramFitDecision {
        allowed: false,
        model_id: model_id.to_string(),
        estimated_vram_mb: est,
        total_vram_mb: policy.total_vram_mb,
        dwm_ui_headroom_mb: reserved_headroom,
        available_vram_mb,
        max_aux_model_vram_mb: policy.max_aux_model_vram_mb,
        enforced_semaphore: ENFORCED_LOCAL_VRAM_SEMAPHORE,
        reason,
    };

    if policy.local_vram_semaphore == 0 {
        return reject(
            "local_vram_semaphore is 0; local execution is disabled".to_string(),
            resolved_vram,
        );
    }

    if policy.active_local_allocations >= ENFORCED_LOCAL_VRAM_SEMAPHORE {
        return reject(
            format!(
                "local_vram_semaphore={} already occupied ({} active allocation(s))",
                ENFORCED_LOCAL_VRAM_SEMAPHORE, policy.active_local_allocations
            ),
            resolved_vram,
        );
    }

    let Some(required_mb) = resolved_vram else {
        return reject(
            format!("unknown VRAM footprint for '{model_id}'; explicit estimated_vram_mb required"),
            None,
        );
    };

    if required_mb == 0 {
        return reject(
            "estimated_vram_mb must be positive (> 0 MB)".to_string(),
            Some(required_mb),
        );
    }

    if required_mb > available_vram_mb {
        return reject(
            format!(
                "requires {required_mb} MB VRAM, exceeding {available_vram_mb} MB available on {total} MB GPU after reserving {reserved_headroom} MB DWM/UI headroom",
                total = policy.total_vram_mb,
            ),
            Some(required_mb),
        );
    }

    if required_mb > policy.max_aux_model_vram_mb {
        return reject(
            format!(
                "requires {required_mb} MB VRAM, exceeding compact auxiliary limit of {limit} MB",
                limit = policy.max_aux_model_vram_mb,
            ),
            Some(required_mb),
        );
    }

    let semaphore_note = if policy.local_vram_semaphore > ENFORCED_LOCAL_VRAM_SEMAPHORE {
        format!(
            " (requested semaphore {} clamped to {})",
            policy.local_vram_semaphore, ENFORCED_LOCAL_VRAM_SEMAPHORE
        )
    } else {
        String::new()
    };

    LocalVramFitDecision {
        allowed: true,
        model_id: model_id.to_string(),
        estimated_vram_mb: Some(required_mb),
        total_vram_mb: policy.total_vram_mb,
        dwm_ui_headroom_mb: reserved_headroom,
        available_vram_mb,
        max_aux_model_vram_mb: policy.max_aux_model_vram_mb,
        enforced_semaphore: ENFORCED_LOCAL_VRAM_SEMAPHORE,
        reason: format!(
            "admitted under local_vram_semaphore=1{semaphore_note}: {required_mb} MB <= min({available_vram_mb} MB available, {limit} MB aux limit)",
            limit = policy.max_aux_model_vram_mb,
        ),
    }
}

fn infer_conservative_vram_mb(model_id: &str) -> Option<u64> {
    let lower = model_id.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("8b") {
        if lower.contains("q4_k_s") {
            return Some(4900);
        }
        if lower.contains("q4") || lower.contains("gguf") {
            return Some(5150);
        }
        return Some(5150);
    }
    if lower.contains("7b") {
        return Some(4600);
    }
    if lower.contains("3b") || lower.contains("4b") {
        return Some(2400);
    }
    if lower.contains("1.5b")
        || lower.contains("1.7b")
        || lower.contains("1b")
        || lower.contains("2b")
    {
        return Some(1500);
    }
    if lower.contains("0.5b") || lower.contains("0.6b") {
        return Some(850);
    }
    None
}

fn normalize_anthropic_messages(
    input: &Map<String, Value>,
) -> Result<NormalizedWirePayload, WireAdapterError> {
    let mut out = Map::new();
    let mut stripped_keys = Vec::new();
    let mut preserved = BTreeSet::new();
    let mut warnings = Vec::new();

    for (key, value) in input {
        if ANTHROPIC_FOREIGN_KEYS.contains(&key.as_str()) {
            stripped_keys.push(key.clone());
            continue;
        }
        out.insert(key.clone(), value.clone());
    }

    let thinking_state = detect_anthropic_thinking(input.get("thinking"));
    if thinking_state.enabled {
        let max_tokens = out.get("max_tokens").and_then(Value::as_u64);
        match (max_tokens, thinking_state.budget_tokens) {
            (Some(max_tok), Some(budget)) if max_tok > budget && budget > 0 => {}
            (Some(_), None) if thinking_state.adaptive => {}
            _ => {
                return Err(WireAdapterError::AnthropicThinkingBudgetInvalid {
                    max_tokens,
                    budget_tokens: thinking_state.budget_tokens,
                });
            }
        }

        if let Some(tool_choice) = out.get("tool_choice") {
            validate_anthropic_tool_choice_for_thinking(tool_choice)?;
        }

        if let Some(temp_val) = out.get("temperature") {
            let temp = temp_val.as_f64().ok_or(
                WireAdapterError::AnthropicInvalidTemperatureWithThinking {
                    temperature: f64::NAN,
                },
            )?;
            if (temp - 1.0).abs() > 1e-6 {
                return Err(WireAdapterError::AnthropicInvalidTemperatureWithThinking {
                    temperature: temp,
                });
            }
            preserved.insert("temperature=1.0".to_string());
        }

        if let Some(messages) = out.get("messages").and_then(Value::as_array) {
            if let Some(last) = messages.last() {
                if is_anthropic_manual_assistant_prefill(last) {
                    return Err(WireAdapterError::AnthropicAssistantPrefillDisallowed);
                }
            }
        }
    }

    if let Some(messages) = out.get("messages").and_then(Value::as_array) {
        for msg in messages {
            if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                for block in blocks {
                    let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                    match block_type {
                        "thinking" => {
                            if block.get("signature").and_then(Value::as_str).is_some() {
                                preserved
                                    .insert("messages[*].content.thinking+signature".to_string());
                            } else {
                                warnings.push(
                                    "encountered anthropic thinking block without signature field"
                                        .to_string(),
                                );
                                preserved.insert("messages[*].content.thinking".to_string());
                            }
                        }
                        "redacted_thinking" => {
                            preserved.insert("messages[*].content.redacted_thinking".to_string());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let breakpoints = validate_anthropic_cache_breakpoints(&out)?;
    if breakpoints > 0 {
        preserved.insert(format!("cache_breakpoints={breakpoints}"));
    }
    collect_tool_namespaces(out.get("tools"), &mut preserved);

    Ok(NormalizedWirePayload {
        dialect: ProviderWireDialect::AnthropicMessages,
        payload: Value::Object(out),
        stripped_keys,
        preserved_fields: preserved.into_iter().collect(),
        warnings,
    })
}

struct AnthropicThinkingState {
    enabled: bool,
    adaptive: bool,
    budget_tokens: Option<u64>,
}

fn detect_anthropic_thinking(value: Option<&Value>) -> AnthropicThinkingState {
    let Some(obj) = value.and_then(Value::as_object) else {
        return AnthropicThinkingState {
            enabled: false,
            adaptive: false,
            budget_tokens: None,
        };
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let budget_tokens = obj.get("budget_tokens").and_then(Value::as_u64);
    if kind.eq_ignore_ascii_case("disabled") {
        return AnthropicThinkingState {
            enabled: false,
            adaptive: false,
            budget_tokens,
        };
    }
    let adaptive = kind.eq_ignore_ascii_case("adaptive");
    let enabled = kind.eq_ignore_ascii_case("enabled") || adaptive || budget_tokens.is_some();
    AnthropicThinkingState {
        enabled,
        adaptive,
        budget_tokens,
    }
}

fn validate_anthropic_tool_choice_for_thinking(
    tool_choice: &Value,
) -> Result<(), WireAdapterError> {
    let kind = match tool_choice {
        Value::String(s) => s.as_str(),
        Value::Object(obj) => obj.get("type").and_then(Value::as_str).unwrap_or("unknown"),
        _ => "invalid",
    };

    if kind.eq_ignore_ascii_case("auto") || kind.eq_ignore_ascii_case("none") {
        return Ok(());
    }

    Err(WireAdapterError::AnthropicForcedToolChoiceWithThinking {
        tool_choice_type: kind.to_string(),
    })
}

fn is_anthropic_manual_assistant_prefill(last_message: &Value) -> bool {
    let Some(obj) = last_message.as_object() else {
        return false;
    };
    let role = obj.get("role").and_then(Value::as_str).unwrap_or("");
    if !role.eq_ignore_ascii_case("assistant") {
        return false;
    }

    match obj.get("content") {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(blocks)) => {
            if blocks.is_empty() {
                return false;
            }
            let has_text = blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("text"));
            let has_tool_use = blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"));
            // Trailing assistant text prefill (even alongside blocks, if it ends or consists of text without user follow-up)
            if has_text && !has_tool_use {
                return true;
            }
            blocks
                .last()
                .and_then(|b| b.get("type").and_then(Value::as_str))
                == Some("text")
        }
        _ => false,
    }
}

fn normalize_openai_responses(
    input: &Map<String, Value>,
) -> Result<NormalizedWirePayload, WireAdapterError> {
    let mut out = Map::new();
    let mut stripped_keys = Vec::new();
    let mut preserved = BTreeSet::new();
    let mut warnings = Vec::new();

    let user_explicit_budget_opt_in = input
        .get("user_explicit_budget_opt_in")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    for (key, value) in input {
        if key == "user_explicit_budget_opt_in" || OPENAI_FOREIGN_KEYS.contains(&key.as_str()) {
            stripped_keys.push(key.clone());
            continue;
        }
        out.insert(key.clone(), value.clone());
    }

    // Lift chat-style `reasoning_effort` if `reasoning` is absent, or strip duplicate.
    let mut reasoning_effort_active = is_openai_reasoning_active(out.get("reasoning"));
    if let Some(top_effort) = out.remove("reasoning_effort") {
        stripped_keys.push("reasoning_effort".to_string());
        if let Some(effort_str) = top_effort.as_str() {
            if !effort_str.is_empty() && !effort_str.eq_ignore_ascii_case("none") {
                reasoning_effort_active = true;
                if !out.contains_key("reasoning") {
                    out.insert("reasoning".to_string(), json!({ "effort": effort_str }));
                }
            }
        }
    }

    if reasoning_effort_active {
        if out.remove("temperature").is_some() {
            stripped_keys.push("temperature".to_string());
        }
        preserved.insert("reasoning".to_string());
    }

    // Enforce `token_budget: null` unless explicitly opted in by user.
    if user_explicit_budget_opt_in {
        match out.get("token_budget") {
            Some(val) if !val.is_null() => {
                preserved.insert("token_budget(user_explicit_opt_in)".to_string());
            }
            _ => {
                out.insert("token_budget".to_string(), Value::Null);
            }
        }
    } else {
        if let Some(prev) = out.get("token_budget") {
            if !prev.is_null() {
                stripped_keys.push("token_budget(overridden_to_null)".to_string());
                warnings.push(
                    "enforced token_budget: null because user_explicit_budget_opt_in is not true"
                        .to_string(),
                );
            }
        }
        out.insert("token_budget".to_string(), Value::Null);
        preserved.insert("token_budget:null".to_string());
    }

    collect_tool_namespaces(out.get("tools"), &mut preserved);
    if let Some(choice_name) = out
        .get("tool_choice")
        .and_then(|tc| tc.get("name"))
        .and_then(Value::as_str)
    {
        if choice_name.contains('.') {
            preserved.insert(format!("tool_choice:{choice_name}"));
        }
    }

    Ok(NormalizedWirePayload {
        dialect: ProviderWireDialect::OpenAiResponses,
        payload: Value::Object(out),
        stripped_keys,
        preserved_fields: preserved.into_iter().collect(),
        warnings,
    })
}

fn is_openai_reasoning_active(reasoning: Option<&Value>) -> bool {
    let Some(obj) = reasoning.and_then(Value::as_object) else {
        return false;
    };
    if let Some(effort) = obj.get("effort").and_then(Value::as_str) {
        return !effort.trim().is_empty() && !effort.eq_ignore_ascii_case("none");
    }
    obj.contains_key("summary") || obj.contains_key("generate_summary")
}

fn normalize_gemini_chat_completions(
    input: &Map<String, Value>,
) -> Result<NormalizedWirePayload, WireAdapterError> {
    let mut out = Map::new();
    let mut stripped_keys = Vec::new();
    let mut preserved = BTreeSet::new();
    let mut warnings = Vec::new();

    for (key, value) in input {
        if !GEMINI_TOP_LEVEL_WHITELIST.contains(&key.as_str()) {
            stripped_keys.push(key.clone());
            continue;
        }
        if key == "extra_body" {
            let sanitized = sanitize_gemini_extra_body(value, &mut stripped_keys, &mut warnings);
            if !sanitized.is_null() {
                out.insert(key.clone(), sanitized);
            }
        } else {
            out.insert(key.clone(), value.clone());
        }
    }

    if let Some(messages) = out.get("messages").and_then(Value::as_array) {
        for msg in messages {
            if let Some(tc_id) = msg.get("tool_call_id").and_then(Value::as_str) {
                preserved.insert(format!("tool_call_id:{tc_id}"));
            }
            if msg.get("thoughtSignature").is_some() || msg.get("thought_signature").is_some() {
                preserved.insert("thoughtSignature".to_string());
            }
            if let Some(tool_calls) = msg.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        preserved.insert(format!("tool_call.id:{id}"));
                    }
                    let has_thought_sig = call.get("thoughtSignature").is_some()
                        || call.get("thought_signature").is_some()
                        || call
                            .get("extra_content")
                            .and_then(|ec| ec.get("google"))
                            .and_then(|g| {
                                g.get("thought_signature")
                                    .or_else(|| g.get("thoughtSignature"))
                            })
                            .is_some();
                    if has_thought_sig {
                        preserved.insert("thoughtSignature".to_string());
                    }
                }
            }
        }
    }

    collect_tool_namespaces(out.get("tools"), &mut preserved);

    Ok(NormalizedWirePayload {
        dialect: ProviderWireDialect::GeminiChatCompletions,
        payload: Value::Object(out),
        stripped_keys,
        preserved_fields: preserved.into_iter().collect(),
        warnings,
    })
}

fn sanitize_gemini_extra_body(
    extra_body: &Value,
    stripped_keys: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Value {
    let Some(obj) = extra_body.as_object() else {
        stripped_keys.push("extra_body".to_string());
        return Value::Null;
    };

    let mut clean_extra = Map::new();
    for (key, value) in obj {
        if key != "google" {
            stripped_keys.push(format!("extra_body.{key}"));
            continue;
        }
        let Some(google_obj) = value.as_object() else {
            stripped_keys.push("extra_body.google".to_string());
            continue;
        };
        let mut clean_google = Map::new();
        for (g_key, g_val) in google_obj {
            if !GEMINI_GOOGLE_EXTRA_WHITELIST.contains(&g_key.as_str()) {
                stripped_keys.push(format!("extra_body.google.{g_key}"));
                continue;
            }
            if g_key == "thinking_config" {
                if let Some(tc_obj) = g_val.as_object() {
                    let mut clean_tc = tc_obj.clone();
                    if clean_tc.contains_key("thinking_budget")
                        && clean_tc.contains_key("thinking_level")
                    {
                        clean_tc.remove("thinking_level");
                        stripped_keys
                            .push("extra_body.google.thinking_config.thinking_level".to_string());
                        warnings.push(
                            "resolved thinking_config conflict by dropping thinking_level in favor of thinking_budget"
                                .to_string(),
                        );
                    }
                    clean_google.insert(g_key.clone(), Value::Object(clean_tc));
                } else {
                    stripped_keys.push("extra_body.google.thinking_config".to_string());
                }
            } else {
                clean_google.insert(g_key.clone(), g_val.clone());
            }
        }
        if !clean_google.is_empty() {
            clean_extra.insert("google".to_string(), Value::Object(clean_google));
        }
    }

    if clean_extra.is_empty() {
        Value::Null
    } else {
        Value::Object(clean_extra)
    }
}

fn normalize_local_aux_gguf(
    input: &Map<String, Value>,
) -> Result<NormalizedWirePayload, WireAdapterError> {
    let mut out = Map::new();
    let mut stripped_keys = Vec::new();
    let mut preserved = BTreeSet::new();
    let mut warnings = Vec::new();

    let user_explicit_budget_opt_in = input
        .get("user_explicit_budget_opt_in")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    for (key, value) in input {
        if key == "user_explicit_budget_opt_in" || LOCAL_AUX_FOREIGN_KEYS.contains(&key.as_str()) {
            stripped_keys.push(key.clone());
            continue;
        }
        out.insert(key.clone(), value.clone());
    }

    let model_id = out
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let total_vram_mb = out
        .get("total_vram_mb")
        .and_then(Value::as_u64)
        .unwrap_or(4096);
    let estimated_vram_mb = out.get("estimated_vram_mb").and_then(Value::as_u64);
    let requested_semaphore = out
        .get("local_vram_semaphore")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(ENFORCED_LOCAL_VRAM_SEMAPHORE);
    let active_allocations = out
        .get("active_local_allocations")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let headroom = out
        .get("dwm_ui_headroom_mb")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_DWM_UI_HEADROOM_MB)
        .max(DEFAULT_DWM_UI_HEADROOM_MB);

    let policy = LocalVramPolicy {
        total_vram_mb,
        dwm_ui_headroom_mb: headroom,
        max_aux_model_vram_mb: out
            .get("max_aux_model_vram_mb")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_AUX_MODEL_VRAM_MB),
        local_vram_semaphore: requested_semaphore,
        active_local_allocations: active_allocations,
    };

    let decision = evaluate_local_vram_fit(&policy, &model_id, estimated_vram_mb);
    if !decision.allowed {
        return Err(WireAdapterError::LocalVramInsufficient {
            model_id,
            reason: decision.reason,
        });
    }

    out.insert(
        "local_vram_semaphore".to_string(),
        json!(ENFORCED_LOCAL_VRAM_SEMAPHORE),
    );
    out.insert("dwm_ui_headroom_mb".to_string(), json!(headroom));
    preserved.insert("local_vram_semaphore=1".to_string());
    preserved.insert(format!("dwm_ui_headroom_mb={headroom}"));

    if user_explicit_budget_opt_in {
        if out.get("token_budget").is_none_or(Value::is_null) {
            out.insert("token_budget".to_string(), Value::Null);
        }
    } else {
        if out.get("token_budget").is_some_and(|v| !v.is_null()) {
            stripped_keys.push("token_budget(overridden_to_null)".to_string());
            warnings.push(
                "enforced token_budget: null because user_explicit_budget_opt_in is not true"
                    .to_string(),
            );
        }
        out.insert("token_budget".to_string(), Value::Null);
    }

    Ok(NormalizedWirePayload {
        dialect: ProviderWireDialect::LocalAuxGguf,
        payload: Value::Object(out),
        stripped_keys,
        preserved_fields: preserved.into_iter().collect(),
        warnings,
    })
}

fn collect_tool_namespaces(tools: Option<&Value>, preserved: &mut BTreeSet<String>) {
    let Some(arr) = tools.and_then(Value::as_array) else {
        return;
    };
    for tool in arr {
        let name = tool.get("name").and_then(Value::as_str).or_else(|| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
        });
        if let Some(tool_name) = name {
            if tool_name.contains('.') {
                preserved.insert(format!("tool:{tool_name}"));
            }
        }
    }
}

/// Telemetry digest capturing 8-char SHA-256 hashes of request KV-prefix segments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CacheShapeDigest {
    pub instr_h: String,
    pub tools_h: String,
    pub first5_h: String,
    pub first10_h: String,
    pub input_head_h: String,
    pub last2_h: String,
    pub include_h: String,
    pub text_h: String,
    pub meta_h: String,
    pub reasoning_h: String,
    pub tc_h: String,
    pub body_h: String,
    pub prefix_8hex: String,
}

impl CacheShapeDigest {
    /// Emit single-line KV-cache telemetry log string pinpointing which prefix field drifted.
    #[must_use]
    pub fn to_log_line(&self) -> String {
        format!(
            "prefix={} instr={} tools={} first5={} first10={} input_head={} last2={} include={} text={} meta={} reasoning={} tc={} body={}",
            self.prefix_8hex,
            self.instr_h,
            self.tools_h,
            self.first5_h,
            self.first10_h,
            self.input_head_h,
            self.last2_h,
            self.include_h,
            self.text_h,
            self.meta_h,
            self.reasoning_h,
            self.tc_h,
            self.body_h,
        )
    }
}

fn short_hash_opt(val: Option<&Value>) -> String {
    match val {
        None | Some(Value::Null) => "00000000".to_owned(),
        Some(v) => {
            let bytes = serde_json::to_vec(v).unwrap_or_default();
            sha256_hex(&bytes)[..8].to_owned()
        }
    }
}

fn short_hash_slice(items: &[Value]) -> String {
    if items.is_empty() {
        return "00000000".to_owned();
    }
    let bytes = serde_json::to_vec(items).unwrap_or_default();
    sha256_hex(&bytes)[..8].to_owned()
}

fn tool_decl_name(tool: &Value) -> &str {
    tool.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
}

/// Lexicographically sort top-level `tools[]` by tool name (`max = 256` fast cap preserved for
/// stability) so client tool-ordering jitter never invalidates upstream KV prompt caches.
pub fn sort_tools_stable(payload: &mut Value) -> usize {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return 0;
    };
    if tools.len() <= 1 || tools.len() > 256 {
        return tools.len();
    }
    tools.sort_by(|a, b| tool_decl_name(a).cmp(tool_decl_name(b)));
    tools.len()
}

/// Normalize historical tool names outside `^[a-zA-Z0-9_.-]+$` to `_` without mutating tool payloads.
pub fn sanitize_input_tool_names(payload: &mut Value) -> usize {
    fn clean_name(raw: &str) -> Option<String> {
        let mut changed = false;
        let sanitized: String = raw
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                    c
                } else {
                    changed = true;
                    '_'
                }
            })
            .collect();
        changed.then_some(sanitized)
    }

    let mut count = 0usize;
    for field in ["messages", "input"] {
        let Some(items) = payload.get_mut(field).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            if let Some(name) = item.get("name").and_then(Value::as_str).map(ToOwned::to_owned) {
                if let Some(cleaned) = clean_name(&name) {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("name".to_owned(), Value::String(cleaned));
                        count += 1;
                    }
                }
            }
            if let Some(calls) = item.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for call in calls {
                    if let Some(fname) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                    {
                        if let Some(cleaned) = clean_name(&fname) {
                            if let Some(fobj) = call.get_mut("function").and_then(Value::as_object_mut)
                            {
                                fobj.insert("name".to_owned(), Value::String(cleaned));
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    count
}

/// Compute 8-char SHA-256 digests (`cache_shape_hash`) across request KV-prefix segments.
#[must_use]
pub fn compute_cache_shape_hash(payload: &Value) -> CacheShapeDigest {
    let instr_val = payload.get("instructions").or_else(|| payload.get("system"));
    let tools_val = payload.get("tools");
    let seq = payload
        .get("input")
        .or_else(|| payload.get("messages"))
        .and_then(Value::as_array);
    let seq_slice = seq.map(Vec::as_slice).unwrap_or(&[]);
    let first5_end = seq_slice.len().min(5);
    let first10_end = seq_slice.len().min(10);
    let tail_start = seq_slice.len().saturating_sub(2);
    let head_end = seq_slice.len().saturating_sub(2);

    let instr_h = short_hash_opt(instr_val);
    let tools_h = short_hash_opt(tools_val);
    let first5_h = short_hash_slice(&seq_slice[..first5_end]);
    let first10_h = short_hash_slice(&seq_slice[..first10_end]);
    let input_head_h = short_hash_slice(&seq_slice[..head_end]);
    let last2_h = short_hash_slice(&seq_slice[tail_start..]);
    let include_h = short_hash_opt(payload.get("include"));
    let text_h = short_hash_opt(payload.get("text").or_else(|| payload.get("response_format")));
    let meta_h = short_hash_opt(payload.get("metadata"));
    let reasoning_h = short_hash_opt(
        payload
            .get("reasoning")
            .or_else(|| payload.get("thinking"))
            .or_else(|| payload.get("output_config")),
    );
    let tc_h = short_hash_opt(payload.get("tool_choice"));
    let body_h = short_hash_opt(Some(payload));

    let prefix_material = format!("{instr_h}:{tools_h}:{input_head_h}:{tc_h}:{reasoning_h}");
    let prefix_8hex = sha256_hex(prefix_material.as_bytes())[..8].to_owned();

    CacheShapeDigest {
        instr_h,
        tools_h,
        first5_h,
        first10_h,
        input_head_h,
        last2_h,
        include_h,
        text_h,
        meta_h,
        reasoning_h,
        tc_h,
        body_h,
        prefix_8hex,
    }
}

/// Enforce Anthropic's 4-breakpoint `cache_control` cap and TTL monotonicity across
/// `tools -> system -> messages` (never allowing `"1h"` after an earlier `"5m"` breakpoint).
pub fn validate_anthropic_cache_breakpoints(
    input: &Map<String, Value>,
) -> Result<usize, WireAdapterError> {
    const MAX_ANTHROPIC_CACHE_BREAKPOINTS: usize = 4;

    fn extract_ttl(cc: &Value) -> String {
        cc.get("ttl")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "5m".to_owned())
    }

    fn visit_cc(
        cc: &Value,
        section: &str,
        count: &mut usize,
        saw_5m: &mut bool,
    ) -> Result<(), WireAdapterError> {
        *count += 1;
        if *count > MAX_ANTHROPIC_CACHE_BREAKPOINTS {
            return Err(WireAdapterError::AnthropicCacheBreakpointsExceeded {
                count: *count,
                max: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
            });
        }
        let ttl = extract_ttl(cc);
        if *saw_5m && ttl == "1h" {
            return Err(WireAdapterError::AnthropicInvalidCacheTtlOrder {
                previous_ttl: "5m".to_owned(),
                next_ttl: ttl,
                section: section.to_owned(),
            });
        }
        if ttl != "1h" {
            *saw_5m = true;
        }
        Ok(())
    }

    let mut count = 0usize;
    let mut saw_5m = false;

    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if let Some(cc) = tool.get("cache_control") {
                visit_cc(cc, "tools", &mut count, &mut saw_5m)?;
            }
        }
    }
    if let Some(sys_blocks) = input.get("system").and_then(Value::as_array) {
        for block in sys_blocks {
            if let Some(cc) = block.get("cache_control") {
                visit_cc(cc, "system", &mut count, &mut saw_5m)?;
            }
        }
    } else if let Some(cc) = input.get("system").and_then(|s| s.get("cache_control")) {
        visit_cc(cc, "system", &mut count, &mut saw_5m)?;
    }
    if let Some(messages) = input.get("messages").and_then(Value::as_array) {
        for msg in messages {
            if let Some(cc) = msg.get("cache_control") {
                visit_cc(cc, "messages", &mut count, &mut saw_5m)?;
            }
            if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                for block in blocks {
                    if let Some(cc) = block.get("cache_control") {
                        visit_cc(cc, "messages", &mut count, &mut saw_5m)?;
                    }
                }
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_thinking_enforces_rules_and_preserves_signatures() {
        let forced_tool = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8192,
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "tool_choice": { "type": "any" },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &forced_tool),
            Err(WireAdapterError::AnthropicForcedToolChoiceWithThinking { .. })
        ));

        let named_tool = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8192,
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "tool_choice": { "type": "tool", "name": "read_file" },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &named_tool),
            Err(WireAdapterError::AnthropicForcedToolChoiceWithThinking { .. })
        ));

        let prefill = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8192,
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "messages": [
                { "role": "user", "content": "json?" },
                { "role": "assistant", "content": "{" }
            ]
        });
        assert_eq!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &prefill),
            Err(WireAdapterError::AnthropicAssistantPrefillDisallowed)
        );

        let bad_temp = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8192,
            "temperature": 0.3,
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &bad_temp),
            Err(WireAdapterError::AnthropicInvalidTemperatureWithThinking { .. })
        ));

        let bad_budget = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 2048,
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &bad_budget),
            Err(WireAdapterError::AnthropicThinkingBudgetInvalid { .. })
        ));

        let valid = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8192,
            "temperature": 1.0,
            "reasoning_effort": "high",
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "tool_choice": { "type": "auto" },
            "messages": [
                { "role": "user", "content": "run tool" },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "step 1 verbatim",
                            "signature": "sig_synthetic_verbatim_001"
                        },
                        { "type": "tool_use", "id": "tu_1", "name": "mcp.fs.read", "input": {} }
                    ]
                },
                {
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": "tu_1", "content": "ok" }]
                }
            ]
        });
        let norm = normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &valid)
            .expect("valid anthropic thinking payload");
        assert!(norm.stripped_keys.contains(&"reasoning_effort".to_string()));
        assert_eq!(
            norm.payload["messages"][1]["content"][0]["signature"],
            "sig_synthetic_verbatim_001"
        );
        assert!(norm
            .preserved_fields
            .contains(&"messages[*].content.thinking+signature".to_string()));
    }

    #[test]
    fn openai_responses_strips_temperature_keeps_dotted_tools_and_null_budget() {
        let input = json!({
            "model": "gpt-5.4",
            "temperature": 0.4,
            "reasoning": { "effort": "high" },
            "token_budget": 12000,
            "tools": [
                { "type": "function", "name": "mcp.omnia.read_file" }
            ],
            "tool_choice": { "type": "function", "name": "mcp.omnia.read_file" },
            "input": "check status"
        });
        let norm = normalize_provider_wire_payload(ProviderWireDialect::OpenAiResponses, &input)
            .expect("openai responses normalization");
        assert!(norm.payload.get("temperature").is_none());
        assert!(norm.stripped_keys.contains(&"temperature".to_string()));
        assert_eq!(norm.payload["token_budget"], Value::Null);
        assert_eq!(norm.payload["tools"][0]["name"], "mcp.omnia.read_file");
        assert_eq!(norm.payload["tool_choice"]["name"], "mcp.omnia.read_file");
        assert!(norm
            .preserved_fields
            .contains(&"tool:mcp.omnia.read_file".to_string()));

        let opt_in = json!({
            "model": "gpt-5.4",
            "reasoning": { "effort": "medium" },
            "user_explicit_budget_opt_in": true,
            "token_budget": 64000,
            "input": "continue"
        });
        let norm_opt =
            normalize_provider_wire_payload(ProviderWireDialect::OpenAiResponses, &opt_in)
                .expect("opt-in token budget preserved");
        assert_eq!(norm_opt.payload["token_budget"], 64000);
        assert!(norm_opt
            .payload
            .get("user_explicit_budget_opt_in")
            .is_none());
    }

    #[test]
    fn gemini_whitelist_strips_foreign_keys_and_preserves_thought_signature() {
        let input = json!({
            "model": "gemini-2.5-pro",
            "reasoning_effort": "high",
            "thinking_config": { "thinking_budget": 1024 },
            "temperature": 0.2,
            "extra_body": {
                "google": {
                    "thinking_config": {
                        "thinking_budget": 2048,
                        "thinking_level": "HIGH"
                    }
                },
                "unexpected": true
            },
            "messages": [
                { "role": "user", "content": "call" },
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_exact_42",
                        "type": "function",
                        "function": { "name": "mcp.git.status", "arguments": "{}" },
                        "thoughtSignature": "tsig_exact_base64_dummy",
                        "extra_content": {
                            "google": { "thought_signature": "tsig_exact_base64_dummy" }
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_exact_42",
                    "content": "{}"
                }
            ]
        });

        let norm =
            normalize_provider_wire_payload(ProviderWireDialect::GeminiChatCompletions, &input)
                .expect("gemini whitelist");
        assert!(norm.payload.get("reasoning_effort").is_none());
        assert!(norm.payload.get("thinking_config").is_none());
        assert!(norm.stripped_keys.contains(&"reasoning_effort".to_string()));
        assert!(norm.stripped_keys.contains(&"thinking_config".to_string()));
        assert!(norm
            .stripped_keys
            .contains(&"extra_body.google.thinking_config.thinking_level".to_string()));
        assert_eq!(
            norm.payload["messages"][1]["tool_calls"][0]["id"],
            "call_exact_42"
        );
        assert_eq!(
            norm.payload["messages"][1]["tool_calls"][0]["thoughtSignature"],
            "tsig_exact_base64_dummy"
        );
        assert_eq!(norm.payload["messages"][2]["tool_call_id"], "call_exact_42");
        assert!(norm
            .preserved_fields
            .contains(&"thoughtSignature".to_string()));
    }

    #[test]
    fn local_vram_guard_rejects_qwen3_8b_on_4gb_and_allows_compact_aux() {
        let policy_4gb = LocalVramPolicy::for_gpu_mb(4096);

        let reject_8b = evaluate_local_vram_fit(&policy_4gb, "Qwen3-8B-Q4_K_M", Some(5150));
        assert!(!reject_8b.allowed);
        assert_eq!(reject_8b.dwm_ui_headroom_mb, 1024);
        assert_eq!(reject_8b.available_vram_mb, 3072);
        assert_eq!(reject_8b.enforced_semaphore, 1);

        let infer_reject_8b = evaluate_local_vram_fit(&policy_4gb, "Qwen3-8B Q4_K_M", None);
        assert!(!infer_reject_8b.allowed);
        assert_eq!(infer_reject_8b.estimated_vram_mb, Some(5150));

        let compact_ok = evaluate_local_vram_fit(&policy_4gb, "qwen3-1.7b-q4_k_m", Some(1800));
        assert!(compact_ok.allowed);
        assert_eq!(compact_ok.enforced_semaphore, 1);

        let mut busy_policy = LocalVramPolicy::for_gpu_mb(4096);
        busy_policy.active_local_allocations = 1;
        let busy_reject = evaluate_local_vram_fit(&busy_policy, "qwen3-1.7b-q4_k_m", Some(1800));
        assert!(!busy_reject.allowed);

        let local_req_err = normalize_provider_wire_payload(
            ProviderWireDialect::LocalAuxGguf,
            &json!({
                "model": "Qwen3-8B Q4_K_M",
                "total_vram_mb": 4096,
                "estimated_vram_mb": 5150
            }),
        );
        assert!(matches!(
            local_req_err,
            Err(WireAdapterError::LocalVramInsufficient { .. })
        ));

        let local_req_ok = normalize_provider_wire_payload(
            ProviderWireDialect::LocalAuxGguf,
            &json!({
                "model": "aux-embed-1.5b-q4",
                "total_vram_mb": 4096,
                "estimated_vram_mb": 2048,
                "local_vram_semaphore": 4,
                "reasoning_effort": "high"
            }),
        )
        .expect("compact local aux allowed with clamped semaphore");
        assert_eq!(local_req_ok.payload["local_vram_semaphore"], 1);
        assert_eq!(local_req_ok.payload["dwm_ui_headroom_mb"], 1024);
        assert_eq!(local_req_ok.payload["token_budget"], Value::Null);
    }

    #[test]
    fn stable_tool_sort_cache_shape_and_anthropic_cache_ttl_guard() {
        let mut p1 = json!({
            "instructions": "system prompt",
            "tools": [
                { "name": "zeta_tool", "parameters": {} },
                { "name": "alpha_tool", "parameters": {} }
            ],
            "input": [
                { "role": "user", "content": "msg 1" },
                { "role": "user", "content": "msg 2", "name": "bad tool/name!" }
            ]
        });
        let mut p2 = json!({
            "instructions": "system prompt",
            "tools": [
                { "name": "alpha_tool", "parameters": {} },
                { "name": "zeta_tool", "parameters": {} }
            ],
            "input": [
                { "role": "user", "content": "msg 1" },
                { "role": "user", "content": "msg 2 modified", "name": "bad tool/name!" }
            ]
        });
        assert_eq!(sort_tools_stable(&mut p1), 2);
        assert_eq!(sort_tools_stable(&mut p2), 2);
        assert_eq!(sanitize_input_tool_names(&mut p1), 1);
        assert_eq!(p1["input"][1]["name"], "bad_tool_name_");

        let d1 = compute_cache_shape_hash(&p1);
        let d2 = compute_cache_shape_hash(&p2);
        assert_eq!(d1.instr_h, d2.instr_h);
        assert_eq!(d1.tools_h, d2.tools_h);
        assert_ne!(d1.last2_h, d2.last2_h);
        assert!(d1.to_log_line().contains(&d1.prefix_8hex));

        // Valid Anthropic 4-breakpoint 1h -> 5m ordering across tools -> system -> messages.
        let valid_cc = json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "tools": [{ "name": "t1", "cache_control": { "type": "ephemeral", "ttl": "1h" } }],
            "system": [{ "type": "text", "text": "sys", "cache_control": { "type": "ephemeral", "ttl": "1h" } }],
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "u1", "cache_control": { "type": "ephemeral", "ttl": "5m" } }] },
                { "role": "assistant", "content": "a1" },
                { "role": "user", "content": [{ "type": "text", "text": "u2", "cache_control": { "type": "ephemeral", "ttl": "5m" } }] }
            ]
        });
        let ok = normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &valid_cc)
            .expect("valid 4-breakpoint 1h->5m should pass");
        assert!(ok
            .preserved_fields
            .contains(&"cache_breakpoints=4".to_owned()));

        // Invalid 5m -> 1h across tools -> messages must fail closed.
        let invalid_ttl = json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "tools": [{ "name": "t1", "cache_control": { "type": "ephemeral", "ttl": "5m" } }],
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "u1", "cache_control": { "type": "ephemeral", "ttl": "1h" } }] }
            ]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &invalid_ttl),
            Err(WireAdapterError::AnthropicInvalidCacheTtlOrder { .. })
        ));

        // Invalid >4 breakpoints must fail closed.
        let too_many = json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "tools": [
                { "name": "t1", "cache_control": { "type": "ephemeral", "ttl": "1h" } },
                { "name": "t2", "cache_control": { "type": "ephemeral", "ttl": "1h" } }
            ],
            "system": [{ "type": "text", "text": "sys", "cache_control": { "type": "ephemeral", "ttl": "1h" } }],
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "u1", "cache_control": { "type": "ephemeral", "ttl": "5m" } }] },
                { "role": "user", "content": [{ "type": "text", "text": "u2", "cache_control": { "type": "ephemeral", "ttl": "5m" } }] }
            ]
        });
        assert!(matches!(
            normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &too_many),
            Err(WireAdapterError::AnthropicCacheBreakpointsExceeded { count: 5, max: 4 })
        ));
    }
}
