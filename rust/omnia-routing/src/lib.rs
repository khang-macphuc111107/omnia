#![forbid(unsafe_code)]

//! Deterministic provider, model, quota, latency, and circuit-breaker router.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use omnia_core::{now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod model_roles;
pub mod scheduler_sota;
pub mod sqlite_store;
pub mod wire_adapter;

pub use model_roles::{
    apply_reasoning_effort_wire, can_replay_cryptographic_proof, clamp_effort_for_model,
    effort_spec_for_model, intrinsic_role_affinity, normalize_model_family_key, EffortLevel,
    EffortWireMode, ModelEffortSpec, ModelRole,
};
pub use scheduler_sota::{
    classify_post_dispatch_outcome, detect_retired_model_notice, splitmix64_next,
    ComboDefinition, ComboProbeOutcome, ComboProbeTarget, ComboRegistry, ComboResolution,
    ComboStrategy, DispatchOutcomeClass, ModelRetiredError, NotServedDecision, NotServedTracker,
    PostDispatchClassification, PostDispatchInput, QuotaResetPoolStatus, COMBO_MAX_DEPTH,
    COMBO_PROBE_INTERVAL_MS, DEFAULT_SOFT_FAIL_WINDOW_MS, MAX_QUOTA_EXHAUSTION_MS,
};
pub use sqlite_store::RouterSqliteStore;

/// Default 1-in-N probe cadence for unproven credentials (`htmustc-proxy/internal/proxy/scheduler.go`).
pub const DEFAULT_PROBE_UNPROVEN_EVERY: u64 = 4;

pub use wire_adapter::{
    compute_cache_shape_hash, evaluate_local_vram_fit, normalize_provider_wire_payload,
    sanitize_input_tool_names, sort_tools_stable, validate_anthropic_cache_breakpoints,
    CacheShapeDigest, LocalVramFitDecision, LocalVramPolicy, NormalizedWirePayload,
    ProviderWireDialect, WireAdapterError, DEFAULT_DWM_UI_HEADROOM_MB,
    DEFAULT_MAX_AUX_MODEL_VRAM_MB, ENFORCED_LOCAL_VRAM_SEMAPHORE,
};

const MAX_LATENCY_SAMPLES: usize = 256;
const MAX_RECEIPT_HISTORY: usize = 2_048;
const MAX_IDEMPOTENCY_ENTRIES: usize = 2_048;
const MAX_TERMINAL_RESERVATIONS: usize = 4_096;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS: i64 = 30_000;

/// Errors returned by [`DynamicProviderRouter`] state mutations and validations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RoutingError {
    #[error("candidate id must not be empty")]
    InvalidCandidateId,
    #[error("unknown candidate `{0}`")]
    UnknownCandidate(String),
    #[error("unknown reservation `{0}`")]
    UnknownReservation(String),
    #[error("stale fencing token for reservation `{reservation_id}`: expected {expected}, got {provided}")]
    StaleFencingToken {
        reservation_id: String,
        expected: u64,
        provided: u64,
    },
    #[error("reservation `{0}` is already terminally reconciled")]
    AlreadyReconciled(String),
    #[error("reservation `{reservation_id}` cannot be transitioned from `{state}`")]
    InvalidReservationTransition {
        reservation_id: String,
        state: &'static str,
    },
    #[error("reservation `{reservation_id}` missed deadline {deadline_ms} at {now_ms}")]
    ReservationDeadlineExpired {
        reservation_id: String,
        deadline_ms: i64,
        now_ms: i64,
    },
    #[error("invalid routing policy: {0}")]
    InvalidPolicy(String),
    #[error("invalid router persistence state: {0}")]
    InvalidState(String),
    #[error("router internal lock poisoned")]
    InternalLockPoisoned,
}

/// Ordered data privacy classification; higher tiers strictly satisfy lower requirements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum PrivacyTier {
    Public = 0,
    ZeroDataRetention = 1,
    PrivateVpc = 2,
    LocalOnly = 3,
}

impl PrivacyTier {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "Public",
            Self::ZeroDataRetention => "ZeroDataRetention",
            Self::PrivateVpc => "PrivateVpc",
            Self::LocalOnly => "LocalOnly",
        }
    }
}

/// Task risk tier controlling emergency quota policy overrides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum TaskRisk {
    Low = 0,
    Standard = 1,
    High = 2,
    Critical = 3,
}

impl TaskRisk {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Standard => "Standard",
            Self::High => "High",
            Self::Critical => "Critical",
        }
    }
}

/// Scope permitted when selecting a fallback after an earlier failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FallbackScope {
    None = 0,
    SameProviderOnly = 1,
    SamePrivacyBoundary = 2,
}

impl FallbackScope {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::SameProviderOnly => "SameProviderOnly",
            Self::SamePrivacyBoundary => "SamePrivacyBoundary",
        }
    }
}

/// Policy controlling whether unknown or stale quota may ever be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EmergencyQuotaMode {
    Deny = 0,
    AllowEmergencyReserve = 1,
    AllowStaleQuotaWithCap = 2,
}

impl EmergencyQuotaMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "Deny",
            Self::AllowEmergencyReserve => "AllowEmergencyReserve",
            Self::AllowStaleQuotaWithCap => "AllowStaleQuotaWithCap",
        }
    }
}

/// Truthful provider quota state distinguishing known, unknown, stale, and contradictory data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuotaState {
    Known {
        remaining_tokens: i64,
        remaining_requests: i64,
        window_capacity_tokens: i64,
        window_duration_ms: i64,
        window_reset_at_ms: Option<i64>,
        freshness_timestamp_ms: Option<i64>,
        max_staleness_ms: i64,
    },
    Unknown {
        reason: String,
    },
    Stale {
        last_known_remaining_tokens: i64,
        last_known_remaining_requests: i64,
        freshness_timestamp_ms: Option<i64>,
        max_staleness_ms: i64,
        window_capacity_tokens: i64,
        window_duration_ms: i64,
        window_reset_at_ms: Option<i64>,
        reason: String,
    },
    Contradictory {
        reason: String,
        freshness_timestamp_ms: Option<i64>,
    },
}

impl Default for QuotaState {
    fn default() -> Self {
        Self::Unknown {
            reason: "quota not yet observed".to_owned(),
        }
    }
}

impl QuotaState {
    /// Construct a fresh [`QuotaState::Known`] snapshot with a 60s staleness window.
    #[must_use]
    pub fn known(remaining_tokens: i64, remaining_requests: i64) -> Self {
        Self::Known {
            remaining_tokens,
            remaining_requests,
            window_capacity_tokens: 0,
            window_duration_ms: 0,
            window_reset_at_ms: None,
            freshness_timestamp_ms: None,
            max_staleness_ms: 60_000,
        }
    }

    #[must_use]
    pub fn known_with_window(
        remaining_tokens: i64,
        remaining_requests: i64,
        window_capacity_tokens: i64,
        window_duration_ms: i64,
        window_reset_at_ms: Option<i64>,
        freshness_timestamp_ms: Option<i64>,
        max_staleness_ms: i64,
    ) -> Self {
        Self::Known {
            remaining_tokens,
            remaining_requests,
            window_capacity_tokens,
            window_duration_ms,
            window_reset_at_ms,
            freshness_timestamp_ms,
            max_staleness_ms,
        }
    }

    #[must_use]
    pub fn unknown(reason: impl Into<String>) -> Self {
        Self::Unknown {
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn stale(
        last_known_remaining_tokens: i64,
        last_known_remaining_requests: i64,
        reason: impl Into<String>,
    ) -> Self {
        Self::Stale {
            last_known_remaining_tokens,
            last_known_remaining_requests,
            freshness_timestamp_ms: None,
            max_staleness_ms: 60_000,
            window_capacity_tokens: 0,
            window_duration_ms: 0,
            window_reset_at_ms: None,
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn contradictory(reason: impl Into<String>) -> Self {
        Self::Contradictory {
            reason: reason.into(),
            freshness_timestamp_ms: None,
        }
    }

    #[must_use]
    pub const fn kind_str(&self) -> &'static str {
        match self {
            Self::Known { .. } => "Known",
            Self::Unknown { .. } => "Unknown",
            Self::Stale { .. } => "Stale",
            Self::Contradictory { .. } => "Contradictory",
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Known {
                remaining_tokens,
                remaining_requests,
                window_capacity_tokens,
                window_duration_ms,
                window_reset_at_ms,
                freshness_timestamp_ms,
                max_staleness_ms,
            } => json!({
                "kind": "Known",
                "remaining_tokens": remaining_tokens,
                "remaining_requests": remaining_requests,
                "window_capacity_tokens": window_capacity_tokens,
                "window_duration_ms": window_duration_ms,
                "window_reset_at_ms": window_reset_at_ms,
                "freshness_timestamp_ms": freshness_timestamp_ms,
                "max_staleness_ms": max_staleness_ms,
            }),
            Self::Unknown { reason } => json!({
                "kind": "Unknown",
                "reason": SecretRedactor::redact(reason),
            }),
            Self::Stale {
                last_known_remaining_tokens,
                last_known_remaining_requests,
                freshness_timestamp_ms,
                max_staleness_ms,
                window_capacity_tokens,
                window_duration_ms,
                window_reset_at_ms,
                reason,
            } => json!({
                "kind": "Stale",
                "last_known_remaining_tokens": last_known_remaining_tokens,
                "last_known_remaining_requests": last_known_remaining_requests,
                "freshness_timestamp_ms": freshness_timestamp_ms,
                "max_staleness_ms": max_staleness_ms,
                "window_capacity_tokens": window_capacity_tokens,
                "window_duration_ms": window_duration_ms,
                "window_reset_at_ms": window_reset_at_ms,
                "reason": SecretRedactor::redact(reason),
            }),
            Self::Contradictory {
                reason,
                freshness_timestamp_ms,
            } => json!({
                "kind": "Contradictory",
                "reason": SecretRedactor::redact(reason),
                "freshness_timestamp_ms": freshness_timestamp_ms,
            }),
        }
    }
}

/// Circuit breaker state per candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CircuitState {
    #[default]
    Closed,
    Open {
        opened_at_ms: i64,
        cooldown_ms: i64,
    },
    HalfOpen {
        probe_in_flight: bool,
    },
}

impl CircuitState {
    #[must_use]
    pub const fn kind_str(&self) -> &'static str {
        match self {
            Self::Closed => "Closed",
            Self::Open { .. } => "Open",
            Self::HalfOpen { .. } => "HalfOpen",
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Closed => json!({ "state": "Closed" }),
            Self::Open {
                opened_at_ms,
                cooldown_ms,
            } => json!({
                "state": "Open",
                "opened_at_ms": opened_at_ms,
                "cooldown_ms": cooldown_ms,
            }),
            Self::HalfOpen { probe_in_flight } => json!({
                "state": "HalfOpen",
                "probe_in_flight": probe_in_flight,
            }),
        }
    }
}

/// Whether a failed remote attempt reached and was accepted by the upstream endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcceptanceState {
    NotSent,
    Accepted,
    Unknown,
}

impl AcceptanceState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotSent => "NotSent",
            Self::Accepted => "Accepted",
            Self::Unknown => "Unknown",
        }
    }
}

/// Lifecycle state of an in-flight or completed routing reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReservationStatus {
    ReservedNotDispatched,
    InFlight,
    ReconciledCharged,
    ReconciledReleased,
    ReconciledUnknownUsage,
    OperatorRecoveryRequired,
    OrphanedOnRestart,
}

impl ReservationStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReservedNotDispatched => "ReservedNotDispatched",
            Self::InFlight => "InFlight",
            Self::ReconciledCharged => "ReconciledCharged",
            Self::ReconciledReleased => "ReconciledReleased",
            Self::ReconciledUnknownUsage => "ReconciledUnknownUsage",
            Self::OperatorRecoveryRequired => "OperatorRecoveryRequired",
            Self::OrphanedOnRestart => "OrphanedOnRestart",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::ReconciledCharged
                | Self::ReconciledReleased
                | Self::ReconciledUnknownUsage
                | Self::OperatorRecoveryRequired
                | Self::OrphanedOnRestart
        )
    }
}

/// Capability flags used both for candidate declarations and request requirements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub supports_tools: bool,
    pub supports_structured_output: bool,
    pub supports_vision: bool,
    pub supports_streaming: bool,
    pub supports_reasoning: bool,
    pub supports_json_mode: bool,
}

impl ModelCapabilities {
    /// Standard text + tool + structured-output capabilities for a modern model candidate.
    #[must_use]
    pub const fn standard_candidate() -> Self {
        Self {
            supports_tools: true,
            supports_structured_output: true,
            supports_vision: false,
            supports_streaming: true,
            supports_reasoning: true,
            supports_json_mode: true,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "supports_tools": self.supports_tools,
            "supports_structured_output": self.supports_structured_output,
            "supports_vision": self.supports_vision,
            "supports_streaming": self.supports_streaming,
            "supports_reasoning": self.supports_reasoning,
            "supports_json_mode": self.supports_json_mode,
        })
    }
}

/// Policy override settings for unknown or stale quota conditions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmergencyQuotaPolicy {
    pub mode: EmergencyQuotaMode,
    pub emergency_reserve_tokens: i64,
    pub stale_fallback_cap_tokens: i64,
    pub allow_on_critical_risk: bool,
}

impl Default for EmergencyQuotaPolicy {
    fn default() -> Self {
        Self {
            mode: EmergencyQuotaMode::Deny,
            emergency_reserve_tokens: 0,
            stale_fallback_cap_tokens: 0,
            allow_on_critical_risk: false,
        }
    }
}

impl EmergencyQuotaPolicy {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "mode": self.mode.as_str(),
            "emergency_reserve_tokens": self.emergency_reserve_tokens,
            "stale_fallback_cap_tokens": self.stale_fallback_cap_tokens,
            "allow_on_critical_risk": self.allow_on_critical_risk,
        })
    }
}

/// Static + pricing definition for one routable provider/model endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RouteCandidate {
    pub candidate_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub auth_boundary: String,
    pub region: String,
    pub privacy_tier: PrivacyTier,
    pub capabilities: ModelCapabilities,
    pub context_limit_tokens: u64,
    pub max_output_tokens: u64,
    pub quality_tier: i32,
    pub pricing_version: String,
    pub input_cost_per_million_microunits: Option<i64>,
    pub output_cost_per_million_microunits: Option<i64>,
    pub credential_present: bool,
    pub enabled: bool,
    pub route_priority: i32,
    #[serde(default)]
    pub supported_roles: Vec<ModelRole>,
}

impl Default for RouteCandidate {
    fn default() -> Self {
        Self {
            candidate_id: String::new(),
            provider_id: String::new(),
            model_id: String::new(),
            auth_boundary: "workspace:default".to_owned(),
            region: "us".to_owned(),
            privacy_tier: PrivacyTier::ZeroDataRetention,
            capabilities: ModelCapabilities::standard_candidate(),
            context_limit_tokens: 128_000,
            max_output_tokens: 16_384,
            quality_tier: 3,
            pricing_version: "v1".to_owned(),
            input_cost_per_million_microunits: Some(3_000_000),
            output_cost_per_million_microunits: Some(15_000_000),
            credential_present: true,
            enabled: true,
            route_priority: 0,
            supported_roles: Vec::new(),
        }
    }
}

impl RouteCandidate {
    /// Ceiling-rounded cost estimate in microunits (`1e-6` currency units).
    #[must_use]
    pub fn estimate_cost_microunits(&self, input_tokens: u64, output_tokens: u64) -> Option<i64> {
        let in_rate = self.input_cost_per_million_microunits?;
        let out_rate = self.output_cost_per_million_microunits?;
        if in_rate < 0 || out_rate < 0 {
            return None;
        }
        let in_cost =
            (u128::from(input_tokens) * u128::from(in_rate as u64)).div_ceil(1_000_000u128);
        let out_cost =
            (u128::from(output_tokens) * u128::from(out_rate as u64)).div_ceil(1_000_000u128);
        let total = in_cost.checked_add(out_cost)?;
        i64::try_from(total).ok()
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "candidate_id": self.candidate_id,
            "provider_id": self.provider_id,
            "model_id": self.model_id,
            "auth_boundary": self.auth_boundary,
            "region": self.region,
            "privacy_tier": self.privacy_tier.as_str(),
            "capabilities": self.capabilities.to_json(),
            "context_limit_tokens": self.context_limit_tokens,
            "max_output_tokens": self.max_output_tokens,
            "quality_tier": self.quality_tier,
            "pricing_version": self.pricing_version,
            "input_cost_per_million_microunits": self.input_cost_per_million_microunits,
            "output_cost_per_million_microunits": self.output_cost_per_million_microunits,
            "credential_present": self.credential_present,
            "enabled": self.enabled,
            "route_priority": self.route_priority,
            "supported_roles": self.supported_roles,
        })
    }
}

/// Live mutable telemetry, quota, reservation, and circuit state for one candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CandidateResourceState {
    pub quota: QuotaState,
    pub circuit: CircuitState,
    pub retry_after_until_ms: Option<i64>,
    pub consecutive_failures: u32,
    pub total_calls: u64,
    pub success_count: u64,
    pub ewma_latency_ms: Option<f64>,
    pub latency_samples_ms: VecDeque<f64>,
    pub reserved_tokens: i64,
    pub reserved_requests: i64,
    #[serde(default)]
    pub quota_exhausted_until_ms: Option<i64>,
    #[serde(default)]
    pub model_proven: BTreeMap<String, bool>,
    #[serde(default)]
    pub model_locks_until_ms: BTreeMap<String, i64>,
    #[serde(default)]
    pub soft_fail_until_ms: Option<i64>,
    #[serde(default)]
    pub provider_quota_reset_until_ms: Option<i64>,
}

impl Default for CandidateResourceState {
    fn default() -> Self {
        Self {
            quota: QuotaState::default(),
            circuit: CircuitState::Closed,
            retry_after_until_ms: None,
            consecutive_failures: 0,
            total_calls: 0,
            success_count: 0,
            ewma_latency_ms: None,
            latency_samples_ms: VecDeque::new(),
            reserved_tokens: 0,
            reserved_requests: 0,
            quota_exhausted_until_ms: None,
            model_proven: BTreeMap::new(),
            model_locks_until_ms: BTreeMap::new(),
            soft_fail_until_ms: None,
            provider_quota_reset_until_ms: None,
        }
    }
}

impl CandidateResourceState {
    /// Advance wall-clock state: expire cooldowns, Retry-After windows, soft-fail demotions,
    /// stated quota resets, or stale/rolled-over quotas.
    pub fn advance_time(&mut self, now_ms: i64) {
        if let CircuitState::Open {
            opened_at_ms,
            cooldown_ms,
        } = self.circuit
        {
            if now_ms >= opened_at_ms.saturating_add(cooldown_ms) {
                self.circuit = CircuitState::HalfOpen {
                    probe_in_flight: false,
                };
            }
        }
        if let Some(until) = self.retry_after_until_ms {
            if now_ms >= until {
                self.retry_after_until_ms = None;
            }
        }
        if let Some(until) = self.soft_fail_until_ms {
            if now_ms >= until {
                self.soft_fail_until_ms = None;
            }
        }
        if let Some(until) = self.provider_quota_reset_until_ms {
            if now_ms >= until {
                self.provider_quota_reset_until_ms = None;
            }
        }
        let next_quota = match &self.quota {
            QuotaState::Known {
                remaining_tokens,
                remaining_requests,
                window_capacity_tokens,
                window_duration_ms,
                window_reset_at_ms,
                freshness_timestamp_ms,
                max_staleness_ms,
            } => {
                if let Some(reset_at) = *window_reset_at_ms {
                    if now_ms >= reset_at {
                        if *window_capacity_tokens > 0 && *window_duration_ms > 0 {
                            let elapsed = now_ms.saturating_sub(reset_at);
                            let steps = (elapsed / *window_duration_ms).saturating_add(1);
                            let next_reset =
                                reset_at.saturating_add(steps.saturating_mul(*window_duration_ms));
                            Some(QuotaState::Known {
                                remaining_tokens: *window_capacity_tokens,
                                remaining_requests: (*remaining_requests).max(100),
                                window_capacity_tokens: *window_capacity_tokens,
                                window_duration_ms: *window_duration_ms,
                                window_reset_at_ms: Some(next_reset),
                                freshness_timestamp_ms: Some(now_ms),
                                max_staleness_ms: *max_staleness_ms,
                            })
                        } else {
                            Some(QuotaState::Stale {
                                last_known_remaining_tokens: *remaining_tokens,
                                last_known_remaining_requests: *remaining_requests,
                                freshness_timestamp_ms: *freshness_timestamp_ms,
                                max_staleness_ms: *max_staleness_ms,
                                window_capacity_tokens: *window_capacity_tokens,
                                window_duration_ms: *window_duration_ms,
                                window_reset_at_ms: *window_reset_at_ms,
                                reason: "quota window expired without rollover capacity".to_owned(),
                            })
                        }
                    } else {
                        check_staleness(
                            *remaining_tokens,
                            *remaining_requests,
                            *window_capacity_tokens,
                            *window_duration_ms,
                            *window_reset_at_ms,
                            *freshness_timestamp_ms,
                            *max_staleness_ms,
                            now_ms,
                        )
                    }
                } else {
                    check_staleness(
                        *remaining_tokens,
                        *remaining_requests,
                        *window_capacity_tokens,
                        *window_duration_ms,
                        *window_reset_at_ms,
                        *freshness_timestamp_ms,
                        *max_staleness_ms,
                        now_ms,
                    )
                }
            }
            _ => None,
        };
        if let Some(updated) = next_quota {
            self.quota = updated;
        }
    }

    /// Record a finite non-negative latency observation into EWMA and the bounded ring buffer.
    pub fn record_latency(&mut self, sample_ms: f64) {
        if !sample_ms.is_finite() || sample_ms < 0.0 {
            return;
        }
        self.ewma_latency_ms = Some(match self.ewma_latency_ms {
            Some(prev) => prev * 0.75 + sample_ms * 0.25,
            None => sample_ms,
        });
        if self.latency_samples_ms.len() >= MAX_LATENCY_SAMPLES {
            self.latency_samples_ms.pop_front();
        }
        self.latency_samples_ms.push_back(sample_ms);
    }

    /// Compute nearest-rank latency percentile (`1..=100`).
    #[must_use]
    pub fn latency_percentile(&self, percentile: usize) -> Option<f64> {
        if self.latency_samples_ms.is_empty() {
            return None;
        }
        let mut sorted: Vec<f64> = self.latency_samples_ms.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let pct = percentile.clamp(1, 100);
        let idx = (sorted.len() * pct).div_ceil(100).saturating_sub(1);
        sorted.get(idx).copied()
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "quota": self.quota.to_json(),
            "circuit": self.circuit.to_json(),
            "retry_after_until_ms": self.retry_after_until_ms,
            "quota_exhausted_until_ms": self.quota_exhausted_until_ms,
            "soft_fail_until_ms": self.soft_fail_until_ms,
            "provider_quota_reset_until_ms": self.provider_quota_reset_until_ms,
            "model_proven": self.model_proven,
            "model_locks_until_ms": self.model_locks_until_ms,
            "consecutive_failures": self.consecutive_failures,
            "total_calls": self.total_calls,
            "success_count": self.success_count,
            "ewma_latency_ms": self.ewma_latency_ms,
            "p95_latency_ms": self.latency_percentile(95),
            "reserved_tokens": self.reserved_tokens,
            "reserved_requests": self.reserved_requests,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn check_staleness(
    remaining_tokens: i64,
    remaining_requests: i64,
    window_capacity_tokens: i64,
    window_duration_ms: i64,
    window_reset_at_ms: Option<i64>,
    freshness_timestamp_ms: Option<i64>,
    max_staleness_ms: i64,
    now_ms: i64,
) -> Option<QuotaState> {
    if let Some(fresh) = freshness_timestamp_ms {
        if max_staleness_ms > 0 && now_ms.saturating_sub(fresh) > max_staleness_ms {
            return Some(QuotaState::Stale {
                last_known_remaining_tokens: remaining_tokens,
                last_known_remaining_requests: remaining_requests,
                freshness_timestamp_ms: Some(fresh),
                max_staleness_ms,
                window_capacity_tokens,
                window_duration_ms,
                window_reset_at_ms,
                reason: "quota freshness exceeded max_staleness_ms".to_owned(),
            });
        }
    }
    None
}

/// Request routing constraints and preferences.
///
/// `token_budget` strictly defaults to `None` so active goals never receive an
/// unrequested budget ceiling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteRequestPolicy {
    pub request_id: String,
    pub idempotency_key: String,
    pub required_auth_boundary: String,
    pub minimum_privacy_tier: PrivacyTier,
    pub task_risk: TaskRisk,
    pub required_capabilities: ModelCapabilities,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
    /// Explicit per-request token budget cap. ALWAYS defaults to `None`.
    pub token_budget: Option<u64>,
    pub max_cost_microunits: Option<i64>,
    pub max_ewma_latency_ms: Option<f64>,
    pub preferred_candidate_ids: Vec<String>,
    pub excluded_candidate_ids: Vec<String>,
    pub fallback_scope: FallbackScope,
    pub allow_unknown_quota_without_emergency: bool,
    pub emergency_policy: EmergencyQuotaPolicy,
    pub reservation_ttl_ms: i64,
    pub now_epoch_ms: Option<i64>,
    #[serde(default)]
    pub model_role: Option<ModelRole>,
    #[serde(default)]
    pub session_affinity_key: Option<String>,
    /// Optional absolute admission deadline (`epoch_ms`) enforced prior to dispatch (`AUD-14`).
    #[serde(default)]
    pub deadline_ms: Option<i64>,
    /// Optional monotonic region allowlist (empty = unrestricted; fallback intersects).
    #[serde(default)]
    pub allowed_regions: Vec<String>,
    /// Optional monotonic provider allowlist (empty = unrestricted; fallback intersects).
    #[serde(default)]
    pub allowed_providers: Vec<String>,
    /// Optional monotonic model allowlist (empty = unrestricted; fallback intersects).
    #[serde(default)]
    pub allowed_models: Vec<String>,
    /// Monotonic provider denylist (fallback unions).
    #[serde(default)]
    pub forbidden_providers: Vec<String>,
    /// Monotonic model denylist (fallback unions).
    #[serde(default)]
    pub forbidden_models: Vec<String>,
    /// Optional maximum data retention window in hours (`Some(0)` enforces zero-retention tiers; fallback takes `min`).
    #[serde(default)]
    pub max_retention_hours: Option<u32>,
}

impl Default for RouteRequestPolicy {
    fn default() -> Self {
        Self {
            request_id: String::new(),
            idempotency_key: String::new(),
            required_auth_boundary: "workspace:default".to_owned(),
            minimum_privacy_tier: PrivacyTier::ZeroDataRetention,
            task_risk: TaskRisk::Standard,
            required_capabilities: ModelCapabilities::default(),
            estimated_input_tokens: 1000,
            estimated_output_tokens: 500,
            token_budget: None,
            max_cost_microunits: None,
            max_ewma_latency_ms: None,
            preferred_candidate_ids: Vec::new(),
            excluded_candidate_ids: Vec::new(),
            fallback_scope: FallbackScope::SamePrivacyBoundary,
            allow_unknown_quota_without_emergency: false,
            emergency_policy: EmergencyQuotaPolicy::default(),
            reservation_ttl_ms: 300_000,
            now_epoch_ms: None,
            model_role: None,
            session_affinity_key: None,
            deadline_ms: None,
            allowed_regions: Vec::new(),
            allowed_providers: Vec::new(),
            allowed_models: Vec::new(),
            forbidden_providers: Vec::new(),
            forbidden_models: Vec::new(),
            max_retention_hours: None,
        }
    }
}

impl RouteRequestPolicy {
    /// Checked total token estimate returning `None` on `u64` overflow (`AUD-14`).
    #[must_use]
    pub fn estimated_total_tokens_checked(&self) -> Option<u64> {
        self.estimated_input_tokens
            .checked_add(self.estimated_output_tokens)
            .map(|v| v.max(1))
    }

    #[must_use]
    pub fn estimated_total_tokens(&self) -> u64 {
        self.estimated_total_tokens_checked().unwrap_or(u64::MAX)
    }

    /// Deterministic SHA-256 hash of the canonical routing constraint set.
    #[must_use]
    pub fn policy_hash(&self) -> String {
        let caps = self.required_capabilities;
        let mut canonical = format!(
            "auth={}|priv={}|risk={}|in={}|out={}|budget={}|caps={}{}{}{}{}{}",
            self.required_auth_boundary,
            self.minimum_privacy_tier.as_str(),
            self.task_risk as i64,
            self.estimated_input_tokens,
            self.estimated_output_tokens,
            self.token_budget
                .map_or_else(|| "none".to_owned(), |v| v.to_string()),
            u8::from(caps.supports_tools),
            u8::from(caps.supports_structured_output),
            u8::from(caps.supports_vision),
            u8::from(caps.supports_streaming),
            u8::from(caps.supports_reasoning),
            u8::from(caps.supports_json_mode),
        );
        if let Some(dl) = self.deadline_ms {
            canonical.push_str(&format!("|dl={dl}"));
        }
        if let Some(ret) = self.max_retention_hours {
            canonical.push_str(&format!("|ret={ret}"));
        }
        if !self.allowed_regions.is_empty() {
            canonical.push_str(&format!("|reg={}", self.allowed_regions.join(",")));
        }
        if !self.allowed_providers.is_empty() {
            canonical.push_str(&format!("|aprov={}", self.allowed_providers.join(",")));
        }
        if !self.allowed_models.is_empty() {
            canonical.push_str(&format!("|amod={}", self.allowed_models.join(",")));
        }
        if !self.forbidden_providers.is_empty() {
            canonical.push_str(&format!("|fprov={}", self.forbidden_providers.join(",")));
        }
        if !self.forbidden_models.is_empty() {
            canonical.push_str(&format!("|fmod={}", self.forbidden_models.join(",")));
        }
        sha256_hex(canonical.as_bytes())
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "request_id": self.request_id,
            "idempotency_key": self.idempotency_key,
            "required_auth_boundary": self.required_auth_boundary,
            "minimum_privacy_tier": self.minimum_privacy_tier.as_str(),
            "task_risk": self.task_risk.as_str(),
            "required_capabilities": self.required_capabilities.to_json(),
            "estimated_input_tokens": self.estimated_input_tokens,
            "estimated_output_tokens": self.estimated_output_tokens,
            "token_budget": self.token_budget,
            "max_cost_microunits": self.max_cost_microunits,
            "max_ewma_latency_ms": self.max_ewma_latency_ms,
            "preferred_candidate_ids": self.preferred_candidate_ids,
            "excluded_candidate_ids": self.excluded_candidate_ids,
            "fallback_scope": self.fallback_scope.as_str(),
            "allow_unknown_quota_without_emergency": self.allow_unknown_quota_without_emergency,
            "emergency_policy": self.emergency_policy.to_json(),
            "reservation_ttl_ms": self.reservation_ttl_ms,
            "deadline_ms": self.deadline_ms,
            "allowed_regions": self.allowed_regions,
            "allowed_providers": self.allowed_providers,
            "allowed_models": self.allowed_models,
            "forbidden_providers": self.forbidden_providers,
            "forbidden_models": self.forbidden_models,
            "max_retention_hours": self.max_retention_hours,
            "policy_hash": self.policy_hash(),
        })
    }
}

/// Deterministic integer basis-point breakdown for one evaluated candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateScoreBreakdown {
    pub candidate_id: String,
    pub eligible: bool,
    pub rejection_reason: Option<String>,
    pub capability_fit_bps: i64,
    pub privacy_fit_bps: i64,
    pub budget_headroom_bps: i64,
    pub latency_health_bps: i64,
    pub reliability_bps: i64,
    pub user_preference_bps: i64,
    pub route_priority_bps: i64,
    pub total_score_bps: i64,
}

/// Single labeled bar segment in a 5-segment candidate score waterfall.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreWaterfallSegment {
    pub key: String,
    pub label: String,
    pub bps: i64,
    pub share_pct: f64,
}

/// 5-segment normalized score waterfall for Router Lab observability (`capability`,
/// `privacy`, `headroom`, `latency`, `reliability_preference`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreWaterfall5 {
    pub candidate_id: String,
    pub eligible: bool,
    pub total_bps: i64,
    pub capability_bps: i64,
    pub privacy_bps: i64,
    pub headroom_bps: i64,
    pub latency_bps: i64,
    pub reliability_pref_bps: i64,
    pub segments: Vec<ScoreWaterfallSegment>,
}

/// Truthful quota burn-rate and runway projection for one candidate.
/// Never fabricates known runway when quota state is `Unknown` or `Contradictory`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuotaRunwayProjection {
    pub candidate_id: String,
    pub quota_kind: String,
    pub remaining_tokens: Option<i64>,
    pub window_capacity_tokens: Option<i64>,
    pub reserved_tokens: i64,
    pub burn_rate_tokens_per_min: Option<f64>,
    pub estimated_runway_minutes: Option<f64>,
    pub window_reset_in_minutes: Option<f64>,
    pub sample_count: usize,
    pub status: String,
}

/// Structured failover / circuit / quota lifecycle event for Router Lab timelines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailoverEvent {
    pub timestamp_ms: i64,
    pub kind: String,
    pub from_candidate_id: Option<String>,
    pub to_candidate_id: Option<String>,
    pub reason: String,
    pub reservation_id: Option<String>,
}

impl FailoverEvent {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "timestamp_ms": self.timestamp_ms,
            "kind": self.kind,
            "from_candidate_id": self.from_candidate_id,
            "to_candidate_id": self.to_candidate_id,
            "reason": SecretRedactor::redact(&self.reason),
            "reservation_id": self.reservation_id,
        }))
    }
}

impl CandidateScoreBreakdown {
    /// Group the deterministic bps breakdown into the canonical 5-segment waterfall.
    #[must_use]
    pub fn score_waterfall_5(&self) -> ScoreWaterfall5 {
        let reliability_pref_bps =
            self.reliability_bps + self.user_preference_bps + self.route_priority_bps;
        let denom = self.total_score_bps.max(1) as f64;
        let share = |bps: i64| -> f64 {
            if !self.eligible || self.total_score_bps <= 0 {
                0.0
            } else {
                (((bps.max(0) as f64) / denom) * 1000.0).round() / 10.0
            }
        };
        let segments = vec![
            ScoreWaterfallSegment {
                key: "capability".to_owned(),
                label: "Capability & Role Fit".to_owned(),
                bps: self.capability_fit_bps,
                share_pct: share(self.capability_fit_bps),
            },
            ScoreWaterfallSegment {
                key: "privacy".to_owned(),
                label: "Privacy Tier".to_owned(),
                bps: self.privacy_fit_bps,
                share_pct: share(self.privacy_fit_bps),
            },
            ScoreWaterfallSegment {
                key: "headroom".to_owned(),
                label: "Quota Headroom".to_owned(),
                bps: self.budget_headroom_bps,
                share_pct: share(self.budget_headroom_bps),
            },
            ScoreWaterfallSegment {
                key: "latency".to_owned(),
                label: "Latency Health".to_owned(),
                bps: self.latency_health_bps,
                share_pct: share(self.latency_health_bps),
            },
            ScoreWaterfallSegment {
                key: "reliability_pref".to_owned(),
                label: "Reliability & Affinity".to_owned(),
                bps: reliability_pref_bps,
                share_pct: share(reliability_pref_bps),
            },
        ];
        ScoreWaterfall5 {
            candidate_id: self.candidate_id.clone(),
            eligible: self.eligible,
            total_bps: self.total_score_bps,
            capability_bps: self.capability_fit_bps,
            privacy_bps: self.privacy_fit_bps,
            headroom_bps: self.budget_headroom_bps,
            latency_bps: self.latency_health_bps,
            reliability_pref_bps,
            segments,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "candidate_id": self.candidate_id,
            "eligible": self.eligible,
            "rejection_reason": self.rejection_reason.as_deref().map(SecretRedactor::redact),
            "capability_fit_bps": self.capability_fit_bps,
            "privacy_fit_bps": self.privacy_fit_bps,
            "budget_headroom_bps": self.budget_headroom_bps,
            "latency_health_bps": self.latency_health_bps,
            "reliability_bps": self.reliability_bps,
            "user_preference_bps": self.user_preference_bps,
            "route_priority_bps": self.route_priority_bps,
            "total_score_bps": self.total_score_bps,
            "waterfall_5": self.score_waterfall_5(),
        })
    }
}

/// Fenced token/request reservation issued to one winning candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservationGrant {
    pub reservation_id: String,
    pub candidate_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub idempotency_key: String,
    pub fencing_token: u64,
    pub epoch: u64,
    pub reserved_tokens: i64,
    pub pricing_version: String,
    pub estimated_cost_microunits: Option<i64>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub deadline_ms: Option<i64>,
    pub attempt_id: Option<String>,
    pub explicit_attempt_required: bool,
    pub status: ReservationStatus,
}

impl ReservationGrant {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "reservation_id": self.reservation_id,
            "candidate_id": self.candidate_id,
            "provider_id": self.provider_id,
            "model_id": self.model_id,
            "idempotency_key": SecretRedactor::redact(&self.idempotency_key),
            "fencing_token": self.fencing_token,
            "epoch": self.epoch,
            "reserved_tokens": self.reserved_tokens,
            "pricing_version": self.pricing_version,
            "estimated_cost_microunits": self.estimated_cost_microunits,
            "created_at_ms": self.created_at_ms,
            "expires_at_ms": self.expires_at_ms,
            "deadline_ms": self.deadline_ms,
            "attempt_id": self.attempt_id,
            "status": self.status.as_str(),
        })
    }
}

/// Secret-free auditable receipt explaining why a route won or failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteDecisionReceipt {
    pub decision_id: String,
    pub request_id: String,
    pub policy_hash: String,
    pub decided_at_ms: i64,
    pub allowed: bool,
    pub simulated: bool,
    pub selected_candidate_id: Option<String>,
    pub reservation_id: Option<String>,
    pub fencing_token: Option<u64>,
    pub deny_reason: Option<String>,
    pub token_budget: Option<u64>,
    pub candidate_scores: Vec<CandidateScoreBreakdown>,
}

impl RouteDecisionReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let scores: Vec<Value> = self
            .candidate_scores
            .iter()
            .map(CandidateScoreBreakdown::to_json)
            .collect();
        SecretRedactor::redact_json(&json!({
            "decision_id": self.decision_id,
            "request_id": self.request_id,
            "policy_hash": self.policy_hash,
            "decided_at_ms": self.decided_at_ms,
            "allowed": self.allowed,
            "simulated": self.simulated,
            "selected_candidate_id": self.selected_candidate_id,
            "reservation_id": self.reservation_id,
            "fencing_token": self.fencing_token,
            "deny_reason": self.deny_reason,
            "token_budget": self.token_budget,
            "candidate_scores": scores,
        }))
    }
}

impl Serialize for RouteDecisionReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Outcome reported after executing (or failing to execute) a reserved route.
#[derive(Debug, Clone, PartialEq)]
pub struct OutcomeReport {
    pub reservation_id: String,
    pub fencing_token: u64,
    pub attempt_id: Option<String>,
    pub success: bool,
    pub acceptance: AcceptanceState,
    pub actual_input_tokens: Option<u64>,
    pub actual_output_tokens: Option<u64>,
    pub actual_cost_microunits: Option<i64>,
    pub latency_ms: Option<f64>,
    pub retry_after_ms: Option<i64>,
    pub diagnostic_note: String,
    pub now_epoch_ms: Option<i64>,
    /// True when the error is request-scoped (`400/413/422` prompt overflow / invalid payload / content filter)
    /// and MUST NOT increment circuit failure counters or penalize account health.
    pub is_request_scoped: bool,
    /// True when this credential explicitly lacks entitlement for the requested model.
    pub model_entitlement_error: bool,
    /// Explicit quota exhaustion reset timestamp (`epoch_ms`) parsed from upstream 429/usage headers.
    pub quota_exhausted_until_ms: Option<i64>,
    /// True when transient error should apply 5s `softFail` demotion rather than tripping the circuit.
    pub soft_fail: bool,
    /// Authoritative provider-stated `QuotaResetAt` deadline (`epoch_ms`, e.g., Codex `resets_at`).
    pub provider_quota_reset_at_ms: Option<i64>,
}

impl Default for OutcomeReport {
    fn default() -> Self {
        Self {
            reservation_id: String::new(),
            fencing_token: 0,
            attempt_id: None,
            success: false,
            acceptance: AcceptanceState::NotSent,
            actual_input_tokens: None,
            actual_output_tokens: None,
            actual_cost_microunits: None,
            latency_ms: None,
            retry_after_ms: None,
            diagnostic_note: String::new(),
            now_epoch_ms: None,
            is_request_scoped: false,
            model_entitlement_error: false,
            quota_exhausted_until_ms: None,
            soft_fail: false,
            provider_quota_reset_at_ms: None,
        }
    }
}

/// Reconciled outcome receipt with redacted diagnostic notes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteOutcomeReceipt {
    pub reservation_id: String,
    pub candidate_id: String,
    pub fencing_token: u64,
    pub status: ReservationStatus,
    pub reconciled_at_ms: i64,
    pub actual_input_tokens: Option<u64>,
    pub actual_output_tokens: Option<u64>,
    pub actual_cost_microunits: Option<i64>,
    pub diagnostic_note: String,
}

impl RouteOutcomeReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "reservation_id": self.reservation_id,
            "candidate_id": self.candidate_id,
            "fencing_token": self.fencing_token,
            "status": self.status.as_str(),
            "reconciled_at_ms": self.reconciled_at_ms,
            "actual_input_tokens": self.actual_input_tokens,
            "actual_output_tokens": self.actual_output_tokens,
            "actual_cost_microunits": self.actual_cost_microunits,
            "diagnostic_note": SecretRedactor::redact(&self.diagnostic_note),
        }))
    }
}

impl Serialize for RouteOutcomeReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Combined decision result returned by [`DynamicProviderRouter::decide_and_reserve`]
/// and [`DynamicProviderRouter::decide_fallback`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionResult {
    pub allowed: bool,
    pub reservation: Option<ReservationGrant>,
    pub receipt: RouteDecisionReceipt,
}

impl DecisionResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "allowed": self.allowed,
            "reservation": self.reservation.as_ref().map(ReservationGrant::to_json),
            "receipt": self.receipt.to_json(),
        }))
    }
}

impl Serialize for DecisionResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Paired static configuration + live state snapshot for inspection or Studio UI.
#[derive(Debug, Clone, PartialEq)]
pub struct CandidateSnapshot {
    pub candidate: RouteCandidate,
    pub state: CandidateResourceState,
}

impl CandidateSnapshot {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "candidate": self.candidate.to_json(),
            "state": self.state.to_json(),
        }))
    }
}

impl Serialize for CandidateSnapshot {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Granular model-scoped cooldown error class (`T2.3`).
/// Scoped to `(candidate_id, model_id, error_class)` so HTTP 403 `model_not_allowed`
/// never trips the provider-wide circuit breaker for other permitted models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCooldownClass {
    ModelNotAllowed403,
    RateLimited429,
    QuotaBucketExhausted,
    TransientTransport,
    ServerFault5xx,
}

impl ModelCooldownClass {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ModelNotAllowed403 => "model_not_allowed_403",
            Self::RateLimited429 => "rate_limited_429",
            Self::QuotaBucketExhausted => "quota_bucket_exhausted",
            Self::TransientTransport => "transient_transport",
            Self::ServerFault5xx => "server_fault_5xx",
        }
    }
}

/// Active model-scoped cooldown entry tracked without tripping unrelated provider models.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCooldownEntry {
    pub candidate_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub error_class: ModelCooldownClass,
    pub until_ms: i64,
    pub reason: String,
}

/// Capability-aware routing profile for Reasoning Sandwich & Dual-Pool execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityProfile {
    DeepResearch,
    DeepThinkPrimary,
    DeepThinkVerifier,
    FastTool,
    CodingExecution,
}

impl CapabilityProfile {
    #[must_use]
    pub const fn mapped_role(self) -> ModelRole {
        match self {
            Self::DeepResearch => ModelRole::Architect,
            Self::DeepThinkPrimary => ModelRole::Architect,
            Self::DeepThinkVerifier => ModelRole::Verifier,
            Self::FastTool => ModelRole::Fast,
            Self::CodingExecution => ModelRole::Main,
        }
    }

    /// Reasoning Sandwich effort triple `(plan_effort, execute_effort, verify_effort)`.
    #[must_use]
    pub const fn reasoning_sandwich_efforts(self) -> (EffortLevel, EffortLevel, EffortLevel) {
        match self {
            Self::DeepResearch => (EffortLevel::High, EffortLevel::Medium, EffortLevel::High),
            Self::DeepThinkPrimary => (EffortLevel::Max, EffortLevel::High, EffortLevel::Max),
            Self::DeepThinkVerifier => (EffortLevel::Max, EffortLevel::Max, EffortLevel::Max),
            Self::FastTool => (EffortLevel::Low, EffortLevel::Low, EffortLevel::Medium),
            Self::CodingExecution => (EffortLevel::High, EffortLevel::Medium, EffortLevel::High),
        }
    }
}

/// Dual-pool Deep Think pair enforcing distinct model families for independent verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepThinkModelPair {
    pub primary_candidate_id: String,
    pub primary_model_id: String,
    pub primary_family: String,
    pub verifier_candidate_id: Option<String>,
    pub verifier_model_id: Option<String>,
    pub verifier_family: Option<String>,
    pub distinct_family_verified: bool,
    pub reasoning_sandwich_efforts: (EffortLevel, EffortLevel, EffortLevel),
}

/// Coarse model family classifier (`claude`, `openai`, `gemini`, `deepseek`, `grok`, `qwen`, etc.)
/// used to enforce cross-family adversarial verification in Deep Think & TEX.
#[must_use]
pub fn model_vendor_family(model_id: &str) -> String {
    let key = normalize_model_family_key(model_id);
    if key.starts_with("claude") {
        "anthropic".to_owned()
    } else if key.starts_with("gpt")
        || key.starts_with("o1")
        || key.starts_with("o3")
        || key.starts_with("o4")
        || key.starts_with("codex")
    {
        "openai".to_owned()
    } else if key.starts_with("gemini") || key.starts_with("gemma") {
        "google".to_owned()
    } else if key.starts_with("deepseek") {
        "deepseek".to_owned()
    } else if key.starts_with("grok") {
        "xai".to_owned()
    } else if key.starts_with("qwen") {
        "qwen".to_owned()
    } else if key.starts_with("glm") {
        "zhipu".to_owned()
    } else if key.starts_with("kimi") {
        "moonshot".to_owned()
    } else {
        key.split('-').next().unwrap_or("other").to_owned()
    }
}

#[derive(Debug)]
struct RegisteredCandidate {
    candidate: RouteCandidate,
    state: CandidateResourceState,
}

#[derive(Debug, Clone)]
struct ParentPolicyBounds {
    required_auth_boundary: String,
    minimum_privacy_tier: PrivacyTier,
    required_capabilities: ModelCapabilities,
    allowed_regions: Vec<String>,
    allowed_providers: Vec<String>,
    allowed_models: Vec<String>,
    forbidden_providers: Vec<String>,
    forbidden_models: Vec<String>,
    excluded_candidate_ids: Vec<String>,
    max_retention_hours: Option<u32>,
    deadline_ms: Option<i64>,
}

impl ParentPolicyBounds {
    fn from_policy(policy: &RouteRequestPolicy) -> Self {
        Self {
            required_auth_boundary: policy.required_auth_boundary.clone(),
            minimum_privacy_tier: policy.minimum_privacy_tier,
            required_capabilities: policy.required_capabilities,
            allowed_regions: policy.allowed_regions.clone(),
            allowed_providers: policy.allowed_providers.clone(),
            allowed_models: policy.allowed_models.clone(),
            forbidden_providers: policy.forbidden_providers.clone(),
            forbidden_models: policy.forbidden_models.clone(),
            excluded_candidate_ids: policy.excluded_candidate_ids.clone(),
            max_retention_hours: policy.max_retention_hours,
            deadline_ms: policy.deadline_ms,
        }
    }
}

#[derive(Debug)]
struct RouterInner {
    epoch: u64,
    next_fencing_token: u64,
    circuit_failure_threshold: u32,
    default_cooldown_ms: i64,
    candidates: BTreeMap<String, RegisteredCandidate>,
    reservations: HashMap<String, ReservationGrant>,
    parent_policy_bounds: HashMap<String, ParentPolicyBounds>,
    terminal_reservation_order: VecDeque<String>,
    idempotency_index: HashMap<String, DecisionResult>,
    idempotency_order: VecDeque<String>,
    decision_receipts: VecDeque<RouteDecisionReceipt>,
    outcome_receipts: VecDeque<RouteOutcomeReceipt>,
    total_reconciled_cost_microunits: BTreeMap<String, i64>,
    sqlite_store: Option<Arc<RouterSqliteStore>>,
    role_bindings: BTreeMap<ModelRole, (String, String)>,
    probe_counters: BTreeMap<String, u64>,
    session_affinity: BTreeMap<String, String>,
    token_burn_samples: BTreeMap<String, VecDeque<(i64, u64)>>,
    failover_events: VecDeque<FailoverEvent>,
    model_cooldowns: BTreeMap<(String, String, ModelCooldownClass), ModelCooldownEntry>,
    not_served_tracker: NotServedTracker,
    combo_registry: ComboRegistry,
}

impl RouterInner {
    fn push_decision_receipt(&mut self, receipt: RouteDecisionReceipt) {
        if self.decision_receipts.len() >= MAX_RECEIPT_HISTORY {
            self.decision_receipts.pop_front();
        }
        self.decision_receipts.push_back(receipt);
    }

    fn push_outcome_receipt(&mut self, receipt: RouteOutcomeReceipt) {
        if self.outcome_receipts.len() >= MAX_RECEIPT_HISTORY {
            self.outcome_receipts.pop_front();
        }
        self.outcome_receipts.push_back(receipt);
    }

    fn record_idempotency(&mut self, key: String, result: DecisionResult) {
        if let Some(slot) = self.idempotency_index.get_mut(&key) {
            *slot = result;
            return;
        }
        while self.idempotency_index.len() >= MAX_IDEMPOTENCY_ENTRIES {
            let Some(oldest) = self.idempotency_order.pop_front() else {
                break;
            };
            self.idempotency_index.remove(&oldest);
        }
        self.idempotency_order.push_back(key.clone());
        self.idempotency_index.insert(key, result);
    }

    fn note_terminal_reservation(&mut self, reservation_id: &str) {
        self.terminal_reservation_order
            .push_back(reservation_id.to_owned());
        while self.terminal_reservation_order.len() > MAX_TERMINAL_RESERVATIONS {
            let Some(oldest) = self.terminal_reservation_order.pop_front() else {
                break;
            };
            if self
                .reservations
                .get(&oldest)
                .is_some_and(|g| g.status.is_terminal())
            {
                self.reservations.remove(&oldest);
                self.parent_policy_bounds.remove(&oldest);
            }
        }
    }

    fn push_failover_event(&mut self, mut ev: FailoverEvent) {
        ev.reason = SecretRedactor::redact(&ev.reason);
        if self.failover_events.len() >= MAX_LATENCY_SAMPLES {
            self.failover_events.pop_front();
        }
        self.failover_events.push_back(ev);
    }

    fn record_burn_sample(&mut self, candidate_id: &str, now_ms: i64, tokens: u64) {
        if tokens == 0 {
            return;
        }
        let ring = self
            .token_burn_samples
            .entry(candidate_id.to_owned())
            .or_default();
        if ring.len() >= MAX_LATENCY_SAMPLES {
            ring.pop_front();
        }
        ring.push_back((now_ms, tokens));
    }
}

/// Thread-safe deterministic provider/model router with quota truth, circuit breakers,
/// fenced reservations, idempotency, SQLite persistence, and restart recovery.
#[derive(Debug)]
pub struct DynamicProviderRouter {
    inner: Mutex<RouterInner>,
}

impl Default for DynamicProviderRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl DynamicProviderRouter {
    #[must_use]
    pub fn new() -> Self {
        Self::with_circuit_config(
            DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
            DEFAULT_CIRCUIT_COOLDOWN_MS,
        )
    }

    #[must_use]
    pub fn with_circuit_config(circuit_failure_threshold: u32, default_cooldown_ms: i64) -> Self {
        Self {
            inner: Mutex::new(RouterInner {
                epoch: 1,
                next_fencing_token: 1,
                circuit_failure_threshold: circuit_failure_threshold.max(1),
                default_cooldown_ms: default_cooldown_ms.max(1),
                candidates: BTreeMap::new(),
                reservations: HashMap::new(),
                parent_policy_bounds: HashMap::new(),
                terminal_reservation_order: VecDeque::new(),
                idempotency_index: HashMap::new(),
                idempotency_order: VecDeque::new(),
                decision_receipts: VecDeque::new(),
                outcome_receipts: VecDeque::new(),
                total_reconciled_cost_microunits: BTreeMap::new(),
                sqlite_store: None,
                role_bindings: BTreeMap::new(),
                probe_counters: BTreeMap::new(),
                session_affinity: BTreeMap::new(),
                token_burn_samples: BTreeMap::new(),
                failover_events: VecDeque::new(),
                model_cooldowns: BTreeMap::new(),
                not_served_tracker: NotServedTracker::new(),
                combo_registry: ComboRegistry::new(),
            }),
        }
    }

    /// Open a SQLite WAL-backed router and restore persisted candidate/quota/circuit/role states.
    pub fn open_sqlite(db_path: impl AsRef<Path>, now_ms: i64) -> Result<Self, RoutingError> {
        let store = Arc::new(RouterSqliteStore::open(db_path)?);
        Self::with_sqlite_store(store, now_ms)
    }

    /// Open an isolated in-memory SQLite-backed router (for tests & ephemeral runs).
    pub fn open_in_memory_sqlite(now_ms: i64) -> Result<Self, RoutingError> {
        let store = Arc::new(RouterSqliteStore::open_in_memory()?);
        Self::with_sqlite_store(store, now_ms)
    }

    /// Construct a router backed by an existing [`RouterSqliteStore`] and restore its state.
    pub fn with_sqlite_store(
        store: Arc<RouterSqliteStore>,
        now_ms: i64,
    ) -> Result<Self, RoutingError> {
        let router = Self::new();
        {
            let mut guard = router
                .inner
                .lock()
                .map_err(|_| RoutingError::InternalLockPoisoned)?;
            for (cand, mut state) in store.load_all_candidates()? {
                state.reserved_tokens = 0;
                state.reserved_requests = 0;
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = state.circuit
                {
                    state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
                state.advance_time(now_ms);
                guard.candidates.insert(
                    cand.candidate_id.clone(),
                    RegisteredCandidate {
                        candidate: cand,
                        state,
                    },
                );
            }
            guard.role_bindings = store.load_role_bindings()?;
            guard.probe_counters = store.load_probe_counters()?;
            guard.sqlite_store = Some(store);
        }
        Ok(router)
    }

    /// Bind an explicit candidate/model spec to a functional [`ModelRole`].
    pub fn bind_role(
        &self,
        role: ModelRole,
        candidate_id: &str,
        model_spec: &str,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard
            .role_bindings
            .insert(role, (candidate_id.to_owned(), model_spec.to_owned()));
        if let Some(ref store) = guard.sqlite_store {
            store.save_role_binding(role, candidate_id, model_spec, now_ms)?;
        }
        Ok(())
    }

    /// Inspect persisted role bindings (`role -> (candidate_id, model_spec)`).
    pub fn role_bindings(&self) -> Result<BTreeMap<ModelRole, (String, String)>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.role_bindings.clone())
    }

    /// Select and reserve the best real-telemetry candidate for a [`ModelRole`].
    pub fn select_for_role(
        &self,
        role: ModelRole,
        mut policy: RouteRequestPolicy,
    ) -> Result<DecisionResult, RoutingError> {
        policy.model_role = Some(role);
        {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RoutingError::InternalLockPoisoned)?;
            if let Some((bound_cid, _)) = guard.role_bindings.get(&role) {
                if !policy.preferred_candidate_ids.iter().any(|c| c == bound_cid) {
                    policy.preferred_candidate_ids.insert(0, bound_cid.clone());
                }
            }
        }
        self.decide_and_reserve(&policy)
    }

    /// Proactive `quota_gate` (`htmustc-proxy/internal/proxy/quota_gate.go`):
    /// updates candidate exhaustion from usage bucket probes before a caller hits a 429.
    /// A probe with zero countable evidence clears nothing; headroom clears exhaustion early.
    /// Returns `true` when the candidate is now marked quota-exhausted.
    pub fn apply_quota_probe(
        &self,
        candidate_id: &str,
        limit_reached: bool,
        buckets: &[(String, i64, i64, bool, Option<i64>)],
        now_ms: i64,
    ) -> Result<bool, RoutingError> {
        let mut countable = 0usize;
        let mut dry = 0usize;
        let mut earliest_reset: Option<i64> = None;

        for (_name, total, remaining, unlimited, reset_ms_opt) in buckets {
            if *unlimited || *total <= 0 {
                continue;
            }
            countable += 1;
            if *remaining > 0 {
                continue;
            }
            dry += 1;
            if let Some(reset_ms) = reset_ms_opt {
                if *reset_ms > now_ms && earliest_reset.is_none_or(|cur| *reset_ms < cur) {
                    earliest_reset = Some(*reset_ms);
                }
            }
        }

        let known = countable > 0 || limit_reached;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;

        if !known {
            return Ok(entry
                .state
                .quota_exhausted_until_ms
                .is_some_and(|u| u > now_ms));
        }

        let exhausted = limit_reached || (countable > 0 && dry == countable);
        if exhausted {
            let until = earliest_reset.unwrap_or(now_ms + 30 * 60 * 1_000);
            entry.state.quota_exhausted_until_ms = Some(until);
        } else {
            entry.state.quota_exhausted_until_ms = None;
        }
        if let Some(store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
        }
        if exhausted {
            guard.push_failover_event(FailoverEvent {
                timestamp_ms: now_ms,
                kind: "quota_exhausted".to_owned(),
                from_candidate_id: Some(candidate_id.to_owned()),
                to_candidate_id: None,
                reason: "proactive_quota_gate_exhausted".to_owned(),
                reservation_id: None,
            });
        }
        Ok(exhausted)
    }

    pub fn upsert_candidate(
        &self,
        candidate: RouteCandidate,
        state: CandidateResourceState,
    ) -> Result<(), RoutingError> {
        if candidate.candidate_id.trim().is_empty() {
            return Err(RoutingError::InvalidCandidateId);
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let id = candidate.candidate_id.clone();
        let store_opt = guard.sqlite_store.clone();
        let reg = RegisteredCandidate { candidate, state };
        if let Some(store) = store_opt {
            store.save_candidate(&reg.candidate, &reg.state, now_epoch_ms())?;
        }
        guard.candidates.insert(id, reg);
        Ok(())
    }

    /// Register or refresh static candidate metadata while preserving persisted runtime quota,
    /// circuit-breaker, soft-fail, latency, and `model_proven` state when loaded from SQLite.
    pub fn upsert_candidate_preserving_state(
        &self,
        candidate: RouteCandidate,
        default_state: CandidateResourceState,
    ) -> Result<(), RoutingError> {
        if candidate.candidate_id.trim().is_empty() {
            return Err(RoutingError::InvalidCandidateId);
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let id = candidate.candidate_id.clone();
        let store_opt = guard.sqlite_store.clone();
        let state = guard
            .candidates
            .get(&id)
            .map(|existing| existing.state.clone())
            .unwrap_or(default_state);
        let reg = RegisteredCandidate { candidate, state };
        if let Some(store) = store_opt {
            store.save_candidate(&reg.candidate, &reg.state, now_epoch_ms())?;
        }
        guard.candidates.insert(id, reg);
        Ok(())
    }

    /// Record a non-punishing transient `5s` `softFail` demotion without tripping the circuit.
    pub fn record_soft_fail(
        &self,
        candidate_id: &str,
        window_ms: Option<i64>,
        now_ms: i64,
        reason: &str,
    ) -> Result<i64, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let effective_window = window_ms.unwrap_or(DEFAULT_SOFT_FAIL_WINDOW_MS).max(1);
        let until_ms = now_ms.saturating_add(effective_window);
        {
            let entry = guard
                .candidates
                .get_mut(candidate_id)
                .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
            let prev = entry.state.soft_fail_until_ms.unwrap_or(0);
            entry.state.soft_fail_until_ms = Some(prev.max(until_ms));
            if let Some(ref store) = store_opt {
                store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
            }
        }
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: "soft_fail_demotion".to_owned(),
            from_candidate_id: Some(candidate_id.to_owned()),
            to_candidate_id: None,
            reason: reason.to_owned(),
            reservation_id: None,
        });
        Ok(until_ms)
    }

    /// Record a provider-stated `QuotaResetAt` deadline (monotonic `max`, capped at `7d`).
    pub fn record_provider_quota_reset(
        &self,
        candidate_id: &str,
        reset_at_ms: i64,
        now_ms: i64,
        reason: &str,
    ) -> Result<i64, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let bounded = reset_at_ms
            .max(now_ms.saturating_add(1_000))
            .min(now_ms.saturating_add(MAX_QUOTA_EXHAUSTION_MS));
        let final_until = {
            let entry = guard
                .candidates
                .get_mut(candidate_id)
                .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
            let prev = entry.state.provider_quota_reset_until_ms.unwrap_or(0);
            let next_until = prev.max(bounded);
            entry.state.provider_quota_reset_until_ms = Some(next_until);
            if let Some(ref store) = store_opt {
                store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
            }
            next_until
        };
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: "provider_quota_reset".to_owned(),
            from_candidate_id: Some(candidate_id.to_owned()),
            to_candidate_id: None,
            reason: reason.to_owned(),
            reservation_id: None,
        });
        Ok(final_until)
    }

    /// Inspect whether all matching enabled candidates are awaiting provider-stated quota resets.
    pub fn pool_quota_reset_status(
        &self,
        provider_or_model: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<QuotaResetPoolStatus>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let filter = provider_or_model
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let matching: Vec<&RegisteredCandidate> = guard
            .candidates
            .values()
            .filter(|reg| {
                reg.candidate.enabled
                    && reg.candidate.credential_present
                    && filter.is_none_or(|f| {
                        reg.candidate.provider_id == f
                            || reg.candidate.model_id == f
                            || reg.candidate.candidate_id == f
                    })
            })
            .collect();
        if matching.is_empty() {
            return Ok(None);
        }
        let mut earliest_reset: Option<i64> = None;
        for reg in &matching {
            let Some(until) = reg
                .state
                .provider_quota_reset_until_ms
                .filter(|&u| u > now_ms)
            else {
                return Ok(None);
            };
            earliest_reset = Some(earliest_reset.map_or(until, |e| e.min(until)));
        }
        let reset_at_ms = earliest_reset.unwrap_or(now_ms);
        let remaining_ms = reset_at_ms.saturating_sub(now_ms).max(1_000) as u64;
        let secs = remaining_ms.div_ceil(1_000);
        Ok(Some(QuotaResetPoolStatus {
            error_code: "usage_limit_reached".to_owned(),
            reset_at_ms,
            resets_in_seconds: secs,
            retry_after_secs: secs,
            candidate_count: matching.len(),
        }))
    }

    /// Record an upstream 404 model-not-served response across a pool to stop 12h retry loops.
    pub fn record_not_served_outcome(
        &self,
        pool_key: &str,
        model_id: &str,
        candidate_id: &str,
        eligible_pool_size: usize,
    ) -> Result<NotServedDecision, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.not_served_tracker.record_not_served(
            pool_key,
            model_id,
            candidate_id,
            eligible_pool_size,
        ))
    }

    /// Mark `(pool_key, model_id)` as actively served, clearing unserved failure state.
    pub fn record_served_outcome(&self, pool_key: &str, model_id: &str) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard.not_served_tracker.record_served(pool_key, model_id);
        Ok(())
    }

    /// Query whether all known candidates in `(pool_key, model_id)` reported unserved 404.
    pub fn is_model_unserved(
        &self,
        pool_key: &str,
        model_id: &str,
        eligible_pool_size: usize,
    ) -> Result<bool, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard
            .not_served_tracker
            .is_model_unserved(pool_key, model_id, eligible_pool_size))
    }

    /// Register or update a virtual `combo/<id>` failover chain.
    pub fn upsert_combo(&self, def: ComboDefinition) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard.combo_registry.upsert(def);
        Ok(())
    }

    /// Resolve a `combo/<id>` chain, applying strategy ordering and `demote_benched` tails.
    pub fn resolve_combo(&self, target: &str, now_ms: i64) -> Result<ComboResolution, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.combo_registry.resolve(target, now_ms))
    }

    /// Non-mutating combo snapshot for dashboard / status inspection.
    pub fn peek_combo(&self, target: &str) -> Result<ComboResolution, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.combo_registry.peek_chain(target))
    }

    /// Demote a failing combo member strictly within `(combo_id, member_id)` to tail fallback.
    pub fn record_combo_member_failure(
        &self,
        combo_id: &str,
        member_id: &str,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard
            .combo_registry
            .record_member_failure(combo_id, member_id, now_ms);
        Ok(())
    }

    /// Restore a recovered combo member to active primary ordering.
    pub fn record_combo_member_success(
        &self,
        combo_id: &str,
        member_id: &str,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard
            .combo_registry
            .record_member_success(combo_id, member_id);
        Ok(())
    }

    /// Claim due `30s` active `ComboProbe` health-recovery probes without stampeding.
    pub fn claim_due_combo_probes(
        &self,
        now_ms: i64,
    ) -> Result<Vec<ComboProbeTarget>, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.combo_registry.claim_due_probes(now_ms))
    }

    /// Finish an active `ComboProbe`; `Healthy` or `Undecided` restores primary ordering.
    pub fn complete_combo_probe(
        &self,
        combo_id: &str,
        member_id: &str,
        outcome: ComboProbeOutcome,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard
            .combo_registry
            .complete_probe(combo_id, member_id, outcome, now_ms);
        Ok(())
    }

    /// Classify post-dispatch wire telemetry into 3-way `Accepted`/`NotAccepted`/`Unknown`
    /// and atomically reconcile the in-flight reservation (`Unknown -> OperatorRecoveryRequired`).
    #[allow(clippy::too_many_arguments)]
    pub fn reconcile_post_dispatch(
        &self,
        reservation_id: &str,
        fencing_token: u64,
        attempt_id: &str,
        input: &PostDispatchInput,
        latency_ms: Option<f64>,
        soft_fail_on_not_accepted: bool,
        now_ms: i64,
    ) -> Result<(PostDispatchClassification, RouteOutcomeReceipt), RoutingError> {
        let class = classify_post_dispatch_outcome(input);
        let success = class.outcome_class == DispatchOutcomeClass::Accepted;
        let is_request_scoped = input
            .http_status
            .is_some_and(|st| matches!(st, 400 | 409 | 413 | 422));
        let receipt = self.reconcile_in_flight_outcome(OutcomeReport {
            reservation_id: reservation_id.to_owned(),
            fencing_token,
            attempt_id: Some(attempt_id.to_owned()),
            success,
            acceptance: class.acceptance_state,
            latency_ms,
            diagnostic_note: class.reason.clone(),
            now_epoch_ms: Some(now_ms),
            is_request_scoped,
            soft_fail: !success && soft_fail_on_not_accepted && !is_request_scoped,
            ..Default::default()
        })?;
        Ok((class, receipt))
    }

    pub fn set_candidate_enabled(
        &self,
        candidate_id: &str,
        enabled: bool,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.candidate.enabled = enabled;
        if let Some(store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_epoch_ms())?;
        }
        Ok(())
    }

    pub fn update_pricing_version(
        &self,
        candidate_id: &str,
        pricing_version: impl Into<String>,
        input_cost_per_million_microunits: Option<i64>,
        output_cost_per_million_microunits: Option<i64>,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.candidate.pricing_version = pricing_version.into();
        entry.candidate.input_cost_per_million_microunits = input_cost_per_million_microunits;
        entry.candidate.output_cost_per_million_microunits = output_cost_per_million_microunits;
        if let Some(store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_epoch_ms())?;
        }
        Ok(())
    }

    pub fn trip_circuit(
        &self,
        candidate_id: &str,
        now_ms: i64,
        cooldown_ms: Option<i64>,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let default_cooldown = guard.default_cooldown_ms;
        let store_opt = guard.sqlite_store.clone();
        let effective_cooldown = cooldown_ms.unwrap_or(default_cooldown).max(1);
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.state.circuit = CircuitState::Open {
            opened_at_ms: now_ms,
            cooldown_ms: effective_cooldown,
        };
        if let Some(store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
        }
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: "circuit_tripped".to_owned(),
            from_candidate_id: Some(candidate_id.to_owned()),
            to_candidate_id: None,
            reason: format!("manual_trip_cooldown_{effective_cooldown}ms"),
            reservation_id: None,
        });
        Ok(())
    }

    pub fn reset_circuit(&self, candidate_id: &str) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let now_ms = now_epoch_ms();
        let store_opt = guard.sqlite_store.clone();
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.state.circuit = CircuitState::Closed;
        entry.state.consecutive_failures = 0;
        entry.state.retry_after_until_ms = None;
        if let Some(store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
        }
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: "circuit_reset".to_owned(),
            from_candidate_id: None,
            to_candidate_id: Some(candidate_id.to_owned()),
            reason: "manual_reset".to_owned(),
            reservation_id: None,
        });
        Ok(())
    }

    pub fn decide_and_reserve(
        &self,
        policy: &RouteRequestPolicy,
    ) -> Result<DecisionResult, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        decide_and_reserve_locked(&mut guard, policy)
    }

    /// Side-effect-free deterministic routing preview (`SIMULATED_DETERMINISTIC`, `AUD-09`).
    /// Never reserves tokens/requests, never mutates circuit half-open probes, probe counters,
    /// idempotency cache, session affinity, or persisted decision receipts.
    pub fn simulate_route(
        &self,
        policy: &RouteRequestPolicy,
    ) -> Result<DecisionResult, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(simulate_route_locked(&guard, policy))
    }

    /// JSON envelope for side-effect-free Router Lab previews (`mode: "SIMULATED_DETERMINISTIC"`).
    pub fn simulate_route_json(
        &self,
        policy: &RouteRequestPolicy,
    ) -> Result<Value, RoutingError> {
        let res = self.simulate_route(policy)?;
        Ok(SecretRedactor::redact_json(&json!({
            "mode": "SIMULATED_DETERMINISTIC",
            "simulated": true,
            "allowed": res.allowed,
            "reservation": Value::Null,
            "receipt": res.receipt.to_json(),
        })))
    }

    /// Record a model-scoped cooldown `(candidate_id, model_id, error_class)` (`T2.3`).
    /// Prevents HTTP 403 `model_not_allowed` or per-model rate limits from tripping
    /// the entire provider circuit for unrelated permitted models.
    #[allow(clippy::too_many_arguments)]
    pub fn record_model_cooldown(
        &self,
        candidate_id: &str,
        model_id: &str,
        error_class: ModelCooldownClass,
        cooldown_ms: i64,
        now_ms: i64,
        reason: &str,
    ) -> Result<ModelCooldownEntry, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let effective_ms = cooldown_ms.max(1);
        let until_ms = now_ms.saturating_add(effective_ms);
        let provider_id = {
            let entry = guard
                .candidates
                .get_mut(candidate_id)
                .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
            let target_model = if model_id.trim().is_empty() {
                entry.candidate.model_id.clone()
            } else {
                model_id.trim().to_owned()
            };
            if error_class == ModelCooldownClass::ModelNotAllowed403 {
                entry.state.model_proven.remove(&target_model);
            }
            let prev = entry
                .state
                .model_locks_until_ms
                .get(&target_model)
                .copied()
                .unwrap_or(0);
            entry
                .state
                .model_locks_until_ms
                .insert(target_model.clone(), prev.max(until_ms));
            if let Some(ref store) = store_opt {
                store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
            }
            (entry.candidate.provider_id.clone(), target_model)
        };
        let record = ModelCooldownEntry {
            candidate_id: candidate_id.to_owned(),
            provider_id: provider_id.0,
            model_id: provider_id.1.clone(),
            error_class,
            until_ms,
            reason: SecretRedactor::redact(reason),
        };
        guard.model_cooldowns.insert(
            (candidate_id.to_owned(), provider_id.1, error_class),
            record.clone(),
        );
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: "model_cooldown".to_owned(),
            from_candidate_id: Some(candidate_id.to_owned()),
            to_candidate_id: None,
            reason: format!("{}: {}", error_class.as_str(), reason),
            reservation_id: None,
        });
        Ok(record)
    }

    /// Return all active (unexpired) model-scoped cooldowns at `now_ms`.
    pub fn active_model_cooldowns(
        &self,
        now_ms: i64,
    ) -> Result<Vec<ModelCooldownEntry>, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard.model_cooldowns.retain(|_, rec| rec.until_ms > now_ms);
        Ok(guard.model_cooldowns.values().cloned().collect())
    }

    /// Capability-aware routing helper for Reasoning Sandwich & Dual-Pool workflows.
    pub fn select_for_capability(
        &self,
        profile: CapabilityProfile,
        mut policy: RouteRequestPolicy,
        simulate: bool,
    ) -> Result<DecisionResult, RoutingError> {
        policy.model_role = Some(profile.mapped_role());
        if matches!(
            profile,
            CapabilityProfile::DeepResearch
                | CapabilityProfile::DeepThinkPrimary
                | CapabilityProfile::DeepThinkVerifier
        ) {
            policy.required_capabilities.supports_reasoning = true;
        }
        {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RoutingError::InternalLockPoisoned)?;
            if let Some((bound_cid, _)) = guard.role_bindings.get(&profile.mapped_role()) {
                if !policy.preferred_candidate_ids.iter().any(|c| c == bound_cid) {
                    policy.preferred_candidate_ids.insert(0, bound_cid.clone());
                }
            }
        }
        if simulate {
            self.simulate_route(&policy)
        } else {
            self.decide_and_reserve(&policy)
        }
    }

    /// Select a Dual-Pool Deep Think pair `(primary, distinct_family_verifier)` without reserving
    /// quota, enforcing `model_vendor_family(verifier) != model_vendor_family(primary)` whenever
    /// an eligible cross-family verifier exists.
    pub fn select_deep_think_pair(
        &self,
        base_policy: &RouteRequestPolicy,
    ) -> Result<DeepThinkModelPair, RoutingError> {
        let mut primary_policy = base_policy.clone();
        primary_policy.model_role = Some(ModelRole::Architect);
        primary_policy.required_capabilities.supports_reasoning = true;
        let primary_res = self.simulate_route(&primary_policy)?;
        let primary_cid = primary_res
            .receipt
            .selected_candidate_id
            .clone()
            .ok_or_else(|| {
                RoutingError::InvalidState(
                    primary_res
                        .receipt
                        .deny_reason
                        .unwrap_or_else(|| "no_eligible_primary_for_deep_think".to_owned()),
                )
            })?;

        let (primary_model_id, same_family_cids) = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RoutingError::InternalLockPoisoned)?;
            let primary_model = guard
                .candidates
                .get(&primary_cid)
                .map(|r| r.candidate.model_id.clone())
                .ok_or_else(|| RoutingError::UnknownCandidate(primary_cid.clone()))?;
            let primary_fam = model_vendor_family(&primary_model);
            let same_fam: Vec<String> = guard
                .candidates
                .iter()
                .filter(|(_, reg)| model_vendor_family(&reg.candidate.model_id) == primary_fam)
                .map(|(cid, _)| cid.clone())
                .collect();
            (primary_model, same_fam)
        };
        let primary_family = model_vendor_family(&primary_model_id);

        let mut verifier_policy = base_policy.clone();
        verifier_policy.model_role = Some(ModelRole::Verifier);
        verifier_policy.required_capabilities.supports_reasoning = true;
        for cid in same_family_cids {
            if !verifier_policy
                .excluded_candidate_ids
                .iter()
                .any(|x| x == &cid)
            {
                verifier_policy.excluded_candidate_ids.push(cid);
            }
        }
        let verifier_res = self.simulate_route(&verifier_policy)?;
        let (verifier_cid, verifier_model, verifier_family, distinct_family_verified) =
            if let Some(vcid) = verifier_res.receipt.selected_candidate_id {
                let guard = self
                    .inner
                    .lock()
                    .map_err(|_| RoutingError::InternalLockPoisoned)?;
                let vmodel = guard
                    .candidates
                    .get(&vcid)
                    .map(|r| r.candidate.model_id.clone());
                let vfam = vmodel.as_deref().map(model_vendor_family);
                let distinct = vfam
                    .as_deref()
                    .is_some_and(|f| !f.eq_ignore_ascii_case(&primary_family));
                (Some(vcid), vmodel, vfam, distinct)
            } else {
                (None, None, None, false)
            };

        Ok(DeepThinkModelPair {
            primary_candidate_id: primary_cid,
            primary_model_id,
            primary_family,
            verifier_candidate_id: verifier_cid,
            verifier_model_id: verifier_model,
            verifier_family,
            distinct_family_verified,
            reasoning_sandwich_efforts: CapabilityProfile::DeepThinkPrimary
                .reasoning_sandwich_efforts(),
        })
    }

    pub fn decide_fallback(
        &self,
        previous_reservation_id: &str,
        original_policy: &RouteRequestPolicy,
    ) -> Result<DecisionResult, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let prev = guard
            .reservations
            .get(previous_reservation_id)
            .cloned()
            .ok_or_else(|| RoutingError::UnknownReservation(previous_reservation_id.to_owned()))?;
        let parent_bounds = guard
            .parent_policy_bounds
            .get(previous_reservation_id)
            .cloned();

        let now_ms = original_policy.now_epoch_ms.unwrap_or_else(now_epoch_ms);
        if matches!(
            prev.status,
            ReservationStatus::OperatorRecoveryRequired | ReservationStatus::OrphanedOnRestart
        ) {
            let receipt = RouteDecisionReceipt {
                decision_id: uuid_v4(),
                request_id: original_policy.request_id.clone(),
                policy_hash: original_policy.policy_hash(),
                decided_at_ms: now_ms,
                allowed: false,
                simulated: false,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some(
                    "automatic_fallback_blocked_for_ambiguous_or_orphaned_reservation".to_owned(),
                ),
                token_budget: original_policy.token_budget,
                candidate_scores: Vec::new(),
            };
            guard.push_decision_receipt(receipt.clone());
            return Ok(DecisionResult {
                allowed: false,
                reservation: None,
                receipt,
            });
        }

        if original_policy.fallback_scope == FallbackScope::None {
            let receipt = RouteDecisionReceipt {
                decision_id: uuid_v4(),
                request_id: original_policy.request_id.clone(),
                policy_hash: original_policy.policy_hash(),
                decided_at_ms: now_ms,
                allowed: false,
                simulated: false,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some("fallback_disabled_by_policy".to_owned()),
                token_budget: original_policy.token_budget,
                candidate_scores: Vec::new(),
            };
            guard.push_decision_receipt(receipt.clone());
            return Ok(DecisionResult {
                allowed: false,
                reservation: None,
                receipt,
            });
        }

        let prev_privacy = guard
            .candidates
            .get(&prev.candidate_id)
            .map_or(original_policy.minimum_privacy_tier, |entry| {
                entry.candidate.privacy_tier
            });

        let mut fb_policy = original_policy.clone();
        fb_policy.minimum_privacy_tier = fb_policy.minimum_privacy_tier.max(prev_privacy);
        // Monotonic fallback narrowing (`AUD-14` / `AUD-16`): never widen parent auth boundary,
        // privacy tier, capabilities, retention cap, allowlists, denylists, or deadline.
        if let Some(ref parent) = parent_bounds {
            if original_policy.required_auth_boundary != parent.required_auth_boundary {
                let receipt = RouteDecisionReceipt {
                    decision_id: uuid_v4(),
                    request_id: original_policy.request_id.clone(),
                    policy_hash: original_policy.policy_hash(),
                    decided_at_ms: now_ms,
                    allowed: false,
                    simulated: false,
                    selected_candidate_id: None,
                    reservation_id: None,
                    fencing_token: None,
                    deny_reason: Some("fallback_auth_boundary_widening_blocked".to_owned()),
                    token_budget: original_policy.token_budget,
                    candidate_scores: Vec::new(),
                };
                guard.push_decision_receipt(receipt.clone());
                return Ok(DecisionResult {
                    allowed: false,
                    reservation: None,
                    receipt,
                });
            }
            fb_policy.minimum_privacy_tier = fb_policy
                .minimum_privacy_tier
                .max(parent.minimum_privacy_tier);
            fb_policy.required_capabilities = merge_capabilities_monotonic(
                parent.required_capabilities,
                fb_policy.required_capabilities,
            );
            let Ok(regions) =
                intersect_allowlist(&parent.allowed_regions, &fb_policy.allowed_regions)
            else {
                return Ok(record_fallback_denial(
                    &mut guard,
                    original_policy,
                    now_ms,
                    "fallback_allowlist_intersection_empty",
                ));
            };
            let Ok(providers) =
                intersect_allowlist(&parent.allowed_providers, &fb_policy.allowed_providers)
            else {
                return Ok(record_fallback_denial(
                    &mut guard,
                    original_policy,
                    now_ms,
                    "fallback_allowlist_intersection_empty",
                ));
            };
            let Ok(models) =
                intersect_allowlist(&parent.allowed_models, &fb_policy.allowed_models)
            else {
                return Ok(record_fallback_denial(
                    &mut guard,
                    original_policy,
                    now_ms,
                    "fallback_allowlist_intersection_empty",
                ));
            };
            fb_policy.allowed_regions = regions;
            fb_policy.allowed_providers = providers;
            fb_policy.allowed_models = models;
            fb_policy.forbidden_providers =
                union_string_lists(&parent.forbidden_providers, &fb_policy.forbidden_providers);
            fb_policy.forbidden_models =
                union_string_lists(&parent.forbidden_models, &fb_policy.forbidden_models);
            fb_policy.excluded_candidate_ids = union_string_lists(
                &parent.excluded_candidate_ids,
                &fb_policy.excluded_candidate_ids,
            );
            fb_policy.max_retention_hours =
                min_optional_u32(parent.max_retention_hours, fb_policy.max_retention_hours);
            let parent_dl = min_optional_i64(parent.deadline_ms, prev.deadline_ms);
            fb_policy.deadline_ms = min_optional_i64(parent_dl, fb_policy.deadline_ms);
        } else {
            fb_policy.deadline_ms = min_optional_i64(prev.deadline_ms, fb_policy.deadline_ms);
        }

        fb_policy.idempotency_key = format!(
            "{}:fallback:{}",
            original_policy.idempotency_key, prev.reservation_id
        );
        let prev_candidate_id = prev.candidate_id.clone();
        if !fb_policy
            .excluded_candidate_ids
            .iter()
            .any(|id| id == &prev_candidate_id)
        {
            fb_policy.excluded_candidate_ids.push(prev_candidate_id.clone());
        }
        if fb_policy.fallback_scope == FallbackScope::SameProviderOnly {
            let extra_excluded: Vec<String> = guard
                .candidates
                .iter()
                .filter(|(_, reg)| reg.candidate.provider_id != prev.provider_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in extra_excluded {
                if !fb_policy.excluded_candidate_ids.iter().any(|x| x == &id) {
                    fb_policy.excluded_candidate_ids.push(id);
                }
            }
        }
        let res = decide_and_reserve_locked(&mut guard, &fb_policy)?;
        guard.push_failover_event(FailoverEvent {
            timestamp_ms: now_ms,
            kind: if res.allowed {
                "fallback_selected".to_owned()
            } else {
                "fallback_denied".to_owned()
            },
            from_candidate_id: Some(prev_candidate_id),
            to_candidate_id: res.receipt.selected_candidate_id.clone(),
            reason: res
                .receipt
                .deny_reason
                .clone()
                .unwrap_or_else(|| "fallback_routed".to_owned()),
            reservation_id: Some(prev.reservation_id),
        });
        Ok(res)
    }

    pub fn mark_dispatched(
        &self,
        reservation_id: &str,
        fencing_token: u64,
    ) -> Result<(), RoutingError> {
        self.mark_dispatched_at(reservation_id, fencing_token, now_epoch_ms())
    }

    /// Transition a `ReservedNotDispatched` grant to `InFlight` at `now_ms`, enforcing
    /// `deadline_ms` before dispatch (`AUD-14`). Expired grants are released immediately.
    pub fn mark_dispatched_at(
        &self,
        reservation_id: &str,
        fencing_token: u64,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let auto_attempt = format!("att-{fencing_token}");
        self.mark_dispatched_internal(reservation_id, fencing_token, &auto_attempt, false, now_ms)
    }

    /// Transition a `ReservedNotDispatched` grant to `InFlight` bound to a caller-supplied
    /// non-empty `attempt_id` (`AUD-14` / `AUD-15`), rejecting expired deadlines or empty IDs.
    pub fn mark_dispatched_with_attempt(
        &self,
        reservation_id: &str,
        fencing_token: u64,
        attempt_id: &str,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let trimmed = attempt_id.trim();
        if trimmed.is_empty() {
            return Err(RoutingError::InvalidPolicy(
                "attempt_id must not be empty".to_owned(),
            ));
        }
        self.mark_dispatched_internal(reservation_id, fencing_token, trimmed, true, now_ms)
    }

    fn mark_dispatched_internal(
        &self,
        reservation_id: &str,
        fencing_token: u64,
        attempt_id: &str,
        explicit_attempt_required: bool,
        now_ms: i64,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let (expired_deadline, candidate_id, reserved_tokens) = {
            let grant = guard
                .reservations
                .get_mut(reservation_id)
                .ok_or_else(|| RoutingError::UnknownReservation(reservation_id.to_owned()))?;
            if grant.fencing_token != fencing_token {
                return Err(RoutingError::StaleFencingToken {
                    reservation_id: reservation_id.to_owned(),
                    expected: grant.fencing_token,
                    provided: fencing_token,
                });
            }
            if grant.status != ReservationStatus::ReservedNotDispatched {
                return Err(RoutingError::InvalidReservationTransition {
                    reservation_id: reservation_id.to_owned(),
                    state: grant.status.as_str(),
                });
            }
            if let Some(dl) = grant.deadline_ms {
                if now_ms >= dl {
                    grant.status = ReservationStatus::ReconciledReleased;
                    (Some(dl), grant.candidate_id.clone(), grant.reserved_tokens)
                } else {
                    grant.attempt_id = Some(attempt_id.to_owned());
                    grant.explicit_attempt_required = explicit_attempt_required;
                    grant.status = ReservationStatus::InFlight;
                    return Ok(());
                }
            } else {
                grant.attempt_id = Some(attempt_id.to_owned());
                grant.explicit_attempt_required = explicit_attempt_required;
                grant.status = ReservationStatus::InFlight;
                return Ok(());
            }
        };

        if let Some(deadline_ms) = expired_deadline {
            release_candidate_reservation(&mut guard, &candidate_id, reserved_tokens, &store_opt, now_ms)?;
            guard.note_terminal_reservation(reservation_id);
            guard.push_failover_event(FailoverEvent {
                timestamp_ms: now_ms,
                kind: "reservation_deadline_expired".to_owned(),
                from_candidate_id: Some(candidate_id),
                to_candidate_id: None,
                reason: format!("deadline_ms={deadline_ms} expired at now_ms={now_ms}"),
                reservation_id: Some(reservation_id.to_owned()),
            });
            return Err(RoutingError::ReservationDeadlineExpired {
                reservation_id: reservation_id.to_owned(),
                deadline_ms,
                now_ms,
            });
        }
        Ok(())
    }

    /// Explicitly cancel and release a `ReservedNotDispatched` grant without charging (`AUD-15`).
    pub fn cancel_reservation(
        &self,
        reservation_id: &str,
        fencing_token: u64,
        note: &str,
        now_ms: i64,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let store_opt = guard.sqlite_store.clone();
        let (candidate_id, reserved_tokens) = {
            let grant = guard
                .reservations
                .get_mut(reservation_id)
                .ok_or_else(|| RoutingError::UnknownReservation(reservation_id.to_owned()))?;
            if grant.fencing_token != fencing_token {
                return Err(RoutingError::StaleFencingToken {
                    reservation_id: reservation_id.to_owned(),
                    expected: grant.fencing_token,
                    provided: fencing_token,
                });
            }
            if grant.status != ReservationStatus::ReservedNotDispatched {
                return Err(RoutingError::InvalidReservationTransition {
                    reservation_id: reservation_id.to_owned(),
                    state: grant.status.as_str(),
                });
            }
            grant.status = ReservationStatus::ReconciledReleased;
            (grant.candidate_id.clone(), grant.reserved_tokens)
        };
        release_candidate_reservation(&mut guard, &candidate_id, reserved_tokens, &store_opt, now_ms)?;
        guard.note_terminal_reservation(reservation_id);
        let receipt = RouteOutcomeReceipt {
            reservation_id: reservation_id.to_owned(),
            candidate_id,
            fencing_token,
            status: ReservationStatus::ReconciledReleased,
            reconciled_at_ms: now_ms,
            actual_input_tokens: None,
            actual_output_tokens: None,
            actual_cost_microunits: None,
            diagnostic_note: SecretRedactor::redact(note),
        };
        guard.push_outcome_receipt(receipt.clone());
        Ok(receipt)
    }

    pub fn reconcile_outcome(
        &self,
        report: OutcomeReport,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        self.reconcile_outcome_internal(report, false)
    }

    /// Strict `AUD-15` outcome reconciliation requiring `ReservationStatus::InFlight`
    /// and a non-empty matching `attempt_id` (rejects `ReservedNotDispatched` without charging).
    pub fn reconcile_in_flight_outcome(
        &self,
        report: OutcomeReport,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        self.reconcile_outcome_internal(report, true)
    }

    /// Inspect accumulated reconciled cost microunits for a candidate.
    pub fn total_reconciled_cost_microunits(&self, candidate_id: &str) -> Result<i64, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard
            .total_reconciled_cost_microunits
            .get(candidate_id)
            .copied()
            .unwrap_or(0))
    }

    fn reconcile_outcome_internal(
        &self,
        report: OutcomeReport,
        require_in_flight: bool,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let now_ms = report.now_epoch_ms.unwrap_or_else(now_epoch_ms);
        let failure_threshold = guard.circuit_failure_threshold;
        let default_cooldown = guard.default_cooldown_ms;
        let store_opt = guard.sqlite_store.clone();

        let (candidate_id, model_id, reserved_tokens, deadline_ms) = {
            let grant = guard
                .reservations
                .get(&report.reservation_id)
                .ok_or_else(|| RoutingError::UnknownReservation(report.reservation_id.clone()))?;
            if grant.fencing_token != report.fencing_token {
                return Err(RoutingError::StaleFencingToken {
                    reservation_id: report.reservation_id.clone(),
                    expected: grant.fencing_token,
                    provided: report.fencing_token,
                });
            }
            if grant.status.is_terminal() {
                return Err(RoutingError::AlreadyReconciled(
                    report.reservation_id.clone(),
                ));
            }
            if require_in_flight && grant.status != ReservationStatus::InFlight {
                return Err(RoutingError::InvalidReservationTransition {
                    reservation_id: report.reservation_id.clone(),
                    state: grant.status.as_str(),
                });
            }
            let enforce_attempt =
                require_in_flight || grant.explicit_attempt_required || report.attempt_id.is_some();
            if enforce_attempt {
                let provided_att = report.attempt_id.as_deref().map(str::trim).unwrap_or("");
                if provided_att.is_empty() {
                    return Err(RoutingError::InvalidPolicy(
                        "attempt_id must not be empty for dispatched outcome reconciliation"
                            .to_owned(),
                    ));
                }
                if grant.status != ReservationStatus::InFlight {
                    return Err(RoutingError::InvalidReservationTransition {
                        reservation_id: report.reservation_id.clone(),
                        state: grant.status.as_str(),
                    });
                }
                if grant.attempt_id.as_deref() != Some(provided_att) {
                    return Err(RoutingError::InvalidPolicy(format!(
                        "mismatched attempt_id for reservation `{}`",
                        report.reservation_id
                    )));
                }
            }
            (
                grant.candidate_id.clone(),
                grant.model_id.clone(),
                grant.reserved_tokens,
                grant.deadline_ms,
            )
        };

        // Fence post-deadline reconciliation and usage/cost integer overflow into
        // `OperatorRecoveryRequired` without charging corrupted totals (`AUD-14` / PR #1).
        let deadline_exceeded = deadline_ms.is_some_and(|dl| now_ms >= dl);
        let usage_overflow = report
            .actual_input_tokens
            .unwrap_or(0)
            .checked_add(report.actual_output_tokens.unwrap_or(0))
            .is_none();
        let prev_cost = guard
            .total_reconciled_cost_microunits
            .get(&candidate_id)
            .copied()
            .unwrap_or(0);
        let cost_overflow = report
            .actual_cost_microunits
            .is_some_and(|c| c < 0 || prev_cost.checked_add(c).is_none());

        if deadline_exceeded || usage_overflow || cost_overflow {
            let anomaly = if deadline_exceeded {
                "reconciliation_after_deadline"
            } else if usage_overflow {
                "usage_overflow"
            } else {
                "cost_overflow"
            };
            if let Some(grant) = guard.reservations.get_mut(&report.reservation_id) {
                grant.status = ReservationStatus::OperatorRecoveryRequired;
            }
            release_candidate_reservation(
                &mut guard,
                &candidate_id,
                reserved_tokens,
                &store_opt,
                now_ms,
            )?;
            guard.note_terminal_reservation(&report.reservation_id);
            guard.push_failover_event(FailoverEvent {
                timestamp_ms: now_ms,
                kind: "operator_recovery_required".to_owned(),
                from_candidate_id: Some(candidate_id.clone()),
                to_candidate_id: None,
                reason: anomaly.to_owned(),
                reservation_id: Some(report.reservation_id.clone()),
            });
            let merged_note = if report.diagnostic_note.trim().is_empty() {
                anomaly.to_owned()
            } else {
                format!("{anomaly}: {}", report.diagnostic_note)
            };
            let receipt = RouteOutcomeReceipt {
                reservation_id: report.reservation_id,
                candidate_id,
                fencing_token: report.fencing_token,
                status: ReservationStatus::OperatorRecoveryRequired,
                reconciled_at_ms: now_ms,
                actual_input_tokens: if usage_overflow {
                    None
                } else {
                    report.actual_input_tokens
                },
                actual_output_tokens: if usage_overflow {
                    None
                } else {
                    report.actual_output_tokens
                },
                actual_cost_microunits: if cost_overflow {
                    None
                } else {
                    report.actual_cost_microunits
                },
                diagnostic_note: SecretRedactor::redact(&merged_note),
            };
            guard.push_outcome_receipt(receipt.clone());
            return Ok(receipt);
        }

        let next_status = if report.success {
            ReservationStatus::ReconciledCharged
        } else {
            match report.acceptance {
                AcceptanceState::Unknown => ReservationStatus::OperatorRecoveryRequired,
                AcceptanceState::Accepted => ReservationStatus::ReconciledCharged,
                AcceptanceState::NotSent => ReservationStatus::ReconciledReleased,
            }
        };

        if let Some(grant) = guard.reservations.get_mut(&report.reservation_id) {
            grant.status = next_status;
        }
        if next_status == ReservationStatus::ReconciledCharged {
            if let Some(obs_cost) = report.actual_cost_microunits {
                if let Some(new_total) = prev_cost.checked_add(obs_cost) {
                    guard
                        .total_reconciled_cost_microunits
                        .insert(candidate_id.clone(), new_total);
                }
            }
        }
        guard.note_terminal_reservation(&report.reservation_id);

        let mut auto_opened_circuit = false;
        let mut model_entitlement_locked: Option<(String, String)> = None;
        let mut served_provider_id: Option<String> = None;
        let diag_lower = report.diagnostic_note.to_ascii_lowercase();
        let inferred_model_not_allowed = !report.success
            && (report.model_entitlement_error
                || diag_lower.contains("model_not_allowed")
                || diag_lower.contains("does not have access to the requested model")
                || (diag_lower.contains("403") && diag_lower.contains("model")));
        if let Some(entry) = guard.candidates.get_mut(&candidate_id) {
            if report.success {
                served_provider_id = Some(entry.candidate.provider_id.clone());
            }
            let was_open = matches!(entry.state.circuit, CircuitState::Open { .. });
            entry.state.reserved_tokens = entry
                .state
                .reserved_tokens
                .saturating_sub(reserved_tokens)
                .max(0);
            entry.state.reserved_requests = entry.state.reserved_requests.saturating_sub(1).max(0);
            entry.state.total_calls = entry.state.total_calls.saturating_add(1);
            if let Some(lat) = report.latency_ms {
                entry.state.record_latency(lat);
            }
            if let Some(retry_after_ms) = report.retry_after_ms {
                if retry_after_ms > 0 {
                    entry.state.retry_after_until_ms = Some(now_ms.saturating_add(retry_after_ms));
                }
            }
            if let Some(q_until) = report.quota_exhausted_until_ms {
                if q_until > now_ms {
                    entry.state.quota_exhausted_until_ms = Some(q_until);
                }
            }
            if let Some(reset_until) = report.provider_quota_reset_at_ms {
                if reset_until > now_ms {
                    let bounded = reset_until.min(now_ms.saturating_add(MAX_QUOTA_EXHAUSTION_MS));
                    let prev = entry.state.provider_quota_reset_until_ms.unwrap_or(0);
                    entry.state.provider_quota_reset_until_ms = Some(prev.max(bounded));
                }
            }
            if report.success {
                entry.state.success_count = entry.state.success_count.saturating_add(1);
                entry.state.consecutive_failures = 0;
                entry.state.circuit = CircuitState::Closed;
                entry.state.quota_exhausted_until_ms = None;
                entry.state.soft_fail_until_ms = None;
                entry.state.provider_quota_reset_until_ms = None;
                entry.state.model_locks_until_ms.remove(&model_id);
                entry.state.model_proven.insert(model_id.clone(), true);
            } else if report.is_request_scoped {
                // RequestScopedError (400/413/422 payload/overflow/safety): MUST NOT trip provider circuit.
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = entry.state.circuit
                {
                    entry.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
            } else if inferred_model_not_allowed {
                // Model entitlement lock (`T2.3`): drops positive proof & cools ONLY this model
                // without tripping the provider circuit for unrelated permitted models.
                entry.state.model_proven.remove(&model_id);
                entry
                    .state
                    .model_locks_until_ms
                    .insert(model_id.clone(), now_ms.saturating_add(300_000));
                model_entitlement_locked = Some((entry.candidate.provider_id.clone(), model_id.clone()));
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = entry.state.circuit
                {
                    entry.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
            } else if report.soft_fail {
                // 5s non-punishing softFail demotion: prefers healthy siblings without causing
                // single-account 503 circuit-open outages.
                let until = now_ms.saturating_add(DEFAULT_SOFT_FAIL_WINDOW_MS);
                let prev = entry.state.soft_fail_until_ms.unwrap_or(0);
                entry.state.soft_fail_until_ms = Some(prev.max(until));
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = entry.state.circuit
                {
                    entry.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
            } else if report.provider_quota_reset_at_ms.is_some() {
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = entry.state.circuit
                {
                    entry.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
            } else {
                entry.state.consecutive_failures =
                    entry.state.consecutive_failures.saturating_add(1);
                let was_half_open = matches!(entry.state.circuit, CircuitState::HalfOpen { .. });
                if was_half_open || entry.state.consecutive_failures >= failure_threshold {
                    entry.state.circuit = CircuitState::Open {
                        opened_at_ms: now_ms,
                        cooldown_ms: default_cooldown,
                    };
                    if !was_open {
                        auto_opened_circuit = true;
                    }
                }
            }
            if let Some(ref store) = store_opt {
                store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
            }
        }
        if let Some(prov) = served_provider_id {
            guard.not_served_tracker.record_served(&prov, &model_id);
        }
        if let Some((provider_id, locked_model)) = model_entitlement_locked {
            let until_ms = now_ms.saturating_add(300_000);
            guard.model_cooldowns.insert(
                (
                    candidate_id.clone(),
                    locked_model.clone(),
                    ModelCooldownClass::ModelNotAllowed403,
                ),
                ModelCooldownEntry {
                    candidate_id: candidate_id.clone(),
                    provider_id,
                    model_id: locked_model,
                    error_class: ModelCooldownClass::ModelNotAllowed403,
                    until_ms,
                    reason: SecretRedactor::redact(&report.diagnostic_note),
                },
            );
            guard.push_failover_event(FailoverEvent {
                timestamp_ms: now_ms,
                kind: "model_cooldown".to_owned(),
                from_candidate_id: Some(candidate_id.clone()),
                to_candidate_id: None,
                reason: "model_not_allowed_403".to_owned(),
                reservation_id: Some(report.reservation_id.clone()),
            });
        }
        let burned_tokens = report
            .actual_input_tokens
            .unwrap_or(0)
            .saturating_add(report.actual_output_tokens.unwrap_or(0));
        if burned_tokens > 0 {
            guard.record_burn_sample(&candidate_id, now_ms, burned_tokens);
        }
        if auto_opened_circuit {
            guard.push_failover_event(FailoverEvent {
                timestamp_ms: now_ms,
                kind: "circuit_opened".to_owned(),
                from_candidate_id: Some(candidate_id.clone()),
                to_candidate_id: None,
                reason: if report.diagnostic_note.trim().is_empty() {
                    "failure_threshold_reached".to_owned()
                } else {
                    report.diagnostic_note.clone()
                },
                reservation_id: Some(report.reservation_id.clone()),
            });
        }

        let receipt = RouteOutcomeReceipt {
            reservation_id: report.reservation_id,
            candidate_id,
            fencing_token: report.fencing_token,
            status: next_status,
            reconciled_at_ms: now_ms,
            actual_input_tokens: report.actual_input_tokens,
            actual_output_tokens: report.actual_output_tokens,
            actual_cost_microunits: report.actual_cost_microunits,
            diagnostic_note: SecretRedactor::redact(&report.diagnostic_note),
        };
        guard.push_outcome_receipt(receipt.clone());
        Ok(receipt)
    }

    pub fn resolve_operator_recovery(
        &self,
        reservation_id: &str,
        accepted_by_provider: bool,
        actual_cost_microunits: Option<i64>,
        note: &str,
        now_ms: i64,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let (candidate_id, fencing_token, status) = {
            let grant = guard
                .reservations
                .get_mut(reservation_id)
                .ok_or_else(|| RoutingError::UnknownReservation(reservation_id.to_owned()))?;
            if !matches!(
                grant.status,
                ReservationStatus::OperatorRecoveryRequired | ReservationStatus::OrphanedOnRestart
            ) {
                return Err(RoutingError::InvalidReservationTransition {
                    reservation_id: reservation_id.to_owned(),
                    state: grant.status.as_str(),
                });
            }
            grant.status = if accepted_by_provider {
                ReservationStatus::ReconciledCharged
            } else {
                ReservationStatus::ReconciledReleased
            };
            (
                grant.candidate_id.clone(),
                grant.fencing_token,
                grant.status,
            )
        };

        let receipt = RouteOutcomeReceipt {
            reservation_id: reservation_id.to_owned(),
            candidate_id,
            fencing_token,
            status,
            reconciled_at_ms: now_ms,
            actual_input_tokens: None,
            actual_output_tokens: None,
            actual_cost_microunits,
            diagnostic_note: SecretRedactor::redact(note),
        };
        guard.push_outcome_receipt(receipt.clone());
        Ok(receipt)
    }

    pub fn recover_after_restart(
        &self,
        now_ms: i64,
    ) -> Result<Vec<ReservationGrant>, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        guard.epoch = guard.epoch.saturating_add(1);
        let mut recovered = Vec::new();
        let ids_to_recover: Vec<String> = guard
            .reservations
            .iter()
            .filter(|(_, grant)| !grant.status.is_terminal())
            .map(|(id, _)| id.clone())
            .collect();

        for id in ids_to_recover {
            let (cand_id, tokens, updated_grant) = {
                let Some(grant) = guard.reservations.get_mut(&id) else {
                    continue;
                };
                let next_status = match grant.status {
                    ReservationStatus::ReservedNotDispatched => {
                        ReservationStatus::ReconciledReleased
                    }
                    ReservationStatus::InFlight => ReservationStatus::OrphanedOnRestart,
                    _ => grant.status,
                };
                grant.status = next_status;
                grant.expires_at_ms = now_ms;
                (
                    grant.candidate_id.clone(),
                    grant.reserved_tokens,
                    grant.clone(),
                )
            };
            if let Some(entry) = guard.candidates.get_mut(&cand_id) {
                entry.state.reserved_tokens =
                    entry.state.reserved_tokens.saturating_sub(tokens).max(0);
                entry.state.reserved_requests =
                    entry.state.reserved_requests.saturating_sub(1).max(0);
                if let CircuitState::HalfOpen {
                    probe_in_flight: true,
                } = entry.state.circuit
                {
                    entry.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: false,
                    };
                }
            }
            recovered.push(updated_grant);
        }
        Ok(recovered)
    }

    pub fn snapshots(&self, now_ms: i64) -> Result<Vec<CandidateSnapshot>, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let mut out = Vec::with_capacity(guard.candidates.len());
        for entry in guard.candidates.values_mut() {
            entry.state.advance_time(now_ms);
            out.push(CandidateSnapshot {
                candidate: entry.candidate.clone(),
                state: entry.state.clone(),
            });
        }
        Ok(out)
    }

    pub fn reservation(
        &self,
        reservation_id: &str,
    ) -> Result<Option<ReservationGrant>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.reservations.get(reservation_id).cloned())
    }

    pub fn decision_receipts(&self) -> Result<Vec<RouteDecisionReceipt>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.decision_receipts.iter().cloned().collect())
    }

    pub fn outcome_receipts(&self) -> Result<Vec<RouteOutcomeReceipt>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.outcome_receipts.iter().cloned().collect())
    }

    /// Look up one secret-redacted decision receipt by `decision_id`.
    pub fn decision_receipt_by_id(
        &self,
        decision_id: &str,
    ) -> Result<Option<RouteDecisionReceipt>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard
            .decision_receipts
            .iter()
            .rev()
            .find(|r| r.decision_id == decision_id)
            .cloned())
    }

    /// Return the most recent secret-redacted decision receipt, if any.
    pub fn latest_decision_receipt(&self) -> Result<Option<RouteDecisionReceipt>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.decision_receipts.back().cloned())
    }

    /// Return recent failover / circuit / quota lifecycle events (newest first, bounded by `limit`).
    pub fn failover_timeline(&self, limit: usize) -> Result<Vec<FailoverEvent>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let cap = limit.max(1);
        Ok(guard
            .failover_events
            .iter()
            .rev()
            .take(cap)
            .cloned()
            .collect())
    }

    /// Compute truthful burn-rate and runway projection for one candidate.
    pub fn candidate_runway(
        &self,
        candidate_id: &str,
        now_ms: i64,
    ) -> Result<QuotaRunwayProjection, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        if let Some(entry) = guard.candidates.get_mut(candidate_id) {
            entry.state.advance_time(now_ms);
        } else {
            return Err(RoutingError::UnknownCandidate(candidate_id.to_owned()));
        }
        let state = &guard.candidates[candidate_id].state;
        let samples = guard.token_burn_samples.get(candidate_id);
        Ok(compute_quota_runway(candidate_id, state, samples, now_ms))
    }

    /// Compute truthful burn-rate and runway projections for all registered candidates.
    pub fn candidate_runways(
        &self,
        now_ms: i64,
    ) -> Result<BTreeMap<String, QuotaRunwayProjection>, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let ids: Vec<String> = guard.candidates.keys().cloned().collect();
        let mut out = BTreeMap::new();
        for id in ids {
            if let Some(entry) = guard.candidates.get_mut(&id) {
                entry.state.advance_time(now_ms);
            }
            let state = &guard.candidates[&id].state;
            let samples = guard.token_burn_samples.get(&id);
            out.insert(id.clone(), compute_quota_runway(&id, state, samples, now_ms));
        }
        Ok(out)
    }
}

fn compute_quota_runway(
    candidate_id: &str,
    state: &CandidateResourceState,
    samples: Option<&VecDeque<(i64, u64)>>,
    now_ms: i64,
) -> QuotaRunwayProjection {
    let sample_count = samples.map_or(0, VecDeque::len);
    let burn_rate_tokens_per_min = samples.and_then(|ring| {
        if ring.is_empty() {
            return None;
        }
        let total_tok: u64 = ring.iter().map(|(_, t)| *t).sum();
        if total_tok == 0 {
            return None;
        }
        let first_ts = ring.front().map_or(now_ms, |(ts, _)| *ts);
        let last_ts = ring.back().map_or(now_ms, |(ts, _)| *ts).max(now_ms);
        let span_ms = last_ts.saturating_sub(first_ts).max(60_000);
        let rate = (total_tok as f64) / ((span_ms as f64) / 60_000.0);
        Some((rate * 100.0).round() / 100.0)
    });

    let (remaining_tokens, window_capacity_tokens, window_reset_at_ms) = match &state.quota {
        QuotaState::Known {
            remaining_tokens,
            window_capacity_tokens,
            window_reset_at_ms,
            ..
        } => (
            Some((*remaining_tokens).saturating_sub(state.reserved_tokens).max(0)),
            (*window_capacity_tokens > 0).then_some(*window_capacity_tokens),
            *window_reset_at_ms,
        ),
        QuotaState::Stale {
            last_known_remaining_tokens,
            window_capacity_tokens,
            window_reset_at_ms,
            ..
        } => (
            Some(
                (*last_known_remaining_tokens)
                    .saturating_sub(state.reserved_tokens)
                    .max(0),
            ),
            (*window_capacity_tokens > 0).then_some(*window_capacity_tokens),
            *window_reset_at_ms,
        ),
        QuotaState::Unknown { .. } | QuotaState::Contradictory { .. } => (None, None, None),
    };

    let window_reset_in_minutes = window_reset_at_ms.map(|reset| {
        let rem_ms = reset.saturating_sub(now_ms).max(0);
        ((rem_ms as f64 / 60_000.0) * 100.0).round() / 100.0
    });

    let estimated_runway_minutes = match (remaining_tokens, burn_rate_tokens_per_min) {
        (Some(rem), Some(rate)) if rate > 0.0 => {
            Some((((rem as f64) / rate) * 100.0).round() / 100.0)
        }
        _ => None,
    };

    let status = if state
        .quota_exhausted_until_ms
        .is_some_and(|until| until > now_ms)
        || remaining_tokens == Some(0)
    {
        "exhausted"
    } else if matches!(
        state.quota,
        QuotaState::Unknown { .. } | QuotaState::Contradictory { .. }
    ) {
        "unknown"
    } else if estimated_runway_minutes.is_some_and(|m| m < 15.0)
        || matches!(state.quota, QuotaState::Stale { .. })
    {
        "warning"
    } else {
        "healthy"
    };

    QuotaRunwayProjection {
        candidate_id: candidate_id.to_owned(),
        quota_kind: state.quota.kind_str().to_owned(),
        remaining_tokens,
        window_capacity_tokens,
        reserved_tokens: state.reserved_tokens,
        burn_rate_tokens_per_min,
        estimated_runway_minutes,
        window_reset_in_minutes,
        sample_count,
        status: status.to_owned(),
    }
}

fn merge_capabilities_monotonic(
    parent: ModelCapabilities,
    child: ModelCapabilities,
) -> ModelCapabilities {
    ModelCapabilities {
        supports_tools: parent.supports_tools || child.supports_tools,
        supports_structured_output: parent.supports_structured_output
            || child.supports_structured_output,
        supports_vision: parent.supports_vision || child.supports_vision,
        supports_streaming: parent.supports_streaming || child.supports_streaming,
        supports_reasoning: parent.supports_reasoning || child.supports_reasoning,
        supports_json_mode: parent.supports_json_mode || child.supports_json_mode,
    }
}

fn intersect_allowlist(parent: &[String], child: &[String]) -> Result<Vec<String>, ()> {
    if parent.is_empty() && child.is_empty() {
        return Ok(Vec::new());
    }
    if parent.is_empty() {
        return Ok(child.to_vec());
    }
    if child.is_empty() {
        return Ok(parent.to_vec());
    }
    let child_set: HashSet<&str> = child.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for item in parent {
        if child_set.contains(item.as_str()) && !out.iter().any(|x| x == item) {
            out.push(item.clone());
        }
    }
    if out.is_empty() {
        Err(())
    } else {
        Ok(out)
    }
}

fn union_string_lists(parent: &[String], child: &[String]) -> Vec<String> {
    let mut out = parent.to_vec();
    for item in child {
        if !out.iter().any(|x| x == item) {
            out.push(item.clone());
        }
    }
    out
}

fn min_optional_u32(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) => Some(x),
        (None, y) => y,
    }
}

fn min_optional_i64(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) => Some(x),
        (None, y) => y,
    }
}

fn validate_deadline(deadline_ms: Option<i64>, now_ms: i64) -> Option<&'static str> {
    let dl = deadline_ms?;
    if dl <= 0 {
        Some("invalid_deadline")
    } else if now_ms >= dl {
        Some("request_deadline_expired")
    } else {
        None
    }
}

fn record_fallback_denial(
    guard: &mut RouterInner,
    policy: &RouteRequestPolicy,
    now_ms: i64,
    reason: &str,
) -> DecisionResult {
    let receipt = RouteDecisionReceipt {
        decision_id: uuid_v4(),
        request_id: policy.request_id.clone(),
        policy_hash: policy.policy_hash(),
        decided_at_ms: now_ms,
        allowed: false,
        simulated: false,
        selected_candidate_id: None,
        reservation_id: None,
        fencing_token: None,
        deny_reason: Some(reason.to_owned()),
        token_budget: policy.token_budget,
        candidate_scores: Vec::new(),
    };
    guard.push_decision_receipt(receipt.clone());
    DecisionResult {
        allowed: false,
        reservation: None,
        receipt,
    }
}

fn release_candidate_reservation(
    guard: &mut RouterInner,
    candidate_id: &str,
    reserved_tokens: i64,
    store_opt: &Option<Arc<RouterSqliteStore>>,
    now_ms: i64,
) -> Result<(), RoutingError> {
    if let Some(entry) = guard.candidates.get_mut(candidate_id) {
        entry.state.reserved_tokens = entry
            .state
            .reserved_tokens
            .saturating_sub(reserved_tokens)
            .max(0);
        entry.state.reserved_requests = entry.state.reserved_requests.saturating_sub(1).max(0);
        if let CircuitState::HalfOpen {
            probe_in_flight: true,
        } = entry.state.circuit
        {
            entry.state.circuit = CircuitState::HalfOpen {
                probe_in_flight: false,
            };
        }
        if let Some(ref store) = store_opt {
            store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
        }
    }
    Ok(())
}

fn summarize_deny_reason(scores: &[CandidateScoreBreakdown]) -> String {
    if scores.is_empty() {
        return "no_candidates_registered".to_owned();
    }
    if let Some(reason) = scores.iter().find_map(|s| {
        s.rejection_reason
            .as_deref()
            .filter(|r| *r != "candidate_excluded_by_policy")
            .map(str::to_owned)
    }) {
        return reason;
    }
    scores
        .iter()
        .find_map(|s| s.rejection_reason.clone())
        .unwrap_or_else(|| "all_candidates_rejected".to_owned())
}

fn simulate_route_locked(
    guard: &RouterInner,
    policy: &RouteRequestPolicy,
) -> DecisionResult {
    let now_ms = policy.now_epoch_ms.unwrap_or_else(now_epoch_ms);
    let policy_hash = policy.policy_hash();
    if let Some(reason) = validate_deadline(policy.deadline_ms, now_ms) {
        return DecisionResult {
            allowed: false,
            reservation: None,
            receipt: RouteDecisionReceipt {
                decision_id: format!("rsim-{}", uuid_v4()),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: false,
                simulated: true,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some(reason.to_owned()),
                token_budget: policy.token_budget,
                candidate_scores: Vec::new(),
            },
        };
    }
    let Some(needed_tokens) = policy
        .estimated_total_tokens_checked()
        .and_then(|v| i64::try_from(v).ok())
    else {
        return DecisionResult {
            allowed: false,
            reservation: None,
            receipt: RouteDecisionReceipt {
                decision_id: format!("rsim-{}", uuid_v4()),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: false,
                simulated: true,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some("estimated_tokens_overflow".to_owned()),
                token_budget: policy.token_budget,
                candidate_scores: Vec::new(),
            },
        };
    };
    let excluded: HashSet<&str> = policy
        .excluded_candidate_ids
        .iter()
        .map(String::as_str)
        .collect();
    let sticky_candidate = policy
        .session_affinity_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|k| guard.session_affinity.get(k).cloned());

    let mut scores = Vec::with_capacity(guard.candidates.len());
    let mut best_clean_idx: Option<usize> = None;
    let mut best_demoted_idx: Option<usize> = None;

    for reg in guard.candidates.values() {
        let mut cloned_state = reg.state.clone();
        cloned_state.advance_time(now_ms);
        if cloned_state
            .quota_exhausted_until_ms
            .is_some_and(|until| now_ms >= until)
        {
            cloned_state.quota_exhausted_until_ms = None;
        }
        let score = evaluate_candidate(
            &reg.candidate,
            &cloned_state,
            policy,
            &excluded,
            sticky_candidate.as_deref(),
            now_ms,
            needed_tokens,
        );
        let idx = scores.len();
        if score.eligible {
            let is_soft_failed = cloned_state
                .soft_fail_until_ms
                .is_some_and(|until| now_ms < until);
            let slot = if is_soft_failed {
                &mut best_demoted_idx
            } else {
                &mut best_clean_idx
            };
            let is_better = match *slot {
                None => true,
                Some(cur_best_idx) => {
                    let cur_best: &CandidateScoreBreakdown = &scores[cur_best_idx];
                    score.total_score_bps > cur_best.total_score_bps
                        || (score.total_score_bps == cur_best.total_score_bps
                            && score.candidate_id < cur_best.candidate_id)
                }
            };
            if is_better {
                *slot = Some(idx);
            }
        }
        scores.push(score);
    }
    let best_idx = best_clean_idx.or(best_demoted_idx);

    if let Some(idx) = best_idx {
        let winner_id = scores[idx].candidate_id.clone();
        DecisionResult {
            allowed: true,
            reservation: None,
            receipt: RouteDecisionReceipt {
                decision_id: format!("rsim-{}", uuid_v4()),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: true,
                simulated: true,
                selected_candidate_id: Some(winner_id),
                reservation_id: None,
                fencing_token: None,
                deny_reason: None,
                token_budget: policy.token_budget,
                candidate_scores: scores,
            },
        }
    } else {
        let deny_reason = summarize_deny_reason(&scores);
        DecisionResult {
            allowed: false,
            reservation: None,
            receipt: RouteDecisionReceipt {
                decision_id: format!("rsim-{}", uuid_v4()),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: false,
                simulated: true,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some(deny_reason),
                token_budget: policy.token_budget,
                candidate_scores: scores,
            },
        }
    }
}

fn decide_and_reserve_locked(
    guard: &mut RouterInner,
    policy: &RouteRequestPolicy,
) -> Result<DecisionResult, RoutingError> {
    if !policy.idempotency_key.is_empty() {
        if let Some(existing) = guard.idempotency_index.get(&policy.idempotency_key) {
            return Ok(existing.clone());
        }
    }

    let now_ms = policy.now_epoch_ms.unwrap_or_else(now_epoch_ms);
    if let Some(reason) = validate_deadline(policy.deadline_ms, now_ms) {
        let receipt = RouteDecisionReceipt {
            decision_id: uuid_v4(),
            request_id: policy.request_id.clone(),
            policy_hash: policy.policy_hash(),
            decided_at_ms: now_ms,
            allowed: false,
            simulated: false,
            selected_candidate_id: None,
            reservation_id: None,
            fencing_token: None,
            deny_reason: Some(reason.to_owned()),
            token_budget: policy.token_budget,
            candidate_scores: Vec::new(),
        };
        guard.push_decision_receipt(receipt.clone());
        return Ok(DecisionResult {
            allowed: false,
            reservation: None,
            receipt,
        });
    }
    let Some(needed_tokens) = policy
        .estimated_total_tokens_checked()
        .and_then(|v| i64::try_from(v).ok())
    else {
        let receipt = RouteDecisionReceipt {
            decision_id: uuid_v4(),
            request_id: policy.request_id.clone(),
            policy_hash: policy.policy_hash(),
            decided_at_ms: now_ms,
            allowed: false,
            simulated: false,
            selected_candidate_id: None,
            reservation_id: None,
            fencing_token: None,
            deny_reason: Some("estimated_tokens_overflow".to_owned()),
            token_budget: policy.token_budget,
            candidate_scores: Vec::new(),
        };
        guard.push_decision_receipt(receipt.clone());
        return Ok(DecisionResult {
            allowed: false,
            reservation: None,
            receipt,
        });
    };
    let excluded: HashSet<&str> = policy
        .excluded_candidate_ids
        .iter()
        .map(String::as_str)
        .collect();
    let sticky_candidate = policy
        .session_affinity_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|k| guard.session_affinity.get(k).cloned());

    let mut scores = Vec::with_capacity(guard.candidates.len());
    let mut eligible_meta: Vec<(usize, bool, bool)> = Vec::new();

    let candidate_ids: Vec<String> = guard.candidates.keys().cloned().collect();
    for id in candidate_ids {
        if let Some(reg) = guard.candidates.get_mut(&id) {
            reg.state.advance_time(now_ms);
            if reg
                .state
                .quota_exhausted_until_ms
                .is_some_and(|until| now_ms >= until)
            {
                reg.state.quota_exhausted_until_ms = None;
            }
            let score = evaluate_candidate(
                &reg.candidate,
                &reg.state,
                policy,
                &excluded,
                sticky_candidate.as_deref(),
                now_ms,
                needed_tokens,
            );
            if score.eligible {
                let is_proven = reg
                    .state
                    .model_proven
                    .get(&reg.candidate.model_id)
                    .copied()
                    .unwrap_or(false);
                let is_soft_failed = reg
                    .state
                    .soft_fail_until_ms
                    .is_some_and(|until| now_ms < until);
                eligible_meta.push((scores.len(), is_proven, is_soft_failed));
            }
            scores.push(score);
        }
    }

    // 4-Tier selection: prefer clean Tier-0 candidates before falling back to 5s softFail Tier-1
    // candidates (eliminating single-account 503 outages while routing healthy traffic elsewhere).
    let has_clean_candidate = eligible_meta.iter().any(|(_, _, soft)| !*soft);
    let tier_meta: Vec<(usize, bool)> = eligible_meta
        .into_iter()
        .filter(|(_, _, soft)| if has_clean_candidate { !*soft } else { true })
        .map(|(idx, proven, _)| (idx, proven))
        .collect();

    // Apply 1-in-4 `probe_unproven_every` narrowing when both proven and unproven candidates
    // exist in the eligible tier (`htmustc-proxy/internal/proxy/scheduler.go`), without starving.
    let proven_count = tier_meta.iter().filter(|(_, p)| *p).count();
    let unproven_count = tier_meta.len().saturating_sub(proven_count);
    let target_proven_filter: Option<bool> = if proven_count > 0 && unproven_count > 0 {
        let probe_key = format!(
            "{}:{}",
            policy.required_auth_boundary,
            policy.model_role.map_or("any", ModelRole::as_str)
        );
        let cnt = guard.probe_counters.entry(probe_key.clone()).or_insert(0);
        *cnt = cnt.saturating_add(1);
        let cval = *cnt;
        if let Some(ref store) = guard.sqlite_store {
            let _ = store.save_probe_counter(&probe_key, cval);
        }
        let probe_unproven = cval.is_multiple_of(DEFAULT_PROBE_UNPROVEN_EVERY);
        Some(!probe_unproven)
    } else {
        None
    };

    let mut best_idx: Option<usize> = None;
    for &(idx, is_proven) in &tier_meta {
        if target_proven_filter.is_some_and(|want| want != is_proven) {
            continue;
        }
        let score = &scores[idx];
        let is_better = match best_idx {
            None => true,
            Some(cur_best_idx) => {
                let cur_best: &CandidateScoreBreakdown = &scores[cur_best_idx];
                score.total_score_bps > cur_best.total_score_bps
                    || (score.total_score_bps == cur_best.total_score_bps
                        && score.candidate_id < cur_best.candidate_id)
            }
        };
        if is_better {
            best_idx = Some(idx);
        }
    }

    let policy_hash = policy.policy_hash();
    let result = if let Some(idx) = best_idx {
        let winner_id = scores[idx].candidate_id.clone();
        // Checked reservation counter guard BEFORE mutating any fencing/affinity/probe state (`AUD-14`).
        let overflow_detected = guard
            .candidates
            .get(&winner_id)
            .is_some_and(|reg| {
                reg.state.reserved_tokens.checked_add(needed_tokens).is_none()
                    || reg.state.reserved_requests.checked_add(1).is_none()
            });
        if overflow_detected {
            let receipt = RouteDecisionReceipt {
                decision_id: uuid_v4(),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: false,
                simulated: false,
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some("reservation_counter_overflow".to_owned()),
                token_budget: policy.token_budget,
                candidate_scores: scores,
            };
            guard.push_decision_receipt(receipt.clone());
            DecisionResult {
                allowed: false,
                reservation: None,
                receipt,
            }
        } else {
            if let Some(aff_key) = policy
                .session_affinity_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                guard
                    .session_affinity
                    .insert(aff_key.to_owned(), winner_id.clone());
            }
            let fencing_token = guard.next_fencing_token;
            guard.next_fencing_token = guard.next_fencing_token.saturating_add(1);
            let reservation_id = format!("res-{}-{}", guard.epoch, fencing_token);

            let (provider_id, model_id, pricing_version, estimated_cost_microunits) = {
                let reg = guard
                    .candidates
                    .get_mut(&winner_id)
                    .ok_or_else(|| RoutingError::UnknownCandidate(winner_id.clone()))?;
                reg.state.reserved_tokens = reg.state.reserved_tokens.saturating_add(needed_tokens);
                reg.state.reserved_requests = reg.state.reserved_requests.saturating_add(1);
                if matches!(
                    reg.state.circuit,
                    CircuitState::HalfOpen {
                        probe_in_flight: false
                    }
                ) {
                    reg.state.circuit = CircuitState::HalfOpen {
                        probe_in_flight: true,
                    };
                }
                (
                    reg.candidate.provider_id.clone(),
                    reg.candidate.model_id.clone(),
                    reg.candidate.pricing_version.clone(),
                    reg.candidate.estimate_cost_microunits(
                        policy.estimated_input_tokens,
                        policy.estimated_output_tokens,
                    ),
                )
            };

            let grant = ReservationGrant {
                reservation_id: reservation_id.clone(),
                candidate_id: winner_id.clone(),
                provider_id,
                model_id,
                idempotency_key: policy.idempotency_key.clone(),
                fencing_token,
                epoch: guard.epoch,
                reserved_tokens: needed_tokens,
                pricing_version,
                estimated_cost_microunits,
                created_at_ms: now_ms,
                expires_at_ms: now_ms.saturating_add(policy.reservation_ttl_ms.max(1)),
                deadline_ms: policy.deadline_ms,
                attempt_id: None,
                explicit_attempt_required: false,
                status: ReservationStatus::ReservedNotDispatched,
            };
            guard
                .reservations
                .insert(reservation_id.clone(), grant.clone());
            guard
                .parent_policy_bounds
                .insert(reservation_id.clone(), ParentPolicyBounds::from_policy(policy));

            let receipt = RouteDecisionReceipt {
                decision_id: uuid_v4(),
                request_id: policy.request_id.clone(),
                policy_hash,
                decided_at_ms: now_ms,
                allowed: true,
                simulated: false,
                selected_candidate_id: Some(winner_id),
                reservation_id: Some(reservation_id),
                fencing_token: Some(fencing_token),
                deny_reason: None,
                token_budget: policy.token_budget,
                candidate_scores: scores,
            };
            guard.push_decision_receipt(receipt.clone());
            DecisionResult {
                allowed: true,
                reservation: Some(grant),
                receipt,
            }
        }
    } else {
        let deny_reason = summarize_deny_reason(&scores);
        let receipt = RouteDecisionReceipt {
            decision_id: uuid_v4(),
            request_id: policy.request_id.clone(),
            policy_hash,
            decided_at_ms: now_ms,
            allowed: false,
            simulated: false,
            selected_candidate_id: None,
            reservation_id: None,
            fencing_token: None,
            deny_reason: Some(deny_reason),
            token_budget: policy.token_budget,
            candidate_scores: scores,
        };
        guard.push_decision_receipt(receipt.clone());
        DecisionResult {
            allowed: false,
            reservation: None,
            receipt,
        }
    };

    if !policy.idempotency_key.is_empty() {
        guard.record_idempotency(policy.idempotency_key.clone(), result.clone());
    }
    Ok(result)
}

fn evaluate_candidate(
    candidate: &RouteCandidate,
    state: &CandidateResourceState,
    policy: &RouteRequestPolicy,
    excluded: &HashSet<&str>,
    sticky_candidate_id: Option<&str>,
    now_ms: i64,
    needed_tokens: i64,
) -> CandidateScoreBreakdown {
    let reject = |reason: String| CandidateScoreBreakdown {
        candidate_id: candidate.candidate_id.clone(),
        eligible: false,
        rejection_reason: Some(reason),
        capability_fit_bps: 0,
        privacy_fit_bps: 0,
        budget_headroom_bps: 0,
        latency_health_bps: 0,
        reliability_bps: 0,
        user_preference_bps: 0,
        route_priority_bps: 0,
        total_score_bps: 0,
    };

    if excluded.contains(candidate.candidate_id.as_str()) {
        return reject("candidate_excluded_by_policy".to_owned());
    }
    if !candidate.enabled {
        return reject("candidate_disabled".to_owned());
    }
    if !candidate.credential_present {
        return reject("missing_credential".to_owned());
    }
    if candidate.auth_boundary != policy.required_auth_boundary {
        return reject("auth_boundary_mismatch".to_owned());
    }
    if candidate.privacy_tier < policy.minimum_privacy_tier {
        return reject("privacy_tier_insufficient".to_owned());
    }
    if !policy.allowed_regions.is_empty()
        && !policy
            .allowed_regions
            .iter()
            .any(|r| r == &candidate.region)
    {
        return reject("region_not_allowed".to_owned());
    }
    if !policy.allowed_providers.is_empty()
        && !policy
            .allowed_providers
            .iter()
            .any(|p| p == &candidate.provider_id)
    {
        return reject("provider_not_allowed".to_owned());
    }
    if !policy.allowed_models.is_empty()
        && !policy
            .allowed_models
            .iter()
            .any(|m| m == &candidate.model_id)
    {
        return reject("model_not_allowed_by_policy".to_owned());
    }
    if policy
        .forbidden_providers
        .iter()
        .any(|p| p == &candidate.provider_id)
    {
        return reject("provider_forbidden_by_policy".to_owned());
    }
    if policy
        .forbidden_models
        .iter()
        .any(|m| m == &candidate.model_id)
    {
        return reject("model_forbidden_by_policy".to_owned());
    }
    if policy.max_retention_hours == Some(0) && candidate.privacy_tier == PrivacyTier::Public {
        return reject("retention_policy_exceeded".to_owned());
    }
    if let Some(missing_cap) =
        missing_capability(candidate.capabilities, policy.required_capabilities)
    {
        return reject(format!("capability_mismatch:{missing_cap}"));
    }
    let Some(total_req_u64) = policy
        .estimated_input_tokens
        .checked_add(policy.estimated_output_tokens)
    else {
        return reject("estimated_tokens_overflow".to_owned());
    };
    if total_req_u64 > candidate.context_limit_tokens {
        return reject("context_limit_exceeded".to_owned());
    }
    if let Some(reason) = validate_deadline(policy.deadline_ms, now_ms) {
        return reject(reason.to_owned());
    }
    if let Some(deadline) = policy.deadline_ms {
        let remaining_ms = deadline.saturating_sub(now_ms);
        if let Some(ewma) = state.ewma_latency_ms {
            if ewma > remaining_ms as f64 {
                return reject("deadline_latency_exceeded".to_owned());
            }
        }
    }
    if state.reserved_tokens.checked_add(needed_tokens).is_none()
        || state.reserved_requests.checked_add(1).is_none()
    {
        return reject("reservation_counter_overflow".to_owned());
    }
    if policy.estimated_output_tokens > candidate.max_output_tokens {
        return reject("max_output_tokens_exceeded".to_owned());
    }
    if let Some(budget) = policy.token_budget {
        if policy.estimated_total_tokens() > budget {
            return reject("request_token_budget_exceeded".to_owned());
        }
    }
    if let Some(max_cost) = policy.max_cost_microunits {
        match candidate.estimate_cost_microunits(
            policy.estimated_input_tokens,
            policy.estimated_output_tokens,
        ) {
            None => return reject("pricing_unknown_for_cost_cap".to_owned()),
            Some(est) if est > max_cost => return reject("estimated_cost_exceeds_cap".to_owned()),
            Some(_) => {}
        }
    }
    if state
        .provider_quota_reset_until_ms
        .is_some_and(|until| now_ms < until)
    {
        return reject("provider_quota_reset_active".to_owned());
    }
    if state
        .quota_exhausted_until_ms
        .is_some_and(|until| now_ms < until)
    {
        return reject("proactive_quota_gate_exhausted".to_owned());
    }
    if state
        .model_locks_until_ms
        .get(&candidate.model_id)
        .is_some_and(|&until| now_ms < until)
    {
        return reject("model_entitlement_locked".to_owned());
    }
    match state.circuit {
        CircuitState::Open { .. } => return reject("circuit_open".to_owned()),
        CircuitState::HalfOpen {
            probe_in_flight: true,
        } => return reject("half_open_probe_busy".to_owned()),
        CircuitState::Closed
        | CircuitState::HalfOpen {
            probe_in_flight: false,
        } => {}
    }
    if let Some(until) = state.retry_after_until_ms {
        if now_ms < until {
            return reject("retry_after_active".to_owned());
        }
    }
    if let Some(max_lat) = policy.max_ewma_latency_ms {
        if let Some(ewma) = state.ewma_latency_ms {
            if ewma > max_lat {
                return reject("latency_sla_exceeded".to_owned());
            }
        }
    }

    let usable_headroom = match evaluate_quota(state, policy, needed_tokens) {
        Ok(headroom) => headroom,
        Err(reason) => return reject(reason),
    };

    let role_bonus_bps = if let Some(role) = policy.model_role {
        let aff = (intrinsic_role_affinity(role, &candidate.model_id) * 40.0).round() as i64;
        let explicit = if candidate.supported_roles.contains(&role) {
            400
        } else {
            0
        };
        aff + explicit
    } else {
        0
    };
    let capability_fit_bps = 2000 + i64::from(candidate.quality_tier) * 400 + role_bonus_bps;
    let privacy_fit_bps = 1500 + (candidate.privacy_tier as i64) * 500;
    let budget_headroom_bps = (usable_headroom.max(0) / 500).min(2500);
    let latency_health_bps = (2500.0 - state.ewma_latency_ms.unwrap_or(250.0) * 2.0).round() as i64;
    let latency_health_bps = latency_health_bps.max(200);
    let reliability_bps = if state.total_calls == 0 {
        1800
    } else {
        i64::try_from((u128::from(state.success_count) * 2500) / u128::from(state.total_calls))
            .unwrap_or(2500)
    };
    let sticky_bonus = if sticky_candidate_id == Some(candidate.candidate_id.as_str()) {
        1800
    } else {
        0
    };
    let user_preference_bps = policy
        .preferred_candidate_ids
        .iter()
        .position(|id| id == &candidate.candidate_id)
        .map_or(0, |idx| {
            1500 - i64::try_from(idx * 300).unwrap_or(1200).min(1200)
        })
        + sticky_bonus;
    let route_priority_bps = i64::from(candidate.route_priority) * 100;
    let total_score_bps = capability_fit_bps
        + privacy_fit_bps
        + budget_headroom_bps
        + latency_health_bps
        + reliability_bps
        + user_preference_bps
        + route_priority_bps;

    CandidateScoreBreakdown {
        candidate_id: candidate.candidate_id.clone(),
        eligible: true,
        rejection_reason: None,
        capability_fit_bps,
        privacy_fit_bps,
        budget_headroom_bps,
        latency_health_bps,
        reliability_bps,
        user_preference_bps,
        route_priority_bps,
        total_score_bps,
    }
}

fn missing_capability(
    offered: ModelCapabilities,
    required: ModelCapabilities,
) -> Option<&'static str> {
    if required.supports_tools && !offered.supports_tools {
        return Some("tools");
    }
    if required.supports_structured_output && !offered.supports_structured_output {
        return Some("structured_output");
    }
    if required.supports_vision && !offered.supports_vision {
        return Some("vision");
    }
    if required.supports_streaming && !offered.supports_streaming {
        return Some("streaming");
    }
    if required.supports_reasoning && !offered.supports_reasoning {
        return Some("reasoning");
    }
    if required.supports_json_mode && !offered.supports_json_mode {
        return Some("json_mode");
    }
    None
}

fn evaluate_quota(
    state: &CandidateResourceState,
    policy: &RouteRequestPolicy,
    needed_tokens: i64,
) -> Result<i64, String> {
    match &state.quota {
        QuotaState::Contradictory { .. } => Err("quota_contradictory".to_owned()),
        QuotaState::Known {
            remaining_tokens,
            remaining_requests,
            ..
        } => {
            let usable_requests = remaining_requests.saturating_sub(state.reserved_requests);
            if usable_requests < 1 {
                return Err("quota_requests_exhausted".to_owned());
            }
            let usable_tokens = remaining_tokens.saturating_sub(state.reserved_tokens);
            if usable_tokens < needed_tokens {
                return Err("quota_tokens_insufficient".to_owned());
            }
            Ok(usable_tokens)
        }
        QuotaState::Unknown { .. } => {
            if policy.allow_unknown_quota_without_emergency {
                return Ok(needed_tokens);
            }
            if policy.emergency_policy.mode == EmergencyQuotaMode::AllowEmergencyReserve {
                let critical_override = policy.task_risk == TaskRisk::Critical
                    && policy.emergency_policy.allow_on_critical_risk;
                let reserve_available = policy
                    .emergency_policy
                    .emergency_reserve_tokens
                    .saturating_sub(state.reserved_tokens);
                if critical_override || reserve_available >= needed_tokens {
                    return Ok(reserve_available.max(needed_tokens));
                }
            }
            Err("quota_unknown".to_owned())
        }
        QuotaState::Stale {
            last_known_remaining_tokens,
            last_known_remaining_requests,
            ..
        } => {
            if policy.emergency_policy.mode == EmergencyQuotaMode::AllowStaleQuotaWithCap {
                let usable_requests =
                    last_known_remaining_requests.saturating_sub(state.reserved_requests);
                if usable_requests < 1 {
                    return Err("quota_requests_exhausted".to_owned());
                }
                let usable_known =
                    last_known_remaining_tokens.saturating_sub(state.reserved_tokens);
                let cap_left = policy
                    .emergency_policy
                    .stale_fallback_cap_tokens
                    .saturating_sub(state.reserved_tokens);
                let usable = usable_known.min(cap_left);
                if usable >= needed_tokens {
                    return Ok(usable);
                }
            }
            Err("quota_stale".to_owned())
        }
    }
}
#[cfg(test)]
mod router_analytics_tests {
    use super::*;

    #[test]
    fn sqlite_persists_manual_trip_reset_and_records_failover_timeline_and_waterfall() {
        let tmp = std::env::temp_dir().join(format!(
            "omnia_router_s17_{}.db",
            uuid_v4()
        ));
        let now_ms = 1_700_000_000_000i64;
        {
            let router = DynamicProviderRouter::open_sqlite(&tmp, now_ms).unwrap();
            let c1 = RouteCandidate {
                candidate_id: "p1::claude-sonnet-5-5".into(),
                provider_id: "p1".into(),
                model_id: "claude-sonnet-5-5".into(),
                quality_tier: 5,
                ..Default::default()
            };
            let c2 = RouteCandidate {
                candidate_id: "p2::gpt-6.2-sol".into(),
                provider_id: "p2".into(),
                model_id: "gpt-6.2-sol".into(),
                quality_tier: 4,
                ..Default::default()
            };
            let s1 = CandidateResourceState {
                quota: QuotaState::known_with_window(
                    100_000,
                    500,
                    200_000,
                    3_600_000,
                    Some(now_ms + 1_800_000),
                    Some(now_ms),
                    600_000,
                ),
                ..Default::default()
            };
            let s2 = CandidateResourceState {
                quota: QuotaState::unknown("unobserved"),
                ..Default::default()
            };
            router.upsert_candidate(c1, s1).unwrap();
            router.upsert_candidate(c2, s2).unwrap();

            let policy = RouteRequestPolicy {
                request_id: "req-wf-1".into(),
                idempotency_key: "idem-wf-1".into(),
                allow_unknown_quota_without_emergency: true,
                now_epoch_ms: Some(now_ms),
                ..Default::default()
            };
            let dec = router.decide_and_reserve(&policy).unwrap();
            assert!(dec.allowed);
            let grant = dec.reservation.unwrap();
            assert_eq!(grant.candidate_id, "p1::claude-sonnet-5-5");

            // 5-segment waterfall & receipt lookup
            let wf = dec.receipt.candidate_scores[0].score_waterfall_5();
            assert_eq!(wf.segments.len(), 5);
            assert!(wf.total_bps > 0);
            let fetched = router
                .decision_receipt_by_id(&dec.receipt.decision_id)
                .unwrap()
                .expect("receipt must be retrievable by decision_id");
            assert_eq!(fetched.decision_id, dec.receipt.decision_id);

            // Reconcile tokens -> burn-rate/runway projection (Known vs Unknown honest!)
            router
                .mark_dispatched(&grant.reservation_id, grant.fencing_token)
                .unwrap();
            router
                .reconcile_outcome(OutcomeReport {
                    reservation_id: grant.reservation_id.clone(),
                    fencing_token: grant.fencing_token,
                    success: true,
                    acceptance: AcceptanceState::Accepted,
                    actual_input_tokens: Some(8_000),
                    actual_output_tokens: Some(2_000),
                    latency_ms: Some(120.0),
                    now_epoch_ms: Some(now_ms + 60_000),
                    ..Default::default()
                })
                .unwrap();
            let rw1 = router
                .candidate_runway("p1::claude-sonnet-5-5", now_ms + 60_000)
                .unwrap();
            assert_eq!(rw1.quota_kind, "Known");
            assert_eq!(rw1.burn_rate_tokens_per_min, Some(10_000.0));
            assert_eq!(rw1.estimated_runway_minutes, Some(10.0));
            assert_eq!(rw1.status, "warning");

            let rw2 = router
                .candidate_runway("p2::gpt-6.2-sol", now_ms + 60_000)
                .unwrap();
            assert_eq!(rw2.quota_kind, "Unknown");
            assert_eq!(rw2.estimated_runway_minutes, None);
            assert_eq!(rw2.status, "unknown");

            // Manual trip persists to SQLite across reopen!
            router
                .trip_circuit("p1::claude-sonnet-5-5", now_ms + 65_000, Some(120_000))
                .unwrap();
            let timeline = router.failover_timeline(10).unwrap();
            assert!(timeline.iter().any(|e| e.kind == "circuit_tripped"));
        }

        // Reopen SQLite and verify tripped circuit survived restart!
        {
            let reopened = DynamicProviderRouter::open_sqlite(&tmp, now_ms + 70_000).unwrap();
            let snaps = reopened.snapshots(now_ms + 70_000).unwrap();
            let p1 = snaps
                .iter()
                .find(|s| s.candidate.candidate_id == "p1::claude-sonnet-5-5")
                .unwrap();
            assert_eq!(p1.state.circuit.kind_str(), "Open");

            // Reset circuit and verify persistence across second reopen
            reopened.reset_circuit("p1::claude-sonnet-5-5").unwrap();
        }
        {
            let reopened2 = DynamicProviderRouter::open_sqlite(&tmp, now_ms + 75_000).unwrap();
            let snaps = reopened2.snapshots(now_ms + 75_000).unwrap();
            let p1 = snaps
                .iter()
                .find(|s| s.candidate.candidate_id == "p1::claude-sonnet-5-5")
                .unwrap();
            assert_eq!(p1.state.circuit.kind_str(), "Closed");
        }
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("db-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("db-shm"));
    }

    #[test]
    fn simulate_route_is_side_effect_free_and_model_cooldown_isolates_403_and_deep_think_pair_enforces_distinct_families() {
        let router = DynamicProviderRouter::new();
        let now_ms = 1_750_000_000_000i64;
        let claude = RouteCandidate {
            candidate_id: "ht::claude-sonnet-5-5".into(),
            provider_id: "htmustc".into(),
            model_id: "claude-sonnet-5-5".into(),
            quality_tier: 5,
            ..Default::default()
        };
        let gpt = RouteCandidate {
            candidate_id: "ht::gpt-6.2-sol".into(),
            provider_id: "htmustc".into(),
            model_id: "gpt-6.2-sol".into(),
            quality_tier: 5,
            ..Default::default()
        };
        let mut s_claude = CandidateResourceState {
            quota: QuotaState::known(100_000, 100),
            ..Default::default()
        };
        s_claude.record_latency(180.0);
        let mut s_gpt = CandidateResourceState {
            quota: QuotaState::known(100_000, 100),
            ..Default::default()
        };
        s_gpt.record_latency(210.0);
        router.upsert_candidate(claude, s_claude).unwrap();
        router.upsert_candidate(gpt, s_gpt).unwrap();

        let policy = RouteRequestPolicy {
            request_id: "req-sim-1".into(),
            idempotency_key: "idem-sim-1".into(),
            estimated_input_tokens: 4_000,
            estimated_output_tokens: 1_000,
            now_epoch_ms: Some(now_ms),
            ..Default::default()
        };
        // 1. Repeated simulate_route calls MUST NOT consume quota or store receipts (`AUD-09`).
        for _ in 0..5 {
            let sim = router.simulate_route(&policy).unwrap();
            assert!(sim.allowed);
            assert!(sim.reservation.is_none());
            assert!(sim.receipt.simulated);
            assert!(sim.receipt.decision_id.starts_with("rsim-"));
        }
        let snaps = router.snapshots(now_ms).unwrap();
        assert!(snaps.iter().all(|s| s.state.reserved_tokens == 0 && s.state.reserved_requests == 0));
        assert!(router.decision_receipts().unwrap().is_empty());

        // 2. Checked u64 overflow + deadline_ms admission rejection (`AUD-14`).
        let expired_policy = RouteRequestPolicy {
            deadline_ms: Some(now_ms - 1),
            ..policy.clone()
        };
        let exp = router.simulate_route(&expired_policy).unwrap();
        assert!(!exp.allowed);
        assert!(exp.receipt.simulated);
        assert_eq!(exp.receipt.deny_reason.as_deref(), Some("request_deadline_expired"));

        let tight_deadline = RouteRequestPolicy {
            deadline_ms: Some(now_ms + 100),
            ..policy.clone()
        };
        let tight = router.simulate_route(&tight_deadline).unwrap();
        assert!(!tight.allowed);
        assert_eq!(tight.receipt.deny_reason.as_deref(), Some("deadline_latency_exceeded"));

        let overflow_policy = RouteRequestPolicy {
            estimated_input_tokens: u64::MAX,
            estimated_output_tokens: 10,
            ..policy.clone()
        };
        let ovf = router.simulate_route(&overflow_policy).unwrap();
        assert!(!ovf.allowed);
        assert_eq!(ovf.receipt.deny_reason.as_deref(), Some("estimated_tokens_overflow"));

        // 3. Dual-Pool Deep Think pair enforces distinct vendor families (`anthropic` vs `openai`).
        let pair = router.select_deep_think_pair(&policy).unwrap();
        assert!(pair.distinct_family_verified);
        assert_ne!(
            Some(pair.primary_family.as_str()),
            pair.verifier_family.as_deref()
        );
        assert_eq!(
            pair.reasoning_sandwich_efforts,
            (EffortLevel::Max, EffortLevel::High, EffortLevel::Max)
        );

        // 4. Model-scoped 403 cooldown (`T2.3`) isolates ONLY that model without tripping circuit.
        router
            .record_model_cooldown(
                "ht::claude-sonnet-5-5",
                "claude-sonnet-5-5",
                ModelCooldownClass::ModelNotAllowed403,
                300_000,
                now_ms,
                "HTTP 403 model_not_allowed",
            )
            .unwrap();
        let after_cool = router.snapshots(now_ms + 1_000).unwrap();
        let c_snap = after_cool
            .iter()
            .find(|s| s.candidate.candidate_id == "ht::claude-sonnet-5-5")
            .unwrap();
        assert_eq!(c_snap.state.circuit.kind_str(), "Closed");
        assert_eq!(router.active_model_cooldowns(now_ms + 1_000).unwrap().len(), 1);
        let rerouted = router.simulate_route(&policy).unwrap();
        assert!(rerouted.allowed);
        assert_eq!(
            rerouted.receipt.selected_candidate_id.as_deref(),
            Some("ht::gpt-6.2-sol")
        );
    }

    #[test]
    fn test_simulation_and_deadline_fences() {
        let router = DynamicProviderRouter::with_circuit_config(2, 5_000);
        let now_ms = 1_760_000_000_000i64;
        let cand = RouteCandidate {
            candidate_id: "p1::claude-sonnet-5-5".into(),
            provider_id: "p1".into(),
            model_id: "claude-sonnet-5-5".into(),
            quality_tier: 5,
            ..Default::default()
        };
        let state = CandidateResourceState {
            quota: QuotaState::known(100_000, 100),
            circuit: CircuitState::HalfOpen {
                probe_in_flight: false,
            },
            ..Default::default()
        };
        router.upsert_candidate(cand, state).unwrap();

        // 1. Non-positive deadline_ms rejected in both simulate_route & decide_and_reserve.
        for bad_dl in [0i64, -500] {
            let p_bad = RouteRequestPolicy {
                request_id: format!("req-bad-{bad_dl}"),
                idempotency_key: format!("idem-bad-{bad_dl}"),
                deadline_ms: Some(bad_dl),
                now_epoch_ms: Some(now_ms),
                ..Default::default()
            };
            let s = router.simulate_route(&p_bad).unwrap();
            assert!(!s.allowed);
            assert!(s.receipt.simulated);
            assert!(s.receipt.decision_id.starts_with("rsim-"));
            assert_eq!(s.receipt.deny_reason.as_deref(), Some("invalid_deadline"));

            let d = router.decide_and_reserve(&p_bad).unwrap();
            assert!(!d.allowed);
            assert!(!d.receipt.simulated);
            assert_eq!(d.receipt.deny_reason.as_deref(), Some("invalid_deadline"));
        }

        // 2. Simulation on HalfOpen candidate MUST NOT flip probe_in_flight or reserve quota.
        let valid_policy = RouteRequestPolicy {
            request_id: "req-halfopen-dl".into(),
            idempotency_key: "idem-halfopen-dl".into(),
            deadline_ms: Some(now_ms + 5_000),
            now_epoch_ms: Some(now_ms),
            ..Default::default()
        };
        let sim = router.simulate_route(&valid_policy).unwrap();
        assert!(sim.allowed);
        assert!(sim.receipt.simulated);
        assert!(sim.receipt.decision_id.starts_with("rsim-"));
        let snap_pre = router.snapshots(now_ms).unwrap();
        assert_eq!(
            snap_pre[0].state.circuit,
            CircuitState::HalfOpen {
                probe_in_flight: false
            }
        );
        assert_eq!(snap_pre[0].state.reserved_tokens, 0);

        // 3. Reserve acquires HalfOpen probe + deadline_ms; expired mark_dispatched_at releases both!
        let dec = router.decide_and_reserve(&valid_policy).unwrap();
        assert!(dec.allowed);
        assert!(!dec.receipt.simulated);
        let grant = dec.reservation.unwrap();
        assert_eq!(grant.deadline_ms, Some(now_ms + 5_000));
        assert_eq!(
            router.snapshots(now_ms).unwrap()[0].state.circuit,
            CircuitState::HalfOpen {
                probe_in_flight: true
            }
        );
        let err = router
            .mark_dispatched_at(&grant.reservation_id, grant.fencing_token, now_ms + 5_000)
            .unwrap_err();
        assert!(matches!(err, RoutingError::ReservationDeadlineExpired { .. }));
        assert_eq!(
            router.reservation(&grant.reservation_id).unwrap().unwrap().status,
            ReservationStatus::ReconciledReleased
        );
        let snap_after = router.snapshots(now_ms + 5_000).unwrap();
        assert_eq!(snap_after[0].state.reserved_tokens, 0);
        assert_eq!(snap_after[0].state.reserved_requests, 0);
        assert_eq!(
            snap_after[0].state.circuit,
            CircuitState::HalfOpen {
                probe_in_flight: false
            }
        );

        // 4. Checked reservation counter overflow is denied without mutating counters.
        router
            .upsert_candidate(
                RouteCandidate {
                    candidate_id: "p1::overflow".into(),
                    provider_id: "p1".into(),
                    model_id: "overflow-m".into(),
                    ..Default::default()
                },
                CandidateResourceState {
                    quota: QuotaState::unknown("test"),
                    reserved_tokens: i64::MAX - 50,
                    ..Default::default()
                },
            )
            .unwrap();
        let ovf_res = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "req-res-ovf".into(),
                idempotency_key: "idem-res-ovf".into(),
                excluded_candidate_ids: vec!["p1::claude-sonnet-5-5".into()],
                allow_unknown_quota_without_emergency: true,
                estimated_input_tokens: 100,
                estimated_output_tokens: 10,
                now_epoch_ms: Some(now_ms),
                ..Default::default()
            })
            .unwrap();
        assert!(!ovf_res.allowed);
        assert_eq!(
            ovf_res.receipt.deny_reason.as_deref(),
            Some("reservation_counter_overflow")
        );
    }

    #[test]
    fn test_policy_boundaries_and_reconciliation_overflow() {
        let router = DynamicProviderRouter::new();
        let now_ms = 1_760_000_000_000i64;
        let c_us = RouteCandidate {
            candidate_id: "prov-a::m1".into(),
            provider_id: "prov-a".into(),
            model_id: "m1".into(),
            region: "us".into(),
            auth_boundary: "tenant:alpha".into(),
            privacy_tier: PrivacyTier::ZeroDataRetention,
            quality_tier: 5,
            ..Default::default()
        };
        let c_eu = RouteCandidate {
            candidate_id: "prov-b::m2".into(),
            provider_id: "prov-b".into(),
            model_id: "m2".into(),
            region: "eu".into(),
            auth_boundary: "tenant:alpha".into(),
            privacy_tier: PrivacyTier::ZeroDataRetention,
            quality_tier: 4,
            ..Default::default()
        };
        router
            .upsert_candidate(
                c_us,
                CandidateResourceState {
                    quota: QuotaState::known(500_000, 100),
                    ..Default::default()
                },
            )
            .unwrap();
        router
            .upsert_candidate(
                c_eu,
                CandidateResourceState {
                    quota: QuotaState::known(500_000, 100),
                    ..Default::default()
                },
            )
            .unwrap();

        let parent_policy = RouteRequestPolicy {
            request_id: "req-bound-1".into(),
            idempotency_key: "idem-bound-1".into(),
            required_auth_boundary: "tenant:alpha".into(),
            allowed_regions: vec!["us".into(), "eu".into()],
            allowed_providers: vec!["prov-a".into(), "prov-b".into()],
            deadline_ms: Some(now_ms + 10_000),
            max_retention_hours: Some(0),
            now_epoch_ms: Some(now_ms),
            ..Default::default()
        };
        let d1 = router.decide_and_reserve(&parent_policy).unwrap();
        assert!(d1.allowed);
        let g1 = d1.reservation.unwrap();
        assert_eq!(g1.candidate_id, "prov-a::m1");

        // 1. Strict `reconcile_in_flight_outcome` MUST reject ReservedNotDispatched & empty attempt_id (`AUD-15`).
        let pre_err = router
            .reconcile_in_flight_outcome(OutcomeReport {
                reservation_id: g1.reservation_id.clone(),
                fencing_token: g1.fencing_token,
                attempt_id: Some("att-1".into()),
                success: true,
                acceptance: AcceptanceState::Accepted,
                now_epoch_ms: Some(now_ms + 100),
                ..Default::default()
            })
            .unwrap_err();
        assert!(matches!(
            pre_err,
            RoutingError::InvalidReservationTransition { .. }
        ));

        let empty_att = router
            .mark_dispatched_with_attempt(&g1.reservation_id, g1.fencing_token, "   ", now_ms + 50)
            .unwrap_err();
        assert!(matches!(empty_att, RoutingError::InvalidPolicy(_)));

        router
            .mark_dispatched_with_attempt(&g1.reservation_id, g1.fencing_token, "att-real-1", now_ms + 50)
            .unwrap();
        let wrong_att = router
            .reconcile_in_flight_outcome(OutcomeReport {
                reservation_id: g1.reservation_id.clone(),
                fencing_token: g1.fencing_token,
                attempt_id: Some("att-wrong".into()),
                success: true,
                acceptance: AcceptanceState::Accepted,
                now_epoch_ms: Some(now_ms + 100),
                ..Default::default()
            })
            .unwrap_err();
        assert!(matches!(wrong_att, RoutingError::InvalidPolicy(_)));

        // Succeed with matching attempt_id & huge cost near i64::MAX to test subsequent overflow fence.
        let ok_rec = router
            .reconcile_in_flight_outcome(OutcomeReport {
                reservation_id: g1.reservation_id.clone(),
                fencing_token: g1.fencing_token,
                attempt_id: Some("att-real-1".into()),
                success: true,
                acceptance: AcceptanceState::Accepted,
                actual_input_tokens: Some(1_000),
                actual_output_tokens: Some(500),
                actual_cost_microunits: Some(i64::MAX - 5),
                now_epoch_ms: Some(now_ms + 200),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ok_rec.status, ReservationStatus::ReconciledCharged);
        assert_eq!(
            router.total_reconciled_cost_microunits("prov-a::m1").unwrap(),
            i64::MAX - 5
        );

        // 2. Monotonic fallback narrowing (`AUD-16`): auth widening & empty allowlist intersection rejected.
        let widened_auth = RouteRequestPolicy {
            required_auth_boundary: "tenant:beta".into(),
            ..parent_policy.clone()
        };
        let fb_auth = router.decide_fallback(&g1.reservation_id, &widened_auth).unwrap();
        assert!(!fb_auth.allowed);
        assert_eq!(
            fb_auth.receipt.deny_reason.as_deref(),
            Some("fallback_auth_boundary_widening_blocked")
        );

        let disjoint_region = RouteRequestPolicy {
            allowed_regions: vec!["ap-south".into()],
            ..parent_policy.clone()
        };
        let fb_empty = router
            .decide_fallback(&g1.reservation_id, &disjoint_region)
            .unwrap();
        assert!(!fb_empty.allowed);
        assert_eq!(
            fb_empty.receipt.deny_reason.as_deref(),
            Some("fallback_allowlist_intersection_empty")
        );

        // Attempting to extend parent deadline in fallback is clamped to parent deadline.
        let extended_dl = RouteRequestPolicy {
            deadline_ms: Some(now_ms + 999_999),
            now_epoch_ms: Some(now_ms + 300),
            ..parent_policy.clone()
        };
        let fb_ok = router.decide_fallback(&g1.reservation_id, &extended_dl).unwrap();
        assert!(fb_ok.allowed);
        let g_fb = fb_ok.reservation.unwrap();
        assert_eq!(g_fb.candidate_id, "prov-b::m2");
        assert_eq!(g_fb.deadline_ms, Some(now_ms + 10_000));

        // Cancel ReservedNotDispatched cleanly via cancel_reservation (`AUD-15`).
        let canceled = router
            .cancel_reservation(&g_fb.reservation_id, g_fb.fencing_token, "aborted_pre_dispatch", now_ms + 350)
            .unwrap();
        assert_eq!(canceled.status, ReservationStatus::ReconciledReleased);

        // 3. Cost overflow & usage overflow & post-deadline reconciliation fence into OperatorRecoveryRequired.
        let d2 = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "req-cost-ovf".into(),
                idempotency_key: "idem-cost-ovf".into(),
                required_auth_boundary: "tenant:alpha".into(),
                allowed_providers: vec!["prov-a".into()],
                deadline_ms: Some(now_ms + 50_000),
                now_epoch_ms: Some(now_ms + 400),
                ..Default::default()
            })
            .unwrap();
        let g2 = d2.reservation.unwrap();
        router
            .mark_dispatched_at(&g2.reservation_id, g2.fencing_token, now_ms + 410)
            .unwrap();
        let ovf_cost = router
            .reconcile_outcome(OutcomeReport {
                reservation_id: g2.reservation_id.clone(),
                fencing_token: g2.fencing_token,
                success: true,
                acceptance: AcceptanceState::Accepted,
                actual_cost_microunits: Some(10),
                now_epoch_ms: Some(now_ms + 450),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ovf_cost.status, ReservationStatus::OperatorRecoveryRequired);
        assert!(ovf_cost.diagnostic_note.contains("cost_overflow"));
        assert_eq!(
            router.total_reconciled_cost_microunits("prov-a::m1").unwrap(),
            i64::MAX - 5
        );

        let d3 = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "req-usage-ovf".into(),
                idempotency_key: "idem-usage-ovf".into(),
                required_auth_boundary: "tenant:alpha".into(),
                allowed_providers: vec!["prov-b".into()],
                deadline_ms: Some(now_ms + 50_000),
                now_epoch_ms: Some(now_ms + 500),
                ..Default::default()
            })
            .unwrap();
        let g3 = d3.reservation.unwrap();
        let ovf_usage = router
            .reconcile_outcome(OutcomeReport {
                reservation_id: g3.reservation_id.clone(),
                fencing_token: g3.fencing_token,
                success: true,
                acceptance: AcceptanceState::Accepted,
                actual_input_tokens: Some(u64::MAX),
                actual_output_tokens: Some(1),
                now_epoch_ms: Some(now_ms + 550),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ovf_usage.status, ReservationStatus::OperatorRecoveryRequired);
        assert!(ovf_usage.diagnostic_note.contains("usage_overflow"));

        let d4 = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "req-post-dl".into(),
                idempotency_key: "idem-post-dl".into(),
                required_auth_boundary: "tenant:alpha".into(),
                allowed_providers: vec!["prov-b".into()],
                deadline_ms: Some(now_ms + 1_000),
                now_epoch_ms: Some(now_ms + 600),
                ..Default::default()
            })
            .unwrap();
        let g4 = d4.reservation.unwrap();
        let late_rec = router
            .reconcile_outcome(OutcomeReport {
                reservation_id: g4.reservation_id.clone(),
                fencing_token: g4.fencing_token,
                success: true,
                acceptance: AcceptanceState::Accepted,
                actual_cost_microunits: Some(500),
                now_epoch_ms: Some(now_ms + 1_500),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(late_rec.status, ReservationStatus::OperatorRecoveryRequired);
        assert!(late_rec.diagnostic_note.contains("reconciliation_after_deadline"));
        assert_eq!(router.total_reconciled_cost_microunits("prov-b::m2").unwrap(), 0);
    }

    #[test]
    fn test_bounded_retention_caps() {
        let router = DynamicProviderRouter::new();
        let now_ms = 1_760_000_000_000i64;
        router
            .upsert_candidate(
                RouteCandidate {
                    candidate_id: "cap::m1".into(),
                    provider_id: "cap".into(),
                    model_id: "m1".into(),
                    ..Default::default()
                },
                CandidateResourceState {
                    quota: QuotaState::known(i64::MAX / 2, i64::MAX / 2),
                    ..Default::default()
                },
            )
            .unwrap();
        let total = MAX_RECEIPT_HISTORY + 32;
        for i in 0..total {
            let d = router
                .decide_and_reserve(&RouteRequestPolicy {
                    request_id: format!("req-cap-{i}"),
                    idempotency_key: format!("idem-cap-{i}"),
                    estimated_input_tokens: 10,
                    estimated_output_tokens: 10,
                    now_epoch_ms: Some(now_ms + i as i64),
                    ..Default::default()
                })
                .unwrap();
            let g = d.reservation.unwrap();
            router
                .cancel_reservation(&g.reservation_id, g.fencing_token, "release", now_ms + i as i64)
                .unwrap();
        }
        assert_eq!(router.decision_receipts().unwrap().len(), MAX_RECEIPT_HISTORY);
        assert_eq!(router.outcome_receipts().unwrap().len(), MAX_RECEIPT_HISTORY);
    }
}
