#![forbid(unsafe_code)]

//! Deterministic provider, model, quota, latency, and circuit-breaker router.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use omnia_core::{now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod model_roles;
pub mod sqlite_store;
pub mod wire_adapter;

pub use model_roles::{
    apply_reasoning_effort_wire, can_replay_cryptographic_proof, clamp_effort_for_model,
    effort_spec_for_model, intrinsic_role_affinity, normalize_model_family_key, EffortLevel,
    EffortWireMode, ModelEffortSpec, ModelRole,
};
pub use sqlite_store::RouterSqliteStore;

/// Default 1-in-N probe cadence for unproven credentials (`htmustc-proxy/internal/proxy/scheduler.go`).
pub const DEFAULT_PROBE_UNPROVEN_EVERY: u64 = 4;

pub use wire_adapter::{
    evaluate_local_vram_fit, normalize_provider_wire_payload, LocalVramFitDecision,
    LocalVramPolicy, NormalizedWirePayload, ProviderWireDialect, WireAdapterError,
    DEFAULT_DWM_UI_HEADROOM_MB, DEFAULT_MAX_AUX_MODEL_VRAM_MB, ENFORCED_LOCAL_VRAM_SEMAPHORE,
};

const MAX_LATENCY_SAMPLES: usize = 256;
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
        }
    }
}

impl CandidateResourceState {
    /// Advance wall-clock state: expire cooldowns, Retry-After windows, or stale/rolled-over quotas.
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
        }
    }
}

impl RouteRequestPolicy {
    #[must_use]
    pub fn estimated_total_tokens(&self) -> u64 {
        self.estimated_input_tokens
            .saturating_add(self.estimated_output_tokens)
            .max(1)
    }

    /// Deterministic SHA-256 hash of the canonical routing constraint set.
    #[must_use]
    pub fn policy_hash(&self) -> String {
        let caps = self.required_capabilities;
        let canonical = format!(
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

impl CandidateScoreBreakdown {
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
}

impl Default for OutcomeReport {
    fn default() -> Self {
        Self {
            reservation_id: String::new(),
            fencing_token: 0,
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

#[derive(Debug)]
struct RegisteredCandidate {
    candidate: RouteCandidate,
    state: CandidateResourceState,
}

#[derive(Debug)]
struct RouterInner {
    epoch: u64,
    next_fencing_token: u64,
    circuit_failure_threshold: u32,
    default_cooldown_ms: i64,
    candidates: BTreeMap<String, RegisteredCandidate>,
    reservations: HashMap<String, ReservationGrant>,
    idempotency_index: HashMap<String, DecisionResult>,
    decision_receipts: Vec<RouteDecisionReceipt>,
    outcome_receipts: Vec<RouteOutcomeReceipt>,
    sqlite_store: Option<Arc<RouterSqliteStore>>,
    role_bindings: BTreeMap<ModelRole, (String, String)>,
    probe_counters: BTreeMap<String, u64>,
    session_affinity: BTreeMap<String, String>,
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
                idempotency_index: HashMap::new(),
                decision_receipts: Vec::new(),
                outcome_receipts: Vec::new(),
                sqlite_store: None,
                role_bindings: BTreeMap::new(),
                probe_counters: BTreeMap::new(),
                session_affinity: BTreeMap::new(),
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

    pub fn set_candidate_enabled(
        &self,
        candidate_id: &str,
        enabled: bool,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.candidate.enabled = enabled;
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
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.candidate.pricing_version = pricing_version.into();
        entry.candidate.input_cost_per_million_microunits = input_cost_per_million_microunits;
        entry.candidate.output_cost_per_million_microunits = output_cost_per_million_microunits;
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
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.state.circuit = CircuitState::Open {
            opened_at_ms: now_ms,
            cooldown_ms: cooldown_ms.unwrap_or(default_cooldown).max(1),
        };
        Ok(())
    }

    pub fn reset_circuit(&self, candidate_id: &str) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let entry = guard
            .candidates
            .get_mut(candidate_id)
            .ok_or_else(|| RoutingError::UnknownCandidate(candidate_id.to_owned()))?;
        entry.state.circuit = CircuitState::Closed;
        entry.state.consecutive_failures = 0;
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
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some(
                    "automatic_fallback_blocked_for_ambiguous_or_orphaned_reservation".to_owned(),
                ),
                token_budget: original_policy.token_budget,
                candidate_scores: Vec::new(),
            };
            guard.decision_receipts.push(receipt.clone());
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
                selected_candidate_id: None,
                reservation_id: None,
                fencing_token: None,
                deny_reason: Some("fallback_disabled_by_policy".to_owned()),
                token_budget: original_policy.token_budget,
                candidate_scores: Vec::new(),
            };
            guard.decision_receipts.push(receipt.clone());
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
        fb_policy.idempotency_key = format!(
            "{}:fallback:{}",
            original_policy.idempotency_key, prev.reservation_id
        );
        if !fb_policy
            .excluded_candidate_ids
            .iter()
            .any(|id| id == &prev.candidate_id)
        {
            fb_policy.excluded_candidate_ids.push(prev.candidate_id);
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
        decide_and_reserve_locked(&mut guard, &fb_policy)
    }

    pub fn mark_dispatched(
        &self,
        reservation_id: &str,
        fencing_token: u64,
    ) -> Result<(), RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
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
        grant.status = ReservationStatus::InFlight;
        Ok(())
    }

    pub fn reconcile_outcome(
        &self,
        report: OutcomeReport,
    ) -> Result<RouteOutcomeReceipt, RoutingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        let now_ms = report.now_epoch_ms.unwrap_or_else(now_epoch_ms);
        let failure_threshold = guard.circuit_failure_threshold;
        let default_cooldown = guard.default_cooldown_ms;
        let store_opt = guard.sqlite_store.clone();

        let (candidate_id, model_id, reserved_tokens) = {
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
            (
                grant.candidate_id.clone(),
                grant.model_id.clone(),
                grant.reserved_tokens,
            )
        };

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

        if let Some(entry) = guard.candidates.get_mut(&candidate_id) {
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
            if report.success {
                entry.state.success_count = entry.state.success_count.saturating_add(1);
                entry.state.consecutive_failures = 0;
                entry.state.circuit = CircuitState::Closed;
                entry.state.quota_exhausted_until_ms = None;
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
            } else if report.model_entitlement_error {
                // Model entitlement lock drops positive proof for this model without killing unrelated models.
                entry.state.model_proven.remove(&model_id);
                entry
                    .state
                    .model_locks_until_ms
                    .insert(model_id.clone(), now_ms.saturating_add(300_000));
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
                }
            }
            if let Some(ref store) = store_opt {
                store.save_candidate(&entry.candidate, &entry.state, now_ms)?;
            }
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
        guard.outcome_receipts.push(receipt.clone());
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
        guard.outcome_receipts.push(receipt.clone());
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
        Ok(guard.decision_receipts.clone())
    }

    pub fn outcome_receipts(&self) -> Result<Vec<RouteOutcomeReceipt>, RoutingError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| RoutingError::InternalLockPoisoned)?;
        Ok(guard.outcome_receipts.clone())
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
    let needed_tokens_u64 = policy.estimated_total_tokens();
    let needed_tokens = i64::try_from(needed_tokens_u64).unwrap_or(i64::MAX);
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
    let mut eligible_meta: Vec<(usize, bool)> = Vec::new();

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
                eligible_meta.push((scores.len(), is_proven));
            }
            scores.push(score);
        }
    }

    // Apply 1-in-4 `probe_unproven_every` narrowing when both proven and unproven candidates
    // exist in the eligible pool (`htmustc-proxy/internal/proxy/scheduler.go`), without ever starving a pool.
    let proven_count = eligible_meta.iter().filter(|(_, p)| *p).count();
    let unproven_count = eligible_meta.len().saturating_sub(proven_count);
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
    for &(idx, is_proven) in &eligible_meta {
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
            status: ReservationStatus::ReservedNotDispatched,
        };
        guard
            .reservations
            .insert(reservation_id.clone(), grant.clone());

        let receipt = RouteDecisionReceipt {
            decision_id: uuid_v4(),
            request_id: policy.request_id.clone(),
            policy_hash,
            decided_at_ms: now_ms,
            allowed: true,
            selected_candidate_id: Some(winner_id),
            reservation_id: Some(reservation_id),
            fencing_token: Some(fencing_token),
            deny_reason: None,
            token_budget: policy.token_budget,
            candidate_scores: scores,
        };
        guard.decision_receipts.push(receipt.clone());
        DecisionResult {
            allowed: true,
            reservation: Some(grant),
            receipt,
        }
    } else {
        let deny_reason = if scores.is_empty() {
            "no_candidates_registered".to_owned()
        } else {
            let mut first_reason = "all_candidates_rejected".to_owned();
            for s in &scores {
                if let Some(r) = &s.rejection_reason {
                    first_reason = r.clone();
                    break;
                }
            }
            first_reason
        };
        let receipt = RouteDecisionReceipt {
            decision_id: uuid_v4(),
            request_id: policy.request_id.clone(),
            policy_hash,
            decided_at_ms: now_ms,
            allowed: false,
            selected_candidate_id: None,
            reservation_id: None,
            fencing_token: None,
            deny_reason: Some(deny_reason),
            token_budget: policy.token_budget,
            candidate_scores: scores,
        };
        guard.decision_receipts.push(receipt.clone());
        DecisionResult {
            allowed: false,
            reservation: None,
            receipt,
        }
    };

    if !policy.idempotency_key.is_empty() {
        guard
            .idempotency_index
            .insert(policy.idempotency_key.clone(), result.clone());
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
    if let Some(missing_cap) =
        missing_capability(candidate.capabilities, policy.required_capabilities)
    {
        return reject(format!("capability_mismatch:{missing_cap}"));
    }
    let total_req_u64 = policy
        .estimated_input_tokens
        .saturating_add(policy.estimated_output_tokens);
    if total_req_u64 > candidate.context_limit_tokens {
        return reject("context_limit_exceeded".to_owned());
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
