//! SOTA `v4.0` Ultra-Lean Native Rust Async SSE Streaming Agent Engine (`omnia-agent`).
//!
//! Synthesizes late-2026 frontier harness pillars into a pure native Rust engine
//! (`<30 MB` RSS, `<15 ms` CLI cold start, zero Bun/Tauri/rusqlite):
//! - **Token-Progress SSE Watchdog (`last_meaningful_delta_at`)** across all 4 wire dialects
//!   (immune to `: ping` keepalive stalls) + `90s` hard per-turn cap + pre-TTFT bounded hedging
//! - **Rust BAML SAP Partial-JSON Tool-Call Repair** (auto-closes truncated strings/braces,
//!   strips fences/trailing commas, coerces float-ints `1000.0 -> 1000` against JSON Schema)
//! - **Multi-Dialect Native Wire Routing (`auto|chat|responses|messages|gemini`)**:
//!   Anthropic `/v1/messages` 3-breakpoint `cache_control` (with 404 fallback), OpenAI
//!   `/v1/chat/completions` + `/v1/responses`, and Gemini verbatim `thoughtSignature` round-trip
//! - **Strict 4-Tier Prefix-0 KV-Cache Engine** + Session Affinity (`prompt_cache_key` &
//!   `X-Session-Id` on all model families) + Context-Scaled Lakeview (`W_soft <= 280k`) +
//!   Stage 2 Factory Anchored Iterative Summarization (`token_budget = None` uncapped)
//! - **Adaptive Edit Router** (Hashline v2 + `BlockDiff` + `apply_patch` + post-edit AST &
//!   targeted compiler checks) + `PASTE`-lite speculative read pool + Anti-Termination-Lag
//!   (`FAIL -> PASS`) + Ring-Buffer Oscillation Detector + Atomic `/rewind`

use crate::agent_store::{default_omnia_data_dir, read_models_config, AgentStore};
use crate::{ModelEntryConfig, ProviderConfig};
use crate::cache_guard::{
    blake3_hex, canonicalize_openai_tools, HarnessCacheStats, PrefixCacheGuard, BASE_SYSTEM_PROMPT,
    BASE_SYSTEM_PROMPT_NO_VERIFY,
};
use crate::checkpoint::TestOutcomeTransition;
use crate::context::{InstructionEpochState, WorkspaceContextBundle};
use crate::edit::ModelEditAffinity;
use crate::graph_locator::WorkspaceGraphIndex;
use crate::hooks::{HookEvent, HookRegistry};
use crate::lakeview::{
    bound_multimodal_images, classify_tool_error, error_fingerprint,
    render_snapcompact_archive_text, AnchoredSummary, BackgroundCompactionCoordinator,
    ContentBlock, EpochMaskingState, FoldAgentState, HarnessMessage, OscillationDetector,
    SemanticLoopGuard, ToolCallRecord, DEFAULT_MAX_TOOL_REPETITIONS,
};
use crate::memory_engine::MemoryEngine;
use crate::output_compressor::compress_text_output;
use crate::path_guard::sanitize_windows_path;
use crate::permissions::{ApprovalMode, PermissionRule};
use crate::plugin::{PluginRegistry, TurnHookContext};
use crate::sap_json::repair_tool_json;
use crate::supervisor::process_tree_rss_bytes;
use crate::test_time_scaling::{
    distill_tex_matrix_pdr, TestTimeScalingConfig, TexCrossValidationReport,
};
use crate::tools::{detect_default_shell, InteractiveApprover, ToolExecOutput, ToolRuntime};
use crate::trajectory::TrajectoryRecorder;
use anyhow::{bail, Result};
use bytes::Bytes;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use memchr::memchr;
use omnia_connector_gateway::htmustc_wire::{
    classify_upstream_failure, conversation_fingerprint, evaluate_proactive_quota_gate,
    inspect_sse_pre_commit, restore_responses_namespaces_value, sanitize_gemini_wire_payload,
    QuotaProbeSnapshot, UpstreamFailureScope,
};
use omnia_routing::{
    apply_reasoning_effort_wire, clamp_effort_for_model, effort_spec_for_model, AcceptanceState,
    CandidateResourceState, DynamicProviderRouter, EffortLevel, ModelCapabilities, ModelRole,
    OutcomeReport, RouteCandidate, RouteRequestPolicy,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, Message as WsMessage,
};

const MAX_INTERLEAVED_REASONING_CHARS: usize = 6_000;
const ACTIVE_DECODE_GAP_CAP_MS: u64 = 5_000;
/// Persistent `/v1/responses` WebSocket connection rotation ceiling (`55` minutes, OpenCode transport).
const WS_CONTINUATION_ROTATE_AFTER: Duration = Duration::from_secs(55 * 60);
/// Maximum consecutive WS failures before permanently downgrading session to HTTP SSE.
const WS_MAX_STREAM_FAILURES: u32 = 5;
/// Separate 1-hour retry window for unreachable network/DNS outages (`ENOTFOUND`/`EAI_AGAIN`/`ENETUNREACH`).
const UNREACHABLE_RETRY_WINDOW: Duration = Duration::from_secs(60 * 60);
const UNREACHABLE_RETRY_INITIAL_MS: u64 = 2_000;
const UNREACHABLE_RETRY_MAX_MS: u64 = 30_000;
/// Active keepalive ceiling while waiting pre-TTFT on long reasoning turns (`gpt-6.2-sol` 186s / Claude 233s).
const HEAVY_THINKING_KEEPALIVE_CAP_SECS: u64 = 240;

/// Multi-dialect wire routing mode (`--wire-api auto|chat|responses|responses-ws|messages|gemini`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireApiMode {
    #[default]
    Auto,
    Chat,
    Responses,
    #[serde(alias = "responses-ws", alias = "responses_ws", alias = "ws")]
    ResponsesWs,
    Messages,
    Gemini,
}

impl WireApiMode {
    #[must_use]
    pub fn parse_flag(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "chat" | "openai-completions" | "completions" => Self::Chat,
            "responses" | "openai-responses" => Self::Responses,
            "responses-ws" | "responses_ws" | "openai-responses-ws" | "ws" => Self::ResponsesWs,
            "messages" | "anthropic" | "anthropic-messages" => Self::Messages,
            "gemini" | "google-gemini" => Self::Gemini,
            _ => Self::Auto,
        }
    }

    /// Resolve the canonical wire API string for `(model_id, provider_configured_api)`.
    #[must_use]
    pub fn resolve_api_kind(self, model_id: &str, configured_api: &str) -> &'static str {
        match self {
            Self::Chat => "openai-completions",
            Self::Responses | Self::ResponsesWs => "openai-responses",
            Self::Messages => "anthropic-messages",
            Self::Gemini => "google-gemini",
            Self::Auto => {
                let m = model_id.to_ascii_lowercase();
                // htmustc wire forensics: Gemini over OpenAI chat/responses loses ~2k tokens of
                // cached prefix EVERY turn (37/103 breaks), while the same models over Anthropic
                // `/v1/messages` keep a byte-stable cached prefix (delta ~6 tokens/turn).
                if m.starts_with("claude")
                    || m.contains("/claude")
                    || m.starts_with("gemini")
                    || m.contains("/gemini")
                {
                    "anthropic-messages"
                } else if configured_api == "openai-responses"
                    || configured_api == "openai-responses-ws"
                    || is_openai_responses_family(&m)
                {
                    "openai-responses"
                } else if configured_api == "google-gemini" {
                    "google-gemini"
                } else {
                    "openai-completions"
                }
            }
        }
    }
}

/// OpenAI families served best by the native stateless Responses API on htmustc
/// (Codex CLI reached 5/7 + 3/3 Axis 11 on `gpt-6.2-sol` over `/v1/responses`).
fn is_openai_responses_family(model_lower: &str) -> bool {
    let bare = model_lower.rsplit('/').next().unwrap_or(model_lower);
    bare.starts_with("gpt-")
        || bare.starts_with("o1")
        || bare.starts_with("o3")
        || bare.starts_with("o4")
        || bare.starts_with("codex")
}

#[derive(Debug, Clone)]
pub struct StreamBudgetConfig {
    pub header_timeout: Duration,
    pub heavy_header_timeout: Duration,
    pub first_delta_timeout: Duration,
    pub heavy_first_delta_timeout: Duration,
    pub inter_chunk_timeout: Duration,
    /// Hard upper bound for EACH individual HTTP attempt (`180s` default). Every retry gets a
    /// FRESH per-attempt budget (bounded only by the overall run deadline) so a slow first
    /// attempt can never clamp later attempts down to sub-second stall windows.
    pub per_attempt_deadline: Duration,
    pub max_retries_per_turn: u32,
    pub retry_base_backoff_ms: u64,
    /// Bounded pre-TTFT hedging (`<= 5%` retry budget, NEVER post-TTFT).
    pub enable_pre_ttft_hedge: bool,
    pub pre_ttft_hedge_delay: Duration,
}

impl Default for StreamBudgetConfig {
    fn default() -> Self {
        Self {
            // Calibrated on 105-run htmustc Stage 1 wire traces + gpt-6.2-sol 186s & Claude 233s silent thinking:
            // the proxy burst-flushes or emits 4096B keepalives while upstream thinks up to ~233s.
            header_timeout: Duration::from_secs(90),
            heavy_header_timeout: Duration::from_secs(150),
            first_delta_timeout: Duration::from_secs(90),
            heavy_first_delta_timeout: Duration::from_secs(150),
            inter_chunk_timeout: Duration::from_secs(65),
            per_attempt_deadline: Duration::from_secs(240),
            max_retries_per_turn: 3,
            retry_base_backoff_ms: 800,
            // Opt-in only: upstream keeps processing aborted requests and serializes per-family
            // concurrency, so hedges/aborts double-load htmustc and queue the next turn.
            enable_pre_ttft_hedge: false,
            pre_ttft_hedge_delay: Duration::from_secs(60),
        }
    }
}

impl StreamBudgetConfig {
    /// Defaults plus explicit opt-in overrides:
    /// `OMNIA_PRE_TTFT_HEDGE=1` enables bounded pre-TTFT hedging (never on Anthropic wire),
    /// `OMNIA_PRE_TTFT_HEDGE_DELAY_SECS` sets the hedge delay (floored at 45s).
    #[must_use]
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if std::env::var("OMNIA_PRE_TTFT_HEDGE").ok().is_some_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        }) {
            cfg.enable_pre_ttft_hedge = true;
        }
        if let Some(secs) = std::env::var("OMNIA_PRE_TTFT_HEDGE_DELAY_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
        {
            cfg.pre_ttft_hedge_delay = Duration::from_secs(secs.max(45));
        }
        cfg
    }
}

impl StreamBudgetConfig {
    pub fn is_heavy_model(model_id: &str, last_context_tokens: u64) -> bool {
        if last_context_tokens > 32_000 {
            return true;
        }
        let m = model_id.to_ascii_lowercase();
        m.contains("claude")
            || m.contains("opus")
            || m.contains("gpt-6")
            || m.contains("gpt-5.6")
            || m.contains("gpt-5-6")
            || m.contains("gemini-4")
            || m.contains("gemini-3")
            || m.contains("o4")
            || m.contains("o3")
            || m.contains("o1")
            || m.contains("sonnet")
    }

    pub fn effective_timeouts(
        &self,
        model_id: &str,
        last_context_tokens: u64,
        attempt: u32,
        remaining: Duration,
    ) -> (Duration, Duration, Duration) {
        let heavy = Self::is_heavy_model(model_id, last_context_tokens);
        let base_header = if heavy {
            self.heavy_header_timeout
        } else {
            self.header_timeout
        };
        let base_first = if heavy {
            self.heavy_first_delta_timeout
        } else {
            self.first_delta_timeout
        };
        let scale = if attempt == 0 {
            1.0
        } else {
            1.25_f64.powi(attempt.min(3) as i32)
        };
        let cap = self.per_attempt_deadline.max(Duration::from_secs(1));
        let scale_dur = |d: Duration| -> Duration {
            let scaled = Duration::from_secs_f64((d.as_secs_f64() * scale).min(cap.as_secs_f64()));
            scaled.min(remaining)
        };
        (
            scale_dur(base_header),
            scale_dur(base_first),
            self.inter_chunk_timeout.min(remaining),
        )
    }
}

/// Token-Progress SSE Watchdog (`SOTA v4` + `v5` keepalive-aware extension):
/// - Tracks `last_meaningful_delta_at` post-TTFT (`: ping` keepalives NEVER extend post-TTFT stalls).
/// - Pre-TTFT, dead/quiet sockets fail at `first_delta_timeout`; when production keepalives/lifecycle
///   events are actively arriving (`last_wire_activity_at`), healthy silent reasoning extends up to `240s`.
/// - Overall turn-deadline expiry returns `Fatal` (never mislabeled as an `<18s` `ChunkStall`).
fn compute_token_progress_wait(
    stream_started_at: Instant,
    last_meaningful_delta_at: Option<Instant>,
    first_delta_timeout: Duration,
    post_delta_token_timeout: Duration,
    turn_deadline: Instant,
    dialect_label: &str,
) -> std::result::Result<Duration, StreamTurnError> {
    compute_token_progress_wait_with_wire(
        stream_started_at,
        last_meaningful_delta_at,
        None,
        first_delta_timeout,
        post_delta_token_timeout,
        turn_deadline,
        dialect_label,
    )
}

fn has_fresh_wire_keepalive(
    now: Instant,
    first_delta_timeout: Duration,
    post_delta_token_timeout: Duration,
    last_wire_activity_at: Option<Instant>,
) -> bool {
    first_delta_timeout >= Duration::from_secs(60)
        && last_wire_activity_at.is_some_and(|wire_ts| {
            now.saturating_duration_since(wire_ts)
                <= post_delta_token_timeout.max(Duration::from_secs(45))
        })
}

fn compute_token_progress_wait_with_wire(
    stream_started_at: Instant,
    last_meaningful_delta_at: Option<Instant>,
    last_wire_activity_at: Option<Instant>,
    first_delta_timeout: Duration,
    post_delta_token_timeout: Duration,
    turn_deadline: Instant,
    dialect_label: &str,
) -> std::result::Result<Duration, StreamTurnError> {
    compute_token_progress_wait_with_phase(
        stream_started_at,
        last_meaningful_delta_at,
        last_wire_activity_at,
        first_delta_timeout,
        post_delta_token_timeout,
        turn_deadline,
        dialect_label,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn compute_token_progress_wait_with_phase(
    stream_started_at: Instant,
    last_meaningful_delta_at: Option<Instant>,
    last_wire_activity_at: Option<Instant>,
    first_delta_timeout: Duration,
    post_delta_token_timeout: Duration,
    turn_deadline: Instant,
    dialect_label: &str,
    in_reasoning_only: bool,
) -> std::result::Result<Duration, StreamTurnError> {
    let now = Instant::now();
    let rem_turn = turn_deadline.saturating_duration_since(now);
    if rem_turn.is_zero() {
        return Err(StreamTurnError::Retryable {
            status: None,
            retry_after_secs: None,
            kind: RetryKind::ChunkStall,
            detail: format!("Timed out waiting for {dialect_label} turn deadline"),
        });
    }

    let (anchor, budget, phase) = match (last_meaningful_delta_at, in_reasoning_only) {
        (None, _) => {
            let cap = if has_fresh_wire_keepalive(
                now,
                first_delta_timeout,
                post_delta_token_timeout,
                last_wire_activity_at,
            ) {
                first_delta_timeout.max(Duration::from_secs(HEAVY_THINKING_KEEPALIVE_CAP_SECS))
            } else if last_wire_activity_at.is_none()
                && first_delta_timeout >= Duration::from_secs(60)
                && dialect_label.starts_with("OpenAI Responses")
            {
                // Healthy /v1/responses emits `response.created` immediately; zero wire bytes
                // means an upstream hang (drop at 60s max for fast fresh-socket retry).
                first_delta_timeout.min(Duration::from_secs(60))
            } else {
                first_delta_timeout
            };
            (stream_started_at, cap, "pre-TTFT")
        }
        (Some(ts), true) => {
            // Reasoning-only phase (`text.is_empty() && tool_calls.is_empty()`): preserve full
            // heavy thinking / keepalive budget (`150s` / `240s`) instead of aborting at 65s.
            let cap = if has_fresh_wire_keepalive(
                now,
                first_delta_timeout,
                post_delta_token_timeout,
                last_wire_activity_at,
            ) {
                first_delta_timeout.max(Duration::from_secs(HEAVY_THINKING_KEEPALIVE_CAP_SECS))
            } else {
                first_delta_timeout.max(post_delta_token_timeout)
            };
            (ts, cap, "reasoning-phase")
        }
        (Some(ts), false) => (ts, post_delta_token_timeout, "post-TTFT token-progress"),
    };
    let elapsed = now.saturating_duration_since(anchor);
    if elapsed >= budget {
        return Err(StreamTurnError::Retryable {
            status: None,
            retry_after_secs: None,
            kind: RetryKind::ChunkStall,
            detail: format!(
                "{dialect_label} {phase} stall timeout after {}ms (limit {}ms; keepalives ignored)",
                elapsed.as_millis(),
                budget.as_millis()
            ),
        });
    }
    Ok((budget - elapsed).min(rem_turn))
}

#[derive(Debug, Clone)]
pub struct ResolvedModelEndpoint {
    pub provider_id: String,
    pub model_id: String,
    pub base_url: String,
    pub api_key: String,
    pub api: String, // "openai-completions" | "anthropic-messages" | "google-gemini"
    pub auth_header: bool,
    pub context_window: u64,
    pub max_tokens: u64,
    pub cost_input_per_m: f64,
    pub cost_output_per_m: f64,
    pub cost_cache_read_per_m: f64,
    pub cost_cache_write_per_m: f64,
}

/// Resolve provider endpoint, API key, and model config directly from `models.yml`
/// (exact same schema as OMP) with CLI/env fallbacks.
pub fn resolve_model_endpoint(
    model_spec: &str,
    config_dir: Option<&Path>,
    api_base_override: Option<&str>,
    api_key_override: Option<&str>,
) -> Result<ResolvedModelEndpoint> {
    let (wanted_provider, wanted_model) = if let Some((p, m)) = model_spec.split_once('/') {
        (Some(p.trim().to_string()), m.trim().to_string())
    } else {
        (None, model_spec.trim().to_string())
    };
    if wanted_model.is_empty() {
        bail!("empty model specification");
    }

    let cfg_dir = config_dir
        .map(PathBuf::from)
        .or_else(detect_default_models_dir);
    let cfg = read_models_config(cfg_dir.as_deref()).ok();

    let mut matched_provider: Option<ProviderConfig> = None;
    let mut matched_model: Option<ModelEntryConfig> = None;

    if let Some(ref c) = cfg {
        if let Some(ref wp) = wanted_provider {
            if let Some(p) = c.providers.iter().find(|p| p.id.eq_ignore_ascii_case(wp)) {
                matched_model = p
                    .models
                    .iter()
                    .find(|m| m.id.eq_ignore_ascii_case(&wanted_model))
                    .cloned();
                matched_provider = Some(p.clone());
            }
        }
        if matched_provider.is_none() {
            for p in &c.providers {
                if let Some(m) = p
                    .models
                    .iter()
                    .find(|m| m.id.eq_ignore_ascii_case(&wanted_model))
                {
                    matched_provider = Some(p.clone());
                    matched_model = Some(m.clone());
                    break;
                }
            }
        }
        if matched_provider.is_none() {
            matched_provider = c.providers.first().cloned();
        }
    }

    let provider_id = wanted_provider
        .or_else(|| matched_provider.as_ref().map(|p| p.id.clone()))
        .unwrap_or_else(|| "openai".into());

    let base_url = api_base_override
        .map(String::from)
        .or_else(|| matched_provider.as_ref().map(|p| p.base_url.clone()))
        .or_else(|| {
            std::env::var("OMNIA_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("OPENAI_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("OPENAI_HOST")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|h| {
                    let t = h.trim_end_matches('/');
                    if t.ends_with("/v1") {
                        t.to_string()
                    } else {
                        format!("{t}/v1")
                    }
                })
        })
        .unwrap_or_else(|| "https://htmustc.id.vn/v1".into());

    // Per-model `apiKey:` (OMP schema) wins over the provider key so gated models such as
    // `must1c-v1` can carry their own credential. A value shaped like an ENV var name is
    // dereferenced; anything else is a literal secret.
    let model_key = matched_model
        .as_ref()
        .map(|m| m.api_key.trim().to_string())
        .filter(|k| !k.is_empty());
    let api_key = api_key_override
        .map(String::from)
        .or_else(|| model_key.clone())
        .or_else(|| {
            matched_provider
                .as_ref()
                .map(|p| p.api_key.clone())
                .filter(|k| !k.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("OMNIA_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("HTMUSTC_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("ANTHROPIC_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("GEMINI_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default();
    // `models.yml` credentials may be literal secrets OR ENV var names (HTMUSTC_API_KEY):
    // deref env-shaped values so ACP/HTTP paths that skip the CLI env fallback still auth.
    let api_key = crate::acp_proto::deref_env_credential(&api_key).unwrap_or(api_key);

    // Per-model `api:` overrides the provider dialect (e.g. must1c-v1 is chat-completions only).
    let api = matched_model
        .as_ref()
        .map(|m| m.api.trim().to_string())
        .filter(|a| !a.is_empty())
        .or_else(|| {
            matched_provider
                .as_ref()
                .map(|p| p.api.clone())
                .filter(|a| !a.trim().is_empty())
        })
        .unwrap_or_else(|| "openai-completions".into());
    let auth_header = matched_provider
        .as_ref()
        .map(|p| p.auth_header)
        .unwrap_or(true);

    let (context_window, max_tokens, cost) = if let Some(m) = matched_model {
        (
            m.context_window.max(32_000),
            m.max_tokens.clamp(1024, 128_000),
            m.cost,
        )
    } else {
        (200_000, 16_384, Default::default())
    };

    Ok(ResolvedModelEndpoint {
        provider_id,
        model_id: wanted_model,
        base_url: base_url.trim_end_matches('/').to_string(),
        api_key: api_key.trim().to_string(),
        api,
        auth_header,
        context_window,
        max_tokens,
        cost_input_per_m: cost.input,
        cost_output_per_m: cost.output,
        cost_cache_read_per_m: cost.cache_read,
        cost_cache_write_per_m: cost.cache_write,
    })
}

fn detect_default_models_dir() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("PI_CODING_AGENT_DIR") {
        let p = PathBuf::from(env_dir);
        if p.join("models.yml").exists() {
            return Some(p);
        }
    }
    if let Some(home) = dirs::home_dir() {
        for cand in [
            home.join(".omp").join("agent"),
            home.join(".pi").join("agent"),
            home.join(".gemini")
                .join("antigravity")
                .join("scratch")
                .join("harness-benchmark")
                .join("omp_profile"),
        ] {
            if cand.join("models.yml").exists() {
                return Some(cand);
            }
        }
        let agy_brain = home.join(".gemini").join("antigravity").join("brain");
        if let Ok(entries) = std::fs::read_dir(&agy_brain) {
            for e in entries.flatten() {
                let p = e.path().join("scratch").join("omp_profile");
                if p.join("models.yml").exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub enum HarnessStreamEvent {
    DeltaBatch {
        message_id: String,
        text_delta: String,
        thinking_delta: String,
    },
    TurnStart {
        turn: u32,
    },
    TurnEnd {
        turn: u32,
    },
    ToolStart {
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
    },
    ToolEnd {
        tool_call_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
        duration_ms: u64,
    },
    AutoRecovery {
        attempt: u32,
        reason: String,
    },
    Metrics {
        tokens_per_second: f64,
        context_tokens: u64,
        context_window: u64,
        context_percent: f64,
        total_cost_usd: f64,
    },
    Telemetry {
        cache_stats: HarnessCacheStats,
        merkle_root: String,
        merkle_refresh_ms: f64,
        lakeview_compressions: u32,
        turn_count: u32,
        tool_call_count: u32,
        tool_error_count: u32,
    },
}

pub type HarnessEventSink = Arc<dyn Fn(HarnessStreamEvent) + Send + Sync>;

#[derive(Clone)]
pub struct SuperEvalOptions {
    pub cwd: PathBuf,
    pub model: String,
    pub prompt: String,
    pub approval_mode: ApprovalMode,
    pub workspace_trusted: bool,
    pub permission_rules: Vec<PermissionRule>,
    pub thinking_level: Option<String>,
    pub config_dir: Option<PathBuf>,
    pub api_base: Option<String>,
    pub api_key: Option<String>,
    pub wire_api: WireApiMode,
    pub timeout_secs: u64,
    pub max_turns: u32,
    pub trajectory_path: Option<PathBuf>,
    pub plugins: PluginRegistry,
    pub db: Option<AgentStore>,
    pub event_sink: Option<HarnessEventSink>,
}

/// Canonical `EvalRunReport` output for `omnia run` and `--eval-acp`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuperEvalReport {
    pub harness: String,
    pub backend: String,
    pub version: String,
    pub provider: String,
    pub model: String,
    pub cwd: String,
    pub status: String,
    pub success: bool,
    pub final_text: String,
    pub elapsed_ms: u64,
    pub ttft_ms: Option<u64>,
    pub llm_ttft_ms: Option<u64>,
    pub gen_duration_ms: u64,
    pub startup_ms: u64,
    pub tool_calls: u32,
    pub tool_errors: u32,
    pub tool_histogram: BTreeMap<String, u32>,
    pub turns: u32,
    /// Uncached input tokens (never double-counts cache tokens).
    pub input_tokens: u64,
    pub uncached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub token_telemetry_complete: bool,
    pub cost_usd: f64,
    pub tokens_per_second: f64,
    pub gen_tokens_per_second: f64,
    pub peak_rss_bytes: u64,
    pub recovery_attempts: u32,
    pub recovery_succeeded: bool,
    pub host_tool_calls: u32,
    pub protocol_version: u32,
    // v2.0 Super-Harness Pillar Telemetry
    pub merkle_root: String,
    pub merkle_refresh_ms: f64,
    pub merkle_file_count: usize,
    pub graph_symbol_count: usize,
    pub prefix_stable: bool,
    pub prefix_cache_hit_pct: f64,
    pub lakeview_compressions: u32,
    pub lakeview_chars_saved: u64,
    pub loop_nudges: u32,
    pub http_retries: u32,
    // v3.0 + v4.0 Frontier Telemetry (strictly additive)
    #[serde(default)]
    pub active_decode_ms: u64,
    #[serde(default)]
    pub active_decode_tps: f64,
    #[serde(default)]
    pub e2e_tps: f64,
    #[serde(default)]
    pub wire_dialect: String,
    #[serde(default)]
    pub truncated_stream_retries: u32,
    #[serde(default)]
    pub stall_retries: u32,
    #[serde(default)]
    pub verify_gate_nudges: u32,
    #[serde(default)]
    pub narration_nudges: u32,
    #[serde(default)]
    pub interleaved_reasoning_turns: u32,
    #[serde(default)]
    pub sap_repairs: u32,
    #[serde(default)]
    pub oscillation_nudges: u32,
    #[serde(default)]
    pub hedge_wins: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct TurnLlmUsage {
    uncached_input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    reasoning: Option<u64>,
    saw_usage: bool,
}

/// RAII guard for D4 `PASTE`-lite speculative read-only tool tasks:
/// records exact argument snapshots so stale pre-streamed handles are aborted on mismatch,
/// and aborts every unconsumed handle immediately if an SSE turn fails, stalls, or retries!
struct SpeculativeEntry {
    spawned_args: String,
    handle: tokio::task::JoinHandle<ToolExecOutput>,
}

struct SpeculativeTaskPool {
    handles: HashMap<usize, SpeculativeEntry>,
    saw_mutating: bool,
}

impl SpeculativeTaskPool {
    fn new() -> Self {
        Self {
            handles: HashMap::new(),
            saw_mutating: false,
        }
    }

    fn try_spawn_if_admissible(
        &mut self,
        wire_key: usize,
        tc: &ToolCallRecord,
        runtime: &ToolRuntime,
        allow_empty_args: bool,
    ) {
        if self.saw_mutating || self.handles.contains_key(&wire_key) || tc.name.trim().is_empty() {
            return;
        }
        if !ToolRuntime::is_read_only_tool(&tc.name) {
            self.saw_mutating = true;
            return;
        }
        let trimmed = tc.arguments.trim();
        let parsed = if trimmed.is_empty() {
            // Mid-stream interleaved SSE headers may arrive before arguments stream in:
            // never speculatively spawn empty `{}` for argument-requiring tools until finish_reason="tool_calls"!
            if allow_empty_args || tc.name == "workspace_map" {
                Ok(json!({}))
            } else {
                return;
            }
        } else {
            serde_json::from_str::<Value>(trimmed)
        };
        if let Ok(args_val) = parsed {
            if !args_val.is_object() {
                return;
            }
            let rt = runtime.clone();
            let name = tc.name.clone();
            let handle = tokio::spawn(async move { rt.execute(&name, &args_val).await });
            self.handles.insert(
                wire_key,
                SpeculativeEntry {
                    spawned_args: tc.arguments.clone(),
                    handle,
                },
            );
        }
    }

    fn take_all(&mut self) -> HashMap<usize, SpeculativeEntry> {
        std::mem::take(&mut self.handles)
    }
}

impl Drop for SpeculativeTaskPool {
    fn drop(&mut self) {
        for (_, entry) in self.handles.drain() {
            entry.handle.abort();
        }
    }
}

struct TurnStreamResult {
    text: String,
    reasoning: String,
    reasoning_signature: Option<String>,
    redacted_thinking: Vec<String>,
    reasoning_encrypted_items: Vec<Value>,
    response_id: Option<String>,
    tool_calls: Vec<ToolCallRecord>,
    /// Pre-spawned speculative read-only tool handles keyed by positional index in `tool_calls`.
    speculative_results: HashMap<usize, tokio::task::JoinHandle<ToolExecOutput>>,
    finish_reason: Option<String>,
    usage: TurnLlmUsage,
    turn_ttft_ms: Option<u64>,
    turn_gen_ms: u64,
    turn_active_decode_ms: u64,
    http_retries: u32,
}

type AgentWsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Stateful 55-minute Persistent WebSocket Continuation transport state (`opencode` transport).
#[derive(Default)]
struct ResponsesWsContinuationState {
    stream: Option<AgentWsStream>,
    connected_at: Option<Instant>,
    endpoint_url: String,
    last_response_id: Option<String>,
    last_model: Option<String>,
    last_instructions_hash: Option<String>,
    last_tools_hash: Option<String>,
    last_prefix_hash: Option<String>,
    last_input_len: usize,
    consecutive_failures: u32,
    disabled: bool,
}

impl ResponsesWsContinuationState {
    fn reset_connection(&mut self) {
        self.stream = None;
        self.connected_at = None;
        self.last_response_id = None;
        self.last_prefix_hash = None;
        self.last_input_len = 0;
    }

    fn record_failure(&mut self, disable_immediately: bool) {
        self.reset_connection();
        self.consecutive_failures += 1;
        if disable_immediately || self.consecutive_failures >= WS_MAX_STREAM_FAILURES {
            self.disabled = true;
        }
    }
}

#[derive(Debug, Default)]
struct ExecutionProgressState {
    files_read: u32,
    files_mutated: BTreeSet<String>,
    shell_runs_total: u32,
    verified_since_last_mutation: bool,
    test_suite_passed_since_last_mutation: bool,
    last_shell_exit_code: Option<i32>,
    verify_gate_nudges: u32,
    narration_nudges: u32,
    post_pass_readonly_turns: u32,
    sent_convergence_hint: bool,
    sent_60pct_nudge: bool,
    sent_82pct_nudge: bool,
    escalate_reasoning: bool,
    final_review_nudges: u32,
    /// Pending shell or edit failure tracked for D7 `ACE` Playbook error -> green fix capture.
    last_failed_shell: Option<(String, String, String)>,
    last_failed_edit: Option<(String, String, String)>,
}

/// Stateful native Rust SOTA v5 Super-Harness engine usable for CLI, Studio, and ACP.
pub struct NativeSuperEngine {
    pub session_key: String,
    pub conversation_fp: String,
    pub workspace_root: PathBuf,
    pub workspace_hash: String,
    pub endpoint: ResolvedModelEndpoint,
    pub wire_api_mode: WireApiMode,
    pub anthropic_fallback_to_openai: bool,
    pub responses_fallback_to_chat: bool,
    pub responses_ws_enabled: bool,
    pub edit_affinity: ModelEditAffinity,
    pub thinking_level: Option<String>,
    pub plugins: PluginRegistry,
    pub tool_runtime: ToolRuntime,
    pub messages: Vec<HarnessMessage>,
    pub cache_guard: PrefixCacheGuard,
    pub epoch_masker: EpochMaskingState,
    pub anchored_summary: AnchoredSummary,
    pub instruction_epoch: InstructionEpochState,
    pub fold_agent: FoldAgentState,
    pub background_compactor: BackgroundCompactionCoordinator,
    pub loop_guard: SemanticLoopGuard,
    pub oscillation_detector: OscillationDetector,
    pub trajectory: TrajectoryRecorder,
    pub hooks: HookRegistry,
    pub memory_engine: Option<Arc<MemoryEngine>>,
    pub tts_config: TestTimeScalingConfig,
    pub dynamic_router: Option<Arc<DynamicProviderRouter>>,
    pub role_endpoints: BTreeMap<ModelRole, ResolvedModelEndpoint>,
    pub system_prompt: String,
    pub canonical_tools: Vec<Value>,
    pub tool_schemas_by_name: HashMap<String, Value>,
    pub stream_budget: StreamBudgetConfig,
    pub supports_reasoning_echo: bool,
    pub supports_prompt_cache_key: bool,
    pub active_prompt_start_turn: u32,
    pub total_turns: u32,
    pub total_tool_calls: u32,
    pub total_tool_errors: u32,
    pub total_host_tool_calls: u32,
    pub tool_histogram: BTreeMap<String, u32>,
    pub total_cost_usd: f64,
    pub total_gen_duration_ms: u64,
    pub total_active_decode_ms: u64,
    pub total_http_retries: u32,
    pub total_unreachable_retries: u32,
    pub total_truncated_stream_retries: u32,
    pub total_stall_retries: u32,
    pub total_ws_turns: u32,
    pub total_ws_fallbacks: u32,
    pub total_rtk_compressions: u32,
    pub total_rtk_spills: u32,
    pub total_fold_compressions: u32,
    pub total_verify_gate_nudges: u32,
    pub total_narration_nudges: u32,
    pub total_interleaved_reasoning_turns: u32,
    pub total_sap_repairs: u32,
    pub total_oscillation_nudges: u32,
    pub total_hedge_wins: u32,
    pub total_hedges_issued: u32,
    pub total_final_review_nudges: u32,
    /// One-shot requirements/edge-case review before a mutating task finishes (default on).
    pub final_review_gate: bool,
    pub last_context_tokens: u64,
    http: reqwest::Client,
    fresh_http: reqwest::Client,
    ws_state: ResponsesWsContinuationState,
    last_prompt_cache_hit_at: Option<Instant>,
    first_prompt_sent: bool,
    shell_label: &'static str,
}

impl NativeSuperEngine {
    pub(crate) fn restore_acp_history(&mut self, turns: u32, messages: Vec<HarnessMessage>) {
        self.first_prompt_sent = !messages.is_empty();
        self.total_turns = turns;
        self.messages.extend(messages);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_key: String,
        workspace_root: PathBuf,
        endpoint: ResolvedModelEndpoint,
        thinking_level: Option<String>,
        approval_mode: ApprovalMode,
        workspace_trusted: bool,
        permission_rules: Vec<PermissionRule>,
        plugins: PluginRegistry,
        graph_index: Arc<Mutex<WorkspaceGraphIndex>>,
        db: Option<AgentStore>,
        approver: Option<InteractiveApprover>,
        cancel_flag: Arc<AtomicBool>,
        trajectory_path: Option<PathBuf>,
    ) -> Result<Self> {
        let clean_ws = sanitize_windows_path(&workspace_root);
        let workspace_hash = blake3_hex(clean_ws.to_string_lossy().as_bytes());
        let context_bundle = Arc::new(WorkspaceContextBundle::discover_for_trust(
            &clean_ws,
            workspace_trusted,
        ));
        let has_skills = !context_bundle.skills.is_empty();

        let tool_runtime = ToolRuntime::new_with_session(
            session_key.clone(),
            clean_ws.clone(),
            approval_mode,
            workspace_trusted,
            permission_rules,
            graph_index,
            context_bundle,
            db,
            approver,
            cancel_flag,
        );

        // Tier-0 100% immutable System Prompt & alphabetically canonicalized static tool schemas
        // (including the 2 static deferred meta-tools when deferred semantic/MCP tools are present!)
        let system_prompt = if plugins.is_enabled("self_verify_gate") {
            BASE_SYSTEM_PROMPT.to_string()
        } else {
            BASE_SYSTEM_PROMPT_NO_VERIFY.to_string()
        };
        let active_tools =
            plugins.active_tools_with_deferred(has_skills, !tool_runtime.deferred_tools.is_empty());
        let tool_schemas_by_name: HashMap<String, Value> = active_tools
            .iter()
            .map(|t| (t.name.clone(), t.parameters.clone()))
            .collect();
        let canonical_tools = canonicalize_openai_tools(&active_tools);
        let cache_guard =
            PrefixCacheGuard::new(Some(session_key.clone()), &system_prompt, &canonical_tools);
        let conversation_fp = conversation_fingerprint(Some(&session_key), &system_prompt, "");

        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(30))
            .user_agent("omnia-agent/5.0.0")
            .build()?;
        let fresh_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .http1_only()
            .tcp_nodelay(true)
            .user_agent("omnia-agent/5.0.0")
            .build()?;

        let (shell_label, _) = detect_default_shell();
        let messages = vec![HarnessMessage::system(system_prompt.clone())];
        let trajectory = TrajectoryRecorder::new(session_key.clone(), trajectory_path);
        let epoch_masker = EpochMaskingState::for_context_window(endpoint.context_window);
        let edit_affinity = ModelEditAffinity::for_model(&endpoint.model_id);
        let wire_api_mode = if endpoint.api.eq_ignore_ascii_case("openai-responses-ws") {
            WireApiMode::ResponsesWs
        } else {
            WireApiMode::Auto
        };
        let responses_ws_enabled = endpoint.api.eq_ignore_ascii_case("openai-responses-ws")
            || endpoint.base_url.starts_with("ws://")
            || endpoint.base_url.starts_with("wss://")
            || std::env::var("OMNIA_RESPONSES_WS").ok().is_some_and(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            });
        let background_compactor = BackgroundCompactionCoordinator::new(endpoint.context_window);
        let hooks = if workspace_trusted {
            HookRegistry::load_from_workspace(&clean_ws)
                .unwrap_or_else(|_| HookRegistry::new(&clean_ws))
        } else {
            HookRegistry::new(&clean_ws)
        };
        let default_mem_db = default_omnia_data_dir()
            .join("memory")
            .join("omnia_memory.db");
        let memory_engine = if default_mem_db.is_file() {
            MemoryEngine::open_default(None).ok().map(Arc::new)
        } else {
            None
        };

        Ok(Self {
            session_key,
            conversation_fp,
            workspace_root: clean_ws,
            workspace_hash,
            endpoint,
            wire_api_mode,
            anthropic_fallback_to_openai: false,
            responses_fallback_to_chat: false,
            responses_ws_enabled,
            edit_affinity,
            thinking_level,
            plugins,
            tool_runtime,
            messages,
            cache_guard,
            epoch_masker,
            anchored_summary: AnchoredSummary::default(),
            instruction_epoch: InstructionEpochState::new(),
            fold_agent: FoldAgentState::new(),
            background_compactor,
            loop_guard: SemanticLoopGuard::new(DEFAULT_MAX_TOOL_REPETITIONS),
            oscillation_detector: OscillationDetector::new(32),
            trajectory,
            hooks,
            memory_engine,
            tts_config: TestTimeScalingConfig::default(),
            dynamic_router: None,
            role_endpoints: BTreeMap::new(),
            system_prompt,
            canonical_tools,
            tool_schemas_by_name,
            stream_budget: StreamBudgetConfig::from_env(),
            supports_reasoning_echo: true,
            supports_prompt_cache_key: true,
            active_prompt_start_turn: 1,
            total_turns: 0,
            total_tool_calls: 0,
            total_tool_errors: 0,
            total_host_tool_calls: 0,
            tool_histogram: BTreeMap::new(),
            total_cost_usd: 0.0,
            total_gen_duration_ms: 0,
            total_active_decode_ms: 0,
            total_http_retries: 0,
            total_unreachable_retries: 0,
            total_truncated_stream_retries: 0,
            total_stall_retries: 0,
            total_ws_turns: 0,
            total_ws_fallbacks: 0,
            total_rtk_compressions: 0,
            total_rtk_spills: 0,
            total_fold_compressions: 0,
            total_verify_gate_nudges: 0,
            total_narration_nudges: 0,
            total_interleaved_reasoning_turns: 0,
            total_sap_repairs: 0,
            total_oscillation_nudges: 0,
            total_hedge_wins: 0,
            total_hedges_issued: 0,
            total_final_review_nudges: 0,
            final_review_gate: true,
            last_context_tokens: 0,
            http,
            fresh_http,
            ws_state: ResponsesWsContinuationState::default(),
            last_prompt_cache_hit_at: None,
            first_prompt_sent: false,
            shell_label,
        })
    }

    /// Attach a configured `DynamicProviderRouter` (optionally WAL SQLite-backed).
    pub fn bind_dynamic_router(&mut self, router: Arc<DynamicProviderRouter>) {
        self.dynamic_router = Some(router);
    }

    /// Initialize WAL SQLite-backed `DynamicProviderRouter` from `omnia_router.db` and `models.yml`.
    pub fn init_default_sqlite_router(&mut self, db_path: Option<&Path>) -> Result<()> {
        let resolved_path = db_path
            .map(PathBuf::from)
            .unwrap_or_else(|| default_omnia_data_dir().join("omnia_router.db"));
        let now_ms = Utc::now().timestamp_millis();
        let router = Arc::new(
            DynamicProviderRouter::open_sqlite(&resolved_path, now_ms)
                .map_err(|e| anyhow::anyhow!("open router sqlite failed: {e}"))?,
        );
        Self::register_endpoint_candidate(&router, &self.endpoint);
        if let Some(cfg_dir) = detect_default_models_dir() {
            if let Ok(cfg) = read_models_config(Some(&cfg_dir)) {
                for p in &cfg.providers {
                    for m in &p.models {
                        let cid = format!("{}::{}", p.id, m.id);
                        let low = m.id.to_ascii_lowercase();
                        let roles = if low.contains("haiku") || low.contains("flash") || low.contains("mini") {
                            vec![ModelRole::Fast, ModelRole::FastApply]
                        } else if low.contains("opus") || low.contains("gpt-6") || low.contains("sonnet") {
                            vec![ModelRole::Main, ModelRole::Architect, ModelRole::Advisor, ModelRole::Verifier]
                        } else {
                            vec![ModelRole::Main]
                        };
                        let cand = RouteCandidate {
                            candidate_id: cid,
                            provider_id: p.id.clone(),
                            model_id: m.id.clone(),
                            capabilities: ModelCapabilities::standard_candidate(),
                            context_limit_tokens: m.context_window.max(32_000),
                            max_output_tokens: m.max_tokens.clamp(1024, 128_000),
                            input_cost_per_million_microunits: Some((m.cost.input * 1_000_000.0) as i64),
                            output_cost_per_million_microunits: Some((m.cost.output * 1_000_000.0) as i64),
                            credential_present: !p.api_key.trim().is_empty() || !m.api_key.trim().is_empty(),
                            enabled: true,
                            supported_roles: roles,
                            ..RouteCandidate::default()
                        };
                        let _ = router.upsert_candidate(cand, CandidateResourceState::default());
                    }
                }
            }
        }
        self.dynamic_router = Some(router);
        Ok(())
    }

    fn register_endpoint_candidate(router: &DynamicProviderRouter, ep: &ResolvedModelEndpoint) {
        let cid = format!("{}::{}", ep.provider_id, ep.model_id);
        let cand = RouteCandidate {
            candidate_id: cid,
            provider_id: ep.provider_id.clone(),
            model_id: ep.model_id.clone(),
            capabilities: ModelCapabilities::standard_candidate(),
            context_limit_tokens: ep.context_window.max(32_000),
            max_output_tokens: ep.max_tokens.clamp(1024, 128_000),
            input_cost_per_million_microunits: Some((ep.cost_input_per_m * 1_000_000.0) as i64),
            output_cost_per_million_microunits: Some((ep.cost_output_per_m * 1_000_000.0) as i64),
            credential_present: !ep.api_key.trim().is_empty(),
            enabled: true,
            ..RouteCandidate::default()
        };
        let _ = router.upsert_candidate(cand, CandidateResourceState::default());
    }

    /// Explicitly register an endpoint override for a functional role (`main`, `architect`, `fast`, `advisor`, `verifier`, `fast_apply`).
    pub fn register_role_endpoint(&mut self, role: ModelRole, ep: ResolvedModelEndpoint) {
        if let Some(ref router) = self.dynamic_router {
            Self::register_endpoint_candidate(router, &ep);
            let spec = format!("{}/{}", ep.provider_id, ep.model_id);
            let _ = router.bind_role(
                role,
                &format!("{}::{}", ep.provider_id, ep.model_id),
                &spec,
                Utc::now().timestamp_millis(),
            );
        }
        self.role_endpoints.insert(role, ep);
    }

    /// Resolve an endpoint for a functional `ModelRole` via bound endpoint -> `DynamicProviderRouter` -> active `endpoint`.
    #[must_use]
    pub fn resolve_role_endpoint(&self, role: ModelRole) -> ResolvedModelEndpoint {
        if let Some(ep) = self.role_endpoints.get(&role) {
            return ep.clone();
        }
        if let Some(ref router) = self.dynamic_router {
            let mut policy = RouteRequestPolicy::default();
            policy.request_id = format!("role-{}-{}", role.as_str(), self.total_turns);
            policy.idempotency_key = format!("{}:{}", self.session_key, policy.request_id);
            policy.allow_unknown_quota_without_emergency = true;
            policy.session_affinity_key = Some(self.session_key.clone());
            if let Ok(res) = router.select_for_role(role, policy) {
                if let Some(grant) = res.reservation {
                    let spec = format!("{}/{}", grant.provider_id, grant.model_id);
                    if let Ok(resolved) = resolve_model_endpoint(&spec, None, None, None) {
                        return resolved;
                    }
                }
            }
        }
        self.endpoint.clone()
    }

    /// Open a Context-Folding exploration branch (`FoldAgent`, arXiv:2510.11967).
    pub fn branch_context_fold(&mut self, branch_id: &str, objective: &str) {
        self.fold_agent
            .branch_subtask(branch_id, objective, self.messages.len(), self.total_turns);
    }

    /// Collapse a completed Context-Folding branch back into main history with Prefix-0 intact.
    pub fn complete_context_fold(
        &mut self,
        branch_id: &str,
        verified_summary: &str,
        kept_files: &[String],
    ) -> Option<crate::lakeview::FoldResult> {
        let res = self.fold_agent.return_and_fold(
            branch_id,
            &mut self.messages,
            verified_summary,
            kept_files,
            self.total_turns,
        );
        if res.is_some() {
            self.total_fold_compressions += 1;
        }
        res
    }

    /// Attach a `MemoryEngine` for Prefix-0-safe message-tail `<recalled_memories>` retrieval.
    pub fn bind_memory_engine(&mut self, engine: Arc<MemoryEngine>) {
        self.memory_engine = Some(engine);
    }

    /// Configure opt-in Test-Time Scaling (`Best-of-N` / `TEX` / `MCTS`; disabled by default).
    pub fn enable_test_time_scaling(&mut self, cfg: TestTimeScalingConfig) {
        self.tts_config = cfg;
    }

    /// Distill a Parallel-Distill-Refine (PDR) digest from an opt-in TEX $K \times K$ matrix report.
    #[must_use]
    pub fn summarize_tex_pdr(
        &self,
        report: &TexCrossValidationReport,
        max_chars: usize,
    ) -> Option<String> {
        if !self.tts_config.enabled {
            return None;
        }
        Some(distill_tex_matrix_pdr(report, max_chars))
    }

    /// Evaluate a proactive `quota_gate` snapshot and update SQLite router exhaustion before hitting 429.
    pub fn apply_proactive_quota_snapshot(
        &self,
        candidate_id: &str,
        snapshot: &QuotaProbeSnapshot,
        now_ms: i64,
    ) -> bool {
        let verdict = evaluate_proactive_quota_gate(snapshot, now_ms);
        if let Some(ref router) = self.dynamic_router {
            let buckets: Vec<(String, i64, i64, bool, Option<i64>)> = snapshot
                .buckets
                .iter()
                .map(|b| {
                    (
                        b.name.clone(),
                        b.total,
                        b.remaining,
                        b.unlimited,
                        b.reset_at_epoch_ms,
                    )
                })
                .collect();
            if let Ok(exh) =
                router.apply_quota_probe(candidate_id, snapshot.limit_reached, &buckets, now_ms)
            {
                return exh;
            }
        }
        verdict.exhausted
    }

    /// Resolve per-turn adaptive reasoning effort (unlocked through `max`).
    #[must_use]
    pub fn resolve_effort_for_turn(
        &self,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
    ) -> Option<EffortLevel> {
        if force_low_reasoning {
            return clamp_effort_for_model(&self.endpoint.model_id, EffortLevel::Low);
        }
        if let Some(ref raw) = self.thinking_level {
            if let Ok(parsed) = raw.trim().parse::<EffortLevel>() {
                return clamp_effort_for_model(&self.endpoint.model_id, parsed)
                    .or(Some(parsed));
            }
        }
        let spec = effort_spec_for_model(&self.endpoint.model_id);
        let base = spec.default_level?;
        if escalate_reasoning {
            let bumped = match base {
                EffortLevel::Minimal | EffortLevel::Low => EffortLevel::Medium,
                EffortLevel::Medium => EffortLevel::High,
                EffortLevel::High => EffortLevel::XHigh,
                EffortLevel::XHigh | EffortLevel::Max => EffortLevel::Max,
                EffortLevel::None => EffortLevel::None,
            };
            clamp_effort_for_model(&self.endpoint.model_id, bumped).or(Some(base))
        } else {
            Some(base)
        }
    }

    /// Resolve active wire dialect honoring `wire_api_mode` and automatic fallback.
    #[must_use]
    pub fn active_wire_dialect(&self) -> &'static str {
        let resolved = self
            .wire_api_mode
            .resolve_api_kind(&self.endpoint.model_id, &self.endpoint.api);
        if (resolved == "anthropic-messages" && self.anthropic_fallback_to_openai)
            || (resolved == "openai-responses" && self.responses_fallback_to_chat)
        {
            "openai-completions"
        } else {
            resolved
        }
    }

    #[must_use]
    fn should_use_responses_ws(&self) -> bool {
        !self.ws_state.disabled
            && (self.responses_ws_enabled
                || self.wire_api_mode == WireApiMode::ResponsesWs
                || self
                    .endpoint
                    .api
                    .eq_ignore_ascii_case("openai-responses-ws")
                || self.endpoint.base_url.starts_with("ws://")
                || self.endpoint.base_url.starts_with("wss://"))
    }

    /// D2 Atomic `/rewind`: roll back all file mutations made after `target_turn`, refresh Merkle/Graph,
    /// and truncate message history to `turn_index <= target_turn` keeping turns `0..=target_turn` KV-cache hot!
    pub fn rewind_to_turn(&mut self, target_turn: u32) -> Result<Vec<String>> {
        let restored = self
            .tool_runtime
            .checkpoint_store
            .lock()
            .unwrap()
            .rollback_to_turn(
                target_turn,
                &self.workspace_root,
                &self.tool_runtime.read_tracker,
            )?;
        let _ = self.tool_runtime.graph_index.lock().unwrap().refresh();
        self.messages
            .retain(|m| m.role == "system" || m.turn_index <= target_turn);
        Ok(restored)
    }

    /// Execute one user prompt to completion (multi-turn agent loop until final response, max_turns, timeout, or cancel).
    pub async fn run_prompt(
        &mut self,
        user_prompt: &str,
        max_turns: u32,
        timeout_secs: u64,
        sink: Option<HarnessEventSink>,
    ) -> Result<PromptRunSummary> {
        self.run_prompt_with_blocks(user_prompt, Vec::new(), max_turns, timeout_secs, sink)
            .await
    }

    /// Execute one user prompt with optional multimodal image/file content blocks.
    pub async fn run_prompt_with_blocks(
        &mut self,
        user_prompt: &str,
        user_blocks: Vec<ContentBlock>,
        max_turns: u32,
        timeout_secs: u64,
        sink: Option<HarnessEventSink>,
    ) -> Result<PromptRunSummary> {
        let prompt_start = Instant::now();
        let total_budget_secs = timeout_secs.max(5);
        let deadline = prompt_start + Duration::from_secs(total_budget_secs);
        let max_turns = max_turns.clamp(1, 120);
        self.active_prompt_start_turn = self.total_turns + 1;

        let before_start = self
            .hooks
            .dispatch(
                HookEvent::BeforeAgentStart,
                None,
                json!({ "sessionKey": self.session_key, "model": self.endpoint.model_id }),
            )
            .await;
        if before_start.blocked {
            bail!(
                "Hook blocked agent start: {}",
                before_start
                    .block_reason
                    .unwrap_or_else(|| "exit 2".into())
            );
        }
        let prompt_hook = self
            .hooks
            .dispatch(
                HookEvent::UserPromptSubmit,
                None,
                json!({ "prompt": user_prompt }),
            )
            .await;
        if prompt_hook.blocked {
            bail!(
                "Hook blocked prompt: {}",
                prompt_hook
                    .block_reason
                    .unwrap_or_else(|| "exit 2".into())
            );
        }
        let effective_prompt = prompt_hook
            .revised_input
            .as_ref()
            .and_then(|v| v.get("prompt").or(Some(v)).and_then(Value::as_str))
            .unwrap_or(user_prompt)
            .to_string();

        // Inject workspace context + query-seeded PPR AST RepoMap ONLY into Turn-1 user message
        // (NEVER mutating Token-0 system prompt!)
        let mut user_content = if !self.first_prompt_sent {
            self.first_prompt_sent = true;
            let mut extra_sections = Vec::new();
            self.plugins
                .run_turn1_transforms(&self.workspace_root, &mut extra_sections);
            let turn1_prefix = {
                let g = self.tool_runtime.graph_index.lock().unwrap();
                let opt_g = if self.plugins.is_enabled("merkle_index") {
                    Some(&*g)
                } else {
                    None
                };
                self.tool_runtime.context_bundle.format_turn1_prefix(
                    &self.workspace_root,
                    self.shell_label,
                    opt_g,
                    &effective_prompt,
                    &extra_sections,
                )
            };
            format!("{turn1_prefix}{effective_prompt}")
        } else {
            effective_prompt.clone()
        };

        for ctx_note in prompt_hook.additional_context {
            if !ctx_note.trim().is_empty() {
                user_content.push_str("\n\n");
                user_content.push_str(ctx_note.trim());
            }
        }
        if let Some(ref mem) = self.memory_engine {
            if let Some(recalled_tail) =
                mem.recall_tail_for_prompt(&self.workspace_root, &effective_prompt, 2_400)
            {
                user_content.push_str("\n\n");
                user_content.push_str(&recalled_tail);
            }
        }

        let user_msg = if user_blocks.is_empty() {
            HarnessMessage::user(user_content, self.total_turns + 1)
        } else {
            HarnessMessage::user_multimodal(user_content, user_blocks, self.total_turns + 1)
        };
        self.messages.push(user_msg);
        if self.conversation_fp.starts_with("fp:") {
            self.conversation_fp = conversation_fingerprint(
                Some(&self.session_key),
                &self.system_prompt,
                &effective_prompt,
            );
        }

        let mut prompt_turns = 0u32;
        let mut ttft_ms: Option<u64> = None;
        let mut llm_ttft_ms: Option<u64> = None;
        let mut prompt_gen_ms = 0u64;
        let mut prompt_active_decode_ms = 0u64;
        let mut prompt_output_tokens = 0u64;
        let mut saw_any_usage = false;
        let mut saw_any_reasoning_tokens = false;
        let mut had_tool_result_this_prompt = false;
        let mut final_text = String::new();
        let mut recovery_attempts = 0u32;
        let mut recovery_succeeded = false;
        let mut force_low_reasoning = false;
        let mut status = "completed".to_string();
        let mut error_msg: Option<String> = None;
        let mut progress = ExecutionProgressState::default();

        while prompt_turns < max_turns {
            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                status = "aborted".into();
                error_msg = Some("Aborted by user".into());
                break;
            }
            if Instant::now() >= deadline {
                status = "timeout".into();
                error_msg = Some(format!("Timed out after {total_budget_secs}s"));
                break;
            }

            prompt_turns += 1;
            self.total_turns += 1;
            let cur_turn = self.total_turns;
            self.tool_runtime
                .current_turn
                .store(cur_turn, Ordering::Relaxed);

            // Cordis + external lifecycle pre-turn hooks
            let mut hook_ctx = TurnHookContext {
                turn_index: cur_turn,
                last_tool_errors: self.total_tool_errors,
                injected_notes: Vec::new(),
            };
            self.plugins.run_before_turn(&mut hook_ctx);
            let turn_hook = self
                .hooks
                .dispatch(
                    HookEvent::TurnStart,
                    None,
                    json!({ "turn": cur_turn, "toolErrors": self.total_tool_errors }),
                )
                .await;
            for ctx_note in turn_hook.additional_context {
                if !ctx_note.trim().is_empty() {
                    hook_ctx.injected_notes.push(ctx_note);
                }
            }

            // SHA-256 Instruction Delta Epoch: freeze Turn-1 baseline, append Tier-3 delta ONLY on drift.
            let instr_sources = self.collect_instruction_epoch_sources(&hook_ctx.injected_notes);
            if let Some(delta_block) = self
                .instruction_epoch
                .observe_and_commit(&instr_sources, cur_turn)
            {
                self.messages
                    .push(HarnessMessage::user(delta_block, cur_turn));
            }

            // 25 MiB -> 15 MiB multimodal image hysteresis bounding before compaction/serialization.
            if self
                .messages
                .iter()
                .any(|m| !m.content_blocks.is_empty())
            {
                self.messages = bound_multimodal_images(&self.messages);
            }

            // Compaction-ahead-of-Steers + Warm-Cache 200k Compaction + Stage 1/2 Lakeview:
            let compact_cap = self.endpoint.context_window.min(200_000);
            let total_est_chars: usize = self.messages.iter().map(|m| m.content.len()).sum();
            let est_total_tokens =
                self.last_context_tokens.max((total_est_chars as u64).div_ceil(4));
            let mut stage2_anchor_note: Option<String> = None;
            if est_total_tokens >= compact_cap
                && self
                    .background_compactor
                    .try_swap_precomputed(&mut self.messages, cur_turn)
            {
                self.cache_guard.lakeview_compressions += 1;
                self.trajectory.record(
                    cur_turn,
                    "warm_cache_compaction_swap",
                    json!({ "ceilingTokens": compact_cap, "estTokens": est_total_tokens }),
                );
            } else if self.plugins.is_enabled("lakeview_compress") {
                let comp = self.epoch_masker.maybe_fold(&mut self.messages, cur_turn);
                if comp.compressed_count > 0 {
                    self.cache_guard.lakeview_compressions += comp.compressed_count;
                    self.cache_guard.lakeview_chars_saved += comp.chars_saved;
                    self.trajectory.record(
                        cur_turn,
                        "lakeview_compress",
                        json!({
                            "compressedCount": comp.compressed_count,
                            "charsSaved": comp.chars_saved,
                            "epochCutoffTurn": self.epoch_masker.last_masked_turn
                        }),
                    );
                    // Stage 2: Factory Anchored Iterative Summarization when nearing context-rot knee (~68% of <=200k compact cap)
                    let rot_knee = (compact_cap * 68) / 100;
                    if self.last_context_tokens >= rot_knee
                        && self.epoch_masker.last_masked_turn > 0
                    {
                        self.anchored_summary
                            .merge_messages(&self.messages, self.epoch_masker.last_masked_turn);
                        stage2_anchor_note = Some(self.anchored_summary.render_tail_block());
                    }
                }
                let cache_age_ms = self
                    .last_prompt_cache_hit_at
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                if self.background_compactor.should_start_precompute(
                    est_total_tokens,
                    0,
                    &self.endpoint.model_id,
                    cache_age_ms,
                    None,
                ) && self.messages.len() > 6
                {
                    let keep_idx = (self.messages.len() / 2).max(2);
                    let kept_files: Vec<String> = progress.files_mutated.iter().cloned().collect();
                    let snap_text = render_snapcompact_archive_text(
                        &kept_files,
                        &self.messages[..keep_idx],
                        false,
                    );
                    self.background_compactor.store_precomputed(
                        keep_idx,
                        cur_turn,
                        &self.endpoint.model_id,
                        snap_text,
                        Utc::now().timestamp_millis().max(0) as u64,
                    );
                }
            }
            if let Some(anchor_text) = stage2_anchor_note {
                // Append strictly at Tier 3 (tail) to keep Tier 0..2 KV prefix hot!
                self.messages
                    .push(HarnessMessage::user(anchor_text, cur_turn));
            }

            // Final-Step `tool_choice: "none"` (`prompt_turns == max_turns && max_turns > 1`):
            // preserves `tools` schema prefix while guaranteeing clean textual closure.
            let force_no_tools = prompt_turns >= max_turns && max_turns > 1;
            if force_no_tools
                && had_tool_result_this_prompt
                && self
                    .messages
                    .last()
                    .is_some_and(|m| !m.content.contains("[Max Steps Reached]"))
            {
                self.messages.push(HarnessMessage::user(
                    "[Max Steps Reached] Tool execution is disabled for this final turn. Summarize completed work and remaining verification cleanly now.",
                    cur_turn,
                ));
            }

            // SHA-256 Prefix-Cache Stability verification on EVERY turn
            let _stable = self
                .cache_guard
                .verify_turn_prefix(&self.system_prompt, &self.canonical_tools);

            if let Some(ref s) = sink {
                s(HarnessStreamEvent::TurnStart { turn: cur_turn });
            }
            self.trajectory.record(
                cur_turn,
                "turn_start",
                json!({
                    "model": self.endpoint.model_id,
                    "messageCount": self.messages.len(),
                    "prefixStable": self.cache_guard.snapshot().prefix_stable,
                    "forceNoTools": force_no_tools
                }),
            );

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                status = "timeout".into();
                error_msg = Some(format!("Timed out after {total_budget_secs}s"));
                break;
            }

            // Track whether this request actually echoes interleaved reasoning from an earlier tool turn
            let echoing_interleaved = self.supports_reasoning_echo
                && self.messages.iter().any(|m| {
                    m.role == "assistant"
                        && m.turn_index >= self.active_prompt_start_turn
                        && !m.tool_calls.is_empty()
                        && m.reasoning.as_deref().is_some_and(|r| !r.is_empty())
                });
            if echoing_interleaved {
                self.total_interleaved_reasoning_turns += 1;
            }

            let msg_id = format!("msg-{}-{}", self.session_key, cur_turn);
            let turn_res = match self
                .call_llm_streaming(
                    &msg_id,
                    remaining,
                    force_low_reasoning,
                    progress.escalate_reasoning,
                    force_no_tools,
                    sink.as_ref(),
                )
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let s = e.to_string();
                    if s.contains("Timed out") || Instant::now() >= deadline {
                        status = "timeout".into();
                    } else if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                        status = "aborted".into();
                    } else {
                        status = "error".into();
                    }
                    error_msg = Some(s);
                    break;
                }
            };

            if llm_ttft_ms.is_none() {
                llm_ttft_ms = turn_res.turn_ttft_ms;
            }
            if ttft_ms.is_none() && turn_res.turn_ttft_ms.is_some() {
                ttft_ms = Some(
                    prompt_start
                        .elapsed()
                        .as_millis()
                        .saturating_sub(turn_res.turn_gen_ms as u128) as u64,
                );
                if prompt_turns == 1 {
                    if let Some(lt) = turn_res.turn_ttft_ms {
                        ttft_ms = Some(lt);
                    }
                }
            }
            prompt_gen_ms += turn_res.turn_gen_ms;
            prompt_active_decode_ms += turn_res.turn_active_decode_ms;
            self.total_gen_duration_ms += turn_res.turn_gen_ms;
            self.total_active_decode_ms += turn_res.turn_active_decode_ms;

            if turn_res.usage.saw_usage {
                saw_any_usage = true;
                if turn_res.usage.reasoning.is_some() {
                    saw_any_reasoning_tokens = true;
                }
                if turn_res.usage.cache_read > 0 || turn_res.usage.cache_write > 0 {
                    self.last_prompt_cache_hit_at = Some(Instant::now());
                }
                self.cache_guard.record_usage(
                    turn_res.usage.uncached_input,
                    turn_res.usage.cache_read,
                    turn_res.usage.cache_write,
                    turn_res.usage.output,
                    turn_res.usage.reasoning,
                );
                prompt_output_tokens += turn_res.usage.output;
                self.last_context_tokens = turn_res.usage.uncached_input
                    + turn_res.usage.cache_read
                    + turn_res.usage.cache_write
                    + turn_res.usage.output;
                let turn_cost = (turn_res.usage.uncached_input as f64 / 1_000_000.0)
                    * self.endpoint.cost_input_per_m
                    + (turn_res.usage.cache_read as f64 / 1_000_000.0)
                        * self.endpoint.cost_cache_read_per_m
                    + (turn_res.usage.cache_write as f64 / 1_000_000.0)
                        * self.endpoint.cost_cache_write_per_m
                    + (turn_res.usage.output as f64 / 1_000_000.0)
                        * self.endpoint.cost_output_per_m;
                self.total_cost_usd += turn_cost;
            }

            if !turn_res.text.trim().is_empty() {
                final_text = turn_res.text.clone();
                if recovery_attempts > 0 {
                    recovery_succeeded = true;
                }
            }

            self.trajectory.record(
                cur_turn,
                "llm_response",
                json!({
                    "finishReason": turn_res.finish_reason,
                    "toolCallCount": turn_res.tool_calls.len(),
                    "textChars": turn_res.text.len(),
                    "reasoningChars": turn_res.reasoning.len(),
                    "turnGenMs": turn_res.turn_gen_ms,
                    "turnActiveDecodeMs": turn_res.turn_active_decode_ms,
                    "outputTokens": turn_res.usage.output,
                    "httpRetries": turn_res.http_retries
                }),
            );

            // Run Rust BAML SAP partial-JSON repair ONCE BEFORE recording conversation history
            // so repaired tool calls persist cleanly as valid JSON objects (never `{"_raw": ...}`).
            let mut sap_repairs_this_turn = 0u32;
            let mut sanitized_tcs: Vec<ToolCallRecord> =
                Vec::with_capacity(turn_res.tool_calls.len());
            let mut parsed_calls: Vec<(ToolCallRecord, Result<Value>)> =
                Vec::with_capacity(turn_res.tool_calls.len());
            for tc in &turn_res.tool_calls {
                let schema = self.tool_schemas_by_name.get(&tc.name);
                let (clean_args, parsed) = if tc.arguments.trim().is_empty() {
                    ("{}".to_string(), Ok(json!({})))
                } else {
                    match repair_tool_json(&tc.arguments, schema) {
                        Ok(sap) => {
                            if sap.repaired {
                                sap_repairs_this_turn += 1;
                            }
                            let serialized =
                                serde_json::to_string(&sap.value).unwrap_or_else(|_| "{}".into());
                            (serialized, Ok(sap.value))
                        }
                        Err(err) => (
                            json!({ "_raw": tc.arguments }).to_string(),
                            Err(anyhow::anyhow!(
                                "invalid JSON arguments for '{}': {err}",
                                tc.name
                            )),
                        ),
                    }
                };
                let repaired_tc = ToolCallRecord {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: clean_args,
                };
                sanitized_tcs.push(repaired_tc.clone());
                parsed_calls.push((repaired_tc, parsed));
            }
            self.total_sap_repairs += sap_repairs_this_turn;

            if !turn_res.text.trim().is_empty()
                || !sanitized_tcs.is_empty()
                || !turn_res.redacted_thinking.is_empty()
                || !turn_res.reasoning_encrypted_items.is_empty()
            {
                let mut asst_msg = HarnessMessage::assistant_with_signature(
                    turn_res.text.clone(),
                    if turn_res.reasoning.is_empty() {
                        None
                    } else {
                        Some(turn_res.reasoning.clone())
                    },
                    turn_res.reasoning_signature.clone(),
                    sanitized_tcs,
                    cur_turn,
                )
                .with_origin(&self.endpoint.provider_id, &self.endpoint.model_id);
                asst_msg.redacted_thinking = turn_res.redacted_thinking.clone();
                asst_msg.reasoning_encrypted_items = turn_res.reasoning_encrypted_items.clone();
                self.messages.push(asst_msg);
            }

            self.emit_live_telemetry(sink.as_ref(), prompt_output_tokens, prompt_gen_ms);

            // No tool calls -> check Empty-Thinking Recovery, Narration-Stop Guard, and Active Self-Verify Gate!
            if turn_res.tool_calls.is_empty() {
                let rem_now = deadline.saturating_duration_since(Instant::now());
                let empty_visible = turn_res.text.trim().is_empty();
                let is_empty_thinking = empty_visible
                    && (had_tool_result_this_prompt || !turn_res.reasoning.trim().is_empty());

                // 1. 2-Stage Empty-Thinking Auto-Recovery
                if is_empty_thinking
                    && self.plugins.is_enabled("empty_thinking_recovery")
                    && recovery_attempts < 2
                    && prompt_turns < max_turns
                {
                    recovery_attempts += 1;
                    self.cache_guard.recovery_attempts += 1;
                    let (nudge, reason) = if recovery_attempts == 1 {
                        (
                            "Your previous turn ended with internal reasoning only and no visible text response. Please provide your complete final visible response now (or invoke any remaining tool needed to complete the task).",
                            "Empty visible assistant response after tool/reasoning (stage 1 recovery nudge)",
                        )
                    } else {
                        force_low_reasoning = true;
                        (
                            "Respond now in plain visible text with your final answer based on the tool results already gathered. Do not emit an empty response.",
                            "Repeated thinking-only empty stop (stage 2 plain-text recovery)",
                        )
                    };
                    if let Some(ref s) = sink {
                        s(HarnessStreamEvent::AutoRecovery {
                            attempt: recovery_attempts,
                            reason: reason.to_string(),
                        });
                    }
                    self.trajectory.record(
                        cur_turn,
                        "auto_recovery",
                        json!({ "attempt": recovery_attempts, "reason": reason }),
                    );
                    self.messages
                        .push(HarnessMessage::user(nudge.to_string(), cur_turn));
                    if let Some(ref s) = sink {
                        s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
                    }
                    continue;
                }

                // 2. Narration-Only Premature Stop Guard (`narration_nudges < 2`)
                if !empty_visible
                    && prompt_turns < max_turns
                    && rem_now > Duration::from_secs(20)
                    && progress.narration_nudges < 2
                    && progress.files_mutated.is_empty()
                    && progress.shell_runs_total == 0
                    && is_narration_only_stop(&turn_res.text)
                {
                    progress.narration_nudges += 1;
                    self.total_narration_nudges += 1;
                    self.trajectory.record(
                        cur_turn,
                        "narration_guard",
                        json!({ "nudge": progress.narration_nudges }),
                    );
                    self.messages.push(HarnessMessage::user(
                        "[Execution Guard] You described your next step without calling a tool. Invoke the required tool(s) now (batching reads/edits) and complete the task.",
                        cur_turn,
                    ));
                    if let Some(ref s) = sink {
                        s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
                    }
                    continue;
                }

                // 3. Active Runtime Self-Verification Gate (`self_verify_gate` enabled, `verify_gate_nudges < 1`)
                let needs_verify = !progress.files_mutated.is_empty()
                    && (!progress.verified_since_last_mutation
                        || progress.last_shell_exit_code.is_some_and(|c| c != 0));
                if needs_verify
                    && self.plugins.is_enabled("self_verify_gate")
                    && prompt_turns < max_turns
                    && rem_now > Duration::from_secs(20)
                    && progress.verify_gate_nudges < 1
                {
                    progress.verify_gate_nudges += 1;
                    self.total_verify_gate_nudges += 1;
                    let edited_list: Vec<&str> = progress
                        .files_mutated
                        .iter()
                        .take(8)
                        .map(|s| s.as_str())
                        .collect();
                    self.trajectory.record(
                        cur_turn,
                        "self_verify_gate",
                        json!({
                            "editedFiles": edited_list,
                            "lastShellExit": progress.last_shell_exit_code
                        }),
                    );
                    self.messages.push(HarnessMessage::user(
                        format!(
                            "[Self-Verify Gate] You modified [{}] without running a verification test/build command after your final edit (or the last command exited non-zero). Run the relevant test/verification command via `shell` now and confirm exit_code == 0 before finishing.",
                            edited_list.join(", ")
                        ),
                        cur_turn,
                    ));
                    if let Some(ref s) = sink {
                        s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
                    }
                    continue;
                }

                // 4. One-shot Final Review Gate: re-check every stated requirement & edge case
                // (catches `9/10 checks` premature exits) while budget clearly remains.
                // Anti-Termination-Lag (arXiv:2611.14960): if a real test suite already ran green
                // (`FailToPass` / `AllGreen`) after the last edit, do NOT force an extra turn.
                let base_floor = (total_budget_secs / 5).max(45);
                let is_heavy = StreamBudgetConfig::is_heavy_model(
                    &self.endpoint.model_id,
                    self.last_context_tokens,
                );
                let heavy_floor = if (is_heavy
                    && self.stream_budget.heavy_first_delta_timeout >= Duration::from_secs(120))
                    || self.stream_budget.first_delta_timeout >= Duration::from_secs(120)
                {
                    base_floor.max(155)
                } else {
                    base_floor
                };
                let review_floor = Duration::from_secs(heavy_floor);
                if self.final_review_gate
                    && !progress.files_mutated.is_empty()
                    && !progress.test_suite_passed_since_last_mutation
                    && progress.final_review_nudges < 1
                    && prompt_turns + 2 <= max_turns
                    && rem_now > review_floor
                {
                    progress.final_review_nudges += 1;
                    self.total_final_review_nudges += 1;
                    self.trajectory.record(
                        cur_turn,
                        "final_review_gate",
                        json!({ "editedFiles": progress.files_mutated.len() }),
                    );
                    self.messages.push(HarnessMessage::user(
                        "[Final Review Gate] Before finishing, re-read the original task and check EVERY stated requirement and edge case (boundaries, inclusive/exclusive limits, rounding/precision, idempotency, error paths). If any item is not yet proven by a passing run, add or run a targeted check and fix it now. If everything is verified, reply with your concise final summary.",
                        cur_turn,
                    ));
                    if let Some(ref s) = sink {
                        s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
                    }
                    continue;
                }

                if let Some(ref s) = sink {
                    s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
                }
                break;
            }

            // Prefix-Parallel Mixed-Batch Tool Dispatch (using pre-repaired SAP `parsed_calls` + PreToolUse hook)
            let mut spec_map = turn_res.speculative_results;
            let batches = partition_tool_batches(&parsed_calls);
            let mut outcomes = Vec::with_capacity(parsed_calls.len());

            for batch in batches {
                match batch {
                    ToolDispatchBatch::ParallelRead(range) => {
                        let mut futs = Vec::with_capacity(range.len());
                        for idx in range {
                            let (tc, parsed) = &parsed_calls[idx];
                            if let Some(ref s) = sink {
                                s(HarnessStreamEvent::ToolStart {
                                    tool_call_id: tc.id.clone(),
                                    tool_name: tc.name.clone(),
                                    arguments: parsed
                                        .as_ref()
                                        .cloned()
                                        .unwrap_or_else(|_| json!({})),
                                });
                            }
                            let pre_hook = self
                                .hooks
                                .dispatch(
                                    HookEvent::PreToolUse,
                                    Some(&tc.name),
                                    json!({
                                        "toolName": tc.name,
                                        "arguments": parsed.as_ref().cloned().unwrap_or_else(|_| json!({}))
                                    }),
                                )
                                .await;
                            let mut pre_handle = spec_map.remove(&idx);
                            let blocked_msg = if pre_hook.blocked {
                                if let Some(h) = pre_handle.take() {
                                    h.abort();
                                }
                                Some(format!(
                                    "Error: Hook blocked '{}': {}",
                                    tc.name,
                                    pre_hook
                                        .block_reason
                                        .unwrap_or_else(|| "exit 2".into())
                                ))
                            } else {
                                None
                            };
                            let arg_res = if let Some(rev) = pre_hook.revised_input {
                                if let Some(h) = pre_handle.take() {
                                    h.abort();
                                }
                                Ok(rev)
                            } else {
                                parsed.as_ref().cloned().map_err(|e| e.to_string())
                            };
                            let rt = self.tool_runtime.clone();
                            let name = tc.name.clone();
                            futs.push(async move {
                                if let Some(bmsg) = blocked_msg {
                                    return ToolExecOutput {
                                        content: bmsg,
                                        is_error: true,
                                        is_host_tool: name.starts_with("omni_"),
                                        duration_ms: 0,
                                    };
                                }
                                if let Some(h) = pre_handle {
                                    if let Ok(pre_out) = h.await {
                                        return pre_out;
                                    }
                                }
                                match arg_res {
                                    Ok(val) => rt.execute(&name, &val).await,
                                    Err(e) => ToolExecOutput {
                                        content: format!("Error: {e}"),
                                        is_error: true,
                                        is_host_tool: name.starts_with("omni_"),
                                        duration_ms: 0,
                                    },
                                }
                            });
                        }
                        let par_outs = futures_util::future::join_all(futs).await;
                        outcomes.extend(par_outs);
                    }
                    ToolDispatchBatch::Sequential(idx) => {
                        let (tc, parsed) = &parsed_calls[idx];
                        if let Some(ref s) = sink {
                            s(HarnessStreamEvent::ToolStart {
                                tool_call_id: tc.id.clone(),
                                tool_name: tc.name.clone(),
                                arguments: parsed.as_ref().cloned().unwrap_or_else(|_| json!({})),
                            });
                        }
                        let pre_hook = self
                            .hooks
                            .dispatch(
                                HookEvent::PreToolUse,
                                Some(&tc.name),
                                json!({
                                    "toolName": tc.name,
                                    "arguments": parsed.as_ref().cloned().unwrap_or_else(|_| json!({}))
                                }),
                            )
                            .await;
                        let mut pre_handle = spec_map.remove(&idx);
                        let out = if pre_hook.blocked {
                            if let Some(h) = pre_handle.take() {
                                h.abort();
                            }
                            ToolExecOutput {
                                content: format!(
                                    "Error: Hook blocked '{}': {}",
                                    tc.name,
                                    pre_hook.block_reason.unwrap_or_else(|| "exit 2".into())
                                ),
                                is_error: true,
                                is_host_tool: tc.name.starts_with("omni_"),
                                duration_ms: 0,
                            }
                        } else if let Some(rev) = pre_hook.revised_input {
                            if let Some(h) = pre_handle.take() {
                                h.abort();
                            }
                            self.tool_runtime.execute(&tc.name, &rev).await
                        } else if let Some(h) = pre_handle {
                            match h.await {
                                Ok(pre_out) => pre_out,
                                Err(_) => match parsed {
                                    Ok(val) => self.tool_runtime.execute(&tc.name, val).await,
                                    Err(e) => ToolExecOutput {
                                        content: format!("Error: {e}"),
                                        is_error: true,
                                        is_host_tool: tc.name.starts_with("omni_"),
                                        duration_ms: 0,
                                    },
                                },
                            }
                        } else {
                            match parsed {
                                Ok(val) => self.tool_runtime.execute(&tc.name, val).await,
                                Err(e) => ToolExecOutput {
                                    content: format!("Error: {e}"),
                                    is_error: true,
                                    is_host_tool: tc.name.starts_with("omni_"),
                                    duration_ms: 0,
                                },
                            }
                        };
                        outcomes.push(out);
                    }
                }
            }

            had_tool_result_this_prompt = true;
            let mut loop_nudges_this_turn = Vec::new();
            let mut turn_had_mutation = false;
            let mut turn_had_error = false;
            let mut turn_had_syntax_error = false;
            let mut turn_fail_to_pass: Option<(u32, u32)> = None;
            let was_already_verified_before_turn = !progress.files_mutated.is_empty()
                && progress.verified_since_last_mutation
                && progress.last_shell_exit_code == Some(0);
            let total_calls_this_turn = parsed_calls.len();

            for (call_idx, ((tc, parsed), out)) in
                parsed_calls.into_iter().zip(outcomes).enumerate()
            {
                self.total_tool_calls += 1;
                *self.tool_histogram.entry(tc.name.clone()).or_insert(0) += 1;
                // A shell command that ran and returned non-zero (e.g. failing tests) is valid
                // tool output, not a tool failure; it still drives verify gates & playbooks.
                let shell_nonzero = tc.name == "shell"
                    && !out.is_error
                    && parse_shell_exit_code(&out.content).is_some_and(|c| c != 0);
                let effective_error = out.is_error || shell_nonzero;
                if out.is_error {
                    self.total_tool_errors += 1;
                }
                if effective_error {
                    turn_had_error = true;
                    progress.escalate_reasoning = true;
                }
                if out.is_host_tool {
                    self.total_host_tool_calls += 1;
                }

                let arg_val = parsed.unwrap_or_else(|_| json!({}));
                let target_path = extract_tool_target_path(&tc.name, &arg_val);

                // Update ExecutionProgressState for Runtime Self-Verify Gate, Regression Detector,
                // Anti-Termination-Lag, & ACE Playbook + RTK stdout noise compression + >20KB spill.
                let mut tool_text = if out.content.len() >= 1_800 && tc.name != "read_file" {
                    let cmd_label = arg_val
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or(tc.name.as_str());
                    let exit_opt = if tc.name == "shell" {
                        parse_shell_exit_code(&out.content)
                    } else {
                        None
                    };
                    let spill_dir = std::env::temp_dir().join("omnia_tool_spills");
                    let rtk =
                        compress_text_output(cmd_label, &out.content, exit_opt, Some(&spill_dir));
                    if rtk.was_compressed {
                        self.total_rtk_compressions += 1;
                    }
                    if rtk.spilled {
                        self.total_rtk_spills += 1;
                    }
                    rtk.content
                } else {
                    if tc.name != "read_file"
                        && (out.content.contains("\n... [repeated ")
                            || out.content.contains("[rtk:"))
                    {
                        self.total_rtk_compressions += 1;
                        if out.content.contains("[rtk: raw log spilled ->") {
                            self.total_rtk_spills += 1;
                        }
                    }
                    out.content
                };
                if tool_text.contains("[Syntax Check")
                    || tool_text.contains("[Compiler Syntax Check FAILED]")
                {
                    turn_had_syntax_error = true;
                }
                match tc.name.as_str() {
                    "read_file" => {
                        if !out.is_error {
                            progress.files_read += 1;
                        }
                    }
                    "edit_file" | "write_file" | "apply_patch" => {
                        turn_had_mutation = true;
                        if out.is_error {
                            let fp_hex = format!("{:016x}", error_fingerprint(&tool_text));
                            let err_kind =
                                format!("{:?}", classify_tool_error(&tc.name, &tool_text));
                            let symptom: String = tool_text.chars().take(200).collect();
                            if let Some(ref db) = self.tool_runtime.db {
                                if let Ok(Some(entry)) =
                                    db.lookup_playbook_fix(&self.workspace_hash, &fp_hex)
                                {
                                    tool_text.push_str(&format!(
                                        "\n\n[Workspace Playbook Match (helpful={}): {}]",
                                        entry.helpful_count, entry.verified_fix
                                    ));
                                }
                            }
                            progress.last_failed_edit = Some((fp_hex, err_kind, symptom));
                        } else {
                            let label = target_path
                                .clone()
                                .unwrap_or_else(|| "workspace_file".into());
                            progress.files_mutated.insert(label.clone());
                            progress.verified_since_last_mutation = false;
                            progress.test_suite_passed_since_last_mutation = false;
                            if let Some((fp_hex, err_kind, symptom)) =
                                progress.last_failed_edit.take()
                            {
                                if let Some(ref db) = self.tool_runtime.db {
                                    let fix_summary =
                                        format!("Recovered via `{}` on `{label}`", tc.name);
                                    let _ = db.record_playbook_fix(
                                        &self.workspace_hash,
                                        &fp_hex,
                                        &err_kind,
                                        &symptom,
                                        &fix_summary,
                                    );
                                }
                            }
                        }
                    }
                    "shell" => {
                        progress.shell_runs_total += 1;
                        // D2: Test Regression Detector + Anti-Termination-Lag (`FAIL -> PASS`)
                        let transition = self
                            .tool_runtime
                            .checkpoint_store
                            .lock()
                            .unwrap()
                            .record_test_outcome_detailed(cur_turn, &tool_text);
                        let transition_passed_suite = matches!(
                            transition,
                            TestOutcomeTransition::FailToPass { .. }
                                | TestOutcomeTransition::AllGreen { .. }
                        );
                        match transition {
                            TestOutcomeTransition::Regression(ref reg_alert) => {
                                tool_text.push_str("\n\n");
                                tool_text.push_str(reg_alert);
                                progress.escalate_reasoning = true;
                                progress.test_suite_passed_since_last_mutation = false;
                            }
                            TestOutcomeTransition::FailToPass {
                                prev_failed,
                                passed,
                            } => {
                                turn_fail_to_pass = Some((prev_failed, passed));
                            }
                            TestOutcomeTransition::AllGreen { .. }
                            | TestOutcomeTransition::Neutral => {}
                        }
                        if effective_error {
                            progress.last_shell_exit_code = Some(1);
                            progress.test_suite_passed_since_last_mutation = false;
                            let fp_hex = format!("{:016x}", error_fingerprint(&tool_text));
                            let err_kind =
                                format!("{:?}", classify_tool_error("shell", &tool_text));
                            let symptom: String = tool_text.chars().take(200).collect();
                            if let Some(ref db) = self.tool_runtime.db {
                                if let Ok(Some(entry)) =
                                    db.lookup_playbook_fix(&self.workspace_hash, &fp_hex)
                                {
                                    tool_text.push_str(&format!(
                                        "\n\n[Workspace Playbook Match (helpful={}): {}]",
                                        entry.helpful_count, entry.verified_fix
                                    ));
                                }
                            }
                            progress.last_failed_shell = Some((fp_hex, err_kind, symptom));
                        } else {
                            progress.last_shell_exit_code = Some(0);
                            let cmd = arg_val
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or("shell");
                            if !progress.files_mutated.is_empty() {
                                progress.verified_since_last_mutation = true;
                                if transition_passed_suite
                                    || (!matches!(transition, TestOutcomeTransition::Regression(_))
                                        && is_test_script_invocation(cmd, &tool_text))
                                {
                                    progress.test_suite_passed_since_last_mutation = true;
                                }
                            }
                            if let Some((fp_hex, err_kind, symptom)) =
                                progress.last_failed_shell.take()
                            {
                                if let Some(ref db) = self.tool_runtime.db {
                                    let fix_summary = if progress.files_mutated.is_empty() {
                                        format!("Verified command succeeded: `{cmd}`")
                                    } else {
                                        let edited: Vec<&str> = progress
                                            .files_mutated
                                            .iter()
                                            .take(5)
                                            .map(|s| s.as_str())
                                            .collect();
                                        format!(
                                            "Modified [{}] and passed `{cmd}`",
                                            edited.join(", ")
                                        )
                                    };
                                    let _ = db.record_playbook_fix(
                                        &self.workspace_hash,
                                        &fp_hex,
                                        &err_kind,
                                        &symptom,
                                        &fix_summary,
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }

                self.trajectory
                    .record_tool_call(cur_turn, &tc.name, out.is_error, out.duration_ms);

                if let Some(ref s) = sink {
                    s(HarnessStreamEvent::ToolEnd {
                        tool_call_id: tc.id.clone(),
                        tool_name: tc.name.clone(),
                        output: tool_text.clone(),
                        is_error: out.is_error,
                        duration_ms: out.duration_ms,
                    });
                }
                let _ = self
                    .hooks
                    .dispatch(
                        if out.is_error {
                            HookEvent::PostToolUseFailure
                        } else {
                            HookEvent::PostToolUse
                        },
                        Some(&tc.name),
                        json!({
                            "toolCallId": tc.id,
                            "toolName": tc.name,
                            "isError": out.is_error,
                            "durationMs": out.duration_ms
                        }),
                    )
                    .await;

                if self.plugins.is_enabled("lakeview_compress") {
                    if let Some(nudge) = self.loop_guard.observe_with_output(
                        &tc.name,
                        &arg_val,
                        &tool_text,
                        effective_error,
                    ) {
                        self.cache_guard.loop_nudges += 1;
                        loop_nudges_this_turn.push(nudge.clone());
                        tool_text.push_str("\n\n");
                        tool_text.push_str(&nudge);
                    }
                    // Ring-Buffer Exact Repeat Detector (`arXiv:2607.01641`)
                    if let Some(osc) = self.oscillation_detector.observe_tool(
                        &tc.name,
                        &tc.arguments,
                        &tool_text,
                        effective_error,
                    ) {
                        let msg = osc.format_nudge();
                        self.total_oscillation_nudges += 1;
                        self.cache_guard.loop_nudges += 1;
                        loop_nudges_this_turn.push(msg.clone());
                        tool_text.push_str("\n\n");
                        tool_text.push_str(&msg);
                    }
                }

                // Append KV-cache-safe Tier-3 pacing & convergence suffixes ONLY to the LAST tool result!
                let is_last_call = call_idx + 1 == total_calls_this_turn;
                if is_last_call {
                    // Ring-Buffer Workspace Merkle Oscillation / Zero-Mutation Churn Check
                    if self.plugins.is_enabled("merkle_index") {
                        let root_hex = {
                            let mut g = self.tool_runtime.graph_index.lock().unwrap();
                            if turn_had_mutation {
                                let _ = g.refresh();
                            }
                            g.merkle().root_hash().to_string()
                        };
                        if let Some(osc) = self
                            .oscillation_detector
                            .observe_turn_tree(&root_hex, turn_had_mutation)
                        {
                            let msg = osc.format_nudge();
                            self.total_oscillation_nudges += 1;
                            self.cache_guard.loop_nudges += 1;
                            loop_nudges_this_turn.push(msg.clone());
                            tool_text.push_str("\n\n");
                            tool_text.push_str(&msg);
                        }
                    }

                    // Anti-Termination-Lag Immediate Stop Signal (`arXiv:2611.14960`):
                    // On verified FAIL -> PASS transition with 0 new syntax errors, emit crisp stop signal!
                    if let Some((prev_f, passed)) = turn_fail_to_pass {
                        if !turn_had_syntax_error
                            && !turn_had_error
                            && !progress.files_mutated.is_empty()
                            && !progress.sent_convergence_hint
                        {
                            progress.sent_convergence_hint = true;
                            tool_text.push_str(&format!(
                                "\n\n[Stop-Eligible | Verified FAIL->PASS] Tests transitioned from {prev_f} failed to {passed} passed (0 failed, 0 syntax errors). Unless another explicit requirement remains unmet, conclude concisely now without extra exploratory turns."
                            ));
                            self.trajectory.record(
                                cur_turn,
                                "stop_eligible_fail_to_pass",
                                json!({ "prevFailed": prev_f, "passed": passed }),
                            );
                        }
                    } else if was_already_verified_before_turn
                        && !turn_had_mutation
                        && !turn_had_error
                    {
                        progress.post_pass_readonly_turns += 1;
                        if progress.post_pass_readonly_turns >= 2 && !progress.sent_convergence_hint
                        {
                            progress.sent_convergence_hint = true;
                            tool_text.push_str("\n\n[Convergence Hint] Edits are verified (exit_code=0) with 0 failures across the last 2 turns. Unless a specific requirement remains unmet, summarize your changes and conclude now.");
                            self.trajectory.record(
                                cur_turn,
                                "convergence_hint",
                                json!({ "postPassReadonlyTurns": progress.post_pass_readonly_turns }),
                            );
                        }
                    } else if turn_had_mutation || turn_had_error {
                        progress.post_pass_readonly_turns = 0;
                        progress.sent_convergence_hint = false;
                    }

                    let elapsed_s = prompt_start.elapsed().as_secs();
                    let rem_s = total_budget_secs.saturating_sub(elapsed_s);
                    let rem_turns = max_turns.saturating_sub(prompt_turns);

                    // Unconditional Reasoning Blowup Guard (`SOTA v4` Fix #2):
                    // Fires whenever >8,000 reasoning tokens were spent in 1 turn, INCLUDING on
                    // edit/write/shell turns (fixes Gemini Flash 15k+ thinking burn on refact/swe!).
                    if turn_res.usage.reasoning.unwrap_or(0) > 8_000 {
                        tool_text.push_str(&format!(
                            "\n\n[Pacing: keep reasoning brief and direct; prioritize concise edits & tests; remaining budget: {rem_s}s / {rem_turns} turns]"
                        ));
                    }

                    // 60% & 82% elapsed time-budget pacing
                    if !progress.sent_82pct_nudge && elapsed_s * 100 >= total_budget_secs * 82 {
                        progress.sent_82pct_nudge = true;
                        progress.sent_60pct_nudge = true;
                        tool_text.push_str(&format!(
                            "\n\n[Time Budget: {rem_s}s left. Finalize edits, run verification tests, and conclude cleanly.]"
                        ));
                    } else if !progress.sent_60pct_nudge
                        && progress.files_mutated.is_empty()
                        && elapsed_s * 100 >= total_budget_secs * 60
                    {
                        progress.sent_60pct_nudge = true;
                        tool_text.push_str(&format!(
                            "\n\n[Time Budget: {rem_s}s left, 0 files edited yet. Stop broad exploration and begin implementing + testing your fix now.]"
                        ));
                    }
                }

                self.messages.push(HarnessMessage::tool_result_with_meta(
                    tc.id,
                    tc.name,
                    tool_text,
                    cur_turn,
                    target_path,
                    effective_error,
                ));
            }

            if !loop_nudges_this_turn.is_empty() {
                self.trajectory.record(
                    cur_turn,
                    "loop_nudge",
                    json!({ "nudges": loop_nudges_this_turn }),
                );
            }

            // Budget wrap-up hint on penultimate turn so agent concludes cleanly
            if prompt_turns + 1 == max_turns {
                self.messages.push(HarnessMessage::user(
                    "[Budget Notice: 1 turn remaining. Run your final verification if needed or present your concise final summary now.]",
                    cur_turn,
                ));
            }

            self.plugins.run_after_turn(&mut hook_ctx);
            let _ = self
                .hooks
                .dispatch(
                    HookEvent::TurnEnd,
                    None,
                    json!({ "turn": cur_turn, "toolCalls": self.total_tool_calls }),
                )
                .await;
            if let Some(ref s) = sink {
                s(HarnessStreamEvent::TurnEnd { turn: cur_turn });
            }
        }

        // Refresh Merkle/Graph stats once at prompt completion for accurate telemetry
        if self.plugins.is_enabled("merkle_index") {
            let _ = self.tool_runtime.graph_index.lock().unwrap().refresh();
        }
        let _ = self
            .hooks
            .dispatch(
                HookEvent::AgentEnd,
                None,
                json!({
                    "status": status,
                    "turns": prompt_turns,
                    "toolCalls": self.total_tool_calls,
                    "toolErrors": self.total_tool_errors
                }),
            )
            .await;
        self.emit_live_telemetry(sink.as_ref(), prompt_output_tokens, prompt_gen_ms);

        let snap = self.cache_guard.snapshot();
        Ok(PromptRunSummary {
            status,
            final_text,
            turns: prompt_turns,
            ttft_ms,
            llm_ttft_ms,
            gen_duration_ms: prompt_gen_ms,
            active_decode_ms: prompt_active_decode_ms,
            saw_any_usage,
            saw_any_reasoning_tokens,
            recovery_attempts,
            recovery_succeeded,
            truncated_stream_retries: self.total_truncated_stream_retries,
            stall_retries: self.total_stall_retries,
            verify_gate_nudges: progress.verify_gate_nudges,
            narration_nudges: progress.narration_nudges,
            interleaved_reasoning_turns: self.total_interleaved_reasoning_turns,
            cache_stats: snap,
            error: error_msg,
        })
    }

    fn emit_live_telemetry(
        &self,
        sink: Option<&HarnessEventSink>,
        output_tokens: u64,
        gen_ms: u64,
    ) {
        let Some(s) = sink else {
            return;
        };
        let tps = if gen_ms > 0 && output_tokens > 0 {
            ((output_tokens as f64 / (gen_ms as f64 / 1000.0)) * 100.0).round() / 100.0
        } else {
            0.0
        };
        let ctx_pct = if self.endpoint.context_window > 0 {
            ((self.last_context_tokens as f64 / self.endpoint.context_window as f64) * 10000.0)
                .round()
                / 100.0
        } else {
            0.0
        };
        s(HarnessStreamEvent::Metrics {
            tokens_per_second: tps,
            context_tokens: self.last_context_tokens,
            context_window: self.endpoint.context_window,
            context_percent: ctx_pct,
            total_cost_usd: self.total_cost_usd,
        });

        let (merkle_root, merkle_refresh_ms) = {
            let g = self.tool_runtime.graph_index.lock().unwrap();
            (
                g.merkle().root_hash().to_string(),
                g.merkle().last_refresh_ms(),
            )
        };
        let snap = self.cache_guard.snapshot();
        s(HarnessStreamEvent::Telemetry {
            lakeview_compressions: snap.lakeview_compressions,
            cache_stats: snap,
            merkle_root,
            merkle_refresh_ms,
            turn_count: self.total_turns,
            tool_call_count: self.total_tool_calls,
            tool_error_count: self.total_tool_errors,
        });
    }

    fn collect_instruction_epoch_sources(
        &self,
        injected_notes: &[String],
    ) -> Vec<(String, Option<String>)> {
        let mut sources = Vec::new();
        if self.tool_runtime.context_bundle.workspace_trusted {
            for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] {
                let path = self.workspace_root.join(name);
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let trimmed = raw.trim();
                    let capped: String = trimmed.chars().take(6_000).collect();
                    sources.push((
                        name.to_string(),
                        if capped.is_empty() { None } else { Some(capped) },
                    ));
                } else {
                    sources.push((name.to_string(), None));
                }
            }
        }
        if !injected_notes.is_empty() {
            sources.push((
                "turn_hook_notes".to_string(),
                Some(injected_notes.join("\n")),
            ));
        }
        sources
    }

    async fn call_llm_streaming(
        &mut self,
        msg_id: &str,
        remaining: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        sink: Option<&HarnessEventSink>,
    ) -> Result<TurnStreamResult> {
        let max_retries = if self.plugins.is_enabled("empty_thinking_recovery") {
            self.stream_budget.max_retries_per_turn
        } else {
            0
        };
        let max_attempts = max_retries + 1;
        // Overall run deadline bounds ALL attempts; each attempt gets its own FRESH
        // `per_attempt_deadline` budget (never a shared, shrinking per-turn window).
        let run_deadline = Instant::now() + remaining;

        let mut include_stream_options = true;
        let mut retries = 0u32;
        let mut compat_bounces = 0u32;
        let mut attempt = 0u32;
        let mut unreachable_started_at: Option<Instant> = None;
        let mut unreachable_attempt = 0u32;

        loop {
            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                bail!("Aborted by user");
            }
            let rem_run = run_deadline.saturating_duration_since(Instant::now());
            if rem_run.is_zero() {
                bail!("Timed out waiting for LLM turn");
            }
            let rem_now = compute_attempt_budget(
                rem_run,
                self.stream_budget.per_attempt_deadline,
                attempt,
                max_retries,
            );

            let router_grant = self.try_reserve_router_slot(msg_id, attempt);
            let t_attempt = Instant::now();
            let api_kind = self.active_wire_dialect();
            let force_fresh_socket = attempt > 0;
            let (header_to, first_delta_to, inter_chunk_to) =
                self.stream_budget.effective_timeouts(
                    &self.endpoint.model_id,
                    self.last_context_tokens,
                    attempt,
                    rem_now,
                );

            // Bounded Pre-TTFT Hedging (`<= 5%` retry budget, NEVER post-TTFT; loser aborted on first content byte):
            let max_hedges = ((self.total_turns.max(1) as f64) * 0.05).ceil() as u32;
            let allow_hedge = self.stream_budget.enable_pre_ttft_hedge
                && attempt == 0
                && (api_kind == "openai-completions"
                    || (api_kind == "openai-responses" && !self.should_use_responses_ws()))
                && self.total_hedges_issued < max_hedges
                && rem_now > self.stream_budget.pre_ttft_hedge_delay + Duration::from_millis(250);

            let attempt_res = if allow_hedge {
                let hedge_delay = self.stream_budget.pre_ttft_hedge_delay;
                let winner = AtomicU8::new(0);
                let notify = Notify::new();
                let hedge_fired = AtomicBool::new(false);
                let primary_failed = AtomicBool::new(false);
                let hedge_failed = AtomicBool::new(false);
                let (res, hedge_won) = {
                    let primary_fut = async {
                        let r = if api_kind == "openai-responses" {
                            self.stream_openai_responses_turn(
                                msg_id,
                                rem_now,
                                header_to,
                                first_delta_to,
                                inter_chunk_to,
                                force_low_reasoning,
                                escalate_reasoning,
                                force_no_tools,
                                force_fresh_socket,
                                sink,
                                Some((&winner, &notify, 1)),
                            )
                            .await
                        } else {
                            self.stream_openai_turn(
                                msg_id,
                                rem_now,
                                header_to,
                                first_delta_to,
                                inter_chunk_to,
                                include_stream_options,
                                force_low_reasoning,
                                escalate_reasoning,
                                force_no_tools,
                                force_fresh_socket,
                                sink,
                                Some((&winner, &notify, 1)),
                            )
                            .await
                        };
                        if r.is_err() {
                            primary_failed.store(true, Ordering::Release);
                            if winner.load(Ordering::Acquire) == 2
                                || (hedge_fired.load(Ordering::Acquire)
                                    && !hedge_failed.load(Ordering::Acquire))
                            {
                                std::future::pending::<()>().await;
                            }
                        }
                        r
                    };
                    let hedge_fut = async {
                        tokio::select! {
                            _ = tokio::time::sleep(hedge_delay) => {}
                            _ = notify.notified() => {}
                        }
                        if winner.load(Ordering::Acquire) != 0
                            || primary_failed.load(Ordering::Acquire)
                        {
                            std::future::pending::<()>().await;
                        }
                        hedge_fired.store(true, Ordering::Release);
                        let r = if api_kind == "openai-responses" {
                            self.stream_openai_responses_turn(
                                msg_id,
                                rem_now.saturating_sub(hedge_delay),
                                header_to,
                                first_delta_to,
                                inter_chunk_to,
                                force_low_reasoning,
                                escalate_reasoning,
                                force_no_tools,
                                true,
                                sink,
                                Some((&winner, &notify, 2)),
                            )
                            .await
                        } else {
                            self.stream_openai_turn(
                                msg_id,
                                rem_now.saturating_sub(hedge_delay),
                                header_to,
                                first_delta_to,
                                inter_chunk_to,
                                include_stream_options,
                                force_low_reasoning,
                                escalate_reasoning,
                                force_no_tools,
                                true,
                                sink,
                                Some((&winner, &notify, 2)),
                            )
                            .await
                        };
                        if r.is_err() {
                            hedge_failed.store(true, Ordering::Release);
                            if winner.load(Ordering::Acquire) == 1
                                || !primary_failed.load(Ordering::Acquire)
                            {
                                std::future::pending::<()>().await;
                            }
                        }
                        r
                    };
                    tokio::pin!(primary_fut);
                    tokio::pin!(hedge_fut);
                    tokio::select! {
                        p = &mut primary_fut => (p, false),
                        h = &mut hedge_fut => {
                            let won = h.is_ok();
                            (h, won)
                        }
                    }
                };
                if hedge_fired.load(Ordering::Acquire) {
                    self.total_hedges_issued += 1;
                }
                if hedge_won {
                    self.total_hedge_wins += 1;
                }
                res
            } else {
                match api_kind {
                    "anthropic-messages" => {
                        self.stream_anthropic_turn(
                            msg_id,
                            rem_now,
                            header_to,
                            first_delta_to,
                            inter_chunk_to,
                            force_low_reasoning,
                            escalate_reasoning,
                            force_no_tools,
                            force_fresh_socket,
                            sink,
                        )
                        .await
                    }
                    "openai-responses" => {
                        self.stream_openai_responses_ws_or_http_turn(
                            msg_id,
                            rem_now,
                            header_to,
                            first_delta_to,
                            inter_chunk_to,
                            force_low_reasoning,
                            escalate_reasoning,
                            force_no_tools,
                            force_fresh_socket,
                            sink,
                        )
                        .await
                    }
                    "google-gemini" => {
                        self.stream_gemini_turn(
                            msg_id,
                            rem_now,
                            header_to,
                            first_delta_to,
                            inter_chunk_to,
                            force_low_reasoning,
                            escalate_reasoning,
                            force_fresh_socket,
                            sink,
                        )
                        .await
                    }
                    _ => {
                        self.stream_openai_turn(
                            msg_id,
                            rem_now,
                            header_to,
                            first_delta_to,
                            inter_chunk_to,
                            include_stream_options,
                            force_low_reasoning,
                            escalate_reasoning,
                            force_no_tools,
                            force_fresh_socket,
                            sink,
                            None,
                        )
                        .await
                    }
                }
            };

            let attempt_latency_ms = t_attempt.elapsed().as_millis() as f64;
            match attempt_res {
                Ok(mut r) => {
                    self.reconcile_router_slot(
                        router_grant,
                        true,
                        AcceptanceState::Accepted,
                        None,
                        attempt_latency_ms,
                        None,
                        Some(&r.usage),
                        "ok",
                    );
                    r.http_retries = retries;
                    return Ok(r);
                }
                Err(err) => {
                    let is_non_claude_auto = api_kind == "anthropic-messages"
                        && self.wire_api_mode == WireApiMode::Auto
                        && !self
                            .endpoint
                            .model_id
                            .to_ascii_lowercase()
                            .contains("claude");
                    let err_status_u16 = match &err {
                        StreamTurnError::Retryable { status: Some(s), .. } => s.as_u16(),
                        StreamTurnError::EndpointUnsupported(_) => 404,
                        _ => 0,
                    };
                    let err_detail = match &err {
                        StreamTurnError::EndpointUnsupported(d)
                        | StreamTurnError::Retryable { detail: d, .. }
                        | StreamTurnError::Fatal(d) => d.as_str(),
                        StreamTurnError::BadStreamOptions => "provider rejected stream_options",
                        StreamTurnError::BadReasoningEcho => "provider rejected reasoning_content",
                        StreamTurnError::BadPromptCacheKey => "provider rejected prompt_cache_key",
                    };
                    let scope = classify_upstream_failure(err_status_u16, err_detail);
                    self.reconcile_router_slot(
                        router_grant,
                        false,
                        if err_status_u16 == 0 {
                            AcceptanceState::NotSent
                        } else {
                            AcceptanceState::Accepted
                        },
                        Some(scope),
                        attempt_latency_ms,
                        match &err {
                            StreamTurnError::Retryable {
                                retry_after_secs: Some(s),
                                ..
                            } => Some((*s as i64) * 1000),
                            _ => None,
                        },
                        None,
                        err_detail,
                    );

                    match err {
                        StreamTurnError::EndpointUnsupported(detail)
                            if api_kind == "anthropic-messages"
                                && !self.anthropic_fallback_to_openai =>
                        {
                            tracing::warn!(
                                "Anthropic /v1/messages unsupported ({detail}); seamlessly falling back to /v1/chat/completions"
                            );
                            self.anthropic_fallback_to_openai = true;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::Retryable {
                            status,
                            kind,
                            detail,
                            ..
                        } if is_non_claude_auto
                            && !self.anthropic_fallback_to_openai
                            && matches!(
                                kind,
                                RetryKind::TruncatedStream | RetryKind::HttpStatus
                            )
                            && status.is_none_or(|st| st.as_u16() >= 400) =>
                        {
                            tracing::warn!(
                                "Non-Claude /v1/messages failed ({detail}); falling back to /v1/chat/completions"
                            );
                            self.anthropic_fallback_to_openai = true;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::EndpointUnsupported(detail)
                            if api_kind == "openai-responses" && !self.responses_fallback_to_chat =>
                        {
                            tracing::warn!(
                                "OpenAI /v1/responses unsupported ({detail}); falling back to /v1/chat/completions"
                            );
                            self.responses_fallback_to_chat = true;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::BadStreamOptions
                            if include_stream_options && compat_bounces < 4 =>
                        {
                            include_stream_options = false;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::BadReasoningEcho
                            if self.supports_reasoning_echo && compat_bounces < 4 =>
                        {
                            self.supports_reasoning_echo = false;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::BadPromptCacheKey
                            if self.supports_prompt_cache_key && compat_bounces < 4 =>
                        {
                            self.supports_prompt_cache_key = false;
                            compat_bounces += 1;
                            continue;
                        }
                        StreamTurnError::Retryable {
                            kind: RetryKind::Transport,
                            detail,
                            ..
                        } if is_unreachable_network_error(&detail) => {
                            let start = *unreachable_started_at.get_or_insert_with(Instant::now);
                            let rem_after = run_deadline.saturating_duration_since(Instant::now());
                            if start.elapsed() < UNREACHABLE_RETRY_WINDOW
                                && rem_after > Duration::from_millis(500)
                            {
                                unreachable_attempt += 1;
                                retries += 1;
                                self.total_http_retries += 1;
                                self.total_unreachable_retries += 1;
                                let wait_ms = compute_unreachable_backoff_ms(unreachable_attempt)
                                    .min(rem_after.as_millis().saturating_sub(250) as u64);
                                tracing::warn!(
                                    "Unreachable network retry #{unreachable_attempt} (separate 1h budget): {detail}; sleeping {wait_ms}ms"
                                );
                                if wait_ms > 0 {
                                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                                }
                                continue;
                            }
                            bail!("{detail}");
                        }
                        StreamTurnError::Retryable {
                            status,
                            retry_after_secs,
                            kind,
                            detail,
                        } if attempt + 1 < max_attempts => {
                            let rem_after = run_deadline.saturating_duration_since(Instant::now());
                            if rem_after <= Duration::from_millis(500) {
                                bail!("Timed out after retryable error: {detail}");
                            }
                            retries += 1;
                            self.total_http_retries += 1;
                            match kind {
                                RetryKind::HeaderTimeout | RetryKind::ChunkStall => {
                                    self.total_stall_retries += 1;
                                }
                                RetryKind::TruncatedStream => {
                                    self.total_truncated_stream_retries += 1;
                                }
                                RetryKind::HttpStatus | RetryKind::Transport => {}
                            }

                            let base = self.stream_budget.retry_base_backoff_ms;
                            let exp_ms = (base << attempt.min(3)).min(8_000);
                            let jitter_ms = if base >= 200 {
                                (Utc::now().timestamp_subsec_millis() as u64 % 250) + 50
                            } else {
                                0
                            };
                            let wait_ms = retry_after_secs
                                .map(|s| (s.min(20) * 1000).max(200))
                                .unwrap_or(exp_ms + jitter_ms)
                                .min(rem_after.as_millis().saturating_sub(250) as u64);

                            tracing::warn!(
                                "Retryable LLM error {:?} (status={:?}, attempt {}/{}): {}; backing off {}ms with fresh socket",
                                kind,
                                status,
                                attempt + 1,
                                max_attempts,
                                detail,
                                wait_ms
                            );
                            if wait_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                            }
                            attempt += 1;
                        }
                        StreamTurnError::Retryable { detail, .. }
                        | StreamTurnError::Fatal(detail)
                        | StreamTurnError::EndpointUnsupported(detail) => {
                            bail!("{detail}");
                        }
                        StreamTurnError::BadStreamOptions => {
                            bail!("provider rejected stream_options");
                        }
                        StreamTurnError::BadReasoningEcho => {
                            bail!("provider rejected reasoning_content");
                        }
                        StreamTurnError::BadPromptCacheKey => {
                            bail!("provider rejected prompt_cache_key");
                        }
                    }
                }
            }
        }
    }

    fn try_reserve_router_slot(&self, msg_id: &str, attempt: u32) -> Option<(String, u64)> {
        let router = self.dynamic_router.as_ref()?;
        Self::register_endpoint_candidate(router, &self.endpoint);
        let cid = format!("{}::{}", self.endpoint.provider_id, self.endpoint.model_id);
        let mut policy = RouteRequestPolicy::default();
        policy.request_id = format!("{msg_id}:a{attempt}");
        policy.idempotency_key = format!("{}:{msg_id}:a{attempt}", self.session_key);
        policy.allow_unknown_quota_without_emergency = true;
        policy.preferred_candidate_ids = vec![cid];
        policy.session_affinity_key = Some(self.session_key.clone());
        if let Ok(res) = router.decide_and_reserve(&policy) {
            if let Some(grant) = res.reservation {
                let _ = router.mark_dispatched(&grant.reservation_id, grant.fencing_token);
                return Some((grant.reservation_id, grant.fencing_token));
            }
        }
        None
    }

    #[allow(clippy::too_many_arguments)]
    fn reconcile_router_slot(
        &self,
        grant_opt: Option<(String, u64)>,
        success: bool,
        acceptance: AcceptanceState,
        scope: Option<UpstreamFailureScope>,
        latency_ms: f64,
        retry_after_ms: Option<i64>,
        usage: Option<&TurnLlmUsage>,
        note: &str,
    ) {
        let (Some(router), Some((reservation_id, fencing_token))) =
            (self.dynamic_router.as_ref(), grant_opt)
        else {
            return;
        };
        let mut report = OutcomeReport::default();
        report.reservation_id = reservation_id;
        report.fencing_token = fencing_token;
        report.success = success;
        report.acceptance = acceptance;
        report.latency_ms = Some(latency_ms);
        report.retry_after_ms = retry_after_ms;
        report.diagnostic_note = note.chars().take(240).collect();
        if let Some(u) = usage {
            if u.saw_usage {
                report.actual_input_tokens = Some(u.uncached_input + u.cache_read + u.cache_write);
                report.actual_output_tokens = Some(u.output);
            }
        }
        if let Some(sc) = scope {
            report.is_request_scoped = matches!(sc, UpstreamFailureScope::RequestScoped);
            report.model_entitlement_error =
                matches!(sc, UpstreamFailureScope::ModelEntitlementLock);
        }
        let _ = router.reconcile_outcome(report);
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_openai_turn(
        &self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        include_stream_options: bool,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
        hedge_slot: Option<(&AtomicU8, &Notify, u8)>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let url = if self.endpoint.base_url.ends_with("/chat/completions") {
            self.endpoint.base_url.clone()
        } else {
            format!("{}/chat/completions", self.endpoint.base_url)
        };

        let model_lower = self.endpoint.model_id.to_ascii_lowercase();
        let is_gemini = model_lower.contains("gemini");
        // Avoid snowballing 12k-char raw reasoning_content on Gemini Flash over OpenAI-compat;
        // keep verbatim thought_signature always!
        let echo_reasoning_text = self.supports_reasoning_echo && !model_lower.contains("flash");

        let wire_messages: Vec<Value> = self
            .messages
            .iter()
            .map(|m| {
                message_to_openai_json_for_target(
                    m,
                    self.active_prompt_start_turn,
                    echo_reasoning_text,
                    is_gemini,
                    &self.endpoint.provider_id,
                    &self.endpoint.model_id,
                )
            })
            .collect();
        let mut body = json!({
            "model": self.endpoint.model_id,
            "messages": wire_messages,
            "stream": true,
            "max_tokens": self.endpoint.max_tokens,
        });
        if !self.canonical_tools.is_empty() {
            body["tools"] = Value::Array(self.canonical_tools.clone());
            body["tool_choice"] = Value::String(if force_no_tools { "none" } else { "auto" }.into());
        }
        if include_stream_options {
            body["stream_options"] = json!({ "include_usage": true });
        }
        let sent_reasoning_echo = echo_reasoning_text
            && self.messages.iter().any(|m| {
                m.role == "assistant"
                    && m.turn_index >= self.active_prompt_start_turn
                    && m.reasoning.as_deref().is_some_and(|r| !r.is_empty())
            });
        // Send session-stable `prompt_cache_key` on ALL model families.
        let sent_prompt_cache_key = self.supports_prompt_cache_key;
        if sent_prompt_cache_key {
            body["prompt_cache_key"] = Value::String(self.session_key.clone());
        }

        if let Some(effort) = self.resolve_effort_for_turn(force_low_reasoning, escalate_reasoning) {
            apply_reasoning_effort_wire(
                &mut body,
                "openai-completions",
                &self.endpoint.model_id,
                effort,
                Some(self.endpoint.max_tokens),
            );
        } else if force_low_reasoning {
            body["reasoning_effort"] = Value::String("low".into());
        } else if let Some(ref tl) = self.thinking_level {
            let low = tl.trim().to_ascii_lowercase();
            if matches!(
                low.as_str(),
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            ) {
                body["reasoning_effort"] = Value::String(low);
            }
        }

        let client = if force_fresh_socket {
            &self.fresh_http
        } else {
            &self.http
        };
        let mut req = client
            .post(&url)
            .header("X-Session-Id", &self.session_key)
            .json(&body);
        if self.endpoint.auth_header && !self.endpoint.api_key.is_empty() {
            req = req.bearer_auth(&self.endpoint.api_key);
        }
        if force_fresh_socket {
            req = req.header("Connection", "close");
        }

        let t_req = Instant::now();
        let turn_deadline = t_req + total_remaining;
        let send_res = if let Some((winner, notify, slot)) = hedge_slot {
            if winner.load(Ordering::Acquire) != 0 && winner.load(Ordering::Acquire) != slot {
                return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
            }
            tokio::select! {
                r = tokio::time::timeout(header_timeout, req.send()) => r,
                _ = async {
                    loop {
                        notify.notified().await;
                        let w = winner.load(Ordering::Acquire);
                        if w != 0 && w != slot {
                            break;
                        }
                    }
                } => {
                    return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                }
            }
        } else {
            tokio::time::timeout(header_timeout, req.send()).await
        };
        let resp = send_res
            .map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::HeaderTimeout,
                detail: format!(
                    "Header timeout after {}ms connecting to {url}",
                    header_timeout.as_millis()
                ),
            })?
            .map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: crate::sanitizer::redact_secrets(&format!("HTTP transport error: {e}")),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let err_body = resp.text().await.unwrap_or_default();
            let snippet: String = err_body.chars().take(500).collect();
            let low_snip = snippet.to_ascii_lowercase();
            if status == StatusCode::BAD_REQUEST {
                if low_snip.contains("stream_options") {
                    return Err(StreamTurnError::BadStreamOptions);
                }
                if low_snip.contains("reasoning_content") {
                    return Err(StreamTurnError::BadReasoningEcho);
                }
                if low_snip.contains("prompt_cache_key") {
                    return Err(StreamTurnError::BadPromptCacheKey);
                }
                if low_snip.contains("unrecognized")
                    || low_snip.contains("unknown")
                    || low_snip.contains("extra")
                    || low_snip.contains("additional properties")
                    || low_snip.contains("not permitted")
                {
                    if sent_prompt_cache_key {
                        return Err(StreamTurnError::BadPromptCacheKey);
                    }
                    if sent_reasoning_echo {
                        return Err(StreamTurnError::BadReasoningEcho);
                    }
                    if include_stream_options {
                        return Err(StreamTurnError::BadStreamOptions);
                    }
                }
            }
            if is_retryable_status(status) {
                return Err(StreamTurnError::Retryable {
                    status: Some(status),
                    retry_after_secs: retry_after,
                    kind: RetryKind::HttpStatus,
                    detail: format!("HTTP {status}: {snippet}"),
                });
            }
            return Err(StreamTurnError::Fatal(format!("HTTP {status}: {snippet}")));
        }

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut thought_signature: Option<String> = None;
        let mut tool_accum: BTreeMap<usize, ToolCallRecord> = BTreeMap::new();
        let mut spec_pool = SpeculativeTaskPool::new();
        let mut finish_reason: Option<String> = None;
        let mut saw_done = false;
        let mut usage = TurnLlmUsage::default();
        let mut turn_ttft_ms: Option<u64> = None;
        let mut first_delta_at: Option<Instant> = None;
        let mut last_delta_at: Option<Instant> = None;
        let mut last_wire_activity_at: Option<Instant> = None;
        let mut active_decode_ms = 0u64;
        let mut raw_sse_log: Vec<u8> = Vec::new();

        let mut pending_text_delta = String::new();
        let mut pending_think_delta = String::new();
        let mut last_flush = Instant::now();

        let stream_started_at = Instant::now();
        let mut stream = resp.bytes_stream();
        let mut line_buf = Vec::<u8>::new();

        'sse: loop {
            let chunk_budget = compute_token_progress_wait_with_phase(
                stream_started_at,
                last_delta_at,
                last_wire_activity_at,
                first_delta_timeout,
                inter_chunk_timeout,
                turn_deadline,
                "OpenAI SSE",
                text.is_empty() && tool_accum.is_empty(),
            )?;

            let next_res = if first_delta_at.is_none() {
                if let Some((winner, notify, slot)) = hedge_slot {
                    let w = winner.load(Ordering::Acquire);
                    if w != 0 && w != slot {
                        return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                    }
                    tokio::select! {
                        r = tokio::time::timeout(chunk_budget, stream.next()) => r,
                        _ = async {
                            loop {
                                notify.notified().await;
                                let w2 = winner.load(Ordering::Acquire);
                                if w2 != 0 && w2 != slot {
                                    break;
                                }
                            }
                        } => {
                            return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                        }
                    }
                } else {
                    tokio::time::timeout(chunk_budget, stream.next()).await
                }
            } else {
                tokio::time::timeout(chunk_budget, stream.next()).await
            };
            let next_opt = next_res.map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::ChunkStall,
                detail: format!(
                    "OpenAI SSE token-progress stall timeout after {}ms",
                    chunk_budget.as_millis()
                ),
            })?;

            let Some(chunk_res) = next_opt else {
                if !line_buf.is_empty() {
                    let tail = String::from_utf8_lossy(&line_buf);
                    if tail
                        .trim()
                        .strip_prefix("data:")
                        .is_some_and(|d| d.trim() == "[DONE]")
                    {
                        saw_done = true;
                    }
                    line_buf.clear();
                }
                break;
            };

            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                return Err(StreamTurnError::Fatal("Aborted by user".into()));
            }
            let chunk: Bytes = chunk_res.map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: format!("SSE stream read error: {e}"),
            })?;
            if !chunk.is_empty() {
                last_wire_activity_at = Some(Instant::now());
                if raw_sse_log.len() < 256 * 1024 {
                    let take = (256 * 1024 - raw_sse_log.len()).min(chunk.len());
                    raw_sse_log.extend_from_slice(&chunk[..take]);
                }
            }
            line_buf.extend_from_slice(&chunk);

            let mut cursor = 0usize;
            while let Some(rel_nl) = memchr(b'\n', &line_buf[cursor..]) {
                let line_slice = &line_buf[cursor..cursor + rel_nl];
                cursor += rel_nl + 1;
                let line_str = String::from_utf8_lossy(line_slice);
                let trimmed = line_str.trim();
                if trimmed.is_empty() || trimmed.starts_with(':') {
                    continue;
                }
                let Some(data) = trimmed.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    saw_done = true;
                    break 'sse;
                }
                let Ok(val) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(err_obj) = val.get("error").filter(|v| !v.is_null()) {
                    let msg = err_obj
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("smuggled OpenAI SSE error");
                    return Err(StreamTurnError::Retryable {
                        status: None,
                        retry_after_secs: None,
                        kind: RetryKind::TruncatedStream,
                        detail: crate::sanitizer::redact_secrets(msg),
                    });
                }

                if let Some(u) = val.get("usage").filter(|u| u.is_object()) {
                    parse_openai_usage(u, &mut usage);
                }

                if let Some(choice) = val.pointer("/choices/0") {
                    if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                        finish_reason = Some(fr.to_string());
                        if fr == "tool_calls" {
                            for (&wire_key, tc) in &tool_accum {
                                spec_pool.try_spawn_if_admissible(
                                    wire_key,
                                    tc,
                                    &self.tool_runtime,
                                    true,
                                );
                            }
                        }
                    }
                    if let Some(delta) = choice.get("delta") {
                        let now = Instant::now();
                        let mut got_token = false;

                        // Capture Gemini `thought_signature` / `thoughtSignature` verbatim!
                        if let Some(sig) = extract_thought_signature(delta) {
                            thought_signature = Some(sig);
                        }

                        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
                            if !c.is_empty() {
                                got_token = true;
                                text.push_str(c);
                                pending_text_delta.push_str(c);
                            }
                        }
                        if let Some(r) = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(|v| v.as_str())
                        {
                            if !r.is_empty() {
                                got_token = true;
                                reasoning.push_str(r);
                                pending_think_delta.push_str(r);
                            }
                        }
                        if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            if !tcs.is_empty() {
                                got_token = true;
                                for tc_v in tcs {
                                    if let Some(sig) = extract_thought_signature(tc_v) {
                                        thought_signature = Some(sig);
                                    }
                                }
                                let prev_max_key = tool_accum.keys().next_back().copied();
                                accumulate_openai_tool_deltas(tcs, &mut tool_accum);
                                let new_max_key = tool_accum.keys().next_back().copied();
                                if let (Some(prev_k), Some(new_k)) = (prev_max_key, new_max_key) {
                                    if new_k > prev_k {
                                        for (&wire_key, tc) in tool_accum.range(..new_k) {
                                            spec_pool.try_spawn_if_admissible(
                                                wire_key,
                                                tc,
                                                &self.tool_runtime,
                                                false,
                                            );
                                        }
                                    }
                                }
                            }
                        }

                        if got_token {
                            if turn_ttft_ms.is_none() {
                                if let Some((winner, notify, slot)) = hedge_slot {
                                    match winner.compare_exchange(
                                        0,
                                        slot,
                                        Ordering::AcqRel,
                                        Ordering::Acquire,
                                    ) {
                                        Ok(_) => notify.notify_waiters(),
                                        Err(other) if other != slot => {
                                            return Err(StreamTurnError::Fatal(
                                                "Pre-TTFT hedge superseded".into(),
                                            ));
                                        }
                                        Err(_) => {}
                                    }
                                }
                                turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                first_delta_at = Some(now);
                            } else if let Some(prev) = last_delta_at {
                                let gap = now.saturating_duration_since(prev).as_millis() as u64;
                                if gap <= ACTIVE_DECODE_GAP_CAP_MS {
                                    active_decode_ms += gap;
                                }
                            }
                            last_delta_at = Some(now);
                        }
                    }
                }

                let sink_allowed =
                    hedge_slot.is_none_or(|(w, _, slot)| w.load(Ordering::Acquire) == slot);
                if sink_allowed {
                    if let Some(s) = sink {
                        if (!pending_text_delta.is_empty() || !pending_think_delta.is_empty())
                            && last_flush.elapsed() >= Duration::from_millis(16)
                        {
                            s(HarnessStreamEvent::DeltaBatch {
                                message_id: msg_id.to_string(),
                                text_delta: std::mem::take(&mut pending_text_delta),
                                thinking_delta: std::mem::take(&mut pending_think_delta),
                            });
                            last_flush = Instant::now();
                        }
                    }
                }
            }
            if cursor > 0 {
                line_buf.drain(..cursor);
            }
        }

        let mut raw_spec = spec_pool.take_all();
        let mut finalized_tools: Vec<ToolCallRecord> = Vec::with_capacity(tool_accum.len());
        let mut speculative_results: HashMap<usize, tokio::task::JoinHandle<ToolExecOutput>> =
            HashMap::new();
        for (wire_key, mut tc) in tool_accum {
            if tc.name.trim().is_empty() {
                if let Some(entry) = raw_spec.remove(&wire_key) {
                    entry.handle.abort();
                }
                continue;
            }
            let pos_idx = finalized_tools.len();
            if tc.id.trim().is_empty() {
                tc.id = format!("call_{msg_id}_{pos_idx}");
            }
            if let Some(entry) = raw_spec.remove(&wire_key) {
                if entry.spawned_args == tc.arguments {
                    speculative_results.insert(pos_idx, entry.handle);
                } else {
                    entry.handle.abort();
                }
            }
            finalized_tools.push(tc);
        }
        for (_, entry) in raw_spec {
            entry.handle.abort();
        }

        // Strict Stream-Completion Integrity Proof with SAP Partial-JSON Recovery + Pre-Commit Gate!
        let has_unrecoverable_tool_json = finalized_tools.iter().any(|tc| {
            let trimmed = tc.arguments.trim();
            !trimmed.is_empty()
                && serde_json::from_str::<Value>(trimmed).is_err()
                && repair_tool_json(trimmed, self.tool_schemas_by_name.get(&tc.name)).is_err()
        });
        let nothing_emitted = text.is_empty() && reasoning.is_empty() && finalized_tools.is_empty();
        if nothing_emitted {
            let verdict = inspect_sse_pre_commit(&raw_sse_log);
            if verdict.should_failover_before_commit() {
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: format!("Pre-commit OpenAI SSE gate rejected empty stream: {verdict:?}"),
                });
            }
        }
        if has_unrecoverable_tool_json || (!saw_done && finish_reason.is_none()) {
            for (_, h) in speculative_results {
                h.abort();
            }
            return Err(StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::TruncatedStream,
                detail: format!(
                    "Truncated SSE stream EOF (saw_done={saw_done}, finish_reason={finish_reason:?}, unrecoverable_tool_json={has_unrecoverable_tool_json})"
                ),
            });
        }

        let final_sink_allowed =
            hedge_slot.is_none_or(|(w, _, slot)| w.load(Ordering::Acquire) == slot);
        if final_sink_allowed {
            if let Some(s) = sink {
                if !pending_text_delta.is_empty() || !pending_think_delta.is_empty() {
                    s(HarnessStreamEvent::DeltaBatch {
                        message_id: msg_id.to_string(),
                        text_delta: pending_text_delta,
                        thinking_delta: pending_think_delta,
                    });
                }
            }
        }

        let turn_gen_ms = compute_pure_gen_duration_ms(
            t_req,
            turn_ttft_ms,
            first_delta_at,
            last_delta_at,
            usage.output,
        );
        let turn_active_decode_ms = if first_delta_at.is_some() {
            active_decode_ms.max(1)
        } else {
            0
        };

        Ok(TurnStreamResult {
            text,
            reasoning,
            reasoning_signature: thought_signature,
            redacted_thinking: Vec::new(),
            reasoning_encrypted_items: Vec::new(),
            response_id: None,
            tool_calls: finalized_tools,
            speculative_results,
            finish_reason,
            usage,
            turn_ttft_ms,
            turn_gen_ms,
            turn_active_decode_ms,
            http_retries: 0,
        })
    }

    fn build_openai_responses_input_items(&self) -> Vec<Value> {
        self.build_openai_responses_input_items_from_slice(&self.messages)
    }

    fn build_openai_responses_input_items_from_slice(&self, msgs: &[HarnessMessage]) -> Vec<Value> {
        let mut input_items: Vec<Value> = Vec::with_capacity(msgs.len());
        for m in msgs {
            match m.role.as_str() {
                "system" => {}
                "user" => {
                    if m.content_blocks.is_empty() {
                        input_items.push(json!({
                            "role": "user",
                            "content": m.content
                        }));
                    } else {
                        let mut parts: Vec<Value> = Vec::new();
                        if !m.content.is_empty() {
                            parts.push(json!({ "type": "input_text", "text": m.content }));
                        }
                        for blk in &m.content_blocks {
                            match blk {
                                ContentBlock::Text { text } => {
                                    if !text.is_empty() {
                                        parts.push(json!({ "type": "input_text", "text": text }));
                                    }
                                }
                                ContentBlock::ImageBase64 {
                                    media_type,
                                    data_base64,
                                    detail,
                                    ..
                                } => {
                                    let mut obj = json!({
                                        "type": "input_image",
                                        "image_url": format!("data:{media_type};base64,{data_base64}")
                                    });
                                    if let Some(d) = detail {
                                        obj["detail"] = Value::String(d.clone());
                                    }
                                    parts.push(obj);
                                }
                                ContentBlock::ImageUrl { url, detail } => {
                                    let mut obj = json!({
                                        "type": "input_image",
                                        "image_url": url
                                    });
                                    if let Some(d) = detail {
                                        obj["detail"] = Value::String(d.clone());
                                    }
                                    parts.push(obj);
                                }
                                ContentBlock::FileUri { uri, media_type, .. } => {
                                    parts.push(json!({
                                        "type": "input_text",
                                        "text": format!("[file {media_type}: {uri}]")
                                    }));
                                }
                            }
                        }
                        input_items.push(json!({ "role": "user", "content": parts }));
                    }
                }
                "assistant" => {
                    if !m.reasoning_encrypted_items.is_empty()
                        && m.can_replay_cryptographic_proof(
                            &self.endpoint.provider_id,
                            &self.endpoint.model_id,
                        )
                    {
                        for item in &m.reasoning_encrypted_items {
                            input_items.push(item.clone());
                        }
                    }
                    if !m.content.is_empty() {
                        input_items.push(json!({
                            "role": "assistant",
                            "content": m.content
                        }));
                    }
                    for tc in &m.tool_calls {
                        input_items.push(json!({
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.name,
                            "arguments": if tc.arguments.trim().is_empty() { "{}".to_string() } else { tc.arguments.clone() }
                        }));
                    }
                }
                "tool" => input_items.push(json!({
                    "type": "function_call_output",
                    "call_id": m.tool_call_id.clone().unwrap_or_default(),
                    "output": m.content
                })),
                _ => {}
            }
        }
        input_items
    }

    fn build_openai_responses_tools(&self) -> Vec<Value> {
        self.canonical_tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "parameters": t["function"]["parameters"]
                })
            })
            .collect()
    }

    fn build_responses_name_maps(&self) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
        let mut short_to_full = BTreeMap::new();
        let mut known_full = BTreeMap::new();
        for name in self.tool_schemas_by_name.keys() {
            known_full.insert(name.clone(), name.clone());
            if name.len() > 64 {
                let mut short: String = name.chars().take(64).collect();
                short_to_full.insert(std::mem::take(&mut short), name.clone());
            }
        }
        (short_to_full, known_full)
    }

    fn apply_openai_responses_fields(
        &self,
        body: &mut Value,
        resp_tools: Vec<Value>,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
    ) {
        if !resp_tools.is_empty() {
            body["tools"] = Value::Array(resp_tools);
            if force_no_tools {
                body["tool_choice"] = Value::String("none".into());
            }
        }
        if self.supports_prompt_cache_key {
            body["prompt_cache_key"] = Value::String(self.session_key.clone());
        }
        body["include"] = json!(["reasoning.encrypted_content"]);
        body["parallel_tool_calls"] = json!(true);
        if let Some(effort) = self.resolve_effort_for_turn(force_low_reasoning, escalate_reasoning) {
            apply_reasoning_effort_wire(
                body,
                "openai-responses",
                &self.endpoint.model_id,
                effort,
                Some(self.endpoint.max_tokens),
            );
        } else if force_low_reasoning {
            body["reasoning"] = json!({ "effort": "low" });
        } else if escalate_reasoning {
            body["reasoning"] = json!({ "effort": "high" });
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_openai_responses_ws_or_http_turn(
        &mut self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let mut http_fresh_socket = force_fresh_socket;
        if self.should_use_responses_ws() {
            match self
                .stream_openai_responses_ws_turn(
                    msg_id,
                    total_remaining,
                    header_timeout,
                    first_delta_timeout,
                    inter_chunk_timeout,
                    force_low_reasoning,
                    escalate_reasoning,
                    force_no_tools,
                    force_fresh_socket,
                    sink,
                )
                .await
            {
                Ok(res) => return Ok(res),
                Err(StreamTurnError::Fatal(msg)) => return Err(StreamTurnError::Fatal(msg)),
                Err(StreamTurnError::EndpointUnsupported(reason)) => {
                    tracing::info!(
                        "Responses WebSocket continuation falling back to HTTP SSE: {reason}"
                    );
                    http_fresh_socket = true;
                }
                Err(_other) if !self.ws_state.disabled => {
                    tracing::warn!(
                        "Responses WebSocket turn failed; degrading cleanly to fresh HTTP SSE socket"
                    );
                    self.ws_state.reset_connection();
                    http_fresh_socket = true;
                }
                Err(other) => return Err(other),
            }
        }
        self.stream_openai_responses_turn(
            msg_id,
            total_remaining,
            header_timeout,
            first_delta_timeout,
            inter_chunk_timeout,
            force_low_reasoning,
            escalate_reasoning,
            force_no_tools,
            http_fresh_socket,
            sink,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_openai_responses_ws_turn(
        &mut self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let ws_url = openai_responses_ws_url(&self.endpoint.base_url);
        let t_req = Instant::now();
        let turn_deadline = t_req + total_remaining;
        let instructions_hash = blake3_hex(self.system_prompt.as_bytes());
        let resp_tools = self.build_openai_responses_tools();
        let tools_json = serde_json::to_string(&resp_tools).unwrap_or_default();
        let tools_hash = blake3_hex(tools_json.as_bytes());
        let input_items = self.build_openai_responses_input_items();
        let (short_to_full, known_full) = self.build_responses_name_maps();

        if force_fresh_socket
            || self.ws_state.endpoint_url != ws_url
            || self
                .ws_state
                .connected_at
                .is_some_and(|ts| ts.elapsed() >= WS_CONTINUATION_ROTATE_AFTER)
        {
            self.ws_state.reset_connection();
        }

        let mut ws_retry_full = false;
        let mut reconnected_on_stale = false;
        loop {
            let reused_existing_conn = self.ws_state.stream.is_some();
            if self.ws_state.stream.is_none() {
                let mut req = ws_url.as_str().into_client_request().map_err(|e| {
                    self.ws_state.record_failure(true);
                    self.total_ws_fallbacks += 1;
                    StreamTurnError::EndpointUnsupported(format!("Invalid WS URL '{ws_url}': {e}"))
                })?;
                req.headers_mut().insert(
                    "openai-beta",
                    HeaderValue::from_static("responses_websockets=2026-02-06"),
                );
                if self.endpoint.auth_header && !self.endpoint.api_key.is_empty() {
                    if let Ok(val) =
                        HeaderValue::from_str(&format!("Bearer {}", self.endpoint.api_key))
                    {
                        req.headers_mut().insert("authorization", val);
                    }
                }
                if let Ok(val) = HeaderValue::from_str(&self.session_key) {
                    req.headers_mut().insert("x-session-id", val);
                }

                let conn_res =
                    tokio::time::timeout(header_timeout, tokio_tungstenite::connect_async(req))
                        .await
                        .map_err(|_| {
                            self.ws_state.record_failure(false);
                            self.total_ws_fallbacks += 1;
                            StreamTurnError::EndpointUnsupported("WS connect timeout".into())
                        })?;
                let (ws_stream, _) = match conn_res {
                    Ok(pair) => pair,
                    Err(e) => {
                        let msg = crate::sanitizer::redact_secrets(&format!("{e}"));
                        let permanent = msg.contains("TLS")
                            || msg.contains("HTTP status")
                            || msg.contains("404")
                            || msg.contains("426");
                        self.ws_state.record_failure(permanent);
                        self.total_ws_fallbacks += 1;
                        return Err(StreamTurnError::EndpointUnsupported(format!(
                            "WS handshake unavailable: {msg}"
                        )));
                    }
                };
                self.ws_state.stream = Some(ws_stream);
                self.ws_state.connected_at = Some(Instant::now());
                self.ws_state.endpoint_url = ws_url.clone();
            }

            let prev_len = self.ws_state.last_input_len;
            let delta_start = if self
                .messages
                .get(prev_len)
                .is_some_and(|m| m.role == "assistant")
            {
                prev_len + 1
            } else {
                prev_len
            };
            let prefix_ok = prev_len <= self.messages.len()
                && self.ws_state.last_prefix_hash.as_deref()
                    == Some(messages_prefix_hash(&self.messages[..prev_len]).as_str());
            let can_continue = !ws_retry_full
                && self.ws_state.last_response_id.is_some()
                && self.ws_state.last_model.as_deref() == Some(self.endpoint.model_id.as_str())
                && self.ws_state.last_instructions_hash.as_deref()
                    == Some(instructions_hash.as_str())
                && self.ws_state.last_tools_hash.as_deref() == Some(tools_hash.as_str())
                && prefix_ok
                && delta_start < self.messages.len()
                && !self.messages[delta_start..]
                    .iter()
                    .any(|m| m.role == "assistant");

            let mut payload = if can_continue {
                json!({
                    "type": "response.create",
                    "model": self.endpoint.model_id,
                    "previous_response_id": self.ws_state.last_response_id,
                    "input": self.build_openai_responses_input_items_from_slice(&self.messages[delta_start..]),
                    "store": false,
                    "max_output_tokens": self.endpoint.max_tokens,
                })
            } else {
                json!({
                    "type": "response.create",
                    "model": self.endpoint.model_id,
                    "instructions": self.system_prompt,
                    "input": input_items,
                    "store": false,
                    "max_output_tokens": self.endpoint.max_tokens,
                })
            };
            self.apply_openai_responses_fields(
                &mut payload,
                resp_tools.clone(),
                force_low_reasoning,
                escalate_reasoning,
                force_no_tools,
            );

            let mut ws = match self.ws_state.stream.take() {
                Some(s) => s,
                None => {
                    self.ws_state.record_failure(false);
                    self.total_ws_fallbacks += 1;
                    return Err(StreamTurnError::EndpointUnsupported(
                        "WS stream unavailable".into(),
                    ));
                }
            };
            let payload_txt = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
            if let Err(e) = ws.send(WsMessage::Text(payload_txt.into())).await {
                if reused_existing_conn && !reconnected_on_stale {
                    reconnected_on_stale = true;
                    ws_retry_full = true;
                    self.ws_state.reset_connection();
                    continue;
                }
                self.ws_state.record_failure(false);
                self.total_ws_fallbacks += 1;
                return Err(StreamTurnError::EndpointUnsupported(format!(
                    "WS send failed: {e}"
                )));
            }

            let mut acc = ResponsesFrameState::new(t_req);
            let mut spec_pool = SpeculativeTaskPool::new();
            let stream_started_at = Instant::now();
            let mut retry_kind: Option<&'static str> = None;
            let mut saw_ws_close = false;
            let mut saw_data_frame = false;

            loop {
                let chunk_budget = compute_token_progress_wait_with_phase(
                    stream_started_at,
                    acc.last_delta_at,
                    acc.last_wire_activity_at,
                    first_delta_timeout,
                    inter_chunk_timeout,
                    turn_deadline,
                    "OpenAI Responses WS",
                    acc.in_reasoning_only(),
                )?;
                let next_frame = tokio::time::timeout(chunk_budget, ws.next())
                    .await
                    .map_err(|_| {
                        self.ws_state.record_failure(false);
                        self.total_ws_fallbacks += 1;
                        StreamTurnError::Retryable {
                            status: None,
                            retry_after_secs: None,
                            kind: RetryKind::ChunkStall,
                            detail: format!(
                                "Responses WS stall timeout after {}ms",
                                chunk_budget.as_millis()
                            ),
                        }
                    })?;
                let Some(msg_res) = next_frame else {
                    if reused_existing_conn && !reconnected_on_stale && !saw_data_frame {
                        reconnected_on_stale = true;
                        retry_kind = Some("rotate");
                    } else {
                        saw_ws_close = true;
                    }
                    break;
                };
                if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                    return Err(StreamTurnError::Fatal("Aborted by user".into()));
                }
                let ws_msg = match msg_res {
                    Ok(m) => m,
                    Err(e) => {
                        if reused_existing_conn && !reconnected_on_stale && !saw_data_frame {
                            reconnected_on_stale = true;
                            retry_kind = Some("rotate");
                            break;
                        }
                        self.ws_state.record_failure(false);
                        self.total_ws_fallbacks += 1;
                        return Err(StreamTurnError::Retryable {
                            status: None,
                            retry_after_secs: None,
                            kind: RetryKind::Transport,
                            detail: format!("Responses WS error: {e}"),
                        });
                    }
                };
                acc.last_wire_activity_at = Some(Instant::now());
                let raw_txt = match ws_msg {
                    WsMessage::Text(txt) => {
                        saw_data_frame = true;
                        txt.to_string()
                    }
                    WsMessage::Binary(bin) => {
                        saw_data_frame = true;
                        String::from_utf8_lossy(&bin).into_owned()
                    }
                    WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                    WsMessage::Close(_) => {
                        if reused_existing_conn && !reconnected_on_stale && !saw_data_frame {
                            reconnected_on_stale = true;
                            retry_kind = Some("rotate");
                        } else {
                            saw_ws_close = true;
                        }
                        break;
                    }
                    _ => continue,
                };
                let Ok(val) = serde_json::from_str::<Value>(&raw_txt) else {
                    continue;
                };
                match acc.process_event(
                    &val,
                    msg_id,
                    &self.tool_runtime,
                    &mut spec_pool,
                    &short_to_full,
                    &known_full,
                    sink,
                    None,
                ) {
                    Ok(true) => break,
                    Ok(false) => {}
                    Err(StreamTurnError::Retryable { detail, .. })
                        if !ws_retry_full
                            && (detail.contains("previous_response_not_found")
                                || detail.contains("websocket_connection_limit_reached")) =>
                    {
                        retry_kind = Some(if detail.contains("websocket_connection_limit_reached") {
                            "rotate"
                        } else {
                            "retry_full"
                        });
                        break;
                    }
                    Err(e) => {
                        self.ws_state.record_failure(false);
                        self.total_ws_fallbacks += 1;
                        return Err(e);
                    }
                }
            }

            if let Some(rk) = retry_kind {
                ws_retry_full = true;
                if rk == "rotate" {
                    self.ws_state.reset_connection();
                } else {
                    if !saw_ws_close {
                        self.ws_state.stream = Some(ws);
                    }
                    self.ws_state.last_response_id = None;
                }
                continue;
            }

            if !acc.saw_completed && acc.finish_reason.is_none() {
                self.ws_state.record_failure(false);
                self.total_ws_fallbacks += 1;
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: "Truncated Responses WS stream before response.completed".into(),
                });
            }

            if !saw_ws_close {
                self.ws_state.stream = Some(ws);
            }

            self.ws_state.consecutive_failures = 0;
            self.ws_state.last_response_id = acc.response_id.clone();
            self.ws_state.last_model = Some(self.endpoint.model_id.clone());
            self.ws_state.last_instructions_hash = Some(instructions_hash);
            self.ws_state.last_tools_hash = Some(tools_hash);
            self.ws_state.last_prefix_hash = Some(messages_prefix_hash(&self.messages));
            self.ws_state.last_input_len = self.messages.len();
            self.total_ws_turns += 1;

            return Ok(acc.finish(spec_pool));
        }
    }

    /// Native OpenAI `/v1/responses` SSE streaming dialect (`--wire-api responses`).
    #[allow(clippy::too_many_arguments)]
    async fn stream_openai_responses_turn(
        &self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
        hedge_slot: Option<(&AtomicU8, &Notify, u8)>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let base = self.endpoint.base_url.trim_end_matches('/');
        let url = if base.ends_with("/responses") {
            base.to_string()
        } else if base.ends_with("/chat/completions") {
            format!("{}/responses", base.trim_end_matches("/chat/completions"))
        } else {
            format!("{base}/responses")
        };

        let input_items = self.build_openai_responses_input_items();
        let resp_tools = self.build_openai_responses_tools();
        let (short_to_full, known_full) = self.build_responses_name_maps();

        let mut body = json!({
            "model": self.endpoint.model_id,
            "instructions": self.system_prompt,
            "input": input_items,
            "stream": true,
            "store": false,
            "max_output_tokens": self.endpoint.max_tokens,
        });
        self.apply_openai_responses_fields(
            &mut body,
            resp_tools,
            force_low_reasoning,
            escalate_reasoning,
            force_no_tools,
        );

        let client = if force_fresh_socket {
            &self.fresh_http
        } else {
            &self.http
        };
        let mut req = client
            .post(&url)
            .header("X-Session-Id", &self.session_key)
            .json(&body);
        if self.endpoint.auth_header && !self.endpoint.api_key.is_empty() {
            req = req.bearer_auth(&self.endpoint.api_key);
        }
        if force_fresh_socket {
            req = req.header("Connection", "close");
        }

        let t_req = Instant::now();
        let turn_deadline = t_req + total_remaining;
        let send_res = if let Some((winner, notify, slot)) = hedge_slot {
            if winner.load(Ordering::Acquire) != 0 && winner.load(Ordering::Acquire) != slot {
                return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
            }
            tokio::select! {
                r = tokio::time::timeout(header_timeout, req.send()) => r,
                _ = async {
                    loop {
                        notify.notified().await;
                        let w = winner.load(Ordering::Acquire);
                        if w != 0 && w != slot {
                            break;
                        }
                    }
                } => {
                    return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                }
            }
        } else {
            tokio::time::timeout(header_timeout, req.send()).await
        };
        let resp = send_res
            .map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::HeaderTimeout,
                detail: format!(
                    "Responses header timeout after {}ms",
                    header_timeout.as_millis()
                ),
            })?
            .map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: crate::sanitizer::redact_secrets(&format!(
                    "Responses transport error: {e}"
                )),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let snippet: String = err_body.chars().take(400).collect();
            if self.wire_api_mode == WireApiMode::Auto
                && matches!(
                    status,
                    StatusCode::BAD_REQUEST
                        | StatusCode::NOT_FOUND
                        | StatusCode::METHOD_NOT_ALLOWED
                        | StatusCode::UNPROCESSABLE_ENTITY
                        | StatusCode::NOT_IMPLEMENTED
                )
            {
                return Err(StreamTurnError::EndpointUnsupported(format!(
                    "Responses HTTP {status}: {snippet}"
                )));
            }
            if is_retryable_status(status) {
                return Err(StreamTurnError::Retryable {
                    status: Some(status),
                    retry_after_secs: None,
                    kind: RetryKind::HttpStatus,
                    detail: format!("Responses HTTP {status}: {snippet}"),
                });
            }
            return Err(StreamTurnError::Fatal(format!(
                "Responses HTTP {status}: {snippet}"
            )));
        }

        let mut acc = ResponsesFrameState::new(t_req);
        let mut spec_pool = SpeculativeTaskPool::new();
        let stream_started_at = Instant::now();
        let mut stream = resp.bytes_stream();
        let mut line_buf = Vec::<u8>::new();
        let mut raw_sse_log: Vec<u8> = Vec::new();

        'resp_sse: loop {
            let chunk_budget = compute_token_progress_wait_with_phase(
                stream_started_at,
                acc.last_delta_at,
                acc.last_wire_activity_at,
                first_delta_timeout,
                inter_chunk_timeout,
                turn_deadline,
                "OpenAI Responses SSE",
                acc.in_reasoning_only(),
            )?;
            let next_res = if acc.first_delta_at.is_none() {
                if let Some((winner, notify, slot)) = hedge_slot {
                    let w = winner.load(Ordering::Acquire);
                    if w != 0 && w != slot {
                        return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                    }
                    tokio::select! {
                        r = tokio::time::timeout(chunk_budget, stream.next()) => r,
                        _ = async {
                            loop {
                                notify.notified().await;
                                let w2 = winner.load(Ordering::Acquire);
                                if w2 != 0 && w2 != slot {
                                    break;
                                }
                            }
                        } => {
                            return Err(StreamTurnError::Fatal("Pre-TTFT hedge superseded".into()));
                        }
                    }
                } else {
                    tokio::time::timeout(chunk_budget, stream.next()).await
                }
            } else {
                tokio::time::timeout(chunk_budget, stream.next()).await
            };
            let next_opt = next_res.map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::ChunkStall,
                detail: format!(
                    "Responses SSE stall timeout after {}ms",
                    chunk_budget.as_millis()
                ),
            })?;
            let Some(chunk_res) = next_opt else {
                break;
            };
            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                return Err(StreamTurnError::Fatal("Aborted by user".into()));
            }
            let chunk = chunk_res.map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: format!("Responses stream error: {e}"),
            })?;
            if !chunk.is_empty() {
                acc.last_wire_activity_at = Some(Instant::now());
                if raw_sse_log.len() < 256 * 1024 {
                    let take = (256 * 1024 - raw_sse_log.len()).min(chunk.len());
                    raw_sse_log.extend_from_slice(&chunk[..take]);
                }
            }
            line_buf.extend_from_slice(&chunk);
            let mut cursor = 0usize;
            while let Some(rel_nl) = memchr(b'\n', &line_buf[cursor..]) {
                let line_slice = &line_buf[cursor..cursor + rel_nl];
                cursor += rel_nl + 1;
                let line = String::from_utf8_lossy(line_slice);
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with(':') {
                    continue;
                }
                let Some(data) = trimmed.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    acc.saw_completed = true;
                    break 'resp_sse;
                }
                let Ok(val) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if acc.process_event(
                    &val,
                    msg_id,
                    &self.tool_runtime,
                    &mut spec_pool,
                    &short_to_full,
                    &known_full,
                    sink,
                    hedge_slot,
                )? {
                    break 'resp_sse;
                }
            }
            if cursor > 0 {
                line_buf.drain(..cursor);
            }
        }

        if acc.text.is_empty() && acc.reasoning.is_empty() && acc.tool_calls.is_empty() {
            let verdict = inspect_sse_pre_commit(&raw_sse_log);
            if verdict.should_failover_before_commit() {
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: format!(
                        "Pre-commit OpenAI Responses SSE gate rejected empty stream: {verdict:?}"
                    ),
                });
            }
        }

        if !acc.saw_completed && acc.finish_reason.is_none() {
            return Err(StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::TruncatedStream,
                detail: "Truncated OpenAI Responses SSE stream EOF before response.completed"
                    .into(),
            });
        }

        Ok(acc.finish(spec_pool))
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_anthropic_turn(
        &self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_no_tools: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let url = if self.endpoint.base_url.ends_with("/messages") {
            self.endpoint.base_url.clone()
        } else {
            format!("{}/messages", self.endpoint.base_url)
        };

        let mut ant_msgs = build_anthropic_messages_for_target(
            &self.messages,
            self.supports_reasoning_echo,
            self.active_prompt_start_turn,
            &self.endpoint.provider_id,
            &self.endpoint.model_id,
        );

        let set_ephemeral = |msg: &mut Value| {
            if let Some(s) = msg
                .get("content")
                .and_then(|v| v.as_str())
                .map(String::from)
            {
                msg["content"] = json!([{
                    "type": "text",
                    "text": s,
                    "cache_control": { "type": "ephemeral" }
                }]);
            } else if let Some(arr) = msg.get_mut("content").and_then(|v| v.as_array_mut()) {
                if let Some(last_blk) = arr.last_mut() {
                    if let Some(obj) = last_blk.as_object_mut() {
                        obj.insert("cache_control".into(), json!({ "type": "ephemeral" }));
                    }
                }
            }
        };

        // Breakpoint #3: cache_control on last block of penultimate user/tool_result message
        // Breakpoint #4: cache_control on last block of trailing user/tool_result message when >= 3 messages
        let user_indices: Vec<usize> = ant_msgs
            .iter()
            .enumerate()
            .filter_map(|(i, m)| {
                if m.get("role").and_then(|v| v.as_str()) == Some("user") {
                    Some(i)
                } else {
                    None
                }
            })
            .collect();
        let mut bp3_idx = None;
        if user_indices.len() >= 2 {
            let target_idx = user_indices[user_indices.len() - 2];
            if let Some(msg) = ant_msgs.get_mut(target_idx) {
                set_ephemeral(msg);
                bp3_idx = Some(target_idx);
            }
        }
        if ant_msgs.len() >= 3 {
            if let Some(&last_u) = user_indices.last() {
                if Some(last_u) != bp3_idx {
                    if let Some(msg) = ant_msgs.get_mut(last_u) {
                        set_ephemeral(msg);
                    }
                }
            }
        }

        // Breakpoint #2: cache_control on last canonicalized tool schema
        let mut ant_tools: Vec<Value> = self
            .canonical_tools
            .iter()
            .map(|t| {
                json!({
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"]
                })
            })
            .collect();
        if let Some(last_tool) = ant_tools.last_mut() {
            if let Some(obj) = last_tool.as_object_mut() {
                obj.insert("cache_control".into(), json!({ "type": "ephemeral" }));
            }
        }

        // Breakpoint #1: cache_control on system[0]
        let mut body = json!({
            "model": self.endpoint.model_id,
            "max_tokens": self.endpoint.max_tokens,
            "stream": true,
            "system": [{
                "type": "text",
                "text": self.system_prompt,
                "cache_control": { "type": "ephemeral" }
            }],
            "messages": ant_msgs
        });
        if !ant_tools.is_empty() {
            body["tools"] = Value::Array(ant_tools);
            if force_no_tools {
                body["tool_choice"] = json!({ "type": "none" });
            }
        }
        let is_claude_model = self.endpoint.model_id.to_ascii_lowercase().contains("claude");
        if is_claude_model {
            if let Some(effort) = self.resolve_effort_for_turn(force_low_reasoning, escalate_reasoning)
            {
                apply_reasoning_effort_wire(
                    &mut body,
                    "anthropic-messages",
                    &self.endpoint.model_id,
                    effort,
                    Some(self.endpoint.max_tokens),
                );
            }
        }

        let client = if force_fresh_socket {
            &self.fresh_http
        } else {
            &self.http
        };
        let mut req = client
            .post(&url)
            .header("x-api-key", &self.endpoint.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("X-Session-Id", &self.session_key)
            .json(&body);
        if force_fresh_socket {
            req = req.header("Connection", "close");
        }

        let t_req = Instant::now();
        let turn_deadline = t_req + total_remaining;
        let resp = tokio::time::timeout(header_timeout, req.send())
            .await
            .map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::HeaderTimeout,
                detail: format!(
                    "Anthropic header timeout after {}ms",
                    header_timeout.as_millis()
                ),
            })?
            .map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: crate::sanitizer::redact_secrets(&format!(
                    "Anthropic transport error: {e}"
                )),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let err_body = resp.text().await.unwrap_or_default();
            let snippet: String = err_body.chars().take(400).collect();
            let non_claude_auto = self.wire_api_mode == WireApiMode::Auto && !is_claude_model;
            if matches!(
                status,
                StatusCode::NOT_FOUND
                    | StatusCode::METHOD_NOT_ALLOWED
                    | StatusCode::NOT_IMPLEMENTED
            ) || (non_claude_auto
                && matches!(
                    status,
                    StatusCode::BAD_REQUEST
                        | StatusCode::UNPROCESSABLE_ENTITY
                        | StatusCode::INTERNAL_SERVER_ERROR
                        | StatusCode::BAD_GATEWAY
                        | StatusCode::SERVICE_UNAVAILABLE
                ))
            {
                return Err(StreamTurnError::EndpointUnsupported(format!(
                    "Anthropic HTTP {status}: {snippet}"
                )));
            }
            if is_retryable_status(status) {
                return Err(StreamTurnError::Retryable {
                    status: Some(status),
                    retry_after_secs: retry_after,
                    kind: RetryKind::HttpStatus,
                    detail: format!("Anthropic HTTP {status}: {snippet}"),
                });
            }
            return Err(StreamTurnError::Fatal(format!(
                "Anthropic HTTP {status}: {snippet}"
            )));
        }

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut reasoning_sig = String::new();
        let mut redacted_thinking: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut spec_pool = SpeculativeTaskPool::new();
        let mut cur_tool_idx: Option<usize> = None;
        let mut saw_message_stop = false;
        let mut stop_reason: Option<String> = None;
        let mut usage = TurnLlmUsage::default();
        let mut turn_ttft_ms: Option<u64> = None;
        let mut first_delta_at: Option<Instant> = None;
        let mut last_delta_at: Option<Instant> = None;
        let mut last_wire_activity_at: Option<Instant> = None;
        let mut active_decode_ms = 0u64;
        let mut raw_sse_log: Vec<u8> = Vec::new();
        let stream_started_at = Instant::now();
        let mut stream = resp.bytes_stream();
        let mut line_buf = Vec::<u8>::new();

        'ant: loop {
            let chunk_budget = compute_token_progress_wait_with_phase(
                stream_started_at,
                last_delta_at,
                last_wire_activity_at,
                first_delta_timeout,
                inter_chunk_timeout,
                turn_deadline,
                "Anthropic SSE",
                text.is_empty() && tool_calls.is_empty(),
            )?;
            let next_opt = tokio::time::timeout(chunk_budget, stream.next())
                .await
                .map_err(|_| StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::ChunkStall,
                    detail: format!(
                        "Anthropic SSE token-progress stall timeout after {}ms",
                        chunk_budget.as_millis()
                    ),
                })?;
            let Some(chunk_res) = next_opt else {
                // Flush any final SSE data line if the proxy closed the stream without trailing `\n`.
                if !line_buf.is_empty() {
                    let tail = String::from_utf8_lossy(&line_buf);
                    if let Some(data) = tail.trim().strip_prefix("data:") {
                        if let Ok(val) = serde_json::from_str::<Value>(data.trim()) {
                            match val.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                                "message_delta" => {
                                    if let Some(sr) =
                                        val.pointer("/delta/stop_reason").and_then(|v| v.as_str())
                                    {
                                        stop_reason = Some(sr.to_string());
                                    }
                                    if let Some(u) = val.get("usage") {
                                        apply_anthropic_usage_fields(u, &mut usage);
                                    }
                                }
                                "message_stop" => {
                                    saw_message_stop = true;
                                }
                                _ => {}
                            }
                        }
                    }
                    line_buf.clear();
                }
                break;
            };
            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                return Err(StreamTurnError::Fatal("Aborted by user".into()));
            }
            let chunk = chunk_res.map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: format!("Anthropic stream error: {e}"),
            })?;
            if !chunk.is_empty() {
                last_wire_activity_at = Some(Instant::now());
                if raw_sse_log.len() < 256 * 1024 {
                    let take = (256 * 1024 - raw_sse_log.len()).min(chunk.len());
                    raw_sse_log.extend_from_slice(&chunk[..take]);
                }
            }
            line_buf.extend_from_slice(&chunk);
            let mut cursor = 0usize;
            while let Some(rel_nl) = memchr(b'\n', &line_buf[cursor..]) {
                let line_slice = &line_buf[cursor..cursor + rel_nl];
                cursor += rel_nl + 1;
                let line = String::from_utf8_lossy(line_slice);
                let Some(data) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<Value>(data.trim()) else {
                    continue;
                };
                match val.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "ping" => {
                        last_wire_activity_at = Some(Instant::now());
                    }
                    "error" => {
                        let msg = val
                            .pointer("/error/message")
                            .or_else(|| val.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Anthropic SSE error");
                        return Err(StreamTurnError::Retryable {
                            status: None,
                            retry_after_secs: None,
                            kind: RetryKind::TruncatedStream,
                            detail: crate::sanitizer::redact_secrets(&format!(
                                "Anthropic SSE stream error: {msg}"
                            )),
                        });
                    }
                    "message_start" => {
                        last_wire_activity_at = Some(Instant::now());
                        if let Some(u) = val.pointer("/message/usage") {
                            apply_anthropic_usage_fields(u, &mut usage);
                        }
                    }
                    "content_block_start" => {
                        match val.pointer("/content_block/type").and_then(|v| v.as_str()) {
                            Some("tool_use") => {
                                let now = Instant::now();
                                if turn_ttft_ms.is_none() {
                                    turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                    first_delta_at = Some(now);
                                }
                                last_delta_at = Some(now);
                                let id = val
                                    .pointer("/content_block/id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let name = val
                                    .pointer("/content_block/name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                // Some proxy translators populate `content_block.input` inline on
                                // `content_block_start` instead of emitting `input_json_delta`.
                                let initial_args = val
                                    .pointer("/content_block/input")
                                    .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
                                    .and_then(|v| serde_json::to_string(v).ok())
                                    .unwrap_or_default();
                                tool_calls.push(ToolCallRecord {
                                    id,
                                    name,
                                    arguments: initial_args,
                                });
                                cur_tool_idx = Some(tool_calls.len() - 1);
                            }
                            Some("redacted_thinking") => {
                                let now = Instant::now();
                                if turn_ttft_ms.is_none() {
                                    turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                    first_delta_at = Some(now);
                                }
                                last_delta_at = Some(now);
                                if let Some(data) = val
                                    .pointer("/content_block/data")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                {
                                    redacted_thinking.push(data.to_string());
                                }
                                cur_tool_idx = None;
                            }
                            _ => {
                                cur_tool_idx = None;
                            }
                        }
                    }
                    "content_block_delta" => {
                        let now = Instant::now();
                        let dtype = val
                            .pointer("/delta/type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let mut stamp_token = || {
                            if turn_ttft_ms.is_none() {
                                turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                first_delta_at = Some(now);
                            } else if let Some(prev) = last_delta_at {
                                let gap = now.saturating_duration_since(prev).as_millis() as u64;
                                if gap <= ACTIVE_DECODE_GAP_CAP_MS {
                                    active_decode_ms += gap;
                                }
                            }
                            last_delta_at = Some(now);
                        };
                        match dtype {
                            "text_delta" => {
                                if let Some(t) = val.pointer("/delta/text").and_then(|v| v.as_str())
                                {
                                    stamp_token();
                                    text.push_str(t);
                                    if let Some(s) = sink {
                                        s(HarnessStreamEvent::DeltaBatch {
                                            message_id: msg_id.to_string(),
                                            text_delta: t.to_string(),
                                            thinking_delta: String::new(),
                                        });
                                    }
                                }
                            }
                            "thinking_delta" => {
                                if let Some(t) =
                                    val.pointer("/delta/thinking").and_then(|v| v.as_str())
                                {
                                    stamp_token();
                                    reasoning.push_str(t);
                                    if let Some(s) = sink {
                                        s(HarnessStreamEvent::DeltaBatch {
                                            message_id: msg_id.to_string(),
                                            text_delta: String::new(),
                                            thinking_delta: t.to_string(),
                                        });
                                    }
                                }
                            }
                            "signature_delta" => {
                                if let Some(sig) =
                                    val.pointer("/delta/signature").and_then(|v| v.as_str())
                                {
                                    stamp_token();
                                    reasoning_sig.push_str(sig);
                                }
                            }
                            "input_json_delta" => {
                                if let (Some(idx), Some(pj)) = (
                                    cur_tool_idx,
                                    val.pointer("/delta/partial_json").and_then(|v| v.as_str()),
                                ) {
                                    stamp_token();
                                    tool_calls[idx].arguments.push_str(pj);
                                }
                            }
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        if let Some(idx) = cur_tool_idx.take() {
                            if let Some(tc) = tool_calls.get(idx) {
                                spec_pool.try_spawn_if_admissible(
                                    idx,
                                    tc,
                                    &self.tool_runtime,
                                    true,
                                );
                            }
                        }
                    }
                    "message_delta" => {
                        last_delta_at = Some(Instant::now());
                        if let Some(sr) = val.pointer("/delta/stop_reason").and_then(|v| v.as_str())
                        {
                            stop_reason = Some(sr.to_string());
                        }
                        if let Some(u) = val.get("usage") {
                            apply_anthropic_usage_fields(u, &mut usage);
                        }
                    }
                    "message_stop" => {
                        saw_message_stop = true;
                        break 'ant;
                    }
                    _ => {}
                }
            }
            if cursor > 0 {
                line_buf.drain(..cursor);
            }
        }

        let has_truncated_tool_json = tool_calls.iter().any(|tc| {
            let trimmed = tc.arguments.trim();
            !trimmed.is_empty()
                && serde_json::from_str::<Value>(trimmed).is_err()
                && repair_tool_json(trimmed, self.tool_schemas_by_name.get(&tc.name)).is_err()
        });
        if text.is_empty() && reasoning.is_empty() && tool_calls.is_empty() {
            let verdict = inspect_sse_pre_commit(&raw_sse_log);
            if verdict.should_failover_before_commit() {
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: format!(
                        "Pre-commit Anthropic SSE gate rejected empty stream: {verdict:?}"
                    ),
                });
            }
        }
        if has_truncated_tool_json || (!saw_message_stop && stop_reason.is_none()) {
            return Err(StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::TruncatedStream,
                detail: "Truncated Anthropic SSE stream EOF before message_stop".into(),
            });
        }

        let turn_gen_ms = compute_pure_gen_duration_ms(
            t_req,
            turn_ttft_ms,
            first_delta_at,
            last_delta_at,
            usage.output,
        );
        let turn_active_decode_ms = if first_delta_at.is_some() {
            active_decode_ms.max(1)
        } else {
            0
        };
        let mut raw_spec = spec_pool.take_all();
        let mut speculative_results: HashMap<usize, tokio::task::JoinHandle<ToolExecOutput>> =
            HashMap::new();
        for (idx, tc) in tool_calls.iter().enumerate() {
            if let Some(entry) = raw_spec.remove(&idx) {
                if entry.spawned_args == tc.arguments {
                    speculative_results.insert(idx, entry.handle);
                } else {
                    entry.handle.abort();
                }
            }
        }
        for (_, entry) in raw_spec {
            entry.handle.abort();
        }

        Ok(TurnStreamResult {
            text,
            reasoning,
            reasoning_signature: if reasoning_sig.is_empty() {
                None
            } else {
                Some(reasoning_sig)
            },
            redacted_thinking,
            reasoning_encrypted_items: Vec::new(),
            response_id: None,
            tool_calls,
            speculative_results,
            finish_reason: stop_reason.or_else(|| Some("end_turn".into())),
            usage,
            turn_ttft_ms,
            turn_gen_ms,
            turn_active_decode_ms,
            http_retries: 0,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_gemini_turn(
        &self,
        msg_id: &str,
        total_remaining: Duration,
        header_timeout: Duration,
        first_delta_timeout: Duration,
        inter_chunk_timeout: Duration,
        force_low_reasoning: bool,
        escalate_reasoning: bool,
        force_fresh_socket: bool,
        sink: Option<&HarnessEventSink>,
    ) -> std::result::Result<TurnStreamResult, StreamTurnError> {
        let url = format!(
            "{}/models/{}:streamGenerateContent?alt=sse",
            self.endpoint.base_url, self.endpoint.model_id
        );

        let mut contents = Vec::new();
        for m in &self.messages {
            match m.role.as_str() {
                "user" => {
                    let mut parts = Vec::new();
                    if !m.content.is_empty() || m.content_blocks.is_empty() {
                        parts.push(json!({ "text": m.content }));
                    }
                    for blk in &m.content_blocks {
                        match blk {
                            ContentBlock::Text { text } if !text.is_empty() => {
                                parts.push(json!({ "text": text }));
                            }
                            ContentBlock::ImageBase64 {
                                media_type,
                                data_base64,
                                ..
                            } => {
                                parts.push(json!({
                                    "inlineData": {
                                        "mimeType": media_type,
                                        "data": data_base64
                                    }
                                }));
                            }
                            ContentBlock::ImageUrl { url, .. } => {
                                parts.push(json!({ "fileData": { "fileUri": url } }));
                            }
                            ContentBlock::FileUri { uri, media_type, .. } => {
                                parts.push(json!({
                                    "fileData": { "mimeType": media_type, "fileUri": uri }
                                }));
                            }
                            _ => {}
                        }
                    }
                    contents.push(json!({ "role": "user", "parts": parts }));
                }
                "assistant" => {
                    let mut parts = Vec::new();
                    if !m.content.is_empty() {
                        parts.push(json!({ "text": m.content }));
                    }
                    let replay_sig = m.can_replay_cryptographic_proof(
                        &self.endpoint.provider_id,
                        &self.endpoint.model_id,
                    );
                    for (idx, tc) in m.tool_calls.iter().enumerate() {
                        let args: Value =
                            serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!({}));
                        let mut part = json!({
                            "functionCall": { "name": tc.name, "args": args }
                        });
                        if idx == 0 && replay_sig {
                            if let Some(ref sig) = m.reasoning_signature {
                                if !sig.is_empty() {
                                    part["thoughtSignature"] = Value::String(sig.clone());
                                }
                            }
                        }
                        parts.push(part);
                    }
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
                "tool" => {
                    let part = json!({
                        "functionResponse": {
                            "name": m.tool_name.clone().unwrap_or_else(|| "tool".into()),
                            "response": { "result": m.content }
                        }
                    });
                    if let Some(last) = contents.last_mut() {
                        if last.get("role").and_then(|v| v.as_str()) == Some("user")
                            && last.pointer("/parts/0/functionResponse").is_some()
                        {
                            if let Some(arr) = last.get_mut("parts").and_then(|p| p.as_array_mut())
                            {
                                arr.push(part);
                                continue;
                            }
                        }
                    }
                    contents.push(json!({
                        "role": "user",
                        "parts": [part]
                    }));
                }
                _ => {}
            }
        }
        let decls: Vec<Value> = self
            .canonical_tools
            .iter()
            .map(|t| {
                json!({
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "parameters": t["function"]["parameters"]
                })
            })
            .collect();
        let mut body = json!({
            "systemInstruction": { "parts": [{ "text": self.system_prompt }] },
            "contents": contents,
            "tools": [{ "functionDeclarations": decls }],
            "generationConfig": { "maxOutputTokens": self.endpoint.max_tokens }
        });
        if let Some(effort) = self.resolve_effort_for_turn(force_low_reasoning, escalate_reasoning) {
            apply_reasoning_effort_wire(
                &mut body,
                "gemini",
                &self.endpoint.model_id,
                effort,
                Some(self.endpoint.max_tokens),
            );
        }
        sanitize_gemini_wire_payload(&mut body);

        let client = if force_fresh_socket {
            &self.fresh_http
        } else {
            &self.http
        };
        let mut req = client.post(&url).json(&body);
        if !self.endpoint.api_key.is_empty() {
            req = req.header("x-goog-api-key", &self.endpoint.api_key);
        }
        if force_fresh_socket {
            req = req.header("Connection", "close");
        }

        let t_req = Instant::now();
        let turn_deadline = t_req + total_remaining;
        let resp = tokio::time::timeout(header_timeout, req.send())
            .await
            .map_err(|_| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::HeaderTimeout,
                detail: format!(
                    "Gemini header timeout after {}ms",
                    header_timeout.as_millis()
                ),
            })?
            .map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: crate::sanitizer::redact_secrets(&format!("Gemini transport error: {e}")),
            })?;
        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let snippet: String = err_body.chars().take(400).collect();
            if is_retryable_status(status) {
                return Err(StreamTurnError::Retryable {
                    status: Some(status),
                    retry_after_secs: None,
                    kind: RetryKind::HttpStatus,
                    detail: format!("Gemini HTTP {status}: {snippet}"),
                });
            }
            return Err(StreamTurnError::Fatal(format!(
                "Gemini HTTP {status}: {snippet}"
            )));
        }

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut thought_signature: Option<String> = None;
        let mut tool_calls = Vec::new();
        let mut finish_reason: Option<String> = None;
        let mut usage = TurnLlmUsage::default();
        let mut turn_ttft_ms = None;
        let mut first_delta_at = None;
        let mut last_delta_at = None;
        let mut last_wire_activity_at = None;
        let mut active_decode_ms = 0u64;
        let stream_started_at = Instant::now();
        let mut stream = resp.bytes_stream();
        let mut line_buf = Vec::<u8>::new();
        let mut raw_sse_log: Vec<u8> = Vec::new();

        loop {
            let chunk_budget = compute_token_progress_wait_with_phase(
                stream_started_at,
                last_delta_at,
                last_wire_activity_at,
                first_delta_timeout,
                inter_chunk_timeout,
                turn_deadline,
                "Gemini SSE",
                text.is_empty() && tool_calls.is_empty(),
            )?;
            let next_opt = tokio::time::timeout(chunk_budget, stream.next())
                .await
                .map_err(|_| StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::ChunkStall,
                    detail: format!(
                        "Gemini SSE token-progress stall timeout after {}ms",
                        chunk_budget.as_millis()
                    ),
                })?;
            let Some(chunk_res) = next_opt else {
                break;
            };
            if self.tool_runtime.cancel_flag.load(Ordering::Relaxed) {
                return Err(StreamTurnError::Fatal("Aborted by user".into()));
            }
            let chunk = chunk_res.map_err(|e| StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::Transport,
                detail: format!("Gemini stream error: {e}"),
            })?;
            if !chunk.is_empty() {
                last_wire_activity_at = Some(Instant::now());
                if raw_sse_log.len() < 256 * 1024 {
                    let take = (256 * 1024 - raw_sse_log.len()).min(chunk.len());
                    raw_sse_log.extend_from_slice(&chunk[..take]);
                }
            }
            line_buf.extend_from_slice(&chunk);
            let mut cursor = 0usize;
            while let Some(rel_nl) = memchr(b'\n', &line_buf[cursor..]) {
                let line_slice = &line_buf[cursor..cursor + rel_nl];
                cursor += rel_nl + 1;
                let line = String::from_utf8_lossy(line_slice);
                let Some(data) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<Value>(data.trim()) else {
                    continue;
                };
                if let Some(fr) = val
                    .pointer("/candidates/0/finishReason")
                    .and_then(|v| v.as_str())
                {
                    finish_reason = Some(fr.to_string());
                }
                if let Some(um) = val.get("usageMetadata") {
                    usage.saw_usage = true;
                    let pt = um
                        .get("promptTokenCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cr = um
                        .get("cachedContentTokenCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    usage.cache_read = cr;
                    usage.uncached_input = pt.saturating_sub(cr);
                    usage.output = um
                        .get("candidatesTokenCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if let Some(th) = um.get("thoughtsTokenCount").and_then(|v| v.as_u64()) {
                        usage.reasoning = Some(th);
                        usage.output += th;
                    }
                }
                if let Some(parts) = val
                    .pointer("/candidates/0/content/parts")
                    .and_then(|v| v.as_array())
                {
                    let now = Instant::now();
                    for p in parts {
                        if let Some(sig) = extract_thought_signature(p) {
                            thought_signature = Some(sig);
                        }
                        let is_thought =
                            p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false);
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                if turn_ttft_ms.is_none() {
                                    turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                    first_delta_at = Some(now);
                                } else if let Some(prev) = last_delta_at {
                                    let gap =
                                        now.saturating_duration_since(prev).as_millis() as u64;
                                    if gap <= ACTIVE_DECODE_GAP_CAP_MS {
                                        active_decode_ms += gap;
                                    }
                                }
                                last_delta_at = Some(now);
                                if is_thought {
                                    reasoning.push_str(t);
                                    if let Some(s) = sink {
                                        s(HarnessStreamEvent::DeltaBatch {
                                            message_id: msg_id.to_string(),
                                            text_delta: String::new(),
                                            thinking_delta: t.to_string(),
                                        });
                                    }
                                } else {
                                    text.push_str(t);
                                    if let Some(s) = sink {
                                        s(HarnessStreamEvent::DeltaBatch {
                                            message_id: msg_id.to_string(),
                                            text_delta: t.to_string(),
                                            thinking_delta: String::new(),
                                        });
                                    }
                                }
                            }
                        } else if let Some(fc) = p.get("functionCall") {
                            if turn_ttft_ms.is_none() {
                                turn_ttft_ms = Some(t_req.elapsed().as_millis() as u64);
                                first_delta_at = Some(now);
                            } else if let Some(prev) = last_delta_at {
                                let gap = now.saturating_duration_since(prev).as_millis() as u64;
                                if gap <= ACTIVE_DECODE_GAP_CAP_MS {
                                    active_decode_ms += gap;
                                }
                            }
                            last_delta_at = Some(now);
                            let name = fc
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                            tool_calls.push(ToolCallRecord {
                                id: format!("call_{msg_id}_{}", tool_calls.len()),
                                name,
                                arguments: args.to_string(),
                            });
                        }
                    }
                }
            }
            if cursor > 0 {
                line_buf.drain(..cursor);
            }
        }

        if text.is_empty() && reasoning.is_empty() && tool_calls.is_empty() {
            let verdict = inspect_sse_pre_commit(&raw_sse_log);
            if verdict.should_failover_before_commit() {
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: format!(
                        "Pre-commit Gemini SSE gate rejected empty stream: {verdict:?}"
                    ),
                });
            }
        }
        if finish_reason.is_none() && tool_calls.is_empty() {
            return Err(StreamTurnError::Retryable {
                status: None,
                retry_after_secs: None,
                kind: RetryKind::TruncatedStream,
                detail: "Truncated Gemini SSE stream EOF before finishReason".into(),
            });
        }

        let turn_gen_ms = compute_pure_gen_duration_ms(
            t_req,
            turn_ttft_ms,
            first_delta_at,
            last_delta_at,
            usage.output,
        );
        let turn_active_decode_ms = if first_delta_at.is_some() {
            active_decode_ms.max(1)
        } else {
            0
        };
        Ok(TurnStreamResult {
            text,
            reasoning,
            reasoning_signature: thought_signature,
            redacted_thinking: Vec::new(),
            reasoning_encrypted_items: Vec::new(),
            response_id: None,
            tool_calls,
            speculative_results: HashMap::new(),
            finish_reason: finish_reason.or_else(|| Some("STOP".into())),
            usage,
            turn_ttft_ms,
            turn_gen_ms,
            turn_active_decode_ms,
            http_retries: 0,
        })
    }
}

/// Shared OpenAI `/v1/responses` SSE & WebSocket event state machine.
struct ResponsesFrameState {
    t_req: Instant,
    text: String,
    reasoning: String,
    reasoning_encrypted_items: Vec<Value>,
    response_id: Option<String>,
    tool_by_item_id: HashMap<String, usize>,
    tool_calls: Vec<ToolCallRecord>,
    finish_reason: Option<String>,
    saw_completed: bool,
    usage: TurnLlmUsage,
    turn_ttft_ms: Option<u64>,
    first_delta_at: Option<Instant>,
    last_delta_at: Option<Instant>,
    last_wire_activity_at: Option<Instant>,
    active_decode_ms: u64,
}

impl ResponsesFrameState {
    fn new(t_req: Instant) -> Self {
        Self {
            t_req,
            text: String::new(),
            reasoning: String::new(),
            reasoning_encrypted_items: Vec::new(),
            response_id: None,
            tool_by_item_id: HashMap::new(),
            tool_calls: Vec::new(),
            finish_reason: None,
            saw_completed: false,
            usage: TurnLlmUsage::default(),
            turn_ttft_ms: None,
            first_delta_at: None,
            last_delta_at: None,
            last_wire_activity_at: None,
            active_decode_ms: 0,
        }
    }

    fn in_reasoning_only(&self) -> bool {
        self.text.is_empty() && self.tool_calls.is_empty()
    }

    fn stamp_token(
        &mut self,
        now: Instant,
        hedge_slot: Option<(&AtomicU8, &Notify, u8)>,
    ) -> std::result::Result<(), StreamTurnError> {
        if self.turn_ttft_ms.is_none() {
            if let Some((winner, notify, slot)) = hedge_slot {
                match winner.compare_exchange(0, slot, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) => notify.notify_waiters(),
                    Err(other) if other != slot => {
                        return Err(StreamTurnError::Fatal(
                            "Pre-TTFT hedge superseded".into(),
                        ));
                    }
                    Err(_) => {}
                }
            }
            self.turn_ttft_ms = Some(self.t_req.elapsed().as_millis() as u64);
            self.first_delta_at = Some(now);
        } else if let Some(prev) = self.last_delta_at {
            let gap = now.saturating_duration_since(prev).as_millis() as u64;
            if gap <= ACTIVE_DECODE_GAP_CAP_MS {
                self.active_decode_ms += gap;
            }
        }
        self.last_delta_at = Some(now);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn process_event(
        &mut self,
        val: &Value,
        msg_id: &str,
        tool_runtime: &ToolRuntime,
        spec_pool: &mut SpeculativeTaskPool,
        short_to_full: &BTreeMap<String, String>,
        known_full: &BTreeMap<String, String>,
        sink: Option<&HarnessEventSink>,
        hedge_slot: Option<(&AtomicU8, &Notify, u8)>,
    ) -> std::result::Result<bool, StreamTurnError> {
        let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let now = Instant::now();
        self.last_wire_activity_at = Some(now);
        if self.response_id.is_none() {
            if let Some(id) = val.pointer("/response/id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    self.response_id = Some(id.to_string());
                }
            }
        }

        match ev_type {
            "response.created" | "response.queued" | "response.in_progress" => {
                self.last_wire_activity_at = Some(now);
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(d) = val.get("delta").and_then(|v| v.as_str()) {
                    if !d.is_empty() {
                        self.stamp_token(now, hedge_slot)?;
                        self.text.push_str(d);
                        let allow_sink = hedge_slot
                            .is_none_or(|(w, _, slot)| w.load(Ordering::Acquire) == slot);
                        if allow_sink {
                            if let Some(s) = sink {
                                s(HarnessStreamEvent::DeltaBatch {
                                    message_id: msg_id.to_string(),
                                    text_delta: d.to_string(),
                                    thinking_delta: String::new(),
                                });
                            }
                        }
                    }
                }
            }
            "response.reasoning_text.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning.delta" => {
                if let Some(d) = val.get("delta").and_then(|v| v.as_str()) {
                    if !d.is_empty() {
                        self.stamp_token(now, hedge_slot)?;
                        self.reasoning.push_str(d);
                        let allow_sink = hedge_slot
                            .is_none_or(|(w, _, slot)| w.load(Ordering::Acquire) == slot);
                        if allow_sink {
                            if let Some(s) = sink {
                                s(HarnessStreamEvent::DeltaBatch {
                                    message_id: msg_id.to_string(),
                                    text_delta: String::new(),
                                    thinking_delta: d.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            "response.output_item.added" => {
                if let Some(item_orig) = val.get("item") {
                    let mut item = item_orig.clone();
                    restore_responses_namespaces_value(&mut item, short_to_full, known_full);
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if matches!(item_type, "function_call" | "custom_tool_call") {
                        self.stamp_token(now, hedge_slot)?;
                        if let Some(prev_idx) = self.tool_calls.len().checked_sub(1) {
                            spec_pool.try_spawn_if_admissible(
                                prev_idx,
                                &self.tool_calls[prev_idx],
                                tool_runtime,
                                false,
                            );
                        }
                        let item_id = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let call_id = item
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .unwrap_or_else(|| format!("call_{msg_id}_{}", self.tool_calls.len()));
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args = item
                            .get("arguments")
                            .or_else(|| item.get("input"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let idx = self.tool_calls.len();
                        self.tool_calls.push(ToolCallRecord {
                            id: call_id,
                            name,
                            arguments: args,
                        });
                        if !item_id.is_empty() {
                            self.tool_by_item_id.insert(item_id, idx);
                        }
                    }
                }
            }
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
                if let Some(d) = val.get("delta").and_then(|v| v.as_str()) {
                    if !d.is_empty() {
                        self.stamp_token(now, hedge_slot)?;
                        let item_id = val.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(&idx) = self.tool_by_item_id.get(item_id) {
                            self.tool_calls[idx].arguments.push_str(d);
                        } else if let Some(last) = self.tool_calls.last_mut() {
                            last.arguments.push_str(d);
                        }
                    }
                }
            }
            "response.output_item.done" => {
                if let Some(item_orig) = val.get("item") {
                    let mut item = item_orig.clone();
                    restore_responses_namespaces_value(&mut item, short_to_full, known_full);
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if item_type == "reasoning" {
                        let has_enc = item
                            .get("encrypted_content")
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.is_empty());
                        if has_enc {
                            self.reasoning_encrypted_items.push(item);
                        }
                    } else if matches!(item_type, "function_call" | "custom_tool_call") {
                        let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let final_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let final_args = item
                            .get("arguments")
                            .or_else(|| item.get("input"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let idx_opt = self.tool_by_item_id.get(item_id).copied().or_else(|| {
                            let cid = item.get("call_id").and_then(|v| v.as_str())?;
                            self.tool_calls.iter().position(|t| t.id == cid)
                        });
                        let idx = match idx_opt {
                            Some(idx) => {
                                if !final_name.is_empty() {
                                    self.tool_calls[idx].name = final_name.to_string();
                                }
                                if !final_args.is_empty() {
                                    self.tool_calls[idx].arguments = final_args.to_string();
                                }
                                idx
                            }
                            None => {
                                self.stamp_token(now, hedge_slot)?;
                                let call_id = item
                                    .get("call_id")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .map(String::from)
                                    .unwrap_or_else(|| {
                                        format!("call_{msg_id}_{}", self.tool_calls.len())
                                    });
                                let new_idx = self.tool_calls.len();
                                self.tool_calls.push(ToolCallRecord {
                                    id: call_id,
                                    name: final_name.to_string(),
                                    arguments: final_args.to_string(),
                                });
                                new_idx
                            }
                        };
                        spec_pool.try_spawn_if_admissible(
                            idx,
                            &self.tool_calls[idx],
                            tool_runtime,
                            true,
                        );
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                self.saw_completed = true;
                self.finish_reason = Some(if ev_type == "response.incomplete" {
                    "length".into()
                } else if self.tool_calls.is_empty() {
                    "stop".into()
                } else {
                    "tool_calls".into()
                });
                if let Some(u) = val.pointer("/response/usage") {
                    parse_openai_usage(u, &mut self.usage);
                }
                return Ok(true);
            }
            "response.failed" | "error" => {
                let code = val
                    .pointer("/response/error/code")
                    .or_else(|| val.pointer("/error/code"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let msg = val
                    .pointer("/response/error/message")
                    .or_else(|| val.pointer("/error/message"))
                    .or_else(|| val.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("response.failed");
                let combined = if code.is_empty() {
                    msg.to_string()
                } else {
                    format!("{code}: {msg}")
                };
                return Err(StreamTurnError::Retryable {
                    status: None,
                    retry_after_secs: None,
                    kind: RetryKind::TruncatedStream,
                    detail: crate::sanitizer::redact_secrets(&format!(
                        "OpenAI Responses stream failed: {combined}"
                    )),
                });
            }
            _ => {}
        }
        Ok(false)
    }

    fn finish(self, mut spec_pool: SpeculativeTaskPool) -> TurnStreamResult {
        let mut raw_spec = spec_pool.take_all();
        let mut speculative_results = HashMap::new();
        for (idx, tc) in self.tool_calls.iter().enumerate() {
            if let Some(entry) = raw_spec.remove(&idx) {
                if entry.spawned_args == tc.arguments {
                    speculative_results.insert(idx, entry.handle);
                } else {
                    entry.handle.abort();
                }
            }
        }
        for (_, entry) in raw_spec {
            entry.handle.abort();
        }
        let turn_gen_ms = compute_pure_gen_duration_ms(
            self.t_req,
            self.turn_ttft_ms,
            self.first_delta_at,
            self.last_delta_at,
            self.usage.output,
        );
        let turn_active_decode_ms = if self.first_delta_at.is_some() {
            self.active_decode_ms.max(1)
        } else {
            0
        };
        TurnStreamResult {
            text: self.text,
            reasoning: self.reasoning,
            reasoning_signature: None,
            redacted_thinking: Vec::new(),
            reasoning_encrypted_items: self.reasoning_encrypted_items,
            response_id: self.response_id,
            tool_calls: self.tool_calls,
            speculative_results,
            finish_reason: self.finish_reason,
            usage: self.usage,
            turn_ttft_ms: self.turn_ttft_ms,
            turn_gen_ms,
            turn_active_decode_ms,
            http_retries: 0,
        }
    }
}

fn messages_prefix_hash(msgs: &[HarnessMessage]) -> String {
    let mut buf = Vec::with_capacity(msgs.len().saturating_mul(64));
    for m in msgs {
        buf.extend_from_slice(&(m.role.len() as u32).to_le_bytes());
        buf.extend_from_slice(m.role.as_bytes());
        buf.extend_from_slice(&(m.content.len() as u32).to_le_bytes());
        buf.extend_from_slice(m.content.as_bytes());
        let tc_id = m.tool_call_id.as_deref().unwrap_or("");
        buf.extend_from_slice(&(tc_id.len() as u32).to_le_bytes());
        buf.extend_from_slice(tc_id.as_bytes());
        buf.extend_from_slice(&(m.tool_calls.len() as u32).to_le_bytes());
        for tc in &m.tool_calls {
            buf.extend_from_slice(tc.id.as_bytes());
            buf.push(0);
            buf.extend_from_slice(tc.name.as_bytes());
            buf.push(0);
            buf.extend_from_slice(tc.arguments.as_bytes());
            buf.push(0);
        }
        buf.extend_from_slice(&(m.content_blocks.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(m.reasoning_encrypted_items.len() as u32).to_le_bytes());
    }
    blake3_hex(&buf)
}

fn openai_responses_ws_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let ws_scheme = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    };
    if ws_scheme.ends_with("/responses") {
        ws_scheme
    } else if ws_scheme.ends_with("/chat/completions") {
        format!("{}/responses", ws_scheme.trim_end_matches("/chat/completions"))
    } else {
        format!("{ws_scheme}/responses")
    }
}

fn is_unreachable_network_error(detail: &str) -> bool {
    let low = detail.to_ascii_lowercase();
    [
        "enotfound",
        "eai_again",
        "enetunreach",
        "ehostunreach",
        "enetdown",
        "failed to lookup address information",
        "dns error",
        "no such host",
        "name or service not known",
        "network is unreachable",
        "host is unreachable",
    ]
    .iter()
    .any(|m| low.contains(m))
}

fn compute_unreachable_backoff_ms(attempt: u32) -> u64 {
    let shift = attempt.saturating_sub(1).min(5);
    let raw = UNREACHABLE_RETRY_INITIAL_MS.saturating_mul(1u64 << shift);
    let capped = raw.min(UNREACHABLE_RETRY_MAX_MS);
    let jitter = (Utc::now().timestamp_subsec_millis() as u64 % 500) + 100;
    (capped + jitter).min(UNREACHABLE_RETRY_MAX_MS)
}

#[derive(Debug, Clone)]
pub struct PromptRunSummary {
    pub status: String,
    pub final_text: String,
    pub turns: u32,
    pub ttft_ms: Option<u64>,
    pub llm_ttft_ms: Option<u64>,
    pub gen_duration_ms: u64,
    pub active_decode_ms: u64,
    pub saw_any_usage: bool,
    pub saw_any_reasoning_tokens: bool,
    pub recovery_attempts: u32,
    pub recovery_succeeded: bool,
    pub truncated_stream_retries: u32,
    pub stall_retries: u32,
    pub verify_gate_nudges: u32,
    pub narration_nudges: u32,
    pub interleaved_reasoning_turns: u32,
    pub cache_stats: HarnessCacheStats,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryKind {
    HttpStatus,
    Transport,
    HeaderTimeout,
    ChunkStall,
    TruncatedStream,
}

#[derive(Debug)]
enum StreamTurnError {
    BadStreamOptions,
    BadReasoningEcho,
    BadPromptCacheKey,
    EndpointUnsupported(String),
    Retryable {
        status: Option<StatusCode>,
        retry_after_secs: Option<u64>,
        kind: RetryKind,
        detail: String,
    },
    Fatal(String),
}

fn is_retryable_status(st: StatusCode) -> bool {
    matches!(st.as_u16(), 429 | 500 | 502 | 503 | 504 | 529)
}

#[derive(Debug, PartialEq, Eq)]
enum ToolDispatchBatch {
    ParallelRead(std::ops::Range<usize>),
    Sequential(usize),
}

/// Partition a turn's tool calls into maximal contiguous parallel read-only runs
/// separated by sequential mutating barriers (preserving exact wire order!).
fn partition_tool_batches(calls: &[(ToolCallRecord, Result<Value>)]) -> Vec<ToolDispatchBatch> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let n = calls.len();
    while i < n {
        if ToolRuntime::is_read_only_tool(&calls[i].0.name) {
            let start = i;
            while i < n && ToolRuntime::is_read_only_tool(&calls[i].0.name) {
                i += 1;
            }
            if i - start >= 2 {
                out.push(ToolDispatchBatch::ParallelRead(start..i));
            } else {
                out.push(ToolDispatchBatch::Sequential(start));
            }
        } else {
            out.push(ToolDispatchBatch::Sequential(i));
            i += 1;
        }
    }
    out
}

/// Detect narration-only premature stops (e.g. `"I'll read the guidance files now:"` or
/// Claude's curly-apostrophe `"I’ll now read..."` with `tool_calls=[]`).
fn is_narration_only_stop(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.ends_with(':') || trimmed.ends_with("...") {
        return true;
    }
    if trimmed.len() < 600 {
        let normalized: String = trimmed
            .chars()
            .map(|c| match c {
                '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
                _ => c.to_ascii_lowercase(),
            })
            .collect();
        for marker in [
            "i'll now",
            "i'll read",
            "i'll use",
            "i'll implement",
            "i'll write",
            "i'll edit",
            "i'll fix",
            "i'll update",
            "i'll run",
            "i'll inspect",
            "i'll check",
            "i'll examine",
            "i'm reading",
            "i'm going to",
            "next i'll",
            "next, i'll",
            "next, i will",
            "i will now",
            "i am going to",
            "let me inspect",
            "let me read",
            "let me check",
            "let me run",
            "let me fix",
            "let me write",
            "let me edit",
            "let me update",
            "let's inspect",
            "let's read",
        ] {
            if normalized.contains(marker) {
                return true;
            }
        }
    }
    false
}

fn extract_tool_target_path(tool_name: &str, args: &Value) -> Option<String> {
    match tool_name {
        "read_file" => args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().replace('\\', "/"))
            .filter(|s| !s.is_empty()),
        "edit_file" | "write_file" => args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().replace('\\', "/"))
            .filter(|s| !s.is_empty()),
        "apply_patch" => args.get("patch").and_then(|v| v.as_str()).and_then(|p| {
            p.lines().find_map(|l| {
                let t = l.trim();
                t.strip_prefix("*** Update File:")
                    .or_else(|| t.strip_prefix("*** Add File:"))
                    .or_else(|| t.strip_prefix("*** Delete File:"))
                    .map(|s| s.trim().replace('\\', "/"))
            })
        }),
        _ => None,
    }
}

/// Parse the leading `exit_code: N` header emitted by the `shell` tool.
fn parse_shell_exit_code(content: &str) -> Option<i32> {
    let first = content.lines().next()?.trim();
    first.strip_prefix("exit_code:")?.trim().parse::<i32>().ok()
}

/// Detect clean `exit_code=0` invocations of standalone test/verify scripts (e.g. `test_sample.py`,
/// `verify.py`, `suite.test.mjs`) whose assertions print minimal or custom output.
fn is_test_script_invocation(cmd: &str, output: &str) -> bool {
    let low_out = output.to_ascii_lowercase();
    if low_out.contains("traceback")
        || low_out.contains("assertionerror")
        || low_out.contains("failed")
        || low_out.contains("error[e")
    {
        return false;
    }
    let low_cmd = cmd.to_ascii_lowercase();
    low_cmd
        .split(|c: char| c.is_whitespace() || matches!(c, '&' | '|' | ';' | '"' | '\''))
        .any(|tok| {
            let base = tok.rsplit(['/', '\\']).next().unwrap_or(tok);
            let test_stem = base.starts_with("test_")
                || base.starts_with("verify")
                || base.contains("_test.")
                || base.contains(".test.")
                || base.contains(".spec.");
            let script_ext = base.ends_with(".py")
                || base.ends_with(".mjs")
                || base.ends_with(".js")
                || base.ends_with(".ts")
                || base.ends_with(".ps1")
                || base.ends_with(".sh");
            test_stem && script_ext
        })
}

/// Extract Gemini `thought_signature` / `thoughtSignature` verbatim from SSE delta or part JSON.
fn extract_thought_signature(v: &Value) -> Option<String> {
    v.get("thought_signature")
        .or_else(|| v.get("thoughtSignature"))
        .or_else(|| v.pointer("/extra_content/google/thought_signature"))
        .or_else(|| v.pointer("/extra_content/google/thoughtSignature"))
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Serialize a `HarnessMessage` into OpenAI Chat Completions wire JSON with
/// cross-model cryptographic proof scoping and multimodal `ContentBlock` lowering.
fn message_to_openai_json(
    m: &HarnessMessage,
    active_prompt_start_turn: u32,
    include_reasoning_echo: bool,
    is_gemini: bool,
) -> Value {
    message_to_openai_json_for_target(
        m,
        active_prompt_start_turn,
        include_reasoning_echo,
        is_gemini,
        "",
        "",
    )
}

fn message_to_openai_json_for_target(
    m: &HarnessMessage,
    active_prompt_start_turn: u32,
    include_reasoning_echo: bool,
    is_gemini: bool,
    target_provider: &str,
    target_model: &str,
) -> Value {
    match m.role.as_str() {
        "system" => json!({ "role": "system", "content": m.content }),
        "user" => {
            if m.content_blocks.is_empty() {
                json!({ "role": "user", "content": m.content })
            } else {
                let mut parts: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "type": "text", "text": m.content }));
                }
                for blk in &m.content_blocks {
                    match blk {
                        ContentBlock::Text { text } if !text.is_empty() => {
                            parts.push(json!({ "type": "text", "text": text }));
                        }
                        ContentBlock::ImageBase64 {
                            media_type,
                            data_base64,
                            detail,
                            ..
                        } => {
                            let mut img = json!({
                                "url": format!("data:{media_type};base64,{data_base64}")
                            });
                            if let Some(d) = detail {
                                img["detail"] = Value::String(d.clone());
                            }
                            parts.push(json!({ "type": "image_url", "image_url": img }));
                        }
                        ContentBlock::ImageUrl { url, detail } => {
                            let mut img = json!({ "url": url });
                            if let Some(d) = detail {
                                img["detail"] = Value::String(d.clone());
                            }
                            parts.push(json!({ "type": "image_url", "image_url": img }));
                        }
                        ContentBlock::FileUri { uri, media_type, .. } => {
                            parts.push(json!({
                                "type": "text",
                                "text": format!("[file {media_type}: {uri}]")
                            }));
                        }
                        _ => {}
                    }
                }
                json!({ "role": "user", "content": parts })
            }
        }
        "tool" => json!({
            "role": "tool",
            "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
            "content": m.content
        }),
        "assistant" => {
            let mut obj = serde_json::Map::new();
            obj.insert("role".into(), Value::String("assistant".into()));
            if m.content.is_empty() && !m.tool_calls.is_empty() {
                obj.insert("content".into(), Value::Null);
            } else {
                obj.insert("content".into(), Value::String(m.content.clone()));
            }
            let same_model_untainted = m.can_replay_cryptographic_proof(target_provider, target_model);
            if include_reasoning_echo
                && same_model_untainted
                && m.turn_index >= active_prompt_start_turn
                && !m.tool_calls.is_empty()
            {
                if let Some(ref r) = m.reasoning {
                    if !r.is_empty() {
                        let capped: String =
                            r.chars().take(MAX_INTERLEAVED_REASONING_CHARS).collect();
                        obj.insert("reasoning_content".into(), Value::String(capped));
                    }
                }
            }
            if !m.tool_calls.is_empty() {
                let sig_opt = if is_gemini
                    && same_model_untainted
                    && m.turn_index >= active_prompt_start_turn
                {
                    m.reasoning_signature.as_deref().filter(|s| !s.is_empty())
                } else {
                    None
                };
                let tcs: Vec<Value> = m
                    .tool_calls
                    .iter()
                    .enumerate()
                    .map(|(idx, tc)| {
                        let mut item = json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": if tc.arguments.trim().is_empty() { "{}".to_string() } else { tc.arguments.clone() }
                            }
                        });
                        if idx == 0 {
                            if let Some(sig) = sig_opt {
                                item["extra_content"] = json!({
                                    "google": { "thought_signature": sig }
                                });
                            }
                        }
                        item
                    })
                    .collect();
                obj.insert("tool_calls".into(), Value::Array(tcs));
            }
            Value::Object(obj)
        }
        other => json!({ "role": other, "content": m.content }),
    }
}

/// Accumulate OpenAI-compatible SSE `delta.tool_calls` into a sparse `BTreeMap<usize, ToolCallRecord>`.
fn accumulate_openai_tool_deltas(deltas: &[Value], accum: &mut BTreeMap<usize, ToolCallRecord>) {
    for d in deltas {
        let idx_opt = d.get("index").and_then(|v| v.as_u64()).map(|u| u as usize);
        let id_part = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name_part = d
            .pointer("/function/name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let args_part = d
            .pointer("/function/arguments")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if id_part.is_empty() && name_part.is_empty() && args_part.is_empty() {
            continue;
        }

        let target_key = if let Some(idx) = idx_opt {
            if let Some(existing) = accum.get(&idx) {
                if !id_part.is_empty() && !existing.id.is_empty() && existing.id != id_part {
                    if let Some((&k, _)) = accum.iter().find(|(_, tc)| tc.id == id_part) {
                        k
                    } else {
                        accum.keys().next_back().map(|k| k + 1).unwrap_or(idx + 1)
                    }
                } else {
                    idx
                }
            } else {
                idx
            }
        } else if !id_part.is_empty() {
            if let Some((&k, _)) = accum.iter().find(|(_, tc)| tc.id == id_part) {
                k
            } else {
                accum.keys().next_back().map(|k| k + 1).unwrap_or(0)
            }
        } else {
            accum.keys().next_back().copied().unwrap_or(0)
        };

        let entry = accum.entry(target_key).or_insert_with(|| ToolCallRecord {
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        if !id_part.is_empty() && entry.id.is_empty() {
            entry.id = id_part.to_string();
        }
        if !name_part.is_empty() {
            entry.name.push_str(name_part);
        }
        if !args_part.is_empty() {
            entry.arguments.push_str(args_part);
        }
    }
}

fn parse_openai_usage(u: &Value, dst: &mut TurnLlmUsage) {
    let prompt_tokens = u
        .get("prompt_tokens")
        .or_else(|| u.get("input_tokens"))
        .and_then(|v| v.as_u64());
    let completion_tokens = u
        .get("completion_tokens")
        .or_else(|| u.get("output_tokens"))
        .and_then(|v| v.as_u64());

    if prompt_tokens.is_none() && completion_tokens.is_none() {
        return;
    }

    dst.saw_usage = true;
    let pt = prompt_tokens.unwrap_or(0);
    let ct = completion_tokens.unwrap_or(0);

    let cache_read = u
        .pointer("/prompt_tokens_details/cached_tokens")
        .or_else(|| u.pointer("/input_tokens_details/cached_tokens"))
        .or_else(|| u.get("cache_read_input_tokens"))
        .or_else(|| u.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_write = u
        .get("cache_creation_input_tokens")
        .or_else(|| u.pointer("/prompt_tokens_details/cache_creation_tokens"))
        .or_else(|| u.pointer("/input_tokens_details/cache_creation_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let includes_cached_in_input =
        u.get("prompt_tokens").is_some() || u.get("input_tokens_details").is_some();
    let uncached = if includes_cached_in_input && cache_read <= pt {
        pt.saturating_sub(cache_read)
    } else {
        pt
    };

    dst.uncached_input = uncached;
    dst.cache_read = cache_read;
    dst.cache_write = cache_write;
    dst.output = ct;
    if let Some(rt) = u
        .pointer("/completion_tokens_details/reasoning_tokens")
        .or_else(|| u.pointer("/output_tokens_details/reasoning_tokens"))
        .or_else(|| u.get("reasoning_tokens"))
        .and_then(|v| v.as_u64())
    {
        dst.reasoning = Some(rt);
    }
}

/// Build Anthropic `/v1/messages` array with strict role alternation:
/// - Merges any consecutive `user` / `tool` (`role: "user"`) turns into one content array
///   so Anthropic never rejects with HTTP 400 (`roles must alternate`).
/// - Echoes verbatim `thinking`+`signature` AND `redacted_thinking` blocks within the active prompt.
/// Build Anthropic `/v1/messages` array with strict role alternation:
/// - Merges any consecutive `user` / `tool` (`role: "user"`) turns into one content array.
/// - Enforces cross-model cryptographic proof scoping and multimodal `ContentBlock` lowering.
fn build_anthropic_messages(
    messages: &[HarnessMessage],
    supports_reasoning_echo: bool,
    active_prompt_start_turn: u32,
) -> Vec<Value> {
    build_anthropic_messages_for_target(
        messages,
        supports_reasoning_echo,
        active_prompt_start_turn,
        "",
        "",
    )
}

fn build_anthropic_messages_for_target(
    messages: &[HarnessMessage],
    supports_reasoning_echo: bool,
    active_prompt_start_turn: u32,
    target_provider: &str,
    target_model: &str,
) -> Vec<Value> {
    let mut ant_msgs: Vec<Value> = Vec::new();
    let push_user_block = |out: &mut Vec<Value>, block: Value| {
        if let Some(last) = out.last_mut() {
            if last.get("role").and_then(|v| v.as_str()) == Some("user") {
                if let Some(prev_text) = last
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                {
                    last["content"] = json!([{ "type": "text", "text": prev_text }, block]);
                    return;
                }
                if let Some(arr) = last.get_mut("content").and_then(|v| v.as_array_mut()) {
                    arr.push(block);
                    return;
                }
            }
        }
        out.push(json!({ "role": "user", "content": [block] }));
    };

    for m in messages {
        match m.role.as_str() {
            "system" => {}
            "user" => {
                if m.content_blocks.is_empty() {
                    if let Some(last) = ant_msgs.last() {
                        if last.get("role").and_then(|v| v.as_str()) == Some("user") {
                            push_user_block(
                                &mut ant_msgs,
                                json!({ "type": "text", "text": m.content }),
                            );
                            continue;
                        }
                    }
                    ant_msgs.push(json!({
                        "role": "user",
                        "content": [{ "type": "text", "text": m.content }]
                    }));
                } else {
                    if !m.content.is_empty() {
                        push_user_block(
                            &mut ant_msgs,
                            json!({ "type": "text", "text": m.content }),
                        );
                    }
                    for blk in &m.content_blocks {
                        let rendered = match blk {
                            ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
                            ContentBlock::ImageBase64 {
                                media_type,
                                data_base64,
                                ..
                            } => json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data_base64
                                }
                            }),
                            ContentBlock::ImageUrl { url, .. } => json!({
                                "type": "image",
                                "source": { "type": "url", "url": url }
                            }),
                            ContentBlock::FileUri { uri, media_type, .. } => json!({
                                "type": "text",
                                "text": format!("[file {media_type}: {uri}]")
                            }),
                        };
                        push_user_block(&mut ant_msgs, rendered);
                    }
                }
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if supports_reasoning_echo
                    && m.turn_index >= active_prompt_start_turn
                    && m.can_replay_cryptographic_proof(target_provider, target_model)
                {
                    if let (Some(ref r), Some(ref sig)) = (&m.reasoning, &m.reasoning_signature) {
                        if !r.is_empty() && !sig.is_empty() {
                            blocks.push(json!({
                                "type": "thinking",
                                "thinking": r,
                                "signature": sig
                            }));
                        }
                    }
                    for red in &m.redacted_thinking {
                        if !red.is_empty() {
                            blocks.push(json!({
                                "type": "redacted_thinking",
                                "data": red
                            }));
                        }
                    }
                }
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for tc in &m.tool_calls {
                    let inp: Value =
                        serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": inp
                    }));
                }
                if !blocks.is_empty() {
                    ant_msgs.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            "tool" => {
                push_user_block(
                    &mut ant_msgs,
                    json!({
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": m.content
                    }),
                );
            }
            _ => {}
        }
    }
    ant_msgs
}

fn compute_pure_gen_duration_ms(
    t_req: Instant,
    turn_ttft_ms: Option<u64>,
    first_delta_at: Option<Instant>,
    last_delta_at: Option<Instant>,
    output_tokens: u64,
) -> u64 {
    let total_req_ms = t_req.elapsed().as_millis() as u64;
    let stream_span_ms = match (first_delta_at, last_delta_at) {
        (Some(a), Some(b)) => b.saturating_duration_since(a).as_millis() as u64,
        _ => 0,
    };
    let req_post_ttft = turn_ttft_ms
        .map(|t| total_req_ms.saturating_sub(t))
        .unwrap_or(total_req_ms);

    if output_tokens > 0 && stream_span_ms < 50 {
        req_post_ttft.max(stream_span_ms).max(50)
    } else if first_delta_at.is_some() {
        stream_span_ms.max(1)
    } else {
        0
    }
}

fn compute_attempt_budget(
    rem_run: Duration,
    per_attempt_deadline: Duration,
    attempt: u32,
    max_retries: u32,
) -> Duration {
    let mut budget = rem_run.min(per_attempt_deadline);
    // Reserve budget for Attempt 1+ on production runs (`>= 120s`) when retries are enabled so a
    // single hung Attempt 0 socket (`<= min(180s, 65% of remaining)`) never starves recovery.
    if attempt == 0
        && max_retries > 0
        && per_attempt_deadline >= Duration::from_secs(120)
        && rem_run >= Duration::from_secs(120)
    {
        let attempt0_cap = rem_run
            .mul_f64(0.65)
            .clamp(Duration::from_secs(90), Duration::from_secs(180));
        budget = budget.min(attempt0_cap);
    }
    budget
}

fn apply_anthropic_usage_fields(u: &Value, usage: &mut TurnLlmUsage) {
    usage.saw_usage = true;
    if let Some(n) = u.get("input_tokens").and_then(|v| v.as_u64()) {
        usage.uncached_input = n;
    }
    if let Some(n) = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
        usage.cache_read = n;
    }
    if let Some(n) = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()) {
        usage.cache_write = n;
    }
    if let Some(n) = u.get("output_tokens").and_then(|v| v.as_u64()) {
        usage.output = n;
    }
}

fn compute_eval_tps_metrics(
    output_tokens: u64,
    active_ms: u64,
    gen_dur_ms: u64,
    active_decode_ms: u64,
) -> (f64, f64, f64) {
    let e2e_tps = output_tokens as f64 / (active_ms.max(1) as f64 / 1000.0);
    let gen_tps = output_tokens as f64 / (gen_dur_ms.max(1) as f64 / 1000.0);
    // Keep `active_decode_tps` bounded by `gen_dur_ms` when `ACTIVE_DECODE_GAP_CAP_MS` (>5s pauses)
    // omits most of the physical generation window (`< 25%` of `gen_dur_ms`).
    let effective_active_ms =
        if active_decode_ms > 0 && active_decode_ms.saturating_mul(4) >= gen_dur_ms {
            active_decode_ms
        } else {
            gen_dur_ms
        };
    let active_decode_tps =
        output_tokens as f64 / (effective_active_ms.max(1) as f64 / 1000.0);
    (e2e_tps, gen_tps, active_decode_tps)
}

/// Execute a full headless `--eval-omni` run and produce the canonical `SuperEvalReport`.
pub async fn run_super_eval(opts: SuperEvalOptions) -> Result<SuperEvalReport> {
    let start_all = Instant::now();
    let clean_cwd = sanitize_windows_path(&opts.cwd);
    if !clean_cwd.exists() {
        bail!(
            "workspace directory does not exist: {}",
            clean_cwd.display()
        );
    }

    let endpoint = resolve_model_endpoint(
        &opts.model,
        opts.config_dir.as_deref(),
        opts.api_base.as_deref(),
        opts.api_key.as_deref(),
    )?;

    let graph_index = Arc::new(Mutex::new(WorkspaceGraphIndex::with_options(
        &clean_cwd,
        opts.permission_rules.clone(),
        opts.db.clone(),
    )));
    if opts.plugins.is_enabled("merkle_index") {
        let _ = graph_index.lock().unwrap().refresh();
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let session_key = format!("eval-{}", uuid::Uuid::new_v4());
    let mut engine = NativeSuperEngine::new(
        session_key,
        clean_cwd.clone(),
        endpoint.clone(),
        opts.thinking_level.clone(),
        opts.approval_mode,
        opts.workspace_trusted,
        opts.permission_rules,
        opts.plugins,
        Arc::clone(&graph_index),
        opts.db,
        None,
        cancel_flag,
        opts.trajectory_path,
    )?;
    engine.wire_api_mode = opts.wire_api;

    let startup_ms = start_all.elapsed().as_millis() as u64;

    // Live process-tree RSS peak sampler (250ms)
    let my_pid = std::process::id();
    let peak_rss = Arc::new(AtomicU64::new(process_tree_rss_bytes(my_pid)));
    let peak_bg = Arc::clone(&peak_rss);
    let done_flag = Arc::new(AtomicBool::new(false));
    let done_bg = Arc::clone(&done_flag);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        while !done_bg.load(Ordering::Relaxed) {
            tick.tick().await;
            peak_bg.fetch_max(process_tree_rss_bytes(my_pid), Ordering::Relaxed);
        }
    });

    let summary = engine
        .run_prompt(
            &opts.prompt,
            opts.max_turns,
            opts.timeout_secs,
            opts.event_sink,
        )
        .await?;
    done_flag.store(true, Ordering::Relaxed);

    let elapsed_ms = start_all.elapsed().as_millis() as u64;
    let active_ms = elapsed_ms.saturating_sub(startup_ms).max(1);
    let snap = summary.cache_stats;
    let total_tokens = snap.uncached_input_tokens
        + snap.cache_read_tokens
        + snap.cache_write_tokens
        + snap.output_tokens;
    let gen_dur_ms = if summary.gen_duration_ms > 0 {
        summary.gen_duration_ms
    } else {
        active_ms
    };
    let (e2e_tps, gen_tps, active_decode_tps) = compute_eval_tps_metrics(
        snap.output_tokens,
        active_ms,
        gen_dur_ms,
        summary.active_decode_ms,
    );

    let (merkle_root, merkle_refresh_ms, merkle_file_count, graph_symbol_count) = {
        let g = graph_index.lock().unwrap();
        (
            g.merkle().root_hash().to_string(),
            g.merkle().last_refresh_ms(),
            g.merkle().files().len(),
            g.symbol_count(),
        )
    };

    let wire_dialect = engine.active_wire_dialect().to_string();
    Ok(SuperEvalReport {
        harness: "omnia".into(),
        backend: "omnia-agent".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        provider: endpoint.provider_id,
        model: endpoint.model_id,
        cwd: clean_cwd.to_string_lossy().into_owned(),
        status: summary.status.clone(),
        success: summary.status == "completed" && !summary.final_text.trim().is_empty(),
        final_text: summary.final_text,
        elapsed_ms,
        ttft_ms: summary.ttft_ms,
        llm_ttft_ms: summary.llm_ttft_ms,
        gen_duration_ms: gen_dur_ms,
        startup_ms,
        tool_calls: engine.total_tool_calls,
        tool_errors: engine.total_tool_errors,
        tool_histogram: engine.tool_histogram,
        turns: summary.turns,
        input_tokens: snap.uncached_input_tokens,
        uncached_input_tokens: snap.uncached_input_tokens,
        output_tokens: snap.output_tokens,
        reasoning_tokens: if summary.saw_any_reasoning_tokens {
            Some(snap.reasoning_tokens)
        } else {
            None
        },
        cache_read_tokens: snap.cache_read_tokens,
        cache_write_tokens: snap.cache_write_tokens,
        total_tokens,
        token_telemetry_complete: summary.saw_any_usage && total_tokens > 0,
        cost_usd: engine.total_cost_usd,
        tokens_per_second: (e2e_tps * 100.0).round() / 100.0,
        gen_tokens_per_second: (gen_tps * 100.0).round() / 100.0,
        peak_rss_bytes: peak_rss.load(Ordering::Relaxed),
        recovery_attempts: summary.recovery_attempts,
        recovery_succeeded: summary.recovery_succeeded,
        host_tool_calls: engine.total_host_tool_calls,
        protocol_version: 2,
        merkle_root,
        merkle_refresh_ms,
        merkle_file_count,
        graph_symbol_count,
        prefix_stable: snap.prefix_stable,
        prefix_cache_hit_pct: snap.cache_hit_pct,
        lakeview_compressions: snap.lakeview_compressions,
        lakeview_chars_saved: snap.lakeview_chars_saved,
        loop_nudges: snap.loop_nudges,
        http_retries: engine.total_http_retries,
        active_decode_ms: summary.active_decode_ms,
        active_decode_tps: (active_decode_tps * 100.0).round() / 100.0,
        e2e_tps: (e2e_tps * 100.0).round() / 100.0,
        wire_dialect,
        truncated_stream_retries: summary.truncated_stream_retries,
        stall_retries: summary.stall_retries,
        verify_gate_nudges: summary.verify_gate_nudges,
        narration_nudges: summary.narration_nudges,
        interleaved_reasoning_turns: summary.interleaved_reasoning_turns,
        sap_repairs: engine.total_sap_repairs,
        oscillation_nudges: engine.total_oscillation_nudges,
        hedge_wins: engine.total_hedge_wins,
        error: summary.error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::PermissionsEngine;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn make_test_engine(tmp: &Path, base_url: String) -> NativeSuperEngine {
        let ep = ResolvedModelEndpoint {
            provider_id: "mock".into(),
            model_id: "mock-model".into(),
            base_url,
            api_key: "test-key".into(),
            api: "openai-completions".into(),
            auth_header: true,
            context_window: 128_000,
            max_tokens: 4096,
            cost_input_per_m: 0.0,
            cost_output_per_m: 0.0,
            cost_cache_read_per_m: 0.0,
            cost_cache_write_per_m: 0.0,
        };
        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(tmp)));
        let _ = graph.lock().unwrap().refresh();
        let mut eng = NativeSuperEngine::new(
            "test-sess".into(),
            tmp.to_path_buf(),
            ep,
            None,
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            PluginRegistry::with_default_pillars(),
            graph,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .unwrap();
        eng.stream_budget = StreamBudgetConfig {
            header_timeout: Duration::from_millis(220),
            heavy_header_timeout: Duration::from_millis(300),
            first_delta_timeout: Duration::from_millis(220),
            heavy_first_delta_timeout: Duration::from_millis(300),
            inter_chunk_timeout: Duration::from_millis(180),
            per_attempt_deadline: Duration::from_secs(10),
            pre_ttft_hedge_delay: Duration::from_millis(500),
            enable_pre_ttft_hedge: false,
            max_retries_per_turn: 3,
            retry_base_backoff_ms: 20,
        };
        eng.final_review_gate = false;
        eng.wire_api_mode = WireApiMode::Chat;
        eng
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let mut header_end = None;
        let mut content_len = 0usize;
        loop {
            let n = stream.read(&mut tmp).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if header_end.is_none() {
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = Some(pos + 4);
                    let hdrs = String::from_utf8_lossy(&buf[..pos]);
                    for line in hdrs.lines() {
                        if let Some((k, v)) = line.split_once(':') {
                            if k.trim().eq_ignore_ascii_case("content-length") {
                                content_len = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                }
            }
            if let Some(he) = header_end {
                if buf.len() >= he + content_len {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[test]
    fn parses_openai_usage_without_double_counting_cache_tokens() {
        let mut u = TurnLlmUsage::default();
        parse_openai_usage(
            &json!({
                "prompt_tokens": 5000,
                "completion_tokens": 420,
                "prompt_tokens_details": { "cached_tokens": 4200 },
                "completion_tokens_details": { "reasoning_tokens": 180 }
            }),
            &mut u,
        );
        assert!(u.saw_usage);
        assert_eq!(u.uncached_input, 800);
        assert_eq!(u.cache_read, 4200);
        assert_eq!(u.output, 420);
        assert_eq!(u.reasoning, Some(180));
        assert_eq!(u.uncached_input + u.cache_read + u.cache_write, 5000);
    }

    #[test]
    fn accumulates_streamed_openai_tool_call_deltas_cleanly_including_sparse_claude_indices() {
        let mut accum = BTreeMap::new();
        accumulate_openai_tool_deltas(
            &[json!({
                "index": 2,
                "id": "toolu_abc",
                "function": { "name": "workspace_map", "arguments": "{" }
            })],
            &mut accum,
        );
        accumulate_openai_tool_deltas(
            &[json!({
                "index": 2,
                "function": { "arguments": "\"max_files\":20}" }
            })],
            &mut accum,
        );
        accumulate_openai_tool_deltas(
            &[json!({
                "index": 4,
                "id": "toolu_def",
                "function": { "name": "read_file", "arguments": "{\"path\":\"app.py\"}" }
            })],
            &mut accum,
        );
        let tools: Vec<ToolCallRecord> = accum
            .into_values()
            .filter(|tc| !tc.name.trim().is_empty())
            .collect();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].id, "toolu_abc");
        assert_eq!(tools[0].name, "workspace_map");
        assert_eq!(tools[0].arguments, "{\"max_files\":20}");
        assert_eq!(tools[1].id, "toolu_def");
        assert_eq!(tools[1].name, "read_file");
    }

    #[tokio::test]
    async fn retries_truncated_sse_eof_without_finish_reason() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            // Request 1: emits partial preamble text then drops TCP socket with NO finish_reason and NO [DONE]
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let trunc = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"I'll inspect the file...\"},\"finish_reason\":null}]}\n\n";
            let _ = s1.write_all(trunc.as_bytes()).await;
            let _ = s1.shutdown().await;
            drop(s1);

            // Request 2: clean completion with finish_reason="stop" + [DONE]
            let (mut s2, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"ALL_FIXED_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":12}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_trunc_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));

        let sum = eng.run_prompt("say hello", 4, 10, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "ALL_FIXED_OK");
        assert_eq!(sum.truncated_stream_retries, 1);
        assert_eq!(eng.total_http_retries, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn retries_stalled_sse_chunk_and_header_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen_headers = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_bg = Arc::clone(&seen_headers);

        let srv = tokio::spawn(async move {
            // Request 1: stalls before sending HTTP headers (> 220ms header_timeout)
            let (mut s1, _) = listener.accept().await.unwrap();
            let sb1 = Arc::clone(&seen_bg);
            tokio::spawn(async move {
                let req1 = read_http_request(&mut s1).await;
                sb1.lock().unwrap().push(req1);
                tokio::time::sleep(Duration::from_millis(600)).await;
                drop(s1);
            });

            // Request 2: sends HTTP 200 + 1 chunk, then stalls mid-stream (> 180ms inter_chunk_timeout)
            let (mut s2, _) = listener.accept().await.unwrap();
            let sb2 = Arc::clone(&seen_bg);
            tokio::spawn(async move {
                let req2 = read_http_request(&mut s2).await;
                sb2.lock().unwrap().push(req2);
                let partial = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"half\"},\"finish_reason\":null}]}\n\n";
                let _ = s2.write_all(partial.as_bytes()).await;
                tokio::time::sleep(Duration::from_millis(600)).await;
                drop(s2);
            });

            // Request 3: succeeds immediately
            let (mut s3, _) = listener.accept().await.unwrap();
            let req3 = read_http_request(&mut s3).await;
            seen_bg.lock().unwrap().push(req3);
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"RECOVERED_AFTER_STALLS\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":20}}\n\n\
data: [DONE]\n\n";
            let _ = s3.write_all(ok.as_bytes()).await;
            let _ = s3.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_stall_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));

        let sum = eng.run_prompt("check stalls", 4, 15, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "RECOVERED_AFTER_STALLS");
        assert_eq!(sum.stall_retries, 2);
        let hdrs = seen_headers.lock().unwrap();
        assert_eq!(hdrs.len(), 3);
        assert!(
            hdrs[1].to_ascii_lowercase().contains("connection: close"),
            "retry attempt 1 must attach Connection: close header: {}",
            hdrs[1]
        );
        assert!(
            hdrs[2].to_ascii_lowercase().contains("connection: close"),
            "retry attempt 2 must attach Connection: close header: {}",
            hdrs[2]
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn preserves_interleaved_reasoning_content_within_tool_loop_and_clears_across_user_turns() {
        let tc = vec![ToolCallRecord {
            id: "c1".into(),
            name: "read_file".into(),
            arguments: "{\"path\":\"a.py\"}".into(),
        }];
        let old_prompt_asst =
            HarnessMessage::assistant("", Some("OLD_PROMPT_THOUGHT".into()), tc.clone(), 1);
        let active_prompt_asst =
            HarnessMessage::assistant("", Some("ACTIVE_TOOL_LOOP_THOUGHT".into()), tc, 4);
        let active_final_no_tools =
            HarnessMessage::assistant("Done", Some("FINAL_THOUGHT".into()), Vec::new(), 5);

        // Prompt #2 starts at turn 4
        let wire_old = message_to_openai_json(&old_prompt_asst, 4, true, false);
        assert!(
            wire_old.get("reasoning_content").is_none(),
            "prior user prompt reasoning_content must be omitted"
        );

        let wire_active = message_to_openai_json(&active_prompt_asst, 4, true, false);
        assert_eq!(
            wire_active
                .get("reasoning_content")
                .and_then(|v| v.as_str()),
            Some("ACTIVE_TOOL_LOOP_THOUGHT"),
            "intra-prompt tool loop assistant turn MUST preserve reasoning_content"
        );

        let wire_disabled = message_to_openai_json(&active_prompt_asst, 4, false, false);
        assert!(wire_disabled.get("reasoning_content").is_none());

        let wire_no_tools = message_to_openai_json(&active_final_no_tools, 4, true, false);
        assert!(wire_no_tools.get("reasoning_content").is_none());
    }

    #[tokio::test]
    async fn runtime_self_verify_gate_and_narration_guard_intercept_premature_stop() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            let responses = [
                // Turn 1: Narration-only premature stop (`tool_calls=[]`) -> intercepted by Narration Guard!
                "data: {\"choices\":[{\"delta\":{\"content\":\"I'll read and fix app.py now:\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10}}\n\ndata: [DONE]\n\n",
                // Turn 2: Writes app.py
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_w1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"app.py\\\",\\\"content\\\":\\\"print(42)\\\\n\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":20}}\n\ndata: [DONE]\n\n",
                // Turn 3: Tries to exit WITHOUT verifying via shell -> intercepted by Runtime Self-Verify Gate!
                "data: {\"choices\":[{\"delta\":{\"content\":\"I updated app.py and everything looks great!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":180,\"completion_tokens\":12}}\n\ndata: [DONE]\n\n",
                // Turn 4: Runs verification shell command
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_sh1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo VERIFY_OK\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":220,\"completion_tokens\":15}}\n\ndata: [DONE]\n\n",
                // Turn 5: Concludes cleanly after exit_code == 0!
                "data: {\"choices\":[{\"delta\":{\"content\":\"Verified app.py (exit_code=0).\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":260,\"completion_tokens\":14}}\n\ndata: [DONE]\n\n",
            ];
            for body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let _ = read_http_request(&mut sock).await;
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_gates_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng.stream_budget.inter_chunk_timeout = Duration::from_secs(5);

        let sum = eng
            .run_prompt("Create app.py and verify", 8, 60, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(
            sum.narration_nudges, 1,
            "narration guard must intercept Turn 1"
        );
        assert_eq!(
            sum.verify_gate_nudges, 1,
            "self-verify gate must intercept Turn 3"
        );
        assert_eq!(sum.turns, 5);
        assert!(sum.final_text.contains("Verified app.py"));
        assert_eq!(
            std::fs::read_to_string(tmp.join("app.py")).unwrap(),
            "print(42)\n"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn mixed_batch_runs_read_prefix_in_parallel_before_mutating_barrier() {
        let mk = |name: &str| {
            (
                ToolCallRecord {
                    id: format!("id_{name}"),
                    name: name.into(),
                    arguments: "{}".into(),
                },
                Ok(json!({})),
            )
        };
        let calls = vec![
            mk("read_file"),
            mk("search_code"),
            mk("edit_file"),
            mk("read_file"),
            mk("workspace_map"),
            mk("shell"),
        ];
        let batches = partition_tool_batches(&calls);
        assert_eq!(
            batches,
            vec![
                ToolDispatchBatch::ParallelRead(0..2),
                ToolDispatchBatch::Sequential(2),
                ToolDispatchBatch::ParallelRead(3..5),
                ToolDispatchBatch::Sequential(5),
            ]
        );
    }

    #[tokio::test]
    async fn anti_termination_lag_nudge_triggers_after_two_redundant_post_pass_turns() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured_reqs = Arc::new(Mutex::new(Vec::<String>::new()));
        let cap_bg = Arc::clone(&captured_reqs);

        let srv = tokio::spawn(async move {
            let responses = [
                // Turn 1: writes app.py
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"app.py\\\",\\\"content\\\":\\\"x = 1\\\\n\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":15}}\n\ndata: [DONE]\n\n",
                // Turn 2: runs passing shell verification
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c2\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo OK\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":15}}\n\ndata: [DONE]\n\n",
                // Turn 3: redundant post-pass read #1
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c3\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"app.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":180,\"completion_tokens\":12}}\n\ndata: [DONE]\n\n",
                // Turn 4: redundant post-pass read #2 -> must trigger [Convergence Hint]!
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c4\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"app.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":220,\"completion_tokens\":12}}\n\ndata: [DONE]\n\n",
                // Turn 5: finishes cleanly
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done after convergence hint.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":260,\"completion_tokens\":10}}\n\ndata: [DONE]\n\n",
            ];
            for body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                cap_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_conv_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng.stream_budget.inter_chunk_timeout = Duration::from_secs(5);

        let sum = eng
            .run_prompt("write app.py and verify", 8, 60, None)
            .await
            .unwrap();
        srv.await.unwrap();
        assert_eq!(sum.status, "completed");

        let reqs = captured_reqs.lock().unwrap();
        assert_eq!(reqs.len(), 5);
        assert!(
            reqs[4].contains("[Convergence Hint]"),
            "Turn 5 prompt MUST include Anti-Termination-Lag [Convergence Hint] after 2 redundant post-pass turns!"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn speculative_read_starts_before_sse_done_and_never_runs_after_mutating_tool() {
        let tmp = std::env::temp_dir().join(format!("omni_eng_spec_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "alpha = 1\n").unwrap();
        std::fs::write(tmp.join("b.py"), "beta = 2\n").unwrap();

        let eng = make_test_engine(&tmp, "http://127.0.0.1:1/v1".into());

        // 1. Admissibility check: read_file before mutating write_file IS speculated,
        //    whereas read_file AFTER mutating write_file is NEVER speculated!
        let mut pool = SpeculativeTaskPool::new();
        let tc_read1 = ToolCallRecord {
            id: "c0".into(),
            name: "read_file".into(),
            arguments: r#"{"path":"a.py"}"#.into(),
        };
        let tc_write = ToolCallRecord {
            id: "c1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"b.py","content":"beta = 99\n"}"#.into(),
        };
        let tc_read2 = ToolCallRecord {
            id: "c2".into(),
            name: "read_file".into(),
            arguments: r#"{"path":"b.py"}"#.into(),
        };

        pool.try_spawn_if_admissible(0, &tc_read1, &eng.tool_runtime, false);
        assert!(
            pool.handles.contains_key(&0),
            "pure read before barrier must be spawned speculatively"
        );
        pool.try_spawn_if_admissible(1, &tc_write, &eng.tool_runtime, false);
        assert!(pool.saw_mutating);
        assert!(
            !pool.handles.contains_key(&1),
            "mutating tool must NEVER be speculated"
        );
        pool.try_spawn_if_admissible(2, &tc_read2, &eng.tool_runtime, false);
        assert!(
            !pool.handles.contains_key(&2),
            "read AFTER mutating tool must NEVER be speculated"
        );

        let mut taken = pool.take_all();
        let entry0 = taken.remove(&0).unwrap();
        assert_eq!(entry0.spawned_args, tc_read1.arguments);
        let out0 = entry0.handle.await.unwrap();
        assert!(!out0.is_error);
        assert!(out0.content.contains("alpha = 1"));

        // 2. End-to-end truncated stream aborts speculative handles cleanly and succeeds on retry
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            // Req 1: sends read_file(a.py) index=0 + starts index=1, then truncates TCP!
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let chunk1 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"r0\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.py\\\"}\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"r1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"b\"}}]},\"finish_reason\":null}]}\n\n";
            let _ = s1.write_all(chunk1.as_bytes()).await;
            let _ = s1.shutdown().await;
            drop(s1);

            // Req 2: clean 2-file read batch completing with [DONE]
            let (mut s2, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let chunk2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"r0\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.py\\\"}\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"r1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"b.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(chunk2.as_bytes()).await;
            let _ = s2.shutdown().await;

            // Req 3: final answer
            let (mut s3, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s3).await;
            let chunk3 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"SPECULATIVE_READS_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":150,\"completion_tokens\":10}}\n\n\
data: [DONE]\n\n";
            let _ = s3.write_all(chunk3.as_bytes()).await;
            let _ = s3.shutdown().await;
        });

        let mut eng2 = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng2.stream_budget.header_timeout = Duration::from_secs(5);
        eng2.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng2.stream_budget.inter_chunk_timeout = Duration::from_secs(5);
        let sum = eng2
            .run_prompt("read both files", 5, 30, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "SPECULATIVE_READS_OK");
        assert_eq!(sum.truncated_stream_retries, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn narration_guard_catches_claude_curly_apostrophe_stops_and_allows_real_completions() {
        // Real Claude curly right single quote (`\u{2019}`) premature narration stops
        for sample in [
            "I\u{2019}ll now read the schema and catalog tool files.",
            "I\u{2019}ll read the remaining test files to check edge cases.",
            "I\u{2019}m reading `pkg/pricing.py` to locate the root cause.",
            "I\u{2019}ll use forward dynamic programming with monotone queue optimization.",
            "Next I\u{2019}ll implement the parser fix and run pytest.",
            "I\u{2019}m going to inspect the directory layout.",
        ] {
            assert!(
                is_narration_only_stop(sample),
                "MUST detect curly-apostrophe narration stop: {sample}"
            );
        }

        // Genuine final completion summaries must NOT trigger false nudges
        for done in [
            "Fixed all 6 cascading defects in quantlib_mini and verified `unittest discover` (12 tests passed).",
            "Done. `reconciliation.json` has been written and submitted successfully.",
            "All checks pass with zero warnings.",
        ] {
            assert!(
                !is_narration_only_stop(done),
                "MUST NOT false-positive on genuine completion summary: {done}"
            );
        }
    }

    #[tokio::test]
    async fn speculative_pool_ignores_empty_interleaved_headers_and_rejects_stale_args() {
        let tmp =
            std::env::temp_dir().join(format!("omni_eng_spec_interleave_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "alpha_val = 42\n").unwrap();
        std::fs::write(tmp.join("b.py"), "beta_val = 99\n").unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured_tool_msgs = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let captured_clone = captured_tool_msgs.clone();

        let srv = tokio::spawn(async move {
            // Req 1: interleaved SSE — sends headers with empty args for index 0 and index 1 FIRST,
            // THEN streams the real JSON arguments for index 0 and index 1!
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let sse1 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"r0\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"r1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"a.py\\\"}\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"b.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20}}\n\n\
data: [DONE]\n\n";
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Req 2: inspect tool results returned by harness and complete
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            captured_clone.lock().unwrap().push(req2);
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"INTERLEAVED_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":160,\"completion_tokens\":10}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng.stream_budget.inter_chunk_timeout = Duration::from_secs(5);
        let sum = eng
            .run_prompt("read both files", 5, 30, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(
            eng.total_tool_errors, 0,
            "interleaved headers MUST NOT produce stale empty-arg errors"
        );
        let req2 = &captured_tool_msgs.lock().unwrap()[0];
        assert!(
            req2.contains("alpha_val = 42"),
            "req2 missing a.py content: {req2}"
        );
        assert!(
            req2.contains("beta_val = 99"),
            "req2 missing b.py content: {req2}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn http_400_generic_unknown_field_degrades_prompt_cache_key_cleanly() {
        let tmp =
            std::env::temp_dir().join(format!("omni_eng_400_compat_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            // Req 1: strict proxy rejects prompt_cache_key with generic wording (does NOT echo field name!)
            let (mut s1, _) = listener.accept().await.unwrap();
            let req1 = read_http_request(&mut s1).await;
            assert!(req1.contains("prompt_cache_key"));
            let resp1 = "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"Unrecognized extra request argument\"}}";
            let _ = s1.write_all(resp1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Req 2: prompt_cache_key stripped -> succeeds!
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            assert!(
                !req2.contains("prompt_cache_key"),
                "prompt_cache_key must be stripped after generic 400 fallback: {req2}"
            );
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"STRICT_PROXY_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":8}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("say ok", 4, 30, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "STRICT_PROXY_OK");
        assert!(!eng.supports_prompt_cache_key);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn sse_keepalive_ping_stall_triggers_token_progress_watchdog_and_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            // Request 1: sends 1 initial delta, then emits `: ping\n\n` keepalives every 35ms
            // for 500ms (> 180ms inter_chunk_timeout!). v0.3 hung forever; v4 MUST fire ChunkStall!
            let (mut s1, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = read_http_request(&mut s1).await;
                let init = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"start\"},\"finish_reason\":null}]}\n\n";
                let _ = s1.write_all(init.as_bytes()).await;
                for _ in 0..16 {
                    tokio::time::sleep(Duration::from_millis(35)).await;
                    if s1.write_all(b": ping\n\n").await.is_err() {
                        break;
                    }
                }
                drop(s1);
            });

            // Request 2: fresh socket retry succeeds immediately!
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            assert!(
                req2.to_ascii_lowercase().contains("connection: close"),
                "ping-stall retry MUST open a fresh socket with Connection: close"
            );
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"PING_STALL_RECOVERED\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":12}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_ping_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.stream_budget.header_timeout = Duration::from_secs(2);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(2);
        eng.stream_budget.inter_chunk_timeout = Duration::from_millis(160);

        let sum = eng
            .run_prompt("check ping watchdog", 4, 15, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "PING_STALL_RECOVERED");
        assert_eq!(
            sum.stall_retries, 1,
            "keepalive ping stall must trigger exactly 1 stall retry"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn anthropic_messages_404_auto_falls_back_to_openai_chat_completions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen_paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_bg = Arc::clone(&seen_paths);

        let srv = tokio::spawn(async move {
            // Req 1: POST /v1/messages -> 404 Not Found
            let (mut s1, _) = listener.accept().await.unwrap();
            let req1 = read_http_request(&mut s1).await;
            seen_bg
                .lock()
                .unwrap()
                .push(req1.lines().next().unwrap_or("").to_string());
            let r404 = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"not found\"}";
            let _ = s1.write_all(r404.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Req 2: Automatic fallback to POST /v1/chat/completions -> 200 OK
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            seen_bg
                .lock()
                .unwrap()
                .push(req2.lines().next().unwrap_or("").to_string());
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"FALLBACK_CHAT_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":90,\"completion_tokens\":8}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_ant404_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("say hi", 4, 20, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "FALLBACK_CHAT_OK");
        assert!(eng.anthropic_fallback_to_openai);
        let paths = seen_paths.lock().unwrap();
        assert_eq!(paths.len(), 2);
        assert!(
            paths[0].contains("POST /v1/messages"),
            "first try must be /v1/messages: {}",
            paths[0]
        );
        assert!(
            paths[1].contains("POST /v1/chat/completions"),
            "fallback must be /v1/chat/completions: {}",
            paths[1]
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn anthropic_messages_native_wire_sends_cache_control_and_captures_signature() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap_bg = Arc::clone(&captured);

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let req = read_http_request(&mut s1).await;
            *cap_bg.lock().unwrap() = req;
            let sse = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":120,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":100}}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"checking invariants\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_ant_verbatim_01\"}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"ANTHROPIC_NATIVE_OK\"}}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":22}}\n\n\
data: {\"type\":\"message_stop\"}\n\n";
            let _ = s1.write_all(sse.as_bytes()).await;
            let _ = s1.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_ant_ok_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        eng.wire_api_mode = WireApiMode::Messages;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng
            .run_prompt("check native anthropic", 4, 20, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "ANTHROPIC_NATIVE_OK");
        let raw_req = captured.lock().unwrap().clone();
        assert!(raw_req.contains("POST /v1/messages"));
        assert!(raw_req.contains("\"cache_control\":{\"type\":\"ephemeral\"}"));
        assert!(
            !raw_req.contains("\"temperature\""),
            "Anthropic native requests must NOT send temperature override"
        );
        let last_asst = eng
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "assistant")
            .unwrap();
        assert_eq!(
            last_asst.reasoning_signature.as_deref(),
            Some("sig_ant_verbatim_01")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn openai_responses_api_wire_streams_text_and_function_call_deltas() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            // Turn 1: emits a function_call item over /v1/responses
            let (mut s1, _) = listener.accept().await.unwrap();
            let req1 = read_http_request(&mut s1).await;
            assert!(
                req1.contains("POST /v1/responses"),
                "expected /v1/responses: {req1}"
            );
            let sse1 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_resp_1\",\"name\":\"read_file\"}}\n\n\
data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\\\"hello.py\\\"}\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":200,\"output_tokens\":18,\"input_tokens_details\":{\"cached_tokens\":150}}}}\n\n";
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Turn 2: emits final text after receiving function_call_output
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            assert!(req2.contains("function_call_output"));
            assert!(req2.contains("ANSWER_42"));
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"RESPONSES_API_OK\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":260,\"output_tokens\":10}}}\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_resp_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("hello.py"), "VALUE = 'ANSWER_42'\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.wire_api_mode = WireApiMode::Responses;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("read hello.py", 4, 20, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "RESPONSES_API_OK");
        assert_eq!(eng.total_tool_calls, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn gemini_thought_signature_roundtrip_and_adaptive_reasoning_effort() {
        // 1. Unit check: thought_signature extraction & verbatim echo on Gemini
        let sig1 = extract_thought_signature(&json!({ "thought_signature": "sig_gem_snake" }));
        assert_eq!(sig1.as_deref(), Some("sig_gem_snake"));
        let sig2 = extract_thought_signature(&json!({
            "extra_content": { "google": { "thought_signature": "sig_gem_nested" } }
        }));
        assert_eq!(sig2.as_deref(), Some("sig_gem_nested"));

        let mut msg = HarnessMessage::assistant(
            "",
            Some("long internal thought".into()),
            vec![ToolCallRecord {
                id: "tc_g1".into(),
                name: "read_file".into(),
                arguments: "{\"path\":\"a.py\"}".into(),
            }],
            2,
        );
        msg.reasoning_signature = Some("sig_gem_verbatim".into());
        let wire = message_to_openai_json(&msg, 2, false, true);
        assert!(
            wire.get("reasoning_content").is_none(),
            "Flash must omit redundant reasoning_content echo"
        );
        assert_eq!(
            wire.pointer("/tool_calls/0/extra_content/google/thought_signature")
                .and_then(|v| v.as_str()),
            Some("sig_gem_verbatim"),
            "Gemini must echo verbatim thought_signature on tool_calls[0].extra_content.google"
        );

        // 2. Live wire check: Gemini Flash sends default reasoning_effort="medium" + prompt_cache_key + X-Session-Id
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap_bg = Arc::clone(&captured);

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let req = read_http_request(&mut s1).await;
            *cap_bg.lock().unwrap() = req;
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"GEMINI_OK\",\"thought_signature\":\"sig_ret_99\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":8}}\n\n\
data: [DONE]\n\n";
            let _ = s1.write_all(ok.as_bytes()).await;
            let _ = s1.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_gem_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gemini-3.8-flash".into();
        eng.wire_api_mode = WireApiMode::Chat;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("say gemini ok", 4, 20, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        let raw_req = captured.lock().unwrap().clone();
        assert!(raw_req.contains("\"reasoning_effort\":\"medium\""));
        assert!(
            raw_req.contains("\"prompt_cache_key\""),
            "Gemini must receive session-stable prompt_cache_key"
        );
        assert!(raw_req.to_ascii_lowercase().contains("x-session-id:"));
        let last_asst = eng
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "assistant")
            .unwrap();
        assert_eq!(last_asst.reasoning_signature.as_deref(), Some("sig_ret_99"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn sap_partial_json_repair_recovers_malformed_sse_tool_call_without_retry_roundtrip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            // Turn 1: malformed tool-call JSON (trailing comma + unclosed brace!) -> SAP repairs in place!
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let sse1 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c_sap\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"sap.py\\\",\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":15}}\n\n\
data: [DONE]\n\n";
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Turn 2: verifies file content arrived cleanly with zero tool error
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            assert!(req2.contains("SAP_REPAIRED_CONTENT"));
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"SAP_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":150,\"completion_tokens\":6}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_sap_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("sap.py"), "MSG = 'SAP_REPAIRED_CONTENT'\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("read sap.py", 4, 20, None).await.unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "SAP_OK");
        assert_eq!(eng.total_tool_errors, 0);
        assert!(
            eng.total_sap_repairs >= 1,
            "SAP repair counter must increment"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn pre_ttft_hedge_wins_on_stalled_primary_and_never_hedges_post_ttft() {
        // Case A: Primary stalls pre-TTFT (> 100ms hedge delay) -> hedge fires and wins!
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = read_http_request(&mut s1).await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(s1);
            });
            let (mut s2, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"HEDGE_WINNER_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":8}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_hedge_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng.stream_budget.enable_pre_ttft_hedge = true;
        eng.stream_budget.pre_ttft_hedge_delay = Duration::from_millis(100);

        let sum = eng.run_prompt("hedge win test", 4, 15, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "HEDGE_WINNER_OK");
        assert_eq!(eng.total_hedge_wins, 1);

        // Case B: Primary emits first byte immediately (< 80ms), then takes 220ms (> hedge_delay)
        // to finish decoding -> ZERO hedge request must EVER fire post-TTFT!
        let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr2 = listener2.local_addr().unwrap();
        let req_count = Arc::new(AtomicU64::new(0));
        let rc_bg = Arc::clone(&req_count);
        let srv2 = tokio::spawn(async move {
            let (mut s1, _) = listener2.accept().await.unwrap();
            rc_bg.fetch_add(1, Ordering::Relaxed);
            let _ = read_http_request(&mut s1).await;
            let part1 =
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"FIRST_\"},\"finish_reason\":null}]}\n\n";
            let _ = s1.write_all(part1.as_bytes()).await;
            tokio::time::sleep(Duration::from_millis(220)).await;
            let part2 = "data: {\"choices\":[{\"delta\":{\"content\":\"SECOND\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":8}}\n\n\
data: [DONE]\n\n";
            let _ = s1.write_all(part2.as_bytes()).await;
            let _ = s1.shutdown().await;
        });

        let mut eng2 = make_test_engine(&tmp, format!("http://{addr2}/v1"));
        eng2.stream_budget.header_timeout = Duration::from_secs(5);
        eng2.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng2.stream_budget.inter_chunk_timeout = Duration::from_secs(5);
        eng2.stream_budget.enable_pre_ttft_hedge = true;
        eng2.stream_budget.pre_ttft_hedge_delay = Duration::from_millis(80);

        let sum2 = eng2
            .run_prompt("no post-ttft hedge", 4, 15, None)
            .await
            .unwrap();
        srv2.await.unwrap();
        assert_eq!(sum2.final_text, "FIRST_SECOND");
        assert_eq!(
            req_count.load(Ordering::Relaxed),
            1,
            "MUST NEVER fire a hedge post-TTFT"
        );
        assert_eq!(eng2.total_hedges_issued, 0);
        assert_eq!(eng2.total_hedge_wins, 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn anthropic_messages_merges_consecutive_user_turns_and_echoes_redacted_thinking() {
        let mut asst = HarnessMessage::assistant_with_signature(
            "",
            Some("visible thought".into()),
            Some("sig_123".into()),
            vec![ToolCallRecord {
                id: "tu_1".into(),
                name: "read_file".into(),
                arguments: "{\"path\":\"a.py\"}".into(),
            }],
            1,
        );
        asst.redacted_thinking
            .push("opaque_redacted_blob_xyz".into());

        let msgs = vec![
            HarnessMessage::system("SYS"),
            HarnessMessage::user("first user msg", 1),
            HarnessMessage::user("consecutive user nudge", 1),
            asst,
            HarnessMessage::tool_result("tu_1", "read_file", "content", 1),
            HarnessMessage::user("[Budget Notice] 1 turn left", 2),
        ];

        let ant = build_anthropic_messages(&msgs, true, 1);
        // Must strictly alternate: user -> assistant -> user (3 messages total, ZERO adjacent user roles!)
        assert_eq!(ant.len(), 3, "adjacent user/tool turns must merge: {ant:?}");
        assert_eq!(ant[0]["role"], "user");
        assert_eq!(ant[1]["role"], "assistant");
        assert_eq!(ant[2]["role"], "user");

        // Assistant message must contain thinking + redacted_thinking + tool_use
        let asst_blocks = ant[1]["content"].as_array().unwrap();
        assert!(asst_blocks
            .iter()
            .any(|b| b["type"] == "thinking" && b["signature"] == "sig_123"));
        assert!(asst_blocks
            .iter()
            .any(|b| b["type"] == "redacted_thinking" && b["data"] == "opaque_redacted_blob_xyz"));

        // Final merged user message must contain both tool_result AND trailing text block
        let tail_blocks = ant[2]["content"].as_array().unwrap();
        assert_eq!(tail_blocks.len(), 2);
        assert_eq!(tail_blocks[0]["type"], "tool_result");
        assert_eq!(tail_blocks[1]["type"], "text");
    }

    #[test]
    fn openai_responses_usage_parses_input_and_output_token_details_without_double_counting() {
        let mut u = TurnLlmUsage::default();
        parse_openai_usage(
            &json!({
                "input_tokens": 200,
                "output_tokens": 50,
                "input_tokens_details": { "cached_tokens": 150 },
                "output_tokens_details": { "reasoning_tokens": 35 }
            }),
            &mut u,
        );
        assert!(u.saw_usage);
        assert_eq!(u.cache_read, 150);
        assert_eq!(
            u.uncached_input, 50,
            "must subtract cached_tokens from Responses input_tokens"
        );
        assert_eq!(u.output, 50);
        assert_eq!(u.reasoning, Some(35));
    }

    #[tokio::test]
    async fn gemini_native_wire_uses_x_goog_api_key_header_never_url_query() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap_bg = Arc::clone(&captured);

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let req = read_http_request(&mut s1).await;
            *cap_bg.lock().unwrap() = req;
            let sse = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"GEMINI_HEADER_OK\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":50,\"candidatesTokenCount\":5}}\n\n";
            let _ = s1.write_all(sse.as_bytes()).await;
            let _ = s1.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_gem_hdr_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1beta"));
        eng.endpoint.model_id = "gemini-3.8-flash".into();
        eng.endpoint.api_key = "AIzaSyDummyHeaderSecret123456".into();
        eng.wire_api_mode = WireApiMode::Gemini;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng
            .run_prompt("check header auth", 4, 20, None)
            .await
            .unwrap();
        srv.await.unwrap();

        assert_eq!(sum.status, "completed");
        assert_eq!(sum.final_text, "GEMINI_HEADER_OK");
        let raw_req = captured.lock().unwrap().clone();
        let first_line = raw_req.lines().next().unwrap_or("");
        assert!(
            first_line.contains("?alt=sse"),
            "request line missing ?alt=sse: {first_line}"
        );
        assert!(
            !first_line.contains("key=")
                && !first_line.contains("AIzaSyDummyHeaderSecret123456"),
            "API key MUST NEVER appear in Gemini URL query: {first_line}"
        );
        assert!(
            raw_req
                .to_ascii_lowercase()
                .contains("x-goog-api-key: aizasydummyheadersecret123456")
                || raw_req.contains("x-goog-api-key: AIzaSyDummyHeaderSecret123456"),
            "Gemini native request must pass x-goog-api-key header: {raw_req}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn pre_ttft_hedge_survives_fast_hedge_502_and_streams_sink_deltas_when_hedge_wins() {
        let tmp = std::env::temp_dir().join(format!("omni_eng_hedge2_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();

        // Case A: Hedge gets an immediate 502 while primary is still healthy and finishes at 220ms ->
        // fast hedge error MUST NOT abort healthy primary!
        let listener_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_a = listener_a.local_addr().unwrap();
        let srv_a = tokio::spawn(async move {
            let (mut s1, _) = listener_a.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = read_http_request(&mut s1).await;
                tokio::time::sleep(Duration::from_millis(220)).await;
                let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"PRIMARY_SURVIVED_HEDGE_502\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":60,\"completion_tokens\":6}}\n\n\
data: [DONE]\n\n";
                let _ = s1.write_all(ok.as_bytes()).await;
                let _ = s1.shutdown().await;
            });
            let (mut s2, _) = listener_a.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let err502 = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nbad gateway";
            let _ = s2.write_all(err502.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let mut eng_a = make_test_engine(&tmp, format!("http://{addr_a}/v1"));
        eng_a.stream_budget.header_timeout = Duration::from_secs(5);
        eng_a.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng_a.stream_budget.enable_pre_ttft_hedge = true;
        eng_a.stream_budget.pre_ttft_hedge_delay = Duration::from_millis(80);
        eng_a.stream_budget.max_retries_per_turn = 0;

        let sum_a = eng_a
            .run_prompt("hedge 502 test", 4, 15, None)
            .await
            .unwrap();
        srv_a.await.unwrap();
        assert_eq!(sum_a.final_text, "PRIMARY_SURVIVED_HEDGE_502");
        assert_eq!(eng_a.total_hedge_wins, 0);

        // Case B: Hedge wins AND streams DeltaBatch events to `sink` (zero blackout)!
        let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_b = listener_b.local_addr().unwrap();
        let srv_b = tokio::spawn(async move {
            let (mut s1, _) = listener_b.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = read_http_request(&mut s1).await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(s1);
            });
            let (mut s2, _) = listener_b.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"HEDGE_STREAMED_TO_SINK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":60,\"completion_tokens\":6}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let streamed = Arc::new(Mutex::new(String::new()));
        let st_bg = Arc::clone(&streamed);
        let sink: HarnessEventSink = Arc::new(move |ev| {
            if let HarnessStreamEvent::DeltaBatch { text_delta, .. } = ev {
                st_bg.lock().unwrap().push_str(&text_delta);
            }
        });
        let mut eng_b = make_test_engine(&tmp, format!("http://{addr_b}/v1"));
        eng_b.stream_budget.header_timeout = Duration::from_secs(5);
        eng_b.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng_b.stream_budget.enable_pre_ttft_hedge = true;
        eng_b.stream_budget.pre_ttft_hedge_delay = Duration::from_millis(80);

        let sum_b = eng_b
            .run_prompt("hedge sink test", 4, 15, Some(sink))
            .await
            .unwrap();
        srv_b.await.unwrap();
        assert_eq!(sum_b.final_text, "HEDGE_STREAMED_TO_SINK");
        assert_eq!(eng_b.total_hedge_wins, 1);
        assert_eq!(
            streamed.lock().unwrap().as_str(),
            "HEDGE_STREAMED_TO_SINK",
            "winning hedge MUST emit DeltaBatch to sink without blackout"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn sap_repaired_tool_call_persists_valid_json_in_history_not_raw_wrapper() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let sse1 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c_hist\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"hist.py\\\",\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":10}}\n\n\
data: [DONE]\n\n";
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_http_request(&mut s2).await;
            assert!(
                !req2.contains("\"_raw\""),
                "repaired tool call MUST NOT be sent back in history wrapped in _raw: {req2}"
            );
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"SAP_HISTORY_CLEAN\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":5}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_saphist_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("hist.py"), "x = 1\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("read hist.py", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "SAP_HISTORY_CLEAN");
        let tool_asst = eng
            .messages
            .iter()
            .find(|m| m.role == "assistant" && !m.tool_calls.is_empty())
            .unwrap();
        assert_eq!(tool_asst.tool_calls[0].arguments, "{\"path\":\"hist.py\"}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn http_body_json(raw: &str) -> Value {
        let body = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        serde_json::from_str(body).unwrap_or(Value::Null)
    }

    fn strip_cache_control(v: &Value) -> Value {
        match v {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(k, _)| k.as_str() != "cache_control")
                    .map(|(k, val)| (k.clone(), strip_cache_control(val)))
                    .collect(),
            ),
            Value::Array(arr) => Value::Array(arr.iter().map(strip_cache_control).collect()),
            other => other.clone(),
        }
    }

    #[tokio::test]
    async fn every_retry_attempt_gets_fresh_budget_instead_of_shared_shrinking_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            // Attempt 1: burst-flush proxy sends NOTHING (no headers) for 1s -> pre-delta stall.
            let (mut s1, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = read_http_request(&mut s1).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
                drop(s1);
            });
            // Attempt 2: flushes after 300ms. A shared 600ms window would only have ~180ms left!
            let (mut s2, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"FRESH_ATTEMPT_BUDGET_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":5}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_fresh_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.stream_budget.header_timeout = Duration::from_millis(400);
        eng.stream_budget.first_delta_timeout = Duration::from_millis(400);
        eng.stream_budget.per_attempt_deadline = Duration::from_millis(600);

        let sum = eng.run_prompt("fresh budget", 4, 15, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.status, "completed", "error: {:?}", sum.error);
        assert_eq!(sum.final_text, "FRESH_ATTEMPT_BUDGET_OK");
        assert_eq!(sum.stall_retries, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn htmustc_calibrated_defaults_cover_burst_flush_waits_and_hedge_is_opt_in() {
        let cfg = StreamBudgetConfig::default();
        assert!(cfg.header_timeout >= Duration::from_secs(75));
        assert!(cfg.first_delta_timeout >= Duration::from_secs(75));
        assert!(cfg.heavy_first_delta_timeout >= Duration::from_secs(95));
        assert!(cfg.inter_chunk_timeout >= Duration::from_secs(45));
        assert!(cfg.per_attempt_deadline >= Duration::from_secs(180));
        assert!(!cfg.enable_pre_ttft_hedge, "hedging must be opt-in");
        assert!(cfg.pre_ttft_hedge_delay >= Duration::from_secs(45));
        // Retry attempts are never clamped below the base budget by a 60s cap.
        let (h, f, _) = cfg.effective_timeouts("claude-sonnet-5-5", 0, 1, Duration::from_secs(290));
        assert!(h >= Duration::from_secs(150) && f >= Duration::from_secs(150));
        assert!(StreamBudgetConfig::is_heavy_model("claude-sonnet-5-5", 0));
    }

    #[tokio::test]
    async fn chat_wire_prefix_is_byte_identical_across_turns_1_to_3() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
        let bodies_bg = Arc::clone(&bodies);
        let srv = tokio::spawn(async move {
            let responses = [
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"k1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"k2\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"b.py\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":150,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"KV_DONE\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":200,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n",
            ];
            for body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                bodies_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_kvchat_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "A = 1\n").unwrap();
        std::fs::write(tmp.join("b.py"), "B = 2\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("read a then b", 6, 30, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "KV_DONE");

        let reqs: Vec<Value> = bodies
            .lock()
            .unwrap()
            .iter()
            .map(|r| http_body_json(r))
            .collect();
        assert_eq!(reqs.len(), 3);
        for w in reqs.windows(2) {
            let (prev, cur) = (&w[0], &w[1]);
            assert_eq!(
                prev["tools"], cur["tools"],
                "tools[] must be byte-identical"
            );
            assert_eq!(prev["prompt_cache_key"], cur["prompt_cache_key"]);
            let pm = prev["messages"].as_array().unwrap();
            let cm = cur["messages"].as_array().unwrap();
            assert!(cm.len() > pm.len());
            assert_eq!(
                &cm[..pm.len()],
                &pm[..],
                "earlier messages must stay append-only"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn anthropic_wire_prefix_is_stable_across_turns_and_gemini_auto_routes_to_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reqs_raw = Arc::new(Mutex::new(Vec::<String>::new()));
        let reqs_bg = Arc::clone(&reqs_raw);
        let srv = tokio::spawn(async move {
            let tool_turn = |id: &str, path: &str| {
                format!(
                    "data: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":100}}}}}}\n\n\
data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"read_file\"}}}}\n\n\
data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"{{\\\"path\\\":\\\"{path}\\\"}}\"}}}}\n\n\
data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"tool_use\"}},\"usage\":{{\"output_tokens\":9}}}}\n\n\
data: {{\"type\":\"message_stop\"}}\n\n"
                )
            };
            let final_turn = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100}}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"GEMINI_VIA_MESSAGES_OK\"}}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n\
data: {\"type\":\"message_stop\"}\n\n".to_string();
            for body in [tool_turn("t1", "a.py"), tool_turn("t2", "b.py"), final_turn] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                reqs_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_kvant_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "A = 1\n").unwrap();
        std::fs::write(tmp.join("b.py"), "B = 2\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gemini-3.8-flash".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        assert_eq!(eng.active_wire_dialect(), "anthropic-messages");

        let sum = eng.run_prompt("read a then b", 6, 30, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "GEMINI_VIA_MESSAGES_OK");

        let raws = reqs_raw.lock().unwrap().clone();
        assert_eq!(raws.len(), 3);
        assert!(raws.iter().all(|r| r.starts_with("POST /v1/messages")));
        let reqs: Vec<Value> = raws
            .iter()
            .map(|r| strip_cache_control(&http_body_json(r)))
            .collect();
        for w in reqs.windows(2) {
            let (prev, cur) = (&w[0], &w[1]);
            assert_eq!(
                prev["system"], cur["system"],
                "system must be byte-identical"
            );
            assert_eq!(prev["tools"], cur["tools"], "tools must be byte-identical");
            let pm = prev["messages"].as_array().unwrap();
            let cm = cur["messages"].as_array().unwrap();
            assert!(cm.len() > pm.len());
            assert_eq!(
                &cm[..pm.len()],
                &pm[..],
                "Anthropic history must stay append-only"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn final_review_gate_fires_once_before_finishing_a_mutating_task() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let cap_bg = Arc::clone(&captured);
        let srv = tokio::spawn(async move {
            let responses = [
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"w1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"m.py\\\",\\\"content\\\":\\\"V = 1\\\\n\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"s1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo OK\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"All requirements verified.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":160,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n",
            ];
            for body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                cap_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_review_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.final_review_gate = true;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("create m.py", 10, 120, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "All requirements verified.");
        assert_eq!(eng.total_final_review_nudges, 1);
        let reqs = captured.lock().unwrap();
        assert_eq!(reqs.len(), 4);
        assert!(reqs[3].contains("[Final Review Gate]"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn final_review_gate_skips_after_passing_test_suite_anti_termination_lag() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let cap_bg = Arc::clone(&captured);
        let srv = tokio::spawn(async move {
            let responses = [
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"w1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"m.py\\\",\\\"content\\\":\\\"V = 1\\\\n\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"s1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo 5 passed, 0 failed\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"Tests passed, done.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n",
            ];
            for body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                cap_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_atl_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.final_review_gate = true;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("fix m.py", 10, 300, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "Tests passed, done.");
        assert_eq!(eng.total_final_review_nudges, 0);
        assert_eq!(captured.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn gpt_auto_routes_to_responses_with_stable_prefix_and_falls_back_to_chat_on_404() {
        // Part A: gpt-6.2-sol auto -> /v1/responses, store=false, prefix-stable across turns 1..3
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let raws = Arc::new(Mutex::new(Vec::<String>::new()));
        let raws_bg = Arc::clone(&raws);
        let srv = tokio::spawn(async move {
            let fc = |id: &str, call: &str, path: &str| {
                format!(
                    "data: {{\"type\":\"response.output_item.added\",\"item\":{{\"id\":\"{id}\",\"type\":\"function_call\",\"call_id\":\"{call}\",\"name\":\"read_file\"}}}}\n\n\
data: {{\"type\":\"response.output_item.done\",\"item\":{{\"id\":\"{id}\",\"type\":\"function_call\",\"call_id\":\"{call}\",\"name\":\"read_file\",\"arguments\":\"{{\\\"path\\\":\\\"{path}\\\"}}\"}}}}\n\n\
data: {{\"type\":\"response.completed\",\"response\":{{\"usage\":{{\"input_tokens\":100,\"output_tokens\":9,\"input_tokens_details\":{{\"cached_tokens\":64}}}}}}}}\n\n"
                )
            };
            let done = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"RESPONSES_AUTO_OK\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":150,\"output_tokens\":3}}}\n\n".to_string();
            for body in [fc("i1", "c1", "a.py"), fc("i2", "c2", "b.py"), done] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut sock).await;
                raws_bg.lock().unwrap().push(req);
                let frame = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!("omni_eng_respauto_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "A = 1\n").unwrap();
        std::fs::write(tmp.join("b.py"), "B = 2\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        assert_eq!(eng.active_wire_dialect(), "openai-responses");
        let sum = eng.run_prompt("read a then b", 6, 30, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "RESPONSES_AUTO_OK");
        assert_eq!(eng.total_tool_calls, 2);

        let raw = raws.lock().unwrap().clone();
        assert!(raw.iter().all(|r| r.starts_with("POST /v1/responses")));
        let reqs: Vec<Value> = raw.iter().map(|r| http_body_json(r)).collect();
        for w in reqs.windows(2) {
            let (prev, cur) = (&w[0], &w[1]);
            assert_eq!(cur["store"], json!(false));
            assert!(cur.get("temperature").is_none());
            assert_eq!(prev["instructions"], cur["instructions"]);
            assert_eq!(prev["tools"], cur["tools"]);
            assert_eq!(prev["prompt_cache_key"], cur["prompt_cache_key"]);
            let pi = prev["input"].as_array().unwrap();
            let ci = cur["input"].as_array().unwrap();
            assert!(ci.len() > pi.len());
            assert_eq!(
                &ci[..pi.len()],
                &pi[..],
                "Responses input must stay append-only"
            );
        }
        // Every function_call has a matching function_call_output (zero orphaned IDs)
        let last_input = reqs[2]["input"].as_array().unwrap();
        for item in last_input.iter().filter(|i| i["type"] == "function_call") {
            let cid = item["call_id"].as_str().unwrap();
            assert!(last_input
                .iter()
                .any(|o| o["type"] == "function_call_output" && o["call_id"] == cid));
        }

        // Part B: /v1/responses 404 -> seamless fallback to /v1/chat/completions
        let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_b = listener_b.local_addr().unwrap();
        let paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let paths_bg = Arc::clone(&paths);
        let srv_b = tokio::spawn(async move {
            let (mut s1, _) = listener_b.accept().await.unwrap();
            let r1 = read_http_request(&mut s1).await;
            paths_bg
                .lock()
                .unwrap()
                .push(r1.lines().next().unwrap_or("").to_string());
            let _ = s1
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"no\"}")
                .await;
            let _ = s1.shutdown().await;
            let (mut s2, _) = listener_b.accept().await.unwrap();
            let r2 = read_http_request(&mut s2).await;
            paths_bg
                .lock()
                .unwrap()
                .push(r2.lines().next().unwrap_or("").to_string());
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"CHAT_FALLBACK_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":3}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });
        let mut eng_b = make_test_engine(&tmp, format!("http://{addr_b}/v1"));
        eng_b.endpoint.model_id = "gpt-6.2-sol".into();
        eng_b.wire_api_mode = WireApiMode::Auto;
        eng_b.stream_budget.header_timeout = Duration::from_secs(5);
        eng_b.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum_b = eng_b.run_prompt("hi", 4, 20, None).await.unwrap();
        srv_b.await.unwrap();
        assert_eq!(sum_b.final_text, "CHAT_FALLBACK_OK");
        assert!(eng_b.responses_fallback_to_chat);
        let p = paths.lock().unwrap();
        assert!(p[0].contains("POST /v1/responses"));
        assert!(p[1].contains("POST /v1/chat/completions"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parses_shell_exit_code_header() {
        assert_eq!(parse_shell_exit_code("exit_code: 0\nok"), Some(0));
        assert_eq!(
            parse_shell_exit_code("exit_code: 3\nCommand exited with code 3."),
            Some(3)
        );
        assert_eq!(parse_shell_exit_code("{\"exitCode\":0}"), None);
    }

    #[tokio::test]
    async fn anthropic_sse_handles_inline_tool_input_signature_progress_and_eof_without_newline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            // Turn 1: content_block_start populates `input` inline (no input_json_delta) AND
            // ends on `message_stop` with NO trailing newline.
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s1).await;
            let turn1 = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":80}}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_inline\",\"name\":\"read_file\",\"input\":{\"path\":\"hello.txt\"}}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":12}}\n\n",
                "data: {\"type\":\"message_stop\"}"
            );
            let _ = s1.write_all(turn1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Turn 2: signature_delta resets inter-chunk watchdog cleanly before final text + no trailing newline
            let (mut s2, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s2).await;
            let head2 = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":80}}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"checking\"}}\n\n"
            );
            let _ = s2.write_all(head2.as_bytes()).await;
            let _ = s2.flush().await;
            tokio::time::sleep(Duration::from_millis(120)).await;
            let mid2 = "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_ok_123\"}}\n\n";
            let _ = s2.write_all(mid2.as_bytes()).await;
            let _ = s2.flush().await;
            tokio::time::sleep(Duration::from_millis(120)).await;
            let tail2 = concat!(
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"INLINE_OK\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}\n\n",
                "data: {\"type\":\"message_stop\"}"
            );
            let _ = s2.write_all(tail2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_ant_inline_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("hello.txt"), "hello world\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.final_review_gate = false;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        eng.stream_budget.inter_chunk_timeout = Duration::from_millis(200);
        let sum = eng.run_prompt("read hello.txt", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "INLINE_OK");
        assert_eq!(eng.total_stall_retries, 0);
        assert_eq!(eng.total_tool_calls, 1);
        assert_eq!(eng.total_tool_errors, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unreachable_network_budget_helper_and_effort_max_unlocked() {
        assert!(is_unreachable_network_error(
            "HTTP transport error: dns error: failed to lookup address information (ENOTFOUND)"
        ));
        assert!(is_unreachable_network_error("connect ENETUNREACH 127.0.0.1"));
        assert!(!is_unreachable_network_error("HTTP 500 Internal Server Error"));
        assert!(compute_unreachable_backoff_ms(1) <= UNREACHABLE_RETRY_MAX_MS);
        assert!(compute_unreachable_backoff_ms(10) <= UNREACHABLE_RETRY_MAX_MS);

        let tmp = std::env::temp_dir().join(format!("omni_eff_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, "http://127.0.0.1:1/v1".into());
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        assert_eq!(eng.resolve_effort_for_turn(false, false), Some(EffortLevel::Medium));
        assert_eq!(eng.resolve_effort_for_turn(false, true), Some(EffortLevel::High));
        assert_eq!(eng.resolve_effort_for_turn(true, true), Some(EffortLevel::Low));
        eng.thinking_level = Some("max".into());
        assert_eq!(eng.resolve_effort_for_turn(false, false), Some(EffortLevel::Max));
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        assert_eq!(eng.resolve_effort_for_turn(false, false), Some(EffortLevel::Max));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cross_model_cryptographic_proof_scoping_blocks_foreign_model_and_taint() {
        let mut msg = HarnessMessage::assistant_with_signature(
            "checking",
            Some("deep thought".into()),
            Some("sig_claude_v1".into()),
            vec![ToolCallRecord {
                id: "tc_1".into(),
                name: "read_file".into(),
                arguments: "{\"path\":\"a.py\"}".into(),
            }],
            2,
        )
        .with_origin("anthropic", "claude-sonnet-5-5");
        msg.redacted_thinking.push("opaque_blob".into());
        msg.reasoning_encrypted_items
            .push(json!({ "type": "reasoning", "encrypted_content": "enc_xyz" }));

        let same_ant = build_anthropic_messages_for_target(
            std::slice::from_ref(&msg),
            true,
            1,
            "anthropic",
            "claude-sonnet-5-5",
        );
        let same_blocks = same_ant[0]["content"].as_array().unwrap();
        assert!(same_blocks.iter().any(|b| b["type"] == "thinking"));
        assert!(same_blocks.iter().any(|b| b["type"] == "redacted_thinking"));

        let foreign_ant = build_anthropic_messages_for_target(
            std::slice::from_ref(&msg),
            true,
            1,
            "openai",
            "gpt-6.2-sol",
        );
        let foreign_blocks = foreign_ant[0]["content"].as_array().unwrap();
        assert!(!foreign_blocks.iter().any(|b| b["type"] == "thinking"));
        assert!(!foreign_blocks.iter().any(|b| b["type"] == "redacted_thinking"));

        let tainted = msg.clone().mark_reasoning_error_tainted();
        let tainted_ant = build_anthropic_messages_for_target(
            std::slice::from_ref(&tainted),
            true,
            1,
            "anthropic",
            "claude-sonnet-5-5",
        );
        assert!(!tainted_ant[0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "thinking"));

        let tmp = std::env::temp_dir().join(format!("omni_xproof_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, "http://127.0.0.1:1/v1".into());
        eng.endpoint.provider_id = "anthropic".into();
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        eng.messages.push(msg.clone());
        let same_resp_items = eng.build_openai_responses_input_items();
        assert!(same_resp_items.iter().any(|i| i["type"] == "reasoning"));

        eng.endpoint.model_id = "gpt-6.2-sol".into();
        let foreign_resp_items = eng.build_openai_responses_input_items();
        assert!(!foreign_resp_items.iter().any(|i| i["type"] == "reasoning"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn ws_continuation_sends_previous_response_id_delta_and_falls_back_to_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ws_payloads = Arc::new(Mutex::new(Vec::<Value>::new()));
        let ws_bg = Arc::clone(&ws_payloads);

        let srv = tokio::spawn(async move {
            // Connection 1: persistent WS server handles Turn 1 (full) + Turn 2 (delta via previous_response_id)
            let (sock1, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock1).await.unwrap();

            // Turn 1 WS frame -> response.output_item (read_file a.py)
            let m1 = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let v1: Value = serde_json::from_str(&m1).unwrap();
            ws_bg.lock().unwrap().push(v1);
            let f1 = [
                json!({"type":"response.created","response":{"id":"resp_ws_1"}}),
                json!({"type":"response.output_item.done","item":{"id":"it1","type":"function_call","call_id":"c_ws_1","name":"read_file","arguments":"{\"path\":\"a.py\"}"}}),
                json!({"type":"response.completed","response":{"id":"resp_ws_1","usage":{"input_tokens":60,"output_tokens":8}}}),
            ];
            for ev in f1 {
                ws.send(WsMessage::Text(ev.to_string().into()))
                    .await
                    .unwrap();
            }

            // Turn 2 WS frame -> must carry previous_response_id="resp_ws_1" and incremental output only, then close cleanly
            let m2 = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let v2: Value = serde_json::from_str(&m2).unwrap();
            ws_bg.lock().unwrap().push(v2);
            let f2 = [
                json!({"type":"response.created","response":{"id":"resp_ws_2"}}),
                json!({"type":"response.output_text.delta","delta":"WS_TURN2_OK"}),
                json!({"type":"response.completed","response":{"id":"resp_ws_2","usage":{"input_tokens":80,"output_tokens":4,"input_tokens_details":{"cached_tokens":60}}}}),
            ];
            for ev in f2 {
                ws.send(WsMessage::Text(ev.to_string().into()))
                    .await
                    .unwrap();
            }
            let _ = ws.close(None).await;

            // Prompt 2 reconnects over WS -> reject upgrade with HTTP 426 so engine degrades cleanly to HTTP SSE!
            let (mut s_rej, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut s_rej).await;
            let _ = s_rej
                .write_all(b"HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nuse http")
                .await;
            let _ = s_rej.shutdown().await;

            let (mut s_http, _) = listener.accept().await.unwrap();
            let req_http = read_http_request(&mut s_http).await;
            assert!(req_http.starts_with("POST /v1/responses"));
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"HTTP_FALLBACK_AFTER_WS_OK\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":90,\"output_tokens\":5}}}\n\n";
            let _ = s_http.write_all(ok.as_bytes()).await;
            let _ = s_http.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_ws_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "X = 42\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.responses_ws_enabled = true;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum1 = eng.run_prompt("read a.py", 4, 20, None).await.unwrap();
        assert_eq!(sum1.final_text, "WS_TURN2_OK");
        assert_eq!(eng.total_ws_turns, 2);

        let captured = ws_payloads.lock().unwrap().clone();
        assert_eq!(captured.len(), 2);
        assert!(captured[0].get("previous_response_id").is_none());
        assert_eq!(captured[1]["previous_response_id"], json!("resp_ws_1"));
        assert_eq!(captured[1]["input"].as_array().unwrap().len(), 1);
        assert_eq!(captured[1]["input"][0]["type"], json!("function_call_output"));

        // Second prompt encounters 426 on WS reconnect and falls back transparently to HTTP SSE
        let sum2 = eng.run_prompt("next step", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum2.final_text, "HTTP_FALLBACK_AFTER_WS_OK");
        assert!(eng.total_ws_fallbacks >= 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn responses_sse_handles_reasoning_text_delta_encrypted_replay_and_tool_choice_none() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reqs = Arc::new(Mutex::new(Vec::<Value>::new()));
        let reqs_bg = Arc::clone(&reqs);

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let r1 = http_body_json(&read_http_request(&mut s1).await);
            reqs_bg.lock().unwrap().push(r1);
            let sse1 = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                ": keepalive\n\n",
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r_1\"}}\n\n",
                "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"thinking step\"}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"encrypted_content\":\"enc_item_abc\"}}\n\n",
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\"}}\n\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\\\"a.py\\\"}\"}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.py\\\"}\"}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":25,\"output_tokens_details\":{\"reasoning_tokens\":12}}}}\n\n"
            );
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            // Turn 2 (max_turns = 2 -> final turn must include tool_choice: "none" and replay encrypted reasoning)
            let (mut s2, _) = listener.accept().await.unwrap();
            let r2 = http_body_json(&read_http_request(&mut s2).await);
            reqs_bg.lock().unwrap().push(r2);
            let sse2 = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"FINAL_SUMMARY_OK\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":140,\"output_tokens\":8,\"input_tokens_details\":{\"cached_tokens\":100}}}}\n\n"
            );
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_resp_enc_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "VAL = 1\n").unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gpt-6.2-sol".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);

        let sum = eng.run_prompt("inspect a.py", 2, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "FINAL_SUMMARY_OK");

        let captured = reqs.lock().unwrap().clone();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0]["reasoning"]["effort"], json!("medium"));
        assert_eq!(
            captured[0]["include"],
            json!(["reasoning.encrypted_content"])
        );
        assert_eq!(captured[0]["tools"], captured[1]["tools"]);
        assert_eq!(captured[1]["tool_choice"], json!("none"));
        assert!(captured[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["type"] == "reasoning" && i["encrypted_content"] == "enc_item_abc"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn non_claude_anthropic_502_auto_falls_back_to_chat_completions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let paths_bg = Arc::clone(&paths);

        let srv = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let r1 = read_http_request(&mut s1).await;
            paths_bg
                .lock()
                .unwrap()
                .push(r1.lines().next().unwrap_or("").to_string());
            let _ = s1
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nupstream error")
                .await;
            let _ = s1.shutdown().await;

            let (mut s2, _) = listener.accept().await.unwrap();
            let r2 = read_http_request(&mut s2).await;
            paths_bg
                .lock()
                .unwrap()
                .push(r2.lines().next().unwrap_or("").to_string());
            let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"GEMINI_502_FAILOVER_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":4}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(ok.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_gem_502_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "gemini-3.8-flash".into();
        eng.wire_api_mode = WireApiMode::Auto;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("hello", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "GEMINI_502_FAILOVER_OK");
        assert!(eng.anthropic_fallback_to_openai);
        let p = paths.lock().unwrap();
        assert!(p[0].contains("POST /v1/messages"));
        assert!(p[1].contains("POST /v1/chat/completions"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn multimodal_content_blocks_lower_across_dialects_and_hysteresis_bounds_images() {
        let msg = HarnessMessage::user_multimodal(
            "inspect screenshot",
            vec![ContentBlock::ImageBase64 {
                media_type: "image/png".into(),
                data_base64: "AAAA".repeat(16),
                detail: Some("high".into()),
                filename: Some("snap.png".into()),
            }],
            1,
        );

        let openai_json = message_to_openai_json_for_target(
            &msg,
            1,
            false,
            false,
            "openai",
            "gpt-6.2-sol",
        );
        assert_eq!(openai_json["content"][0]["type"], json!("text"));
        assert_eq!(openai_json["content"][1]["type"], json!("image_url"));

        let ant_json = build_anthropic_messages_for_target(
            std::slice::from_ref(&msg),
            false,
            1,
            "anthropic",
            "claude-sonnet-5-5",
        );
        let ant_blks = ant_json[0]["content"].as_array().unwrap();
        assert_eq!(ant_blks[1]["type"], json!("image"));
        assert_eq!(ant_blks[1]["source"]["media_type"], json!("image/png"));

        let tmp = std::env::temp_dir().join(format!("omni_mm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, "http://127.0.0.1:1/v1".into());
        eng.messages.push(msg);
        let resp_items = eng.build_openai_responses_input_items();
        assert_eq!(resp_items[0]["content"][1]["type"], json!("input_image"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn router_sqlite_hooks_memory_tail_fold_and_rtk_compressor_integration() {
        let tmp = std::env::temp_dir().join(format!("omni_v5_int_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let router_db = tmp.join("router.db");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reqs = Arc::new(Mutex::new(Vec::<Value>::new()));
        let reqs_bg = Arc::clone(&reqs);

        let srv = tokio::spawn(async move {
            // Turn 1 triggers a noisy shell output (>2KB) to verify RTK output_compressor
            let (mut s1, _) = listener.accept().await.unwrap();
            let r1 = http_body_json(&read_http_request(&mut s1).await);
            reqs_bg.lock().unwrap().push(r1);
            let cmd_payload = "python -B -c \"print('\\x1b[32mok line\\x1b[0m\\n' * 220 + 'AssertionError: line 7')\"";
            let sse1 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"sh_rtk\",\"function\":{{\"name\":\"shell\",\"arguments\":{}}}}}]}} ,\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":60,\"completion_tokens\":8}}}}\n\n\
data: [DONE]\n\n",
                serde_json::to_string(&json!({ "command": cmd_payload }).to_string()).unwrap()
            );
            let _ = s1.write_all(sse1.as_bytes()).await;
            let _ = s1.shutdown().await;

            let (mut s2, _) = listener.accept().await.unwrap();
            let r2 = http_body_json(&read_http_request(&mut s2).await);
            reqs_bg.lock().unwrap().push(r2);
            let sse2 = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"V5_INTEGRATED_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":90,\"completion_tokens\":4}}\n\n\
data: [DONE]\n\n";
            let _ = s2.write_all(sse2.as_bytes()).await;
            let _ = s2.shutdown().await;
        });

        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.api_key = "dummy-fixture-key".into();
        eng.init_default_sqlite_router(Some(&router_db)).unwrap();
        assert!(router_db.exists());
        eng.register_role_endpoint(ModelRole::Advisor, eng.endpoint.clone());
        let adv = eng.resolve_role_endpoint(ModelRole::Advisor);
        assert_eq!(adv.model_id, eng.endpoint.model_id);

        // Proactive quota gate check
        let probe = QuotaProbeSnapshot {
            limit_reached: true,
            buckets: vec![omnia_connector_gateway::htmustc_wire::QuotaBucket {
                name: "daily".into(),
                total: 100,
                remaining: 0,
                unlimited: false,
                reset_at_epoch_ms: None,
            }],
        };
        assert!(eng.apply_proactive_quota_snapshot("mock::mock-model", &probe, 1_000));

        // MemoryEngine tail recall check
        let mem = Arc::new(MemoryEngine::open_in_memory().unwrap());
        let scope = MemoryEngine::compute_bank_scope(
            "omnia",
            "main",
            crate::memory_engine::BankScopingMode::PerProjectTagged,
            &tmp,
        );
        mem.retain(
            &scope.bank_id,
            crate::memory_engine::RetainItemInput {
                namespace_path: "workspace/facts".into(),
                key: "rtk_rule".into(),
                content: "Always check AssertionError line anchors after running shell.".into(),
                context: None,
                tier: omnia_harness::MemoryTier::Durable,
                kind: omnia_harness::MemoryKind::WorldFact,
                scope: omnia_harness::MemoryScope::Project,
                provenance: omnia_harness::MemoryProvenance::VerifiedUser,
                importance_bps: 8_500,
                tags: scope.project_tag.into_iter().collect(),
                links: Vec::new(),
                now_ms: Some(1_000),
            },
        )
        .unwrap();
        eng.bind_memory_engine(mem);

        let sum = eng.run_prompt("check AssertionError shell output", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "V5_INTEGRATED_OK");

        let captured = reqs.lock().unwrap().clone();
        assert!(captured[0]["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("<recalled_memories"));
        assert!(eng.total_rtk_compressions >= 1);
        let tool_msg = captured[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(tool_msg.contains("AssertionError: line 7"));
        assert!(!tool_msg.contains("\u{1b}[32m"));

        // FoldAgent branch & fold check
        eng.branch_context_fold("b1", "explore");
        eng.messages.push(HarnessMessage::user("temp noise", 9));
        let folded = eng.complete_context_fold("b1", "checked ok", &["a.py".into()]).unwrap();
        assert_eq!(folded.folded_messages, 1);
        assert_eq!(eng.total_fold_compressions, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn responses_pre_ttft_zero_sse_caps_at_60s_while_keepalive_honors_240s() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(300);
        // Case A: Hung /v1/responses socket with zero SSE bytes (`last_wire_activity_at = None`)
        let silent_wait = compute_token_progress_wait_with_wire(
            now,
            None,
            None,
            Duration::from_secs(150),
            Duration::from_secs(65),
            deadline,
            "OpenAI Responses SSE",
        )
        .unwrap();
        assert!(silent_wait <= Duration::from_secs(60));

        // Case B: Active wire keepalive / lifecycle event -> full 240s silent reasoning allowance
        let active_wait = compute_token_progress_wait_with_wire(
            now,
            None,
            Some(now),
            Duration::from_secs(150),
            Duration::from_secs(65),
            deadline,
            "OpenAI Responses SSE",
        )
        .unwrap();
        assert!(active_wait > Duration::from_secs(200));
    }

    #[test]
    fn reasoning_phase_keeps_150s_to_240s_allowance_until_visible_output_and_tps_avoids_burst_spike() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(240);
        let reasoned_at = now - Duration::from_secs(70);
        // Active reasoning-only phase (>65s since headline, zero text/tool_calls yet) must NOT stall at 65s
        let with_wire = compute_token_progress_wait_with_phase(
            now - Duration::from_secs(80),
            Some(reasoned_at),
            Some(now - Duration::from_secs(5)),
            Duration::from_secs(150),
            Duration::from_secs(65),
            deadline,
            "OpenAI Responses SSE",
            true,
        )
        .unwrap();
        assert!(with_wire > Duration::from_secs(100));

        let quiet_reasoning = compute_token_progress_wait_with_phase(
            now - Duration::from_secs(80),
            Some(reasoned_at),
            None,
            Duration::from_secs(150),
            Duration::from_secs(65),
            deadline,
            "OpenAI Responses SSE",
            true,
        )
        .unwrap();
        assert!(quiet_reasoning >= Duration::from_secs(75));

        // Once non-reasoning text/tool output begins (`in_reasoning_only = false`), 65s stall applies
        assert!(compute_token_progress_wait_with_phase(
            now - Duration::from_secs(80),
            Some(reasoned_at),
            Some(now - Duration::from_secs(5)),
            Duration::from_secs(150),
            Duration::from_secs(65),
            deadline,
            "OpenAI Responses SSE",
            false,
        )
        .is_err());

        // Burst-flushed `<100` token turns must floor gen_ms at >= 50ms instead of 1ms (`78k TPS` artifact)
        let gen_ms = compute_pure_gen_duration_ms(Instant::now(), Some(0), Some(now), Some(now), 65);
        assert!(gen_ms >= 50);

        // `gen_tokens_per_second` must reflect physical `gen_dur_ms` (not >5s-gap-truncated `active_decode_ms`)
        let (_e2e, g_tps, a_tps) = compute_eval_tps_metrics(4_470, 120_000, 105_811, 4_438);
        assert!((42.0..=42.5).contains(&g_tps), "g_tps={g_tps}");
        assert!((42.0..=42.5).contains(&a_tps), "a_tps={a_tps}");

        // Genuine non-gapped streaming retains distinct `active_decode_tps` alongside `gen_tps`
        let (_e2e2, g2, a2) = compute_eval_tps_metrics(1_000, 20_000, 18_000, 12_000);
        assert!((55.0..=56.0).contains(&g2));
        assert!((83.0..=84.0).contains(&a2));
    }

    #[tokio::test]
    async fn anthropic_message_delta_captures_cache_read_creation_and_input_tokens() {
        // Part A: Helper preserves `message_start` cache tokens when `message_delta` only carries `output_tokens`.
        let mut standard = TurnLlmUsage::default();
        apply_anthropic_usage_fields(
            &json!({"input_tokens": 100, "cache_read_input_tokens": 400, "cache_creation_input_tokens": 50}),
            &mut standard,
        );
        apply_anthropic_usage_fields(&json!({"output_tokens": 12}), &mut standard);
        assert_eq!(standard.uncached_input, 100);
        assert_eq!(standard.cache_read, 400);
        assert_eq!(standard.cache_write, 50);
        assert_eq!(standard.output, 12);

        // Part B: Full Anthropic SSE round-trip where `htmustc`-style `message_delta.usage` reports final KV cache hit.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut sock).await;
            let sse = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"CACHE_DELTA_OK\"}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":1200,\"cache_read_input_tokens\":112544,\"cache_creation_input_tokens\":256,\"output_tokens\":45}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            let _ = sock.write_all(sse.as_bytes()).await;
            let _ = sock.shutdown().await;
        });

        let tmp = std::env::temp_dir().join(format!("omni_ant_delta_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut eng = make_test_engine(&tmp, format!("http://{addr}/v1"));
        eng.endpoint.model_id = "claude-sonnet-5-5".into();
        eng.endpoint.api = "anthropic-messages".into();
        eng.wire_api_mode = WireApiMode::Messages;
        eng.stream_budget.header_timeout = Duration::from_secs(5);
        eng.stream_budget.first_delta_timeout = Duration::from_secs(5);
        let sum = eng.run_prompt("check delta cache", 4, 20, None).await.unwrap();
        srv.await.unwrap();
        assert_eq!(sum.final_text, "CACHE_DELTA_OK");
        assert_eq!(sum.cache_stats.uncached_input_tokens, 1_200);
        assert_eq!(sum.cache_stats.cache_read_tokens, 112_544);
        assert_eq!(sum.cache_stats.cache_write_tokens, 256);
        assert_eq!(sum.cache_stats.output_tokens, 45);
        assert!(sum.cache_stats.cache_hit_pct > 90.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn custom_test_script_invocation_recognizes_clean_scripts_without_masking_echo_or_errors() {
        assert!(is_test_script_invocation(
            "python test_sample.py && python -c \"assert 1\"",
            "exit_code: 0\nOK"
        ));
        assert!(is_test_script_invocation(
            "node tests/algo.test.mjs",
            "exit_code: 0\nall checks ok"
        ));
        assert!(!is_test_script_invocation("echo OK", "exit_code: 0\nOK"));
        assert!(!is_test_script_invocation(
            "python solution.py",
            "exit_code: 0\ndone"
        ));
        assert!(!is_test_script_invocation(
            "python test_sample.py",
            "exit_code: 0\nTraceback: AssertionError"
        ));
    }

    #[test]
    fn attempt0_budget_reserves_retry_headroom_and_expired_turn_deadline_is_retryable() {
        let per_attempt = Duration::from_secs(240);
        // 297s production turn: Attempt 0 caps at 180s (<= min(180s, 65%*297s)), leaving ~117s for Attempt 1
        let a0 = compute_attempt_budget(Duration::from_secs(297), per_attempt, 0, 3);
        assert_eq!(a0, Duration::from_secs(180));
        let a1 = compute_attempt_budget(Duration::from_secs(117), per_attempt, 1, 3);
        assert_eq!(a1, Duration::from_secs(117));

        // 150s remaining: 65% = 97.5s, reserving 52.5s for Attempt 1
        let mid = compute_attempt_budget(Duration::from_secs(150), per_attempt, 0, 3);
        assert!(mid >= Duration::from_secs(97) && mid <= Duration::from_secs(98));

        // Unit-test small deadlines stay untouched
        let small = compute_attempt_budget(Duration::from_secs(15), Duration::from_secs(10), 0, 3);
        assert_eq!(small, Duration::from_secs(10));

        // Per-attempt turn_deadline exhaustion returns Retryable (so Attempt 1 still fires!)
        let now = Instant::now();
        let err = compute_token_progress_wait_with_phase(
            now - Duration::from_secs(180),
            None,
            Some(now),
            Duration::from_secs(150),
            Duration::from_secs(65),
            now,
            "OpenAI Responses SSE",
            false,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            StreamTurnError::Retryable {
                kind: RetryKind::ChunkStall,
                ..
            }
        ));
    }
}
