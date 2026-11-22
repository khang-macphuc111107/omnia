//! Deterministic proxy router, config validator, and 4-state health / circuit-breaker
//! scheduler aligned with `htmustc-proxy` and Omnia `DynamicProviderRouter`, emitting
//! strictly secret-free routing receipts.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::{
    detect_json_secrets, extract_env_reference, find_unsafe_prototype_key, has_bidi_controls,
    has_control_chars, impl_str_enum_serde, is_safe_placeholder, is_sensitive_key_name,
    redact_json_value, redact_secrets_in_text, sanitize_and_inspect_url, sanitize_url_origin,
    sha256_hex, UrlInspectionPolicy, UrlSanitizeError, REDACTED_SECRET,
};

pub const DEFAULT_SOFT_FAIL_WINDOW_MS: u64 = 5_000;
pub const DEFAULT_BASE_BACKOFF_MS: u64 = 15_000;
pub const DEFAULT_MAX_COOLDOWN_MS: u64 = 1_800_000;
pub const DEFAULT_MODEL_MISSING_COOLDOWN_MS: u64 = 900_000;
pub const DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS: u64 = 43_200_000;
pub const DEFAULT_MAX_BACKOFF_LEVEL: u32 = 6;
pub const DEFAULT_MODEL_LOCK_ESCALATION_LEVEL: u32 = 4;
pub const DEFAULT_PROBE_UNPROVEN_EVERY: u64 = 4;
pub const CLIENT_FAULT_EXEMPT_STATUSES: [u16; 4] = [400, 409, 413, 422];

/// Errors returned by proxy route config normalization and routing selection.
#[derive(Debug, Error)]
pub enum ProxyRouterError {
    #[error("invalid proxy URL: {0}")]
    InvalidUrl(#[from] UrlSanitizeError),
    #[error("unsafe prototype key in proxy config at '{0}'")]
    UnsafePrototypeKey(String),
    #[error("inline raw secret forbidden in proxy config field '{field}'; use an env reference like ${{VAR}}")]
    InlineSecretForbidden { field: String },
    #[error("proxy routing cycle detected: {0}")]
    CycleDetected(String),
    #[error("forwarded header trust rejected on non-loopback route '{0}'")]
    AntiSpoofViolation(String),
    #[error("invalid proxy route configuration: {0}")]
    InvalidConfig(String),
    #[error("no eligible upstream candidate available for model '{model}'")]
    NoEligibleRoute { model: String },
}

/// Canonical 4-state health / circuit-breaker model aligned with `htmustc-proxy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProxyHealthState {
    Healthy,
    Cooldown,
    Tripped,
    Unavailable,
}

impl ProxyHealthState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Cooldown => "cooldown",
            Self::Tripped => "tripped",
            Self::Unavailable => "unavailable",
        }
    }
}

impl FromStr for ProxyHealthState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "healthy" | "closed" | "ready" => Ok(Self::Healthy),
            "cooldown" | "half_open" | "half-open" => Ok(Self::Cooldown),
            "tripped" | "open" | "circuit_open" => Ok(Self::Tripped),
            "unavailable" | "suspended" | "disabled" | "manual" => Ok(Self::Unavailable),
            other => Err(format!("unknown proxy health state '{other}'")),
        }
    }
}

impl_str_enum_serde!(ProxyHealthState);

/// Failover scheduling strategy mirroring `htmustc-proxy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RoutingStrategy {
    WeightedRoundRobin,
    RoundRobin,
    WeightedRandom,
    FillFirst,
}

impl RoutingStrategy {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WeightedRoundRobin => "weighted_round_robin",
            Self::RoundRobin => "round_robin",
            Self::WeightedRandom => "weighted_random",
            Self::FillFirst => "fill_first",
        }
    }
}

impl FromStr for RoutingStrategy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "weighted_round_robin" | "wrr" => Ok(Self::WeightedRoundRobin),
            "round_robin" | "rr" => Ok(Self::RoundRobin),
            "weighted_random" | "random" => Ok(Self::WeightedRandom),
            "fill_first" | "priority" => Ok(Self::FillFirst),
            other => Err(format!("unknown routing strategy '{other}'")),
        }
    }
}

impl_str_enum_serde!(RoutingStrategy);

/// Scope of an upstream failure reported to the health state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailureScope {
    None,
    AccountCooldown,
    AccountQuota,
    AccountSuspended,
    AccountManual,
    ModelCooldown,
    ModelEntitlement,
}

impl FailureScope {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::AccountCooldown => "account_cooldown",
            Self::AccountQuota => "account_quota",
            Self::AccountSuspended => "account_suspended",
            Self::AccountManual => "account_manual",
            Self::ModelCooldown => "model_cooldown",
            Self::ModelEntitlement => "model_entitlement",
        }
    }
}

impl FromStr for FailureScope {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "account_cooldown" => Ok(Self::AccountCooldown),
            "account_quota" => Ok(Self::AccountQuota),
            "account_suspended" => Ok(Self::AccountSuspended),
            "account_manual" => Ok(Self::AccountManual),
            "model_cooldown" => Ok(Self::ModelCooldown),
            "model_entitlement" => Ok(Self::ModelEntitlement),
            other => Err(format!("unknown failure scope '{other}'")),
        }
    }
}

impl_str_enum_serde!(FailureScope);

/// Honest quota certainty state aligned with Omnia `DYNAMIC_ROUTING_REQUIREMENTS.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuotaCertainty {
    Known,
    Unknown,
    Stale,
    Contradictory,
}

impl QuotaCertainty {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Known => "known",
            Self::Unknown => "unknown",
            Self::Stale => "stale",
            Self::Contradictory => "contradictory",
        }
    }
}

impl FromStr for QuotaCertainty {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "known" => Ok(Self::Known),
            "unknown" => Ok(Self::Unknown),
            "stale" => Ok(Self::Stale),
            "contradictory" => Ok(Self::Contradictory),
            other => Err(format!("unknown quota certainty '{other}'")),
        }
    }
}

impl_str_enum_serde!(QuotaCertainty);

/// Policy options governing URL/SSRF and anti-spoof validation for normalized proxy configs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyConfigPolicy {
    pub allow_private_endpoints: bool,
    pub allow_non_loopback: bool,
    pub strict_tls: bool,
}

impl Default for ProxyConfigPolicy {
    fn default() -> Self {
        Self {
            allow_private_endpoints: false,
            allow_non_loopback: true,
            strict_tls: true,
        }
    }
}

/// Validated, secret-free upstream candidate route definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyCandidateConfig {
    pub candidate_id: String,
    pub provider_id: String,
    pub upstream_origin: String,
    pub upstream_url: String,
    pub proxy_origin: Option<String>,
    pub direct: bool,
    pub env_var_ref: Option<String>,
    pub route_priority: i32,
    pub weight: u32,
    pub enabled: bool,
    pub proven: bool,
    pub supported_models: Vec<String>,
    pub fallback_chain: Vec<String>,
    pub quota_certainty: QuotaCertainty,
}

impl Serialize for ProxyCandidateConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "candidate_id": self.candidate_id,
            "provider_id": self.provider_id,
            "upstream_origin": self.upstream_origin,
            "upstream_url": self.upstream_url,
            "proxy_origin": self.proxy_origin,
            "direct": self.direct,
            "env_var_ref": self.env_var_ref,
            "route_priority": self.route_priority,
            "weight": self.weight,
            "enabled": self.enabled,
            "proven": self.proven,
            "supported_models": self.supported_models,
            "fallback_chain": self.fallback_chain,
            "quota_certainty": self.quota_certainty,
        })
        .serialize(serializer)
    }
}

/// Normalized, secret-free proxy pool configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedProxyConfig {
    pub strategy: RoutingStrategy,
    pub candidates: Vec<ProxyCandidateConfig>,
    pub trust_forwarded_headers: bool,
}

/// Normalizes and security-validates a raw proxy pool configuration JSON object.
pub fn normalize_proxy_route_config(
    raw: &Value,
    policy: &ProxyConfigPolicy,
) -> Result<NormalizedProxyConfig, ProxyRouterError> {
    if let Some(proto) = find_unsafe_prototype_key(raw, "$") {
        return Err(ProxyRouterError::UnsafePrototypeKey(proto));
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| ProxyRouterError::InvalidConfig("proxy config must be an object".into()))?;

    let strategy = match obj.get("strategy").and_then(Value::as_str) {
        Some(s) => RoutingStrategy::from_str(s).map_err(ProxyRouterError::InvalidConfig)?,
        None => RoutingStrategy::WeightedRoundRobin,
    };

    let trust_forwarded_headers = obj
        .get("trust_forwarded_headers")
        .or_else(|| obj.get("trustForwardedHeaders"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let url_policy = UrlInspectionPolicy {
        strict_tls: policy.strict_tls,
        allow_loopback_http: true,
        allow_private_endpoints: policy.allow_private_endpoints,
        allow_non_loopback: policy.allow_non_loopback,
        redact_signed_params: true,
        allow_socks_schemes: true,
    };

    let raw_candidates = obj
        .get("candidates")
        .or_else(|| obj.get("routes"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProxyRouterError::InvalidConfig("'candidates' or 'routes' array is required".into())
        })?;

    let mut candidates = Vec::with_capacity(raw_candidates.len());
    let mut seen_ids = BTreeSet::new();

    for (idx, cand_val) in raw_candidates.iter().enumerate() {
        let cand_obj = cand_val.as_object().ok_or_else(|| {
            ProxyRouterError::InvalidConfig(format!("candidate[{idx}] must be an object"))
        })?;

        reject_inline_secrets_in_object(cand_obj, &format!("candidates[{idx}]"))?;

        let candidate_id = clean_non_empty(
            cand_obj,
            &["candidate_id", "id", "account_id"],
            &format!("candidates[{idx}].candidate_id"),
        )?;
        if !seen_ids.insert(candidate_id.clone()) {
            return Err(ProxyRouterError::InvalidConfig(format!(
                "duplicate candidate_id '{candidate_id}'"
            )));
        }

        let provider_id = cand_obj
            .get("provider_id")
            .or_else(|| cand_obj.get("provider"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("openai")
            .to_string();

        let upstream_raw = clean_non_empty(
            cand_obj,
            &["upstream_url", "base_url", "url"],
            &format!("candidates[{idx}].upstream_url"),
        )?;
        let upstream_info = sanitize_and_inspect_url(&upstream_raw, &url_policy)?;
        if !upstream_info.is_safe() {
            return Err(ProxyRouterError::InvalidConfig(format!(
                "candidate '{candidate_id}' upstream_url failed SSRF/TLS policy"
            )));
        }

        let direct = cand_obj
            .get("direct")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let proxy_raw = cand_obj
            .get("proxy_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let proxy_origin = if let Some(p_url) = proxy_raw {
            if direct {
                return Err(ProxyRouterError::InvalidConfig(format!(
                    "candidate '{candidate_id}' cannot specify both direct=true and proxy_url"
                )));
            }
            let p_info = sanitize_and_inspect_url(p_url, &url_policy)?;
            if !p_info.is_safe() {
                return Err(ProxyRouterError::InvalidConfig(format!(
                    "candidate '{candidate_id}' proxy_url failed SSRF/TLS policy"
                )));
            }
            if trust_forwarded_headers && !p_info.is_loopback {
                return Err(ProxyRouterError::AntiSpoofViolation(candidate_id));
            }
            Some(p_info.origin)
        } else {
            if trust_forwarded_headers && !upstream_info.is_loopback {
                return Err(ProxyRouterError::AntiSpoofViolation(candidate_id));
            }
            None
        };

        let env_var_ref = cand_obj
            .get("env_var")
            .or_else(|| cand_obj.get("auth_env"))
            .and_then(Value::as_str)
            .and_then(|raw_ref| {
                extract_env_reference(raw_ref).or_else(|| {
                    let trimmed = raw_ref.trim();
                    if is_env_var_name(trimmed) {
                        Some(trimmed.to_string())
                    } else {
                        None
                    }
                })
            });

        let route_priority = cand_obj
            .get("route_priority")
            .or_else(|| cand_obj.get("priority"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32;

        let weight = cand_obj
            .get("weight")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 10_000) as u32;

        let enabled = cand_obj
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let proven = cand_obj
            .get("proven")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let supported_models = cand_obj
            .get("supported_models")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let fallback_chain = cand_obj
            .get("fallback_chain")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let quota_certainty = match cand_obj.get("quota_certainty").and_then(Value::as_str) {
            Some(q) => QuotaCertainty::from_str(q).map_err(ProxyRouterError::InvalidConfig)?,
            None => QuotaCertainty::Unknown,
        };

        candidates.push(ProxyCandidateConfig {
            candidate_id,
            provider_id,
            upstream_origin: upstream_info.origin,
            upstream_url: upstream_info.normalized_url,
            proxy_origin,
            direct,
            env_var_ref,
            route_priority,
            weight,
            enabled,
            proven,
            supported_models,
            fallback_chain,
            quota_certainty,
        });
    }

    detect_fallback_cycles(&candidates)?;

    Ok(NormalizedProxyConfig {
        strategy,
        candidates,
        trust_forwarded_headers,
    })
}

/// Live health + circuit-breaker state for one upstream proxy candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateRuntimeHealth {
    pub config: ProxyCandidateConfig,
    pub state: ProxyHealthState,
    pub consecutive_failures: u32,
    pub backoff_level: u32,
    pub cooldown_until_ms: Option<u64>,
    pub soft_fail_until_ms: Option<u64>,
    pub model_cooldowns_ms: BTreeMap<String, u64>,
    pub model_lock_streak: BTreeMap<String, u32>,
    pub last_status: Option<u16>,
    pub last_reason: Option<String>,
}

impl CandidateRuntimeHealth {
    #[must_use]
    pub fn from_config(config: ProxyCandidateConfig) -> Self {
        let initial_state = if config.enabled {
            ProxyHealthState::Healthy
        } else {
            ProxyHealthState::Unavailable
        };
        Self {
            config,
            state: initial_state,
            consecutive_failures: 0,
            backoff_level: 0,
            cooldown_until_ms: None,
            soft_fail_until_ms: None,
            model_cooldowns_ms: BTreeMap::new(),
            model_lock_streak: BTreeMap::new(),
            last_status: None,
            last_reason: None,
        }
    }

    /// Evaluates effective state at `now_epoch_ms`, advancing expired cooldowns toward recovery.
    #[must_use]
    pub fn effective_state(&self, model: &str, now_epoch_ms: u64) -> ProxyHealthState {
        if !self.config.enabled || self.state == ProxyHealthState::Unavailable {
            return ProxyHealthState::Unavailable;
        }
        if let Some(&model_until) = self.model_cooldowns_ms.get(model) {
            if now_epoch_ms < model_until {
                return ProxyHealthState::Cooldown;
            }
        }
        match self.state {
            ProxyHealthState::Tripped => match self.cooldown_until_ms {
                Some(until) if now_epoch_ms >= until => ProxyHealthState::Cooldown,
                _ => ProxyHealthState::Tripped,
            },
            ProxyHealthState::Cooldown => match self.cooldown_until_ms {
                Some(until) if now_epoch_ms >= until => ProxyHealthState::Healthy,
                _ => ProxyHealthState::Cooldown,
            },
            ProxyHealthState::Healthy => ProxyHealthState::Healthy,
            ProxyHealthState::Unavailable => ProxyHealthState::Unavailable,
        }
    }

    #[must_use]
    pub fn is_soft_demoted(&self, now_epoch_ms: u64) -> bool {
        self.soft_fail_until_ms
            .map(|until| now_epoch_ms < until)
            .unwrap_or(false)
    }
}

/// Incoming routing request parameters (with optional inbound headers checked & redacted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteSelectionRequest {
    pub request_id: String,
    pub model: String,
    pub attempt_number: u32,
    pub excluded_candidates: Vec<String>,
    pub request_headers: BTreeMap<String, String>,
}

/// Secret-free deterministic routing decision receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingReceipt {
    pub request_id: String,
    pub model: String,
    pub selected_candidate_id: String,
    pub provider_id: String,
    pub selected_origin: String,
    pub proxy_origin: Option<String>,
    pub health_state: ProxyHealthState,
    pub route_priority: i32,
    pub strategy: RoutingStrategy,
    pub attempt_number: u32,
    pub quota_certainty: QuotaCertainty,
    pub considered_candidates: Vec<String>,
    pub suppressed_candidates: Vec<String>,
    pub reason: String,
    pub sanitized_headers: BTreeMap<String, String>,
    pub timestamp_epoch_ms: u64,
}

impl Serialize for RoutingReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut obj = json!({
            "request_id": self.request_id,
            "model": self.model,
            "selected_candidate_id": self.selected_candidate_id,
            "provider_id": self.provider_id,
            "selected_origin": self.selected_origin,
            "proxy_origin": self.proxy_origin,
            "health_state": self.health_state,
            "route_priority": self.route_priority,
            "strategy": self.strategy,
            "attempt_number": self.attempt_number,
            "quota_certainty": self.quota_certainty,
            "considered_candidates": self.considered_candidates,
            "suppressed_candidates": self.suppressed_candidates,
            "reason": self.reason,
            "sanitized_headers": self.sanitized_headers,
            "timestamp_epoch_ms": self.timestamp_epoch_ms,
        });
        // Defense-in-depth guarantee: scrub any residual secret/header leak before emission.
        if !detect_json_secrets(&obj).is_empty() {
            let (cleaned, _) = redact_json_value(&obj);
            obj = cleaned;
        }
        obj.serialize(serializer)
    }
}

/// Stateful deterministic failover proxy router aligned with `htmustc-proxy`.
#[derive(Debug, Clone)]
pub struct ProxyRouter {
    strategy: RoutingStrategy,
    candidates: Vec<CandidateRuntimeHealth>,
    pick_counter: u64,
    wrr_counters: BTreeMap<String, i64>,
}

impl ProxyRouter {
    #[must_use]
    pub fn new(config: NormalizedProxyConfig) -> Self {
        let candidates = config
            .candidates
            .into_iter()
            .map(CandidateRuntimeHealth::from_config)
            .collect();
        Self {
            strategy: config.strategy,
            candidates,
            pick_counter: 0,
            wrr_counters: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn candidates(&self) -> &[CandidateRuntimeHealth] {
        &self.candidates
    }

    /// Selects the highest-ranked eligible candidate deterministically and emits a secret-free receipt.
    pub fn select_route(
        &mut self,
        request: &RouteSelectionRequest,
        now_epoch_ms: u64,
    ) -> Result<RoutingReceipt, ProxyRouterError> {
        let excluded: BTreeSet<&str> = request
            .excluded_candidates
            .iter()
            .map(String::as_str)
            .collect();

        let mut eligible: Vec<(usize, ProxyHealthState, bool)> = Vec::new();
        let mut suppressed = Vec::new();

        for (idx, cand) in self.candidates.iter().enumerate() {
            if excluded.contains(cand.config.candidate_id.as_str()) {
                suppressed.push(format!("{}:excluded", cand.config.candidate_id));
                continue;
            }
            if !cand.config.supported_models.is_empty()
                && !cand
                    .config
                    .supported_models
                    .iter()
                    .any(|m| m == &request.model || m == "*")
            {
                suppressed.push(format!("{}:unsupported_model", cand.config.candidate_id));
                continue;
            }
            let eff = cand.effective_state(&request.model, now_epoch_ms);
            match eff {
                ProxyHealthState::Healthy => {
                    eligible.push((idx, eff, cand.is_soft_demoted(now_epoch_ms)));
                }
                ProxyHealthState::Cooldown => {
                    // Half-open recovery probe candidate if account cooldown expired (or model not locked).
                    let account_ready = cand
                        .cooldown_until_ms
                        .map(|u| now_epoch_ms >= u)
                        .unwrap_or(false);
                    let model_locked = cand
                        .model_cooldowns_ms
                        .get(&request.model)
                        .map(|&u| now_epoch_ms < u)
                        .unwrap_or(false);
                    if account_ready && !model_locked {
                        eligible.push((idx, eff, cand.is_soft_demoted(now_epoch_ms)));
                    } else {
                        suppressed.push(format!("{}:cooldown", cand.config.candidate_id));
                    }
                }
                ProxyHealthState::Tripped => {
                    suppressed.push(format!("{}:tripped", cand.config.candidate_id));
                }
                ProxyHealthState::Unavailable => {
                    suppressed.push(format!("{}:unavailable", cand.config.candidate_id));
                }
            }
        }

        if eligible.is_empty() {
            return Err(ProxyRouterError::NoEligibleRoute {
                model: request.model.clone(),
            });
        }

        // Rank cleanly: higher route_priority first, non-demoted first, Healthy before half-open
        // Cooldown, Known/Unknown quota before Stale/Contradictory, tie-break by candidate_id.
        let best_tier = eligible
            .iter()
            .map(|&(idx, eff, demoted)| {
                let c = &self.candidates[idx].config;
                let quota_penalty = match c.quota_certainty {
                    QuotaCertainty::Known => 0_u8,
                    QuotaCertainty::Unknown => 1_u8,
                    QuotaCertainty::Stale => 2_u8,
                    QuotaCertainty::Contradictory => 3_u8,
                };
                let health_penalty = match eff {
                    ProxyHealthState::Healthy => 0_u8,
                    ProxyHealthState::Cooldown => 1_u8,
                    ProxyHealthState::Tripped => 2_u8,
                    ProxyHealthState::Unavailable => 3_u8,
                };
                (
                    std::cmp::Reverse(c.route_priority),
                    demoted,
                    health_penalty,
                    quota_penalty,
                )
            })
            .min()
            .expect("eligible is non-empty");

        let mut top_tier_indices: Vec<usize> = eligible
            .iter()
            .filter(|&&(idx, eff, demoted)| {
                let c = &self.candidates[idx].config;
                let quota_penalty = match c.quota_certainty {
                    QuotaCertainty::Known => 0_u8,
                    QuotaCertainty::Unknown => 1_u8,
                    QuotaCertainty::Stale => 2_u8,
                    QuotaCertainty::Contradictory => 3_u8,
                };
                let health_penalty = match eff {
                    ProxyHealthState::Healthy => 0_u8,
                    ProxyHealthState::Cooldown => 1_u8,
                    ProxyHealthState::Tripped => 2_u8,
                    ProxyHealthState::Unavailable => 3_u8,
                };
                (
                    std::cmp::Reverse(c.route_priority),
                    demoted,
                    health_penalty,
                    quota_penalty,
                ) == best_tier
            })
            .map(|&(idx, _, _)| idx)
            .collect();

        top_tier_indices.sort_by(|&a, &b| {
            self.candidates[a]
                .config
                .candidate_id
                .cmp(&self.candidates[b].config.candidate_id)
        });

        self.pick_counter = self.pick_counter.saturating_add(1);
        let chosen_idx = self.pick_within_tier(&top_tier_indices, &request.request_id);
        let chosen = &self.candidates[chosen_idx];
        let eff_state = chosen.effective_state(&request.model, now_epoch_ms);

        let considered = top_tier_indices
            .iter()
            .map(|&i| self.candidates[i].config.candidate_id.clone())
            .collect();

        let (selected_origin, _) = sanitize_url_origin(&chosen.config.upstream_url);
        let origin_str = selected_origin.unwrap_or_else(|| chosen.config.upstream_origin.clone());
        let reason = match eff_state {
            ProxyHealthState::Cooldown => "half_open_probe_selected".to_string(),
            _ if chosen.is_soft_demoted(now_epoch_ms) => {
                "last_eligible_soft_demoted_fallback".to_string()
            }
            _ => format!("selected_via_{}", self.strategy.as_str()),
        };

        Ok(RoutingReceipt {
            request_id: request.request_id.clone(),
            model: request.model.clone(),
            selected_candidate_id: chosen.config.candidate_id.clone(),
            provider_id: chosen.config.provider_id.clone(),
            selected_origin: origin_str,
            proxy_origin: chosen.config.proxy_origin.clone(),
            health_state: eff_state,
            route_priority: chosen.config.route_priority,
            strategy: self.strategy,
            attempt_number: request.attempt_number,
            quota_certainty: chosen.config.quota_certainty,
            considered_candidates: considered,
            suppressed_candidates: suppressed,
            reason,
            sanitized_headers: sanitize_receipt_headers(&request.request_headers),
            timestamp_epoch_ms: now_epoch_ms,
        })
    }

    /// Updates a candidate's health/circuit-breaker state from an HTTP attempt result.
    /// Client faults (`400`, `409`, `413`, `422`) never penalize credentials or trip circuits.
    pub fn record_outcome(
        &mut self,
        candidate_id: &str,
        model: &str,
        http_status: u16,
        retry_after_ms: Option<u64>,
        scope: FailureScope,
        now_epoch_ms: u64,
    ) {
        let Some(cand) = self
            .candidates
            .iter_mut()
            .find(|c| c.config.candidate_id == candidate_id)
        else {
            return;
        };
        cand.last_status = Some(http_status);

        if (200..300).contains(&http_status) {
            cand.state = if cand.config.enabled {
                ProxyHealthState::Healthy
            } else {
                ProxyHealthState::Unavailable
            };
            cand.consecutive_failures = 0;
            cand.backoff_level = 0;
            cand.cooldown_until_ms = None;
            cand.soft_fail_until_ms = None;
            cand.model_cooldowns_ms.remove(model);
            cand.model_lock_streak.remove(model);
            cand.last_reason = Some("upstream_ok".to_string());
            return;
        }

        if CLIENT_FAULT_EXEMPT_STATUSES.contains(&http_status) {
            cand.last_reason = Some(format!("client_fault_exempt_http_{http_status}"));
            return;
        }

        match scope {
            FailureScope::None => {
                cand.soft_fail_until_ms =
                    Some(now_epoch_ms.saturating_add(DEFAULT_SOFT_FAIL_WINDOW_MS));
                cand.last_reason = Some(format!("soft_demoted_http_{http_status}"));
            }
            FailureScope::AccountManual | FailureScope::AccountSuspended => {
                cand.state = ProxyHealthState::Unavailable;
                cand.cooldown_until_ms = None;
                cand.last_reason = Some(format!("quarantined_{}", scope.as_str()));
            }
            FailureScope::AccountQuota => {
                let dur = retry_after_ms.unwrap_or(DEFAULT_MAX_COOLDOWN_MS);
                cand.state = ProxyHealthState::Cooldown;
                cand.backoff_level = (cand.backoff_level + 1).min(DEFAULT_MAX_BACKOFF_LEVEL);
                cand.consecutive_failures = cand.consecutive_failures.saturating_add(1);
                cand.cooldown_until_ms = Some(now_epoch_ms.saturating_add(dur));
                cand.last_reason = Some(format!("quota_cooldown_http_{http_status}"));
            }
            FailureScope::ModelCooldown | FailureScope::ModelEntitlement => {
                let dur = if scope == FailureScope::ModelEntitlement {
                    DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS
                } else {
                    retry_after_ms.unwrap_or(DEFAULT_MODEL_MISSING_COOLDOWN_MS)
                };
                cand.model_cooldowns_ms
                    .insert(model.to_string(), now_epoch_ms.saturating_add(dur));
                let streak = cand.model_lock_streak.entry(model.to_string()).or_insert(0);
                *streak = streak.saturating_add(1);
                if *streak >= DEFAULT_MODEL_LOCK_ESCALATION_LEVEL {
                    cand.state = ProxyHealthState::Tripped;
                    cand.cooldown_until_ms =
                        Some(now_epoch_ms.saturating_add(DEFAULT_MAX_COOLDOWN_MS));
                    cand.last_reason = Some("model_lock_escalated_to_tripped".to_string());
                } else {
                    cand.last_reason = Some(format!("model_cooldown_{}", scope.as_str()));
                }
            }
            FailureScope::AccountCooldown => {
                cand.consecutive_failures = cand.consecutive_failures.saturating_add(1);
                cand.backoff_level = (cand.backoff_level + 1).min(DEFAULT_MAX_BACKOFF_LEVEL);
                let exp = DEFAULT_BASE_BACKOFF_MS
                    .saturating_mul(1_u64 << cand.backoff_level.saturating_sub(1))
                    .min(DEFAULT_MAX_COOLDOWN_MS);
                let wait_ms = retry_after_ms.map(|ra| ra.max(exp)).unwrap_or(exp);
                cand.cooldown_until_ms = Some(now_epoch_ms.saturating_add(wait_ms));
                cand.state = if cand.backoff_level >= 2 {
                    ProxyHealthState::Tripped
                } else {
                    ProxyHealthState::Cooldown
                };
                cand.last_reason = Some(format!("account_backoff_level_{}", cand.backoff_level));
            }
        }
    }

    fn pick_within_tier(&mut self, tier_indices: &[usize], request_id: &str) -> usize {
        if tier_indices.len() == 1 {
            return tier_indices[0];
        }

        // Every Nth call, prefer an unproven candidate if present to verify liveness cleanly.
        if self
            .pick_counter
            .is_multiple_of(DEFAULT_PROBE_UNPROVEN_EVERY)
        {
            if let Some(&unproven_idx) = tier_indices
                .iter()
                .find(|&&i| !self.candidates[i].config.proven)
            {
                return unproven_idx;
            }
        }

        match self.strategy {
            RoutingStrategy::FillFirst => tier_indices[0],
            RoutingStrategy::RoundRobin => {
                let offset = ((self.pick_counter - 1) as usize) % tier_indices.len();
                tier_indices[offset]
            }
            RoutingStrategy::WeightedRoundRobin => {
                let total_weight: i64 = tier_indices
                    .iter()
                    .map(|&i| self.candidates[i].config.weight as i64)
                    .sum();
                let mut best_idx = tier_indices[0];
                let mut best_score = i64::MIN;
                for &idx in tier_indices {
                    let cid = self.candidates[idx].config.candidate_id.clone();
                    let w = self.candidates[idx].config.weight as i64;
                    let cur = self.wrr_counters.entry(cid).or_insert(0);
                    *cur += w;
                    if *cur > best_score {
                        best_score = *cur;
                        best_idx = idx;
                    }
                }
                let chosen_id = self.candidates[best_idx].config.candidate_id.clone();
                if let Some(cur) = self.wrr_counters.get_mut(&chosen_id) {
                    *cur -= total_weight;
                }
                best_idx
            }
            RoutingStrategy::WeightedRandom => {
                let total_weight: u64 = tier_indices
                    .iter()
                    .map(|&i| self.candidates[i].config.weight as u64)
                    .sum();
                let digest = sha256_hex(format!("{request_id}:{}", self.pick_counter).as_bytes());
                let seed = u64::from_str_radix(&digest[..16], 16).unwrap_or(0);
                let mut target = seed % total_weight.max(1);
                for &idx in tier_indices {
                    let w = self.candidates[idx].config.weight as u64;
                    if target < w {
                        return idx;
                    }
                    target -= w;
                }
                tier_indices[0]
            }
        }
    }
}

/// Redacts API keys, cookies, `Authorization`, and sensitive proxy headers before recording receipts.
#[must_use]
pub fn sanitize_receipt_headers(headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in headers {
        let lower = k.trim().to_ascii_lowercase();
        if is_sensitive_key_name(&lower)
            || lower == "proxy-authorization"
            || lower == "proxy_authorization"
            || lower == "cookie"
            || lower == "set-cookie"
        {
            out.insert(lower, REDACTED_SECRET.to_string());
        } else {
            let (cleaned, _) = redact_secrets_in_text(v);
            out.insert(lower, cleaned);
        }
    }
    out
}

fn reject_inline_secrets_in_object(
    obj: &Map<String, Value>,
    path_prefix: &str,
) -> Result<(), ProxyRouterError> {
    for (key, val) in obj {
        let full_path = format!("{path_prefix}.{key}");
        if is_sensitive_key_name(key) {
            if let Some(s) = val.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty()
                    && !is_safe_placeholder(trimmed)
                    && extract_env_reference(trimmed).is_none()
                {
                    return Err(ProxyRouterError::InlineSecretForbidden { field: full_path });
                }
            }
        }
        if let Some(s) = val.as_str() {
            let (_, kinds) = redact_secrets_in_text(s);
            if !kinds.is_empty() && extract_env_reference(s).is_none() {
                return Err(ProxyRouterError::InlineSecretForbidden { field: full_path });
            }
        } else if let Some(nested) = val.as_object() {
            reject_inline_secrets_in_object(nested, &full_path)?;
        }
    }
    Ok(())
}

fn detect_fallback_cycles(candidates: &[ProxyCandidateConfig]) -> Result<(), ProxyRouterError> {
    let graph: BTreeMap<&str, &[String]> = candidates
        .iter()
        .map(|c| (c.candidate_id.as_str(), c.fallback_chain.as_slice()))
        .collect();
    let mut state: BTreeMap<&str, u8> = BTreeMap::new();
    for c in candidates {
        dfs_cycle(c.candidate_id.as_str(), &graph, &mut state)?;
    }
    Ok(())
}

fn dfs_cycle<'a>(
    node: &'a str,
    graph: &BTreeMap<&'a str, &'a [String]>,
    state: &mut BTreeMap<&'a str, u8>,
) -> Result<(), ProxyRouterError> {
    match state.get(node).copied() {
        Some(1) => return Err(ProxyRouterError::CycleDetected(node.to_string())),
        Some(2) => return Ok(()),
        _ => {}
    }
    state.insert(node, 1);
    if let Some(neighbors) = graph.get(node) {
        for next in *neighbors {
            dfs_cycle(next.as_str(), graph, state)?;
        }
    }
    state.insert(node, 2);
    Ok(())
}

fn clean_non_empty(
    obj: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<String, ProxyRouterError> {
    let val = keys
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ProxyRouterError::InvalidConfig(format!("missing required '{label}'")))?;
    if has_control_chars(val) || has_bidi_controls(val) {
        return Err(ProxyRouterError::InvalidConfig(format!(
            "'{label}' contains forbidden control or bidi characters"
        )));
    }
    Ok(val.to_string())
}

fn is_env_var_name(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inline_secrets_cycles_and_spoofed_headers() {
        let fake_sk = format!("{}-{}-{}", "sk", "proj", "secret1234567890abcdef");
        let with_secret = json!({
            "candidates": [{
                "candidate_id": "acc-1",
                "upstream_url": "https://api.openai.com/v1",
                "api_key": fake_sk
            }]
        });
        assert!(matches!(
            normalize_proxy_route_config(&with_secret, &ProxyConfigPolicy::default()),
            Err(ProxyRouterError::InlineSecretForbidden { .. })
        ));

        let with_cycle = json!({
            "candidates": [
                {"candidate_id": "a", "upstream_url": "https://a.example.com/v1", "fallback_chain": ["b"]},
                {"candidate_id": "b", "upstream_url": "https://b.example.com/v1", "fallback_chain": ["a"]}
            ]
        });
        assert!(matches!(
            normalize_proxy_route_config(&with_cycle, &ProxyConfigPolicy::default()),
            Err(ProxyRouterError::CycleDetected(_))
        ));

        let spoof = json!({
            "trust_forwarded_headers": true,
            "candidates": [
                {"candidate_id": "remote", "upstream_url": "https://remote.example.com/v1"}
            ]
        });
        assert!(matches!(
            normalize_proxy_route_config(&spoof, &ProxyConfigPolicy::default()),
            Err(ProxyRouterError::AntiSpoofViolation(_))
        ));
    }

    #[test]
    fn deterministic_failover_circuit_breaker_and_secret_free_receipts() {
        let cfg = normalize_proxy_route_config(
            &json!({
                "strategy": "fill_first",
                "candidates": [
                    {
                        "candidate_id": "primary",
                        "provider_id": "anthropic",
                        "upstream_url": "https://api.anthropic.com/v1?utm_source=test",
                        "env_var": "${ANTHROPIC_API_KEY}",
                        "route_priority": 100
                    },
                    {
                        "candidate_id": "backup",
                        "provider_id": "anthropic",
                        "upstream_url": "https://backup.anthropic.example.com/v1",
                        "env_var": "${ANTHROPIC_BACKUP_KEY}",
                        "route_priority": 50
                    }
                ]
            }),
            &ProxyConfigPolicy::default(),
        )
        .expect("valid normalized proxy config");

        let mut router = ProxyRouter::new(cfg);
        let mut headers = BTreeMap::new();
        headers.insert(
            "Authorization".into(),
            "Bearer super-secret-jwt-value".into(),
        );
        headers.insert("Cookie".into(), "session=xyz".into());
        headers.insert("X-Request-Trace".into(), "trace-42".into());

        let req = RouteSelectionRequest {
            request_id: "req-1".into(),
            model: "claude-sonnet-4".into(),
            attempt_number: 1,
            excluded_candidates: vec![],
            request_headers: headers,
        };

        let receipt1 = router.select_route(&req, 1_000).expect("select primary");
        assert_eq!(receipt1.selected_candidate_id, "primary");
        assert_eq!(receipt1.health_state, ProxyHealthState::Healthy);
        let receipt_json = serde_json::to_value(&receipt1).expect("serialize receipt");
        assert!(detect_json_secrets(&receipt_json).is_empty());
        assert_eq!(
            receipt1
                .sanitized_headers
                .get("authorization")
                .map(String::as_str),
            Some(REDACTED_SECRET)
        );
        assert_eq!(
            receipt1.sanitized_headers.get("cookie").map(String::as_str),
            Some(REDACTED_SECRET)
        );

        // Client 400 error MUST NOT penalize primary!
        router.record_outcome(
            "primary",
            "claude-sonnet-4",
            400,
            None,
            FailureScope::AccountCooldown,
            2_000,
        );
        assert_eq!(
            router.candidates()[0].effective_state("claude-sonnet-4", 2_000),
            ProxyHealthState::Healthy
        );

        // Two transient 503s trip circuit breaker on primary -> fail over to backup!
        router.record_outcome(
            "primary",
            "claude-sonnet-4",
            503,
            None,
            FailureScope::AccountCooldown,
            3_000,
        );
        assert_eq!(
            router.candidates()[0].effective_state("claude-sonnet-4", 3_000),
            ProxyHealthState::Cooldown
        );
        router.record_outcome(
            "primary",
            "claude-sonnet-4",
            503,
            Some(60_000),
            FailureScope::AccountCooldown,
            4_000,
        );
        assert_eq!(
            router.candidates()[0].effective_state("claude-sonnet-4", 4_000),
            ProxyHealthState::Tripped
        );

        let receipt2 = router
            .select_route(&req, 5_000)
            .expect("failover to backup");
        assert_eq!(receipt2.selected_candidate_id, "backup");

        // After cooldown expires, primary becomes half-open Cooldown probe candidate.
        let receipt3 = router.select_route(&req, 65_000).expect("half-open probe");
        assert_eq!(receipt3.selected_candidate_id, "primary");
        assert_eq!(receipt3.health_state, ProxyHealthState::Cooldown);

        // Successful probe restores primary to Healthy.
        router.record_outcome(
            "primary",
            "claude-sonnet-4",
            200,
            None,
            FailureScope::None,
            66_000,
        );
        assert_eq!(
            router.candidates()[0].effective_state("claude-sonnet-4", 66_000),
            ProxyHealthState::Healthy
        );
    }
}
